import {
  HttpMethod,
  HttpStatus,
  IPC_ROUTES,
  IpcContentType,
  buildChannelMembersPath,
  buildChannelMessagesPath,
  buildChannelReadPath,
  buildChannelWatchPath,
  buildDmsPath,
  buildGuildChannelsPath,
  buildGuildsPath,
  buildInvitesJoinPath,
  buildMessageReactionsPath,
  buildUnreadPath,
  createIpcError,
  formatHttpErrorForCode,
  inspectDaemonLockfile,
  isProcessAlive,
  parseJsonEnvelope,
  parseNdjsonLine,
  removeDaemonLockfile,
} from "../shared/ipc-protocol.js";
import {
  IpcErrorCode,
  type ChannelMembersQuery,
  type ChannelMembersResult,
  type DaemonLockfile,
  type DaemonStatusResult,
  type DaemonStopResult,
  type DirectMessageRequest,
  type DirectMessageResult,
  type DmChannelsResult,
  type GuildChannelsResult,
  type GuildsResult,
  type IpcErrorCodeValue,
  type IpcErrorPayload,
  type JoinGuildRequest,
  type JoinGuildResult,
  type ReactMessageRequest,
  type ReactMessageResult,
  type ReadMessagesRequest,
  type ReadMessagesResult,
  type SendMessageRequest,
  type SendMessageResult,
  type Snowflake,
  type UnreadQuery,
  type UnreadResult,
  type WatchEvent,
  type WatchEventType,
} from "../shared/types.js";

/**
 * Local Daemon Discovery & HTTP/NDJSON IPC Client.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const UNREACHABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function exitCodeForIpcErrorCode(code: string): number {
  switch (code) {
    case IpcErrorCode.DAEMON_UNREACHABLE:
      return 3;
    case IpcErrorCode.BAD_REQUEST:
      return 2;
    default:
      return 1;
  }
}

export class CliRuntimeError extends Error {
  readonly code: IpcErrorCodeValue | string;
  readonly exitCode: number;
  readonly status: number;
  readonly discordCode?: number;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(
    payload: IpcErrorPayload,
    exitCode?: number,
    options?: { cause?: unknown },
  ) {
    super(payload.message, options);
    this.name = "CliRuntimeError";
    this.code = payload.code;
    this.status = payload.status;
    this.exitCode = exitCode ?? exitCodeForIpcErrorCode(payload.code);
    if (payload.discordCode !== undefined) {
      this.discordCode = payload.discordCode;
    }
    if (payload.retryAfterMs !== undefined) {
      this.retryAfterMs = payload.retryAfterMs;
    }
    if (payload.details !== undefined) {
      this.details = payload.details;
    }
  }

  toIpcError(): IpcErrorPayload {
    return createIpcError(this.code, this.message, this.status, {
      discordCode: this.discordCode,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    });
  }
}

export interface DaemonIpcClientOptions {
  lockfilePath: string;
  explicitPort?: number | null;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface RequestCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StreamWatchOptions {
  events?: readonly WatchEventType[];
  signal?: AbortSignal;
  onEvent: (ev: WatchEvent) => void;
}

interface ResolvedDaemonConnection {
  lockfile: DaemonLockfile;
  baseUrl: string;
}

function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  if (typeof err === "object" && err !== null) {
    const rec = err as { name?: unknown; code?: unknown };
    if (rec.name === "AbortError" || rec.code === "ABORT_ERR") {
      return true;
    }
  }
  return false;
}

function isTimeoutError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const rec = err as { name?: unknown; code?: unknown };
    if (rec.name === "TimeoutError" || rec.code === "ETIMEDOUT") {
      return true;
    }
  }
  return false;
}

function isNetworkUnreachableError(
  err: unknown,
  visited: Set<unknown> = new Set(),
): boolean {
  if (typeof err !== "object" || err === null || visited.has(err)) {
    return false;
  }
  visited.add(err);

  const rec = err as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof rec.code === "string" && UNREACHABLE_ERROR_CODES.has(rec.code)) {
    return true;
  }
  if (typeof rec.message === "string") {
    if (/\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND)\b/.test(rec.message)) {
      return true;
    }
  }
  if (Array.isArray(rec.errors)) {
    for (const nested of rec.errors) {
      if (isNetworkUnreachableError(nested, visited)) {
        return true;
      }
    }
  }
  if (rec.cause !== undefined && isNetworkUnreachableError(rec.cause, visited)) {
    return true;
  }
  if (err instanceof TypeError && typeof rec.message === "string") {
    return rec.message.toLowerCase().includes("fetch");
  }
  return false;
}

function createAbortSignalWithTimeout(
  callerSignal?: AbortSignal,
  timeoutMs?: number,
): { signal: AbortSignal | undefined; timeoutSignal: AbortSignal | undefined } {
  const timeoutSignal =
    timeoutMs !== undefined && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  if (callerSignal !== undefined && timeoutSignal !== undefined) {
    return {
      signal: AbortSignal.any([callerSignal, timeoutSignal]),
      timeoutSignal,
    };
  }
  return {
    signal: callerSignal ?? timeoutSignal,
    timeoutSignal,
  };
}

export class DaemonIpcClient {
  private readonly lockfilePath: string;
  private readonly explicitPort: number | null;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: DaemonIpcClientOptions) {
    this.lockfilePath = options.lockfilePath;
    this.explicitPort = options.explicitPort ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async resolveConnection(): Promise<ResolvedDaemonConnection> {
    const inspection = await inspectDaemonLockfile(this.lockfilePath);

    if (inspection.state === "missing") {
      throw new CliRuntimeError(
        formatHttpErrorForCode(
          IpcErrorCode.DAEMON_UNREACHABLE,
          `Daemon is not running (lockfile not found at "${this.lockfilePath}"). Start it with "discord-cli daemon start".`,
        ),
        3,
      );
    }

    if (inspection.state === "stale") {
      await removeDaemonLockfile(
        this.lockfilePath,
        inspection.lockfile.pid,
      ).catch(() => undefined);
      throw new CliRuntimeError(
        formatHttpErrorForCode(
          IpcErrorCode.DAEMON_UNREACHABLE,
          `Daemon is not running (${inspection.reason})`,
        ),
        3,
      );
    }

    if (inspection.state === "corrupt") {
      throw new CliRuntimeError(
        formatHttpErrorForCode(
          IpcErrorCode.DAEMON_UNREACHABLE,
          `Daemon lockfile at "${this.lockfilePath}" is corrupt: ${inspection.error}`,
        ),
        3,
      );
    }

    const { lockfile } = inspection;
    if (this.explicitPort !== null && this.explicitPort !== lockfile.port) {
      throw new CliRuntimeError(
        formatHttpErrorForCode(
          IpcErrorCode.DAEMON_UNREACHABLE,
          `Daemon lockfile specifies port ${lockfile.port}, which does not match requested --port ${this.explicitPort}.`,
        ),
        3,
      );
    }

    return {
      lockfile,
      baseUrl: `http://${lockfile.host}:${lockfile.port}`,
    };
  }

  private async parseErrorResponse(response: Response): Promise<CliRuntimeError> {
    let rawText = "";
    try {
      rawText = await response.text();
    } catch {
      rawText = "";
    }

    if (rawText.trim().length > 0) {
      try {
        const envelope = parseJsonEnvelope<unknown>(rawText);
        if (!envelope.ok) {
          return new CliRuntimeError(envelope.error);
        }
      } catch {
        // Fall through to generic HTTP error if body is not an IPC envelope.
      }
    }

    const status = response.status || HttpStatus.INTERNAL_SERVER_ERROR;
    const code =
      status === HttpStatus.UNAUTHORIZED
        ? IpcErrorCode.UNAUTHORIZED
        : status === HttpStatus.BAD_REQUEST
          ? IpcErrorCode.BAD_REQUEST
          : status === HttpStatus.NOT_FOUND
            ? IpcErrorCode.NOT_FOUND
            : status === HttpStatus.SERVICE_UNAVAILABLE
              ? IpcErrorCode.DAEMON_NOT_READY
              : IpcErrorCode.INTERNAL_ERROR;

    return new CliRuntimeError(
      createIpcError(
        code,
        `Daemon returned HTTP ${status}${response.statusText ? ` (${response.statusText})` : ""}.`,
        status,
      ),
    );
  }

  private async requestJson<T>(
    method: string,
    routePath: string,
    body?: unknown,
    callOptions?: RequestCallOptions,
  ): Promise<T> {
    const { lockfile, baseUrl } = await this.resolveConnection();
    const url = `${baseUrl}${routePath}`;
    const timeoutMs = callOptions?.timeoutMs ?? this.requestTimeoutMs;
    const { signal, timeoutSignal } = createAbortSignalWithTimeout(
      callOptions?.signal,
      timeoutMs,
    );

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = IpcContentType.JSON;
      serializedBody = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: serializedBody,
        signal,
      });
    } catch (err) {
      if (timeoutSignal?.aborted === true || isTimeoutError(err)) {
        throw new CliRuntimeError(
          formatHttpErrorForCode(
            IpcErrorCode.DAEMON_UNREACHABLE,
            `Timed out connecting to daemon at ${baseUrl}${routePath}.`,
          ),
          3,
          { cause: err },
        );
      }

      if (isAbortLikeError(err, callOptions?.signal)) {
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.INTERNAL_ERROR,
            "IPC request was aborted.",
            HttpStatus.INTERNAL_SERVER_ERROR,
          ),
          1,
          { cause: err },
        );
      }

      if (isNetworkUnreachableError(err)) {
        await removeDaemonLockfile(this.lockfilePath, lockfile.pid).catch(
          () => undefined,
        );
        throw new CliRuntimeError(
          formatHttpErrorForCode(
            IpcErrorCode.DAEMON_UNREACHABLE,
            `Unable to connect to daemon at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          ),
          3,
          { cause: err },
        );
      }

      throw new CliRuntimeError(
        createIpcError(
          IpcErrorCode.INTERNAL_ERROR,
          `IPC request failed: ${err instanceof Error ? err.message : String(err)}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
        1,
        { cause: err },
      );
    }

    const rawText = await response.text();
    let parsed: ReturnType<typeof parseJsonEnvelope<T>>;
    try {
      parsed = parseJsonEnvelope<T>(rawText);
    } catch (err) {
      if (!response.ok) {
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.INTERNAL_ERROR,
            `Daemon returned HTTP ${response.status} with non-JSON response.`,
            response.status || HttpStatus.INTERNAL_SERVER_ERROR,
          ),
          1,
          { cause: err },
        );
      }
      throw new CliRuntimeError(
        createIpcError(
          IpcErrorCode.INTERNAL_ERROR,
          `Malformed IPC JSON response from daemon: ${err instanceof Error ? err.message : String(err)}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
        1,
        { cause: err },
      );
    }

    if (!parsed.ok) {
      throw new CliRuntimeError(parsed.error);
    }

    if (!response.ok) {
      throw new CliRuntimeError(
        createIpcError(
          IpcErrorCode.INTERNAL_ERROR,
          `Daemon returned HTTP ${response.status} unexpectedly.`,
          response.status,
        ),
      );
    }

    return parsed.data;
  }

  getStatus(callOptions?: RequestCallOptions): Promise<DaemonStatusResult> {
    return this.requestJson<DaemonStatusResult>(
      HttpMethod.GET,
      IPC_ROUTES.STATUS,
      undefined,
      callOptions,
    );
  }

  getUnread(query?: UnreadQuery): Promise<UnreadResult> {
    return this.requestJson<UnreadResult>(
      HttpMethod.GET,
      buildUnreadPath(query),
    );
  }

  readMessages(
    channelId: Snowflake,
    req: ReadMessagesRequest,
  ): Promise<ReadMessagesResult> {
    return this.requestJson<ReadMessagesResult>(
      HttpMethod.POST,
      buildChannelReadPath(channelId),
      req,
    );
  }

  sendMessage(
    channelId: Snowflake,
    req: SendMessageRequest,
  ): Promise<SendMessageResult> {
    return this.requestJson<SendMessageResult>(
      HttpMethod.POST,
      buildChannelMessagesPath(channelId),
      req,
    );
  }

  reactMessage(
    channelId: Snowflake,
    messageId: Snowflake,
    req: ReactMessageRequest,
  ): Promise<ReactMessageResult> {
    return this.requestJson<ReactMessageResult>(
      HttpMethod.POST,
      buildMessageReactionsPath(channelId, messageId),
      req,
    );
  }

  joinGuild(request: JoinGuildRequest): Promise<JoinGuildResult> {
    return this.requestJson<JoinGuildResult>(
      HttpMethod.POST,
      buildInvitesJoinPath(),
      request,
    );
  }

  listGuilds(): Promise<GuildsResult> {
    return this.requestJson<GuildsResult>(HttpMethod.GET, buildGuildsPath());
  }

  listGuildChannels(guildId: Snowflake): Promise<GuildChannelsResult> {
    return this.requestJson<GuildChannelsResult>(
      HttpMethod.GET,
      buildGuildChannelsPath(guildId),
    );
  }

  listChannelMembers(
    channelId: Snowflake,
    query?: ChannelMembersQuery,
  ): Promise<ChannelMembersResult> {
    return this.requestJson<ChannelMembersResult>(
      HttpMethod.GET,
      buildChannelMembersPath(channelId, query),
    );
  }

  sendDirectMessage(
    request: DirectMessageRequest,
  ): Promise<DirectMessageResult> {
    return this.requestJson<DirectMessageResult>(
      HttpMethod.POST,
      buildDmsPath(),
      request,
    );
  }

  listDms(): Promise<DmChannelsResult> {
    return this.requestJson<DmChannelsResult>(HttpMethod.GET, buildDmsPath());
  }

  stopDaemon(): Promise<DaemonStopResult> {
    return this.requestJson<DaemonStopResult>(
      HttpMethod.POST,
      IPC_ROUTES.DAEMON_STOP,
      {},
    );
  }

  async streamWatch(
    channelId: Snowflake,
    options: StreamWatchOptions,
  ): Promise<void> {
    const { lockfile, baseUrl } = await this.resolveConnection();
    const routePath = buildChannelWatchPath(channelId, options.events);
    const url = `${baseUrl}${routePath}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: HttpMethod.GET,
        headers: {
          Accept: "application/x-ndjson",
        },
        signal: options.signal,
      });
    } catch (err) {
      if (isAbortLikeError(err, options.signal)) {
        return;
      }
      if (isNetworkUnreachableError(err)) {
        await removeDaemonLockfile(this.lockfilePath, lockfile.pid).catch(
          () => undefined,
        );
        throw new CliRuntimeError(
          formatHttpErrorForCode(
            IpcErrorCode.DAEMON_UNREACHABLE,
            `Unable to connect to daemon at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          ),
          3,
          { cause: err },
        );
      }
      throw new CliRuntimeError(
        createIpcError(
          IpcErrorCode.INTERNAL_ERROR,
          `Watch connection failed: ${err instanceof Error ? err.message : String(err)}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
        1,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw await this.parseErrorResponse(response);
    }

    if (response.body === null) {
      throw new CliRuntimeError(
        createIpcError(
          IpcErrorCode.INTERNAL_ERROR,
          "Daemon watch response did not include a readable stream body.",
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const emitLine = (rawLine: string): void => {
      const normalized = rawLine.endsWith("\r")
        ? rawLine.slice(0, -1)
        : rawLine;
      let event: WatchEvent | null;
      try {
        event = parseNdjsonLine(normalized);
      } catch (err) {
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.INTERNAL_ERROR,
            `Invalid WatchEvent NDJSON line from daemon: ${err instanceof Error ? err.message : String(err)}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
          ),
          1,
          { cause: err },
        );
      }
      if (event !== null) {
        options.onEvent(event);
      }
    };

    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (isAbortLikeError(err, options.signal)) {
            return;
          }
          if (!isProcessAlive(lockfile.pid)) {
            await removeDaemonLockfile(this.lockfilePath, lockfile.pid).catch(
              () => undefined,
            );
          }
          if (isNetworkUnreachableError(err)) {
            throw new CliRuntimeError(
              formatHttpErrorForCode(
                IpcErrorCode.DAEMON_UNREACHABLE,
                `Daemon watch stream disconnected: ${err instanceof Error ? err.message : String(err)}`,
              ),
              3,
              { cause: err },
            );
          }
          throw new CliRuntimeError(
            createIpcError(
              IpcErrorCode.INTERNAL_ERROR,
              `Daemon watch stream error: ${err instanceof Error ? err.message : String(err)}`,
              HttpStatus.INTERNAL_SERVER_ERROR,
            ),
            1,
            { cause: err },
          );
        }

        if (chunk.value !== undefined) {
          buffer += decoder.decode(chunk.value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            emitLine(line);
            newlineIndex = buffer.indexOf("\n");
          }
        }

        if (chunk.done) {
          buffer += decoder.decode();
          if (buffer.trim().length > 0) {
            emitLine(buffer);
          }
          return;
        }
      }
    } finally {
      if (options.signal?.aborted === true) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  }
}
