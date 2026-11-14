import zlib from "node:zlib";
import WebSocket from "ws";

import {
  DEFAULT_DISCORD_GATEWAY_URL,
  DEFAULT_GATEWAY_INTENTS,
  buildGatewayIdentifyProperties,
  buildUserModeGatewayHeaders,
  inferDiscordAuthModeFromToken,
  resolveDiscordToken,
} from "../shared/config.js";
import {
  FATAL_GATEWAY_CLOSE_CODES,
  GatewayCloseCode,
  GatewayOpcode,
  type DiscordAuthMode,
  type GatewayBotInfo,
  type GatewayConnectionState,
  type GatewayHelloData,
  type GatewayIdentifyData,
  type GatewayPayload,
  type GatewayReadyData,
  type GatewayResumeData,
  type GatewayStatusSnapshot,
  type IsoTimestamp,
} from "../shared/types.js";

const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSED = 3;

const DEFAULT_BASE_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30000;
const DEFAULT_CLOSE_FALLBACK_TIMEOUT_MS = 1000;

const SESSION_INVALIDATING_CLOSE_CODES: ReadonlySet<number> = new Set([
  GatewayCloseCode.NOT_AUTHENTICATED,
  GatewayCloseCode.ALREADY_AUTHENTICATED,
  GatewayCloseCode.INVALID_SEQ,
  GatewayCloseCode.SESSION_TIMED_OUT,
]);

export type GatewayWebSocketData = WebSocket.RawData | string;

/**
 * Minimal structural WebSocket contract satisfied by `ws.WebSocket` and unit-test mocks.
 */
export interface GatewayWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, data?: string | Buffer): void;
  terminate(): void;
  on(event: "open", listener: () => void): unknown;
  on(
    event: "message",
    listener: (data: GatewayWebSocketData, isBinary: boolean) => void,
  ): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeAllListeners?(event?: string | symbol): unknown;
}

export interface GatewayWebSocketOptions {
  headers?: Record<string, string>;
}

export interface GatewayClientOptions {
  token: string;
  authMode?: DiscordAuthMode;
  intents?: number;
  compress?: boolean;
  userAgent?: string;
  fallbackGatewayUrl?: string;
  fetchGateway?: () => Promise<{ url: string }>;
  fetchGatewayBot?: () => Promise<GatewayBotInfo>;
  onDispatch: (eventName: string, data: unknown) => void;
  onStateChange?: (state: GatewayConnectionState, detail: string | null) => void;
  createWebSocket?: (
    url: string,
    options?: GatewayWebSocketOptions,
  ) => GatewayWebSocket;
  random?: () => number;
  now?: () => number;
  log?: (msg: string) => void;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export type GatewayClientDeps = GatewayClientOptions;

function resolveGatewayAuthMode(options: GatewayClientOptions): DiscordAuthMode {
  if (options.authMode !== undefined) {
    return options.authMode;
  }
  if (inferDiscordAuthModeFromToken(options.token) === "bot") {
    return "bot";
  }
  // Preserve legacy bot-mode inference when callers pass explicit intents + fetchGatewayBot
  // without specifying authMode or fetchGateway.
  if (
    options.fetchGateway === undefined &&
    options.fetchGatewayBot !== undefined &&
    options.intents !== undefined
  ) {
    return "bot";
  }
  return "user";
}

/**
 * Builds a Discord Bot Gateway v10 WebSocket URL with `v=10`, `encoding=json`,
 * and optional `compress=zlib-stream`.
 */
export function buildGatewayWsUrl(baseUrl: string, compress: boolean): string {
  const url = new URL(baseUrl);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  if (compress) {
    url.searchParams.set("compress", "zlib-stream");
  } else {
    url.searchParams.delete("compress");
  }
  return url.toString();
}

function clampUnitRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 0.999999999999;
  }
  return value;
}

function isExplicitFallbackGatewayUrl(fallbackUrl: string): boolean {
  const trimmed = fallbackUrl.trim();
  if (trimmed.length === 0 || trimmed === DEFAULT_DISCORD_GATEWAY_URL) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    const defaultParsed = new URL(DEFAULT_DISCORD_GATEWAY_URL);
    return parsed.host.toLowerCase() !== defaultParsed.host.toLowerCase();
  } catch {
    return false;
  }
}

function isHttpUnauthorizedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const rec = err as Record<string, unknown>;
  if (
    rec["httpStatus"] === 401 ||
    rec["status"] === 401 ||
    rec["statusCode"] === 401
  ) {
    return true;
  }
  if (err instanceof Error) {
    return /\bHTTP\s+401\b|\b401\s+Unauthorized\b/i.test(err.message);
  }
  return false;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function formatFatalCloseError(
  code: number,
  reason: string,
  intents?: number,
): string {
  const suffix = reason.length > 0 ? ` (${reason})` : "";
  const intentsLabel = intents !== undefined ? String(intents) : "none";
  switch (code) {
    case GatewayCloseCode.AUTHENTICATION_FAILED:
      return `Gateway close 4004${suffix}: authentication failed. Verify DISCORD_TOKEN / DISCORD_BOT_TOKEN is valid and not revoked.`;
    case GatewayCloseCode.INVALID_SHARD:
      return `Gateway close 4010${suffix}: invalid shard configuration.`;
    case GatewayCloseCode.SHARDING_REQUIRED:
      return `Gateway close 4011${suffix}: sharding required for this bot.`;
    case GatewayCloseCode.INVALID_API_VERSION:
      return `Gateway close 4012${suffix}: invalid Gateway API version.`;
    case GatewayCloseCode.INVALID_INTENTS:
      return `Gateway close 4013${suffix}: invalid intents bitmask (${intentsLabel}). Check DISCORD_INTENTS.`;
    case GatewayCloseCode.DISALLOWED_INTENTS:
      return `Gateway close 4014${suffix}: disallowed intents (${intentsLabel}). Enable privileged intents such as MESSAGE_CONTENT (1<<15) in the Discord Developer Portal -> Bot -> Privileged Gateway Intents, or set DISCORD_INTENTS without privileged bits.`;
    default:
      return `Gateway close ${code}${suffix}: fatal unrecoverable close code.`;
  }
}

function rawDataToBuffer(data: GatewayWebSocketData): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(String(data), "utf8");
}

function endsWithZlibSyncSuffix(chunks: readonly Buffer[]): boolean {
  let needed = 4;
  const tail = [0, 0, 0, 0];
  for (let i = chunks.length - 1; i >= 0 && needed > 0; i -= 1) {
    const chunk = chunks[i]!;
    for (let j = chunk.length - 1; j >= 0 && needed > 0; j -= 1) {
      needed -= 1;
      tail[needed] = chunk[j]!;
    }
  }
  if (needed > 0) {
    return false;
  }
  return (
    tail[0] === 0x00 &&
    tail[1] === 0x00 &&
    tail[2] === 0xff &&
    tail[3] === 0xff
  );
}

/**
 * Per-connection stateful `zlib-stream` inflate pipeline.
 * Buffers multi-frame payloads until the `0x00 0x00 0xff 0xff` sync flush suffix
 * and serializes `inflate.write` + `Z_SYNC_FLUSH` calls so consecutive messages never interleave.
 */
class PerConnectionZlibDecoder {
  private readonly inflate: zlib.Inflate;
  private pendingChunks: Buffer[] = [];
  private queue: Promise<void> = Promise.resolve();
  private inFlightCount = 0;
  private closed = false;

  constructor() {
    this.inflate = zlib.createInflate();
    this.inflate.on("error", () => {
      // Per-message handlers report errors; persistent listener prevents unhandled error crashes.
    });
  }

  pushBinaryFrame(
    chunk: Buffer,
    onDecoded: (text: string) => void,
    onError: (err: Error) => void,
  ): void {
    if (this.closed) {
      return;
    }
    this.pendingChunks.push(chunk);
    if (!endsWithZlibSyncSuffix(this.pendingChunks)) {
      return;
    }
    const compressed =
      this.pendingChunks.length === 1
        ? this.pendingChunks[0]!
        : Buffer.concat(this.pendingChunks);
    this.pendingChunks = [];

    this.inFlightCount += 1;
    this.queue = this.queue
      .then(() => this.decompressPayload(compressed))
      .then(
        (text) => {
          this.inFlightCount -= 1;
          if (!this.closed) {
            onDecoded(text);
          }
        },
        (err: unknown) => {
          this.inFlightCount -= 1;
          if (!this.closed) {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
  }

  pushTextFrame(text: string, onDecoded: (text: string) => void): void {
    if (this.closed) {
      return;
    }
    if (this.inFlightCount === 0) {
      onDecoded(text);
      return;
    }
    this.inFlightCount += 1;
    this.queue = this.queue.then(() => {
      this.inFlightCount -= 1;
      if (!this.closed) {
        onDecoded(text);
      }
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pendingChunks = [];
    this.inflate.destroy();
  }

  private decompressPayload(compressed: Buffer): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("Zlib inflate decoder closed"));
    }
    return new Promise<string>((resolve, reject) => {
      const outputChunks: Buffer[] = [];
      let settled = false;

      const cleanup = (): void => {
        this.inflate.off("data", onData);
        this.inflate.off("error", onErr);
        this.inflate.off("close", onClose);
      };

      const onData = (chunk: Buffer): void => {
        outputChunks.push(chunk);
      };

      const onErr = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const onClose = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error("Zlib inflate stream closed before flush completed"));
      };

      this.inflate.on("data", onData);
      this.inflate.on("error", onErr);
      this.inflate.on("close", onClose);

      this.inflate.write(compressed);
      this.inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(Buffer.concat(outputChunks).toString("utf8"));
      });
    });
  }
}

/**
 * Standalone Discord API v10 WebSocket Gateway client (user and bot auth modes).
 * Decoupled from concrete REST and state-cache modules via injected callbacks.
 */
export class GatewayClient {
  readonly authMode: DiscordAuthMode;
  private readonly token: string;
  private readonly intents: number | undefined;
  private readonly compress: boolean;
  private readonly userAgent: string | undefined;
  private readonly fallbackGatewayUrl: string;
  private readonly fetchGateway: (() => Promise<{ url: string }>) | undefined;
  private readonly fetchGatewayBot: (() => Promise<GatewayBotInfo>) | undefined;
  private readonly onDispatch: (eventName: string, data: unknown) => void;
  private readonly onStateChange?: (
    state: GatewayConnectionState,
    detail: string | null,
  ) => void;
  private readonly createWebSocket: (
    url: string,
    options?: GatewayWebSocketOptions,
  ) => GatewayWebSocket;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log?: (msg: string) => void;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private state: GatewayConnectionState = "disconnected";
  private lastStateDetail: string | null = null;
  private sessionId: string | null = null;
  private seq: number | null = null;
  private gatewayUrl: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private heartbeatIntervalMs: number | null = null;
  private lastHeartbeatSentAt: number | null = null;
  private lastHeartbeatAt: IsoTimestamp | null = null;
  private lastHeartbeatAckAt: IsoTimestamp | null = null;
  private latencyMs: number | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;

  private awaitingAck = false;
  private stopped = true;
  private started = false;
  private activeConnId = 0;

  private ws: GatewayWebSocket | null = null;
  private decoder: PerConnectionZlibDecoder | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private closeWaiters: Array<() => void> = [];

  private initialHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingImmediateReconnect = false;
  private pendingInvalidSessionDelayMs: number | null = null;

  constructor(options: GatewayClientOptions) {
    const resolvedToken = resolveDiscordToken({ DISCORD_TOKEN: options.token });
    if (resolvedToken === null) {
      throw new TypeError("Discord token must not be empty.");
    }
    this.token = resolvedToken;
    this.authMode = resolveGatewayAuthMode(options);
    this.intents =
      this.authMode === "bot"
        ? (options.intents ?? DEFAULT_GATEWAY_INTENTS)
        : undefined;
    this.compress = options.compress ?? true;
    this.userAgent = options.userAgent;
    this.fallbackGatewayUrl =
      options.fallbackGatewayUrl ?? DEFAULT_DISCORD_GATEWAY_URL;
    this.fetchGateway = options.fetchGateway;
    this.fetchGatewayBot = options.fetchGatewayBot;
    this.onDispatch = options.onDispatch;
    this.onStateChange = options.onStateChange;
    this.createWebSocket =
      options.createWebSocket ??
      ((url: string, wsOptions?: GatewayWebSocketOptions) =>
        wsOptions !== undefined
          ? new WebSocket(url, wsOptions)
          : new WebSocket(url));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.baseReconnectDelayMs =
      options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  }

  getAuthMode(): DiscordAuthMode {
    return this.authMode;
  }

  getConnectionState(): GatewayConnectionState {
    return this.state;
  }

  getStatusSnapshot(): GatewayStatusSnapshot {
    return {
      state: this.state,
      authMode: this.authMode,
      sessionId: this.sessionId,
      seq: this.seq,
      gatewayUrl: this.gatewayUrl,
      resumeGatewayUrl: this.resumeGatewayUrl,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatAckAt: this.lastHeartbeatAckAt,
      latencyMs: this.latencyMs,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.stopPromise !== null) {
      await this.stopPromise;
    }
    if (this.started && !this.stopped) {
      return this.startPromise ?? Promise.resolve();
    }

    this.stopped = false;
    this.started = true;
    this.lastError = null;
    this.reconnectAttempts = 0;

    const connId = ++this.activeConnId;
    this.startPromise = this.initiateConnection(connId).finally(() => {
      if (connId === this.activeConnId) {
        this.startPromise = null;
      }
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    if (!this.started && this.stopped && this.ws === null) {
      return Promise.resolve();
    }

    this.stopPromise = this.performStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.activeConnId += 1;
    this.clearAllTimers();
    this.pendingImmediateReconnect = false;
    this.pendingInvalidSessionDelayMs = null;
    this.awaitingAck = false;

    const socket = this.ws;
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder !== null) {
      decoder.close();
    }

    if (socket === null || socket.readyState === WS_READY_STATE_CLOSED) {
      this.ws = null;
      this.setState("disconnected", "Gateway client stopped");
      return;
    }

    this.setState("disconnected", "Gateway client stopped");

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.closeFallbackTimer !== null) {
          clearTimeout(this.closeFallbackTimer);
          this.closeFallbackTimer = null;
        }
        this.ws = null;
        resolve();
      };

      this.closeWaiters.push(finish);

      this.closeFallbackTimer = setTimeout(() => {
        this.closeFallbackTimer = null;
        try {
          if (socket.readyState !== WS_READY_STATE_CLOSED) {
            socket.terminate();
          }
        } catch {
          // Ignore terminate errors on shutdown.
        }
        finish();
      }, DEFAULT_CLOSE_FALLBACK_TIMEOUT_MS);
      this.closeFallbackTimer.unref?.();

      try {
        socket.close(GatewayCloseCode.NORMAL, "Client stopping");
      } catch {
        try {
          socket.terminate();
        } catch {
          // Ignore terminate errors on shutdown.
        }
        finish();
        return;
      }

      if (socket.readyState === WS_READY_STATE_CLOSED) {
        finish();
      }
    });
  }

  private async initiateConnection(connId: number): Promise<void> {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }

    const canResume = this.canResume();
    if (canResume && this.resumeGatewayUrl !== null) {
      this.openWebSocket(connId, this.resumeGatewayUrl);
      return;
    }

    this.setState("connecting", "Bootstrapping Gateway endpoint");

    let baseUrl: string;
    if (this.authMode === "user") {
      if (this.fetchGateway !== undefined) {
        try {
          const gatewayInfo = await this.fetchGateway();
          if (this.stopped || connId !== this.activeConnId) {
            return;
          }
          if (
            typeof gatewayInfo?.url !== "string" ||
            gatewayInfo.url.trim().length === 0
          ) {
            throw new Error(
              "Discord /gateway response did not include a valid url.",
            );
          }
          baseUrl = gatewayInfo.url;
        } catch (err) {
          if (this.stopped || connId !== this.activeConnId) {
            return;
          }

          if (isHttpUnauthorizedError(err)) {
            const detail =
              "Discord REST authentication failed (HTTP 401): invalid or revoked token.";
            this.lastError = detail;
            this.logMessage(detail);
            this.setState("fatal", detail);
            return;
          }

          const errMsg = formatErrorMessage(err);
          this.logMessage(
            `fetchGateway failed (${errMsg}); falling back to gateway URL (${this.fallbackGatewayUrl}).`,
          );
          baseUrl = this.fallbackGatewayUrl;
        }
      } else {
        baseUrl = this.fallbackGatewayUrl;
      }
    } else if (this.fetchGatewayBot !== undefined) {
      try {
        const botInfo = await this.fetchGatewayBot();
        if (this.stopped || connId !== this.activeConnId) {
          return;
        }

        if (
          botInfo.session_start_limit.remaining <= 0 &&
          botInfo.session_start_limit.reset_after > 0
        ) {
          const waitMs = Math.max(1, botInfo.session_start_limit.reset_after);
          const detail = `Gateway session_start_limit exhausted; waiting ${waitMs}ms for reset`;
          this.lastError = detail;
          this.logMessage(detail);
          this.setState("reconnecting", detail);
          this.scheduleDirectConnect(connId, botInfo.url, waitMs);
          return;
        }

        baseUrl = botInfo.url;
      } catch (err) {
        if (this.stopped || connId !== this.activeConnId) {
          return;
        }

        if (isHttpUnauthorizedError(err)) {
          const detail =
            "Discord REST authentication failed (HTTP 401): invalid or revoked bot token.";
          this.lastError = detail;
          this.logMessage(detail);
          this.setState("fatal", detail);
          return;
        }

        const errMsg = formatErrorMessage(err);
        if (isExplicitFallbackGatewayUrl(this.fallbackGatewayUrl)) {
          this.logMessage(
            `fetchGatewayBot failed (${errMsg}); falling back to configured gateway URL.`,
          );
          baseUrl = this.fallbackGatewayUrl;
        } else {
          this.lastError = `Failed to bootstrap Gateway endpoint: ${errMsg}`;
          this.logMessage(this.lastError);
          const delayMs = this.computeBackoffDelayMs(this.reconnectAttempts);
          this.reconnectAttempts += 1;
          this.setState(
            "reconnecting",
            `Gateway bootstrap failed; retrying in ${delayMs}ms`,
          );
          this.scheduleReconnect(connId, delayMs);
          return;
        }
      }
    } else {
      baseUrl = this.fallbackGatewayUrl;
    }

    if (this.stopped || connId !== this.activeConnId) {
      return;
    }
    this.openWebSocket(connId, baseUrl);
  }

  private openWebSocket(connId: number, baseUrl: string): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }

    let wsUrl: string;
    try {
      wsUrl = buildGatewayWsUrl(baseUrl, this.compress);
    } catch (err) {
      const msg = formatErrorMessage(err);
      this.lastError = `Invalid Gateway URL: ${msg}`;
      this.logMessage(this.lastError);
      const delayMs = this.computeBackoffDelayMs(this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.setState("reconnecting", this.lastError);
      this.scheduleReconnect(connId, delayMs);
      return;
    }

    this.gatewayUrl = wsUrl;
    this.pendingImmediateReconnect = false;
    this.pendingInvalidSessionDelayMs = null;
    this.awaitingAck = false;
    this.clearHeartbeatTimers();
    this.setState("connecting", `Connecting to ${wsUrl}`);

    let socket: GatewayWebSocket;
    try {
      const wsOptions: GatewayWebSocketOptions | undefined =
        this.authMode === "user"
          ? { headers: buildUserModeGatewayHeaders(this.userAgent) }
          : undefined;
      socket =
        wsOptions !== undefined
          ? this.createWebSocket(wsUrl, wsOptions)
          : this.createWebSocket(wsUrl);
    } catch (err) {
      const msg = formatErrorMessage(err);
      this.lastError = `WebSocket creation failed: ${msg}`;
      this.logMessage(this.lastError);
      const delayMs = this.computeBackoffDelayMs(this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.setState("reconnecting", this.lastError);
      this.scheduleReconnect(connId, delayMs);
      return;
    }

    const decoder = this.compress ? new PerConnectionZlibDecoder() : null;
    this.ws = socket;
    this.decoder = decoder;

    let closeHandled = false;
    let connHadError = false;

    socket.on("open", () => {
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }
      this.logMessage("Gateway WebSocket connected");
    });

    socket.on("message", (data: GatewayWebSocketData, isBinary: boolean) => {
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }

      if (!this.compress || !isBinary || typeof data === "string") {
        const text =
          typeof data === "string"
            ? data
            : rawDataToBuffer(data).toString("utf8");
        if (decoder !== null) {
          decoder.pushTextFrame(text, (decoded) => {
            this.handleRawJsonText(connId, decoded);
          });
        } else {
          this.handleRawJsonText(connId, text);
        }
        return;
      }

      const chunk = rawDataToBuffer(data);
      decoder?.pushBinaryFrame(
        chunk,
        (decoded) => {
          this.handleRawJsonText(connId, decoded);
        },
        (err) => {
          this.handleDecodeError(connId, "zlib inflate error", err);
        },
      );
    });

    socket.on("error", (err: Error) => {
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }
      connHadError = true;
      this.lastError = err.message;
      this.logMessage(`Gateway WebSocket error: ${err.message}`);
    });

    socket.on("close", (code: number, reasonBuf: Buffer) => {
      if (closeHandled) {
        return;
      }
      closeHandled = true;
      const reason =
        reasonBuf instanceof Buffer
          ? reasonBuf.toString("utf8")
          : String(reasonBuf ?? "");
      this.handleSocketClose(
        connId,
        socket,
        decoder,
        code,
        reason,
        connHadError,
      );
    });
  }

  private handleDecodeError(
    connId: number,
    prefix: string,
    err: unknown,
  ): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }
    const msg = `${prefix}: ${formatErrorMessage(err)}`;
    this.lastError = msg;
    this.logMessage(msg);
    this.closeSocketForReconnect(connId, GatewayCloseCode.DECODE_ERROR, prefix);
  }

  private handleRawJsonText(connId: number, text: string): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.handleDecodeError(connId, "Gateway JSON parse error", err);
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["op"] !== "number"
    ) {
      this.handleDecodeError(
        connId,
        "Malformed Gateway payload",
        new Error("Missing numeric op field"),
      );
      return;
    }

    const payload = parsed as GatewayPayload;
    this.handleGatewayPayload(connId, payload);
  }

  private handleGatewayPayload(
    connId: number,
    payload: GatewayPayload,
  ): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }

    switch (payload.op) {
      case GatewayOpcode.HELLO: {
        const hello = payload.d as GatewayHelloData | null | undefined;
        const interval = hello?.heartbeat_interval;
        if (
          typeof interval !== "number" ||
          !Number.isFinite(interval) ||
          interval <= 0
        ) {
          this.handleDecodeError(
            connId,
            "Invalid HELLO payload",
            new Error("heartbeat_interval must be a positive number"),
          );
          return;
        }
        this.heartbeatIntervalMs = interval;
        this.awaitingAck = false;
        this.startHeartbeatLoop(connId, interval);

        if (
          this.sessionId !== null &&
          this.seq !== null &&
          this.resumeGatewayUrl !== null
        ) {
          this.setState("resuming", "Sending Op 6 RESUME");
          this.sendPayload(connId, {
            op: GatewayOpcode.RESUME,
            d: {
              token: this.token,
              session_id: this.sessionId,
              seq: this.seq,
            } satisfies GatewayResumeData,
          });
        } else {
          this.sendIdentify(connId);
        }
        break;
      }

      case GatewayOpcode.HEARTBEAT: {
        this.sendHeartbeatReply(connId);
        break;
      }

      case GatewayOpcode.HEARTBEAT_ACK: {
        const nowMs = this.now();
        this.awaitingAck = false;
        this.lastHeartbeatAckAt = new Date(nowMs).toISOString();
        if (this.lastHeartbeatSentAt !== null) {
          this.latencyMs = Math.max(0, nowMs - this.lastHeartbeatSentAt);
        }
        break;
      }

      case GatewayOpcode.DISPATCH: {
        if (payload.s !== null && typeof payload.s === "number") {
          if (this.seq === null || payload.s > this.seq) {
            this.seq = payload.s;
          }
        }

        const eventName = payload.t;
        if (eventName === "READY") {
          const ready = payload.d as Partial<GatewayReadyData> | null | undefined;
          if (
            typeof ready?.session_id === "string" &&
            ready.session_id.length > 0
          ) {
            this.sessionId = ready.session_id;
          }
          if (
            typeof ready?.resume_gateway_url === "string" &&
            ready.resume_gateway_url.length > 0
          ) {
            this.resumeGatewayUrl = ready.resume_gateway_url;
          }
          this.reconnectAttempts = 0;
          this.lastError = null;
          this.setState("ready", "Gateway session ready");
        } else if (eventName === "RESUMED") {
          this.reconnectAttempts = 0;
          this.lastError = null;
          this.setState("ready", "Gateway session resumed");
        }

        if (typeof eventName === "string" && eventName.length > 0) {
          try {
            this.onDispatch(eventName, payload.d);
          } catch (err) {
            this.logMessage(
              `Gateway dispatch handler error for ${eventName}: ${formatErrorMessage(err)}`,
            );
          }
        }
        break;
      }

      case GatewayOpcode.RECONNECT: {
        this.pendingImmediateReconnect = true;
        this.clearHeartbeatTimers();
        this.setState(
          "reconnecting",
          "Gateway requested immediate reconnect (Op 7)",
        );
        this.closeSocketForReconnect(
          connId,
          GatewayCloseCode.UNKNOWN_ERROR,
          "Gateway requested reconnect",
        );
        break;
      }

      case GatewayOpcode.INVALID_SESSION: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = null;
          this.seq = null;
          this.resumeGatewayUrl = null;
        }
        const waitMs = 1000 + Math.floor(clampUnitRandom(this.random()) * 4000);
        this.pendingInvalidSessionDelayMs = waitMs;
        this.clearHeartbeatTimers();
        const detail = resumable
          ? `Gateway invalid session (resumable); reconnecting in ${waitMs}ms`
          : `Gateway invalid session; cleared session and reconnecting in ${waitMs}ms`;
        this.logMessage(detail);
        this.setState("reconnecting", detail);
        this.closeSocketForReconnect(
          connId,
          GatewayCloseCode.UNKNOWN_ERROR,
          "Invalid session",
        );
        break;
      }

      default:
        this.logMessage(`Ignoring Gateway opcode ${String(payload.op)}`);
        break;
    }
  }

  private startHeartbeatLoop(connId: number, intervalMs: number): void {
    this.clearHeartbeatTimers();
    const jitterDelayMs = Math.max(
      0,
      Math.round(intervalMs * clampUnitRandom(this.random())),
    );

    this.initialHeartbeatTimer = setTimeout(() => {
      this.initialHeartbeatTimer = null;
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }
      this.sendScheduledHeartbeat(connId);
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }
      this.heartbeatIntervalTimer = setInterval(() => {
        this.sendScheduledHeartbeat(connId);
      }, intervalMs);
    }, jitterDelayMs);
  }

  private sendIdentify(connId: number): void {
    this.setState("identifying", "Sending Op 2 IDENTIFY");
    const properties = buildGatewayIdentifyProperties(this.authMode);
    const identifyData: GatewayIdentifyData =
      this.authMode === "bot"
        ? {
            token: this.token,
            intents: this.intents ?? DEFAULT_GATEWAY_INTENTS,
            properties,
            compress: this.compress,
          }
        : {
            token: this.token,
            properties,
            ...(this.compress ? { compress: true } : {}),
          };

    this.sendPayload(connId, {
      op: GatewayOpcode.IDENTIFY,
      d: identifyData,
    });
  }

  private sendScheduledHeartbeat(connId: number): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }

    if (this.awaitingAck) {
      this.clearHeartbeatTimers();
      this.lastError =
        "Gateway heartbeat ACK missed (zombie connection); reconnecting.";
      this.logMessage(this.lastError);
      this.setState("reconnecting", this.lastError);
      this.closeSocketForReconnect(
        connId,
        GatewayCloseCode.UNKNOWN_ERROR,
        "Heartbeat ACK timeout",
      );
      return;
    }

    const nowMs = this.now();
    this.awaitingAck = true;
    this.lastHeartbeatSentAt = nowMs;
    this.lastHeartbeatAt = new Date(nowMs).toISOString();
    this.sendPayload(connId, {
      op: GatewayOpcode.HEARTBEAT,
      d: this.seq,
    });
  }

  private sendHeartbeatReply(connId: number): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }
    if (!this.awaitingAck) {
      const nowMs = this.now();
      this.lastHeartbeatSentAt = nowMs;
      this.lastHeartbeatAt = new Date(nowMs).toISOString();
    }
    this.sendPayload(connId, {
      op: GatewayOpcode.HEARTBEAT,
      d: this.seq,
    });
  }

  private sendPayload(connId: number, payload: unknown): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }
    const socket = this.ws;
    if (socket === null || socket.readyState !== WS_READY_STATE_OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      this.logMessage(`Gateway send error: ${formatErrorMessage(err)}`);
    }
  }

  private closeSocketForReconnect(
    connId: number,
    code: number,
    reason: string,
  ): void {
    if (connId !== this.activeConnId) {
      return;
    }
    const socket = this.ws;
    if (socket === null) {
      return;
    }
    if (socket.readyState === WS_READY_STATE_CLOSED) {
      return;
    }

    if (this.closeFallbackTimer !== null) {
      clearTimeout(this.closeFallbackTimer);
    }
    this.closeFallbackTimer = setTimeout(() => {
      this.closeFallbackTimer = null;
      if (connId !== this.activeConnId) {
        return;
      }
      try {
        if (socket.readyState !== WS_READY_STATE_CLOSED) {
          socket.terminate();
        }
      } catch {
        // Ignore terminate error.
      }
    }, DEFAULT_CLOSE_FALLBACK_TIMEOUT_MS);
    this.closeFallbackTimer.unref?.();

    try {
      if (socket.readyState === WS_READY_STATE_CONNECTING) {
        socket.terminate();
      } else {
        socket.close(code, reason);
      }
    } catch {
      try {
        socket.terminate();
      } catch {
        // Ignore terminate error.
      }
    }
  }

  private handleSocketClose(
    connId: number,
    socket: GatewayWebSocket,
    decoder: PerConnectionZlibDecoder | null,
    code: number,
    reason: string,
    connHadError: boolean,
  ): void {
    decoder?.close();
    if (this.decoder === decoder) {
      this.decoder = null;
    }
    if (this.ws === socket) {
      this.ws = null;
    }

    if (this.closeFallbackTimer !== null) {
      clearTimeout(this.closeFallbackTimer);
      this.closeFallbackTimer = null;
    }

    try {
      socket.removeAllListeners?.();
    } catch {
      // Ignore cleanup errors on mock sockets.
    }

    const waiters = this.closeWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }

    if (this.stopped || connId !== this.activeConnId) {
      if (this.stopped) {
        this.setState("disconnected", "Gateway client stopped");
      }
      return;
    }

    this.clearHeartbeatTimers();
    this.awaitingAck = false;

    if (FATAL_GATEWAY_CLOSE_CODES.has(code)) {
      this.sessionId = null;
      this.seq = null;
      this.resumeGatewayUrl = null;
      const fatalMsg = formatFatalCloseError(code, reason, this.intents);
      this.lastError = fatalMsg;
      this.logMessage(fatalMsg);
      this.setState("fatal", fatalMsg);
      return;
    }

    if (SESSION_INVALIDATING_CLOSE_CODES.has(code)) {
      this.sessionId = null;
      this.seq = null;
      this.resumeGatewayUrl = null;
    }

    let delayMs: number;
    if (this.pendingInvalidSessionDelayMs !== null) {
      delayMs = this.pendingInvalidSessionDelayMs;
    } else if (this.pendingImmediateReconnect) {
      delayMs = 0;
    } else {
      delayMs = this.computeBackoffDelayMs(this.reconnectAttempts);
      const reasonSuffix = reason.length > 0 ? `: ${reason}` : "";
      if (!connHadError && this.state !== "reconnecting") {
        this.lastError = `Gateway closed with code ${code}${reasonSuffix}`;
      }
    }

    this.pendingImmediateReconnect = false;
    this.pendingInvalidSessionDelayMs = null;
    this.reconnectAttempts += 1;

    const detail =
      delayMs === 0
        ? `Reconnecting immediately (close ${code})`
        : `Reconnecting in ${delayMs}ms (close ${code})`;
    this.logMessage(detail);
    this.setState("reconnecting", detail);
    this.scheduleReconnect(connId, delayMs);
  }

  private scheduleReconnect(connId: number, delayMs: number): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }
      const nextConnId = ++this.activeConnId;
      void this.initiateConnection(nextConnId);
    }, delayMs);
  }

  private scheduleDirectConnect(
    connId: number,
    url: string,
    delayMs: number,
  ): void {
    if (this.stopped || connId !== this.activeConnId) {
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || connId !== this.activeConnId) {
        return;
      }
      this.lastError = null;
      this.openWebSocket(connId, url);
    }, delayMs);
  }

  private computeBackoffDelayMs(attempt: number): number {
    const exp = Math.min(
      this.baseReconnectDelayMs * 2 ** Math.min(attempt, 10),
      this.maxReconnectDelayMs,
    );
    const jitterMax = Math.min(1000, exp);
    const jitter = Math.floor(clampUnitRandom(this.random()) * jitterMax);
    return exp + jitter;
  }

  private canResume(): boolean {
    return (
      this.sessionId !== null &&
      this.seq !== null &&
      this.resumeGatewayUrl !== null
    );
  }

  private clearHeartbeatTimers(): void {
    if (this.initialHeartbeatTimer !== null) {
      clearTimeout(this.initialHeartbeatTimer);
      this.initialHeartbeatTimer = null;
    }
    if (this.heartbeatIntervalTimer !== null) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearHeartbeatTimers();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closeFallbackTimer !== null) {
      clearTimeout(this.closeFallbackTimer);
      this.closeFallbackTimer = null;
    }
  }

  private setState(
    nextState: GatewayConnectionState,
    detail: string | null,
  ): void {
    if (this.state === nextState && this.lastStateDetail === detail) {
      return;
    }
    this.state = nextState;
    this.lastStateDetail = detail;
    if (this.onStateChange !== undefined) {
      try {
        this.onStateChange(nextState, detail);
      } catch (err) {
        this.logMessage(
          `Gateway state listener error: ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  private logMessage(msg: string): void {
    this.log?.(msg);
  }
}
