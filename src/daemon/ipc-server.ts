import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  DEFAULT_AUTO_TYPING_ENABLED,
  DEFAULT_CHANNEL_MEMBERS_LIMIT,
  DEFAULT_IPC_HOST,
  DEFAULT_READ_LIMIT,
  MAX_DISCORD_READ_LIMIT,
  calculateTypingDelayMs,
  parsePortValue,
} from "../shared/config.js";
import {
  HttpStatus,
  IpcContentType,
  IpcHeaders,
  createIpcError,
  errorEnvelope,
  formatHttpErrorForCode,
  getAllowedMethodsForIpcPath,
  isAllowedLoopbackHostHeader,
  matchIpcRoute,
  normalizeEmojiForRest,
  okEnvelope,
  parseChannelMembersQuery,
  parseUnreadQuery,
  parseWatchEventsQuery,
  serializeJsonEnvelope,
  serializeNdjsonLine,
  validateDirectMessageRequest,
  validateJoinGuildRequest,
  validateReactMessageRequest,
  validateReadMessagesRequest,
  validateSendMessageRequest,
  type HttpMethodValue,
  type MatchedIpcRoute,
} from "../shared/ipc-protocol.js";
import {
  DiscordChannelType,
  IpcErrorCode,
  type CacheStatusSnapshot,
  type CachedChannel,
  type CachedMessage,
  type CachedUser,
  type ChannelMemberSummary,
  type ChannelMembersQuery,
  type ChannelMembersResult,
  type DaemonStatusResult,
  type DaemonStopResult,
  type DirectMessageRequest,
  type DirectMessageResult,
  type DiscordActiveThreadsResponse,
  type DiscordAuthMode,
  type DiscordChannel,
  type DiscordCreateMessageBody,
  type DiscordInvite,
  type DiscordMessage,
  type DiscordPartialGuild,
  type DmChannelSummary,
  type DmChannelsResult,
  type GatewayStatusSnapshot,
  type GuildChannelsResult,
  type GuildSummary,
  type GuildsResult,
  type IpcErrorPayload,
  type IsoTimestamp,
  type JoinGuildRequest,
  type JoinGuildResult,
  type RateLimitStatusSnapshot,
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
import { RateLimitError } from "./rate-limiter.js";
import {
  DiscordRestError,
  type GetChannelMessagesOptions,
} from "./rest-client.js";
import {
  compareSnowflakes,
  type GetCachedMessagesOptions,
  type WatchSubscribeOptions,
} from "./state-cache.js";

/**
 * Local loopback HTTP/1.1 + NDJSON IPC server for the Discord CLI daemon.
 */

export const DEFAULT_MAX_IPC_BODY_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_STOP_CLOSE_TIMEOUT_MS = 2000;

export interface IpcServerStateCache {
  getBotUser(): CachedUser | null;
  getCacheSnapshot(): CacheStatusSnapshot;
  getUnread(query?: UnreadQuery): UnreadResult;
  getChannel(channelId: Snowflake): CachedChannel | null;
  canServeLatestFromCache(channelId: Snowflake, limit: number): boolean;
  getCachedMessages(
    channelId: Snowflake,
    opts?: GetCachedMessagesOptions,
  ): CachedMessage[];
  upsertChannel(channel: DiscordChannel): CachedChannel;
  upsertInviteResult(invite: DiscordInvite): JoinGuildResult;
  listGuilds(): GuildSummary[];
  upsertPartialGuilds(guilds: readonly DiscordPartialGuild[]): GuildSummary[];
  hasHydratedGuildChannels(guildId: Snowflake): boolean;
  listGuildChannels(guildId: Snowflake): GuildChannelsResult | null;
  upsertGuildChannels(
    guildId: Snowflake,
    channels: readonly DiscordChannel[],
    threads?: readonly DiscordChannel[],
  ): void;
  extractChannelMembers(
    channelId: Snowflake,
    limit?: number,
  ): ChannelMemberSummary[];
  findDmChannelByUserId(userId: Snowflake): CachedChannel | null;
  listDmChannels(): DmChannelSummary[];
  upsertDmChannels(channels: readonly DiscordChannel[]): DmChannelSummary[];
  mergeRestMessages(
    channelId: Snowflake,
    messages: readonly DiscordMessage[],
    isLatestTail: boolean,
  ): CachedMessage[];
  markChannelRead(
    channelId: Snowflake,
    upToMessageId?: Snowflake,
  ): Snowflake | null;
  normalizeMessage(message: DiscordMessage): CachedMessage;
  subscribeWatch(
    channelId: Snowflake,
    listener: (event: WatchEvent) => void,
    eventsFilter?: readonly WatchEventType[] | null,
    options?: WatchSubscribeOptions,
  ): () => void;
  readonly restHydratedChannels?: Set<Snowflake>;
}

export interface IpcServerRestClient {
  getAuthMode?(): DiscordAuthMode;
  getChannel(channelId: Snowflake): Promise<DiscordChannel>;
  getChannelMessages(
    channelId: Snowflake,
    opts?: GetChannelMessagesOptions,
  ): Promise<DiscordMessage[]>;
  createMessage(
    channelId: Snowflake,
    body: DiscordCreateMessageBody,
  ): Promise<DiscordMessage>;
  addReaction(
    channelId: Snowflake,
    messageId: Snowflake,
    emoji: string,
  ): Promise<void>;
  removeOwnReaction(
    channelId: Snowflake,
    messageId: Snowflake,
    emoji: string,
  ): Promise<void>;
  acceptInvite(code: string): Promise<DiscordInvite>;
  getCurrentUserGuilds(): Promise<DiscordPartialGuild[]>;
  getGuildChannels(guildId: Snowflake): Promise<DiscordChannel[]>;
  getGuildActiveThreads(
    guildId: Snowflake,
  ): Promise<DiscordActiveThreadsResponse>;
  getUserDms(): Promise<DiscordChannel[]>;
  createDm(recipientId: Snowflake): Promise<DiscordChannel>;
  triggerTyping(channelId: Snowflake): Promise<void>;
}

export interface IpcServerRateLimiter {
  getStatusSnapshot(): RateLimitStatusSnapshot;
}

export interface IpcServerGateway {
  getStatusSnapshot(): GatewayStatusSnapshot;
}

export interface DaemonIpcServerOptions {
  host?: string;
  port: number;
  authMode?: DiscordAuthMode;
  autoTyping?: boolean;
  stateCache: IpcServerStateCache;
  restClient: IpcServerRestClient;
  rateLimiter: IpcServerRateLimiter;
  gateway: IpcServerGateway;
  startedAt?: IsoTimestamp;
  onStopRequested?: () => void | Promise<void>;
  log?: (msg: string) => void;
  maxBodyBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type DaemonIpcServerDeps = DaemonIpcServerOptions;

export interface DaemonIpcListenInfo {
  host: string;
  port: number;
}

class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds maximum allowed size of ${maxBytes} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

class RequestValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RequestValidationError";
  }
}

function assertLoopbackBindHost(rawHost: string | undefined): string {
  const host = (rawHost ?? DEFAULT_IPC_HOST).trim();
  const normalized = host.toLowerCase();
  if (normalized !== "127.0.0.1" && normalized !== "localhost") {
    throw new RangeError(
      `Refusing to bind IPC server to non-loopback host "${host}". Expected "127.0.0.1" or "localhost".`,
    );
  }
  return host;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findAllowedMethodsForPath(
  pathname: string,
): readonly HttpMethodValue[] | null {
  return getAllowedMethodsForIpcPath(pathname);
}

function parseRequestUrl(rawUrl: string | undefined): URL {
  const target = rawUrl ?? "/";
  // Prevent protocol-relative `//host/path` from overriding pathname host semantics.
  if (target.startsWith("//")) {
    return new URL(`http://127.0.0.1${target}`);
  }
  return new URL(target, "http://127.0.0.1");
}

function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  allowEmpty: boolean,
): Promise<unknown> {
  const contentLengthHeader = req.headers["content-length"];
  if (typeof contentLengthHeader === "string") {
    const declaredLength = Number(contentLengthHeader);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxBodyBytes
    ) {
      return Promise.reject(new PayloadTooLargeError(maxBodyBytes));
    }
  }

  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };

    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBodyBytes) {
        fail(new PayloadTooLargeError(maxBodyBytes));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      const rawText = Buffer.concat(chunks, totalBytes).toString("utf8").trim();
      if (rawText.length === 0) {
        resolve(allowEmpty ? {} : undefined);
        return;
      }

      try {
        resolve(JSON.parse(rawText) as unknown);
      } catch (err) {
        reject(
          new RequestValidationError(
            `Invalid JSON request body: ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        );
      }
    };

    const onError = (err: Error): void => {
      fail(err);
    };

    const onAborted = (): void => {
      fail(new Error("Request body stream was aborted by client."));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function writeJsonResponse<T>(
  res: ServerResponse,
  status: number,
  body: T,
  extraHeaders?: Record<string, string>,
  onFlushed?: () => void,
): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  const serialized = serializeJsonEnvelope(
    body as Parameters<typeof serializeJsonEnvelope>[0],
  );
  const headers: Record<string, string | number> = {
    [IpcHeaders.CONTENT_TYPE]: IpcContentType.JSON,
    "Content-Length": Buffer.byteLength(serialized, "utf8"),
    ...extraHeaders,
  };

  res.writeHead(status, headers);
  if (onFlushed !== undefined) {
    let fired = false;
    const fireOnce = (): void => {
      if (fired) {
        return;
      }
      fired = true;
      onFlushed();
    };
    res.once("finish", fireOnce);
    res.end(serialized, fireOnce);
  } else {
    res.end(serialized);
  }
}

function sendErrorResponse(
  res: ServerResponse,
  payload: IpcErrorPayload,
  extraHeaders?: Record<string, string>,
  onFlushed?: () => void,
): void {
  writeJsonResponse(
    res,
    payload.status,
    errorEnvelope(payload),
    extraHeaders,
    onFlushed,
  );
}

function mapErrorToIpcPayload(err: unknown): {
  payload: IpcErrorPayload;
  extraHeaders?: Record<string, string>;
  destroyReqAfterSend?: boolean;
} {
  if (err instanceof PayloadTooLargeError) {
    return {
      payload: createIpcError(IpcErrorCode.BAD_REQUEST, err.message, 413),
      extraHeaders: { Connection: "close" },
      destroyReqAfterSend: true,
    };
  }

  if (err instanceof RequestValidationError) {
    return {
      payload: formatHttpErrorForCode(IpcErrorCode.BAD_REQUEST, err.message),
    };
  }

  if (err instanceof DiscordRestError) {
    if (err.isRateLimit) {
      const payload = createIpcError(
        IpcErrorCode.RATE_LIMITED,
        err.message,
        HttpStatus.TOO_MANY_REQUESTS,
        {
          discordCode: err.discordCode,
          retryAfterMs: err.retryAfterMs,
          details: err.body,
        },
      );
      const extraHeaders =
        err.retryAfterMs !== undefined
          ? { "Retry-After": String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))) }
          : undefined;
      return { payload, extraHeaders };
    }

    const details =
      err.body !== undefined
        ? { httpStatus: err.httpStatus, body: err.body }
        : { httpStatus: err.httpStatus };
    return {
      payload: createIpcError(
        IpcErrorCode.DISCORD_API_ERROR,
        err.message,
        HttpStatus.BAD_GATEWAY,
        {
          discordCode: err.discordCode,
          details,
        },
      ),
    };
  }

  if (err instanceof RateLimitError) {
    return {
      payload: createIpcError(
        IpcErrorCode.RATE_LIMITED,
        err.message,
        HttpStatus.TOO_MANY_REQUESTS,
        {
          discordCode: err.discordCode,
          retryAfterMs: err.retryAfterMs,
          details: err.body,
        },
      ),
      extraHeaders: {
        "Retry-After": String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))),
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    payload: formatHttpErrorForCode(IpcErrorCode.INTERNAL_ERROR, message),
  };
}

export class DaemonIpcServer {
  readonly host: string;
  readonly port: number;

  private readonly authMode?: DiscordAuthMode;
  private readonly autoTyping: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stateCache: IpcServerStateCache;
  private readonly restClient: IpcServerRestClient;
  private readonly rateLimiter: IpcServerRateLimiter;
  private readonly gateway: IpcServerGateway;
  private readonly startedAt: IsoTimestamp;
  private readonly startedAtMs: number;
  private readonly onStopRequested?: () => void | Promise<void>;
  private readonly log?: (msg: string) => void;
  private readonly maxBodyBytes: number;

  private server: http.Server | null = null;
  private boundPort: number | null = null;
  private startPromise: Promise<DaemonIpcListenInfo> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly activeWatchers = new Set<() => void>();

  constructor(options: DaemonIpcServerOptions) {
    this.host = assertLoopbackBindHost(options.host);
    this.port = parsePortValue(options.port, "port");
    this.authMode = options.authMode;
    this.autoTyping = options.autoTyping ?? DEFAULT_AUTO_TYPING_ENABLED;
    this.sleep = options.sleep ?? defaultSleep;

    this.stateCache = options.stateCache;
    this.restClient = options.restClient;
    this.rateLimiter = options.rateLimiter;
    this.gateway = options.gateway;
    this.startedAt = options.startedAt ?? new Date().toISOString();
    const parsedStartedAt = Date.parse(this.startedAt);
    this.startedAtMs = Number.isFinite(parsedStartedAt)
      ? parsedStartedAt
      : Date.now();
    this.onStopRequested = options.onStopRequested;
    this.log = options.log;

    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_IPC_BODY_BYTES;
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new RangeError(
        `Invalid maxBodyBytes "${String(maxBodyBytes)}": expected a positive integer.`,
      );
    }
    this.maxBodyBytes = maxBodyBytes;
  }

  getAddress(): DaemonIpcListenInfo | null {
    if (this.server === null || this.boundPort === null) {
      return null;
    }
    return {
      host: this.host,
      port: this.boundPort,
    };
  }

  async start(): Promise<DaemonIpcListenInfo> {
    if (this.stopPromise !== null) {
      await this.stopPromise;
    }
    if (this.server !== null && this.boundPort !== null) {
      return {
        host: this.host,
        port: this.boundPort,
      };
    }
    if (this.startPromise !== null) {
      return this.startPromise;
    }

    this.startPromise = new Promise<DaemonIpcListenInfo>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      const onStartupError = (err: Error): void => {
        server.off("listening", onListening);
        this.server = null;
        this.boundPort = null;
        this.startPromise = null;
        reject(err);
      };

      const onListening = (): void => {
        server.off("error", onStartupError);
        server.on("error", (err: Error) => {
          this.log?.(`IPC HTTP server error: ${err.message}`);
        });

        const address = server.address();
        if (address === null || typeof address === "string") {
          this.server = null;
          this.boundPort = null;
          this.startPromise = null;
          server.close();
          reject(new Error("Failed to determine bound IPC server address."));
          return;
        }

        this.server = server;
        this.boundPort = address.port;
        this.startPromise = null;
        resolve({
          host: this.host,
          port: address.port,
        });
      };

      server.once("error", onStartupError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }

    this.stopPromise = this.performStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.startPromise !== null) {
      try {
        await this.startPromise;
      } catch {
        // Ignore startup failure during teardown.
      }
    }

    for (const closeWatcher of Array.from(this.activeWatchers)) {
      try {
        closeWatcher();
      } catch {
        // Ignore watcher teardown errors.
      }
    }
    this.activeWatchers.clear();

    const server = this.server;
    this.server = null;
    this.boundPort = null;

    if (server === null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const fallbackTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        server.closeAllConnections?.();
        resolve();
      }, DEFAULT_STOP_CLOSE_TIMEOUT_MS);
      fallbackTimer.unref?.();

      server.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(fallbackTimer);
        resolve();
      });

      server.closeIdleConnections?.();
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!isAllowedLoopbackHostHeader(req.headers.host)) {
        sendErrorResponse(
          res,
          createIpcError(
            "FORBIDDEN",
            "Forbidden Host header: only loopback hosts are allowed.",
            HttpStatus.FORBIDDEN,
          ),
        );
        return;
      }

      let url: URL;
      try {
        url = parseRequestUrl(req.url);
      } catch (err) {
        sendErrorResponse(
          res,
          formatHttpErrorForCode(
            IpcErrorCode.BAD_REQUEST,
            `Malformed request URL: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      const method = (req.method ?? "GET").toUpperCase();
      const matched = matchIpcRoute(method, url.pathname);
      if (matched === null) {
        const allowedMethods = findAllowedMethodsForPath(url.pathname);
        if (allowedMethods !== null) {
          sendErrorResponse(
            res,
            formatHttpErrorForCode(
              IpcErrorCode.METHOD_NOT_ALLOWED,
              `Method ${method} is not allowed for ${url.pathname}.`,
            ),
            { Allow: allowedMethods.join(", ") },
          );
          return;
        }

        sendErrorResponse(
          res,
          formatHttpErrorForCode(
            IpcErrorCode.NOT_FOUND,
            `IPC route not found: ${method} ${url.pathname}.`,
          ),
        );
        return;
      }

      await this.dispatchMatchedRoute(matched, url, req, res);
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }

      const mapped = mapErrorToIpcPayload(err);
      sendErrorResponse(
        res,
        mapped.payload,
        mapped.extraHeaders,
        mapped.destroyReqAfterSend
          ? () => {
              if (!req.destroyed) {
                req.destroy();
              }
            }
          : undefined,
      );
    }
  }

  private async dispatchMatchedRoute(
    matched: MatchedIpcRoute,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    switch (matched.route) {
      case "status": {
        const gateway = this.gateway.getStatusSnapshot();
        const authMode =
          this.authMode ??
          this.restClient.getAuthMode?.() ??
          gateway.authMode;
        const status: DaemonStatusResult = {
          pid: process.pid,
          startedAt: this.startedAt,
          uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
          host: this.host,
          port: this.boundPort ?? this.port,
          ...(authMode !== undefined ? { authMode } : {}),
          gateway,
          botUser: this.stateCache.getBotUser(),
          cache: this.stateCache.getCacheSnapshot(),
          rateLimits: this.rateLimiter.getStatusSnapshot(),
        };
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(status));
        return;
      }

      case "invites_join": {
        const rawBody = await readJsonBody(req, this.maxBodyBytes, false);
        let parsedReq: JoinGuildRequest;
        try {
          parsedReq = validateJoinGuildRequest(rawBody);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const result = await this.handleJoinGuild(parsedReq);
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "guilds": {
        const result = await this.handleListGuilds();
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "guild_channels": {
        const result = await this.handleGuildChannels(matched.guildId);
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "channel_members": {
        let query: ChannelMembersQuery;
        try {
          query = parseChannelMembersQuery(url.searchParams);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const result = await this.handleChannelMembers(
          matched.channelId,
          query,
        );
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "dms_list": {
        const result = await this.handleListDms();
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "dm_send": {
        const rawBody = await readJsonBody(req, this.maxBodyBytes, false);
        let parsedReq: DirectMessageRequest;
        try {
          parsedReq = validateDirectMessageRequest(rawBody);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const result = await this.handleSendDirectMessage(parsedReq);
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "unread": {
        let query: UnreadQuery;
        try {
          query = parseUnreadQuery(url.searchParams);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const unread: UnreadResult = this.stateCache.getUnread(query);
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(unread));
        return;
      }

      case "channel_read": {
        const rawBody = await readJsonBody(req, this.maxBodyBytes, true);
        let parsedReq: ReadMessagesRequest;
        try {
          parsedReq = validateReadMessagesRequest(rawBody);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const result = await this.handleChannelRead(
          matched.channelId,
          parsedReq,
        );
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "channel_messages": {
        const rawBody = await readJsonBody(req, this.maxBodyBytes, false);
        let parsedReq: SendMessageRequest;
        try {
          parsedReq = validateSendMessageRequest(rawBody);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const result = await this.handleSendMessage(
          matched.channelId,
          parsedReq,
        );
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "message_reactions": {
        const rawBody = await readJsonBody(req, this.maxBodyBytes, false);
        let parsedReq: ReactMessageRequest;
        try {
          parsedReq = validateReactMessageRequest(rawBody);
          normalizeEmojiForRest(parsedReq.emoji);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        const result = await this.handleReactMessage(
          matched.channelId,
          matched.messageId,
          parsedReq,
        );
        writeJsonResponse(res, HttpStatus.OK, okEnvelope(result));
        return;
      }

      case "channel_watch": {
        let eventsFilter: WatchEventType[] | null;
        try {
          eventsFilter = parseWatchEventsQuery(url.searchParams);
        } catch (err) {
          throw new RequestValidationError(
            err instanceof Error ? err.message : String(err),
            err,
          );
        }
        this.handleChannelWatch(matched.channelId, eventsFilter, req, res);
        return;
      }

      case "daemon_stop": {
        await readJsonBody(req, this.maxBodyBytes, true);
        const stopResult: DaemonStopResult = {
          stopping: true,
          pid: process.pid,
        };
        writeJsonResponse(
          res,
          HttpStatus.OK,
          okEnvelope(stopResult),
          { Connection: "close" },
          () => {
            if (this.onStopRequested !== undefined) {
              setImmediate(() => {
                Promise.resolve(this.onStopRequested?.()).catch(
                  (err: unknown) => {
                    this.log?.(
                      `Error during onStopRequested callback: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  },
                );
              });
            }
          },
        );
        return;
      }
    }
  }

  private async handleChannelRead(
    channelId: Snowflake,
    req: ReadMessagesRequest,
  ): Promise<ReadMessagesResult> {
    const limit = req.limit ?? DEFAULT_READ_LIMIT;
    const isLatestTail = req.before === undefined && req.after === undefined;

    const cachedChannel = this.stateCache.getChannel(channelId);
    if (
      isLatestTail &&
      cachedChannel !== null &&
      this.stateCache.canServeLatestFromCache(channelId, limit)
    ) {
      const messages = this.stateCache.getCachedMessages(channelId, { limit });
      let markedReadUpTo: Snowflake | null = null;
      if (req.markRead === true) {
        const newestId =
          messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
        markedReadUpTo = this.stateCache.markChannelRead(channelId, newestId);
      }
      return {
        channel: cachedChannel,
        messages,
        source: "cache",
        markedReadUpTo,
      };
    }

    const restOpts: GetChannelMessagesOptions = { limit };
    if (req.before !== undefined) {
      restOpts.before = req.before;
    }
    if (req.after !== undefined) {
      restOpts.after = req.after;
    }

    const rawMessages = await this.restClient.getChannelMessages(
      channelId,
      restOpts,
    );

    let channel = await this.ensureChannelInCache(channelId, rawMessages);
    const messages = this.stateCache.mergeRestMessages(
      channelId,
      rawMessages,
      isLatestTail,
    );
    channel = this.stateCache.getChannel(channelId) ?? channel;

    let markedReadUpTo: Snowflake | null = null;
    if (req.markRead === true) {
      const newestId =
        messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
      markedReadUpTo = this.stateCache.markChannelRead(channelId, newestId);
    }

    return {
      channel,
      messages,
      source: "rest",
      markedReadUpTo,
    };
  }

  private async ensureChannelInCache(
    channelId: Snowflake,
    rawMessages: readonly DiscordMessage[],
  ): Promise<CachedChannel> {
    const existing = this.stateCache.getChannel(channelId);
    if (existing !== null) {
      return existing;
    }

    try {
      const fetched = await this.restClient.getChannel(channelId);
      return this.stateCache.upsertChannel(fetched);
    } catch (err) {
      this.log?.(
        `Using fallback channel metadata for ${channelId} after REST getChannel failure: ${err instanceof Error ? err.message : String(err)}`,
      );
      const inferredGuildId = rawMessages.find(
        (msg) => typeof msg.guild_id === "string",
      )?.guild_id;
      let newestId: Snowflake | null = null;
      for (const msg of rawMessages) {
        if (newestId === null || compareSnowflakes(msg.id, newestId) > 0) {
          newestId = msg.id;
        }
      }
      const fallbackChannel: DiscordChannel = {
        id: channelId,
        type:
          inferredGuildId !== undefined
            ? DiscordChannelType.GUILD_TEXT
            : DiscordChannelType.DM,
        name: inferredGuildId !== undefined ? channelId : `dm-${channelId}`,
        ...(inferredGuildId !== undefined ? { guild_id: inferredGuildId } : {}),
        ...(newestId !== null ? { last_message_id: newestId } : {}),
      };
      return this.stateCache.upsertChannel(fallbackChannel);
    }
  }

  private async handleJoinGuild(
    req: JoinGuildRequest,
  ): Promise<JoinGuildResult> {
    const invite = await this.restClient.acceptInvite(req.invite);
    return this.stateCache.upsertInviteResult(invite);
  }

  private async handleListGuilds(): Promise<GuildsResult> {
    const cached: GuildSummary[] = this.stateCache.listGuilds();
    if (cached.length > 0 && cached.every((g) => g.name.trim().length > 0)) {
      return {
        totalGuilds: cached.length,
        guilds: cached,
        source: "cache",
      };
    }

    const partialGuilds = await this.restClient.getCurrentUserGuilds();
    const guilds = this.stateCache.upsertPartialGuilds(partialGuilds);
    return {
      totalGuilds: guilds.length,
      guilds,
      source: "rest",
    };
  }

  private async handleGuildChannels(
    guildId: Snowflake,
  ): Promise<GuildChannelsResult> {
    if (this.stateCache.hasHydratedGuildChannels(guildId)) {
      const cached = this.stateCache.listGuildChannels(guildId);
      if (cached !== null) {
        return {
          ...cached,
          source: "cache",
        };
      }
    }

    const channels = await this.restClient.getGuildChannels(guildId);
    let threads: DiscordChannel[] | undefined;
    try {
      const activeThreads =
        await this.restClient.getGuildActiveThreads(guildId);
      threads = activeThreads.threads;
    } catch (err) {
      if (
        err instanceof DiscordRestError &&
        (err.httpStatus === 403 || err.httpStatus === 404)
      ) {
        this.log?.(
          `Skipping active threads for guild ${guildId}: ${err.message}`,
        );
      } else {
        throw err;
      }
    }

    this.stateCache.upsertGuildChannels(guildId, channels, threads);
    const refreshed = this.stateCache.listGuildChannels(guildId);
    if (refreshed !== null) {
      return {
        ...refreshed,
        source: "rest",
      };
    }

    return {
      guildId,
      guildName: null,
      totalChannels: 0,
      channels: [],
      categories: [],
      threads: [],
      source: "rest",
    };
  }

  private async handleChannelMembers(
    channelId: Snowflake,
    query: ChannelMembersQuery,
  ): Promise<ChannelMembersResult> {
    const limit = query.limit ?? DEFAULT_CHANNEL_MEMBERS_LIMIT;
    const fetchLimit = Math.min(limit, MAX_DISCORD_READ_LIMIT);
    const canServeCache = this.stateCache.canServeLatestFromCache(
      channelId,
      fetchLimit,
    );

    let source: ChannelMembersResult["source"];
    if (canServeCache) {
      source = "cache";
    } else {
      const existingMembers = this.stateCache.extractChannelMembers(
        channelId,
        limit,
      );
      const rawMessages = await this.restClient.getChannelMessages(channelId, {
        limit: fetchLimit,
      });
      await this.ensureChannelInCache(channelId, rawMessages);
      this.stateCache.mergeRestMessages(channelId, rawMessages, true);
      source = existingMembers.length > 0 ? "mixed" : "rest";
    }

    const channel = this.stateCache.getChannel(channelId);
    const members = this.stateCache.extractChannelMembers(channelId, limit);
    return {
      channelId,
      guildId: channel?.guildId ?? null,
      totalMembers: members.length,
      members,
      source,
    };
  }

  private async handleListDms(): Promise<DmChannelsResult> {
    const cached = this.stateCache.listDmChannels();
    if (cached.length > 0) {
      return {
        totalDms: cached.length,
        dms: cached,
        source: "cache",
      };
    }

    const rawDms = await this.restClient.getUserDms();
    const upserted = this.stateCache.upsertDmChannels(rawDms);
    const listed = this.stateCache.listDmChannels();
    const dms = listed.length > 0 ? listed : upserted;
    return {
      totalDms: dms.length,
      dms,
      source: "rest",
    };
  }

  private async handleSendDirectMessage(
    req: DirectMessageRequest,
  ): Promise<DirectMessageResult> {
    let dmChannel = this.stateCache.findDmChannelByUserId(req.userId);
    if (dmChannel === null) {
      const createdDm = await this.restClient.createDm(req.userId);
      const hasRecipientIds =
        "recipient_ids" in createdDm &&
        Array.isArray(
          (createdDm as { recipient_ids?: unknown }).recipient_ids,
        ) &&
        (createdDm as { recipient_ids: unknown[] }).recipient_ids.length > 0;
      const dmToCache: DiscordChannel =
        (createdDm.recipients === undefined ||
          createdDm.recipients.length === 0) &&
        !hasRecipientIds
          ? ({
              ...createdDm,
              recipient_ids: [req.userId],
            } as DiscordChannel)
          : createdDm;
      dmChannel = this.stateCache.upsertChannel(dmToCache);
    }

    const message = await this.sendChannelMessageWithOptionalTyping(
      dmChannel.id,
      { content: req.content },
      req.typing,
    );
    const channel = this.stateCache.getChannel(dmChannel.id) ?? dmChannel;
    return { channel, message };
  }

  private async sendChannelMessageWithOptionalTyping(
    channelId: Snowflake,
    body: DiscordCreateMessageBody,
    typingOverride?: boolean,
  ): Promise<CachedMessage> {
    const shouldType = typingOverride ?? this.autoTyping;
    if (shouldType) {
      await this.restClient.triggerTyping(channelId);
      const delayMs = calculateTypingDelayMs(body.content ?? "");
      await this.sleep(delayMs);
    }

    const created = await this.restClient.createMessage(channelId, body);

    // Store in message buffer without incrementing unread count for own sent message
    // and without marking an unhydrated channel as fully REST-hydrated.
    const wasHydrated =
      this.stateCache.restHydratedChannels?.has(channelId) ?? false;
    const merged = this.stateCache.mergeRestMessages(
      channelId,
      [created],
      true,
    );
    if (!wasHydrated) {
      this.stateCache.restHydratedChannels?.delete(channelId);
    }

    return merged[0] ?? this.stateCache.normalizeMessage(created);
  }

  private async handleSendMessage(
    channelId: Snowflake,
    req: SendMessageRequest,
  ): Promise<SendMessageResult> {
    const body: DiscordCreateMessageBody = {
      content: req.content,
    };
    if (req.replyToMessageId !== undefined) {
      body.message_reference = {
        message_id: req.replyToMessageId,
      };
    }

    const message = await this.sendChannelMessageWithOptionalTyping(
      channelId,
      body,
      req.typing,
    );
    return { message };
  }

  private async handleReactMessage(
    channelId: Snowflake,
    messageId: Snowflake,
    req: ReactMessageRequest,
  ): Promise<ReactMessageResult> {
    if (req.remove === true) {
      await this.restClient.removeOwnReaction(channelId, messageId, req.emoji);
      return {
        channelId,
        messageId,
        emoji: req.emoji,
        action: "removed",
      };
    }

    await this.restClient.addReaction(channelId, messageId, req.emoji);
    return {
      channelId,
      messageId,
      emoji: req.emoji,
      action: "added",
    };
  }

  private handleChannelWatch(
    channelId: Snowflake,
    eventsFilter: readonly WatchEventType[] | null,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    req.setTimeout?.(0);
    res.setTimeout?.(0);

    res.writeHead(HttpStatus.OK, {
      [IpcHeaders.CONTENT_TYPE]: IpcContentType.NDJSON,
      [IpcHeaders.CACHE_CONTROL]: "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    let cleanedUp = false;
    let unsubscribe: (() => void) | null = null;

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      this.activeWatchers.delete(closeWatcher);
      req.off("close", cleanup);
      req.off("error", cleanup);
      res.off("close", cleanup);
      res.off("error", cleanup);
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const closeWatcher = (): void => {
      cleanup();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    };

    this.activeWatchers.add(closeWatcher);
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    unsubscribe = this.stateCache.subscribeWatch(
      channelId,
      (ev: WatchEvent) => {
        if (cleanedUp || res.writableEnded || res.destroyed) {
          cleanup();
          return;
        }
        try {
          res.write(serializeNdjsonLine(ev));
        } catch {
          cleanup();
        }
      },
      eventsFilter,
      { gatewayState: this.gateway.getStatusSnapshot().state },
    );

    if (req.destroyed || res.destroyed || res.writableEnded) {
      cleanup();
    }
  }
}
