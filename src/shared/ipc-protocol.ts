import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_READ_LIMIT,
  MAX_CHANNEL_MEMBERS_LIMIT,
  MAX_DISCORD_READ_LIMIT,
} from "./config.js";
import {
  IpcErrorCode,
  WatchEventTypeValue,
  type ChannelMembersQuery,
  type DaemonLockfile,
  type DirectMessageRequest,
  type IpcErrorCodeValue,
  type IpcErrorEnvelope,
  type IpcErrorPayload,
  type IpcResponseEnvelope,
  type IpcSuccessEnvelope,
  type JoinGuildRequest,
  type ReactMessageRequest,
  type ReadMessagesRequest,
  type SendMessageRequest,
  type Snowflake,
  type UnreadQuery,
  type WatchEvent,
  type WatchEventType,
} from "./types.js";

/**
 * Local loopback HTTP/1.1 + NDJSON IPC protocol constants, validation, and lockfile helpers.
 */

export const IPC_API_PREFIX = "/v1";
export const MAX_MESSAGE_CONTENT_LENGTH = 2000;

export const HttpMethod = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  DELETE: "DELETE",
} as const;

export type HttpMethodValue = (typeof HttpMethod)[keyof typeof HttpMethod];

export const HttpStatus = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatusValue = (typeof HttpStatus)[keyof typeof HttpStatus];

export const IpcHeaders = {
  CONTENT_TYPE: "content-type",
  CACHE_CONTROL: "cache-control",
  HOST: "host",
} as const;

export const IpcContentType = {
  JSON: "application/json; charset=utf-8",
  NDJSON: "application/x-ndjson; charset=utf-8",
} as const;

export const IPC_ROUTES = {
  STATUS: "/v1/status",
  UNREAD: "/v1/unread",
  DAEMON_STOP: "/v1/daemon/stop",
  INVITES_JOIN: "/v1/invites/join",
  GUILDS: "/v1/guilds",
  GUILD_CHANNELS_PATTERN: "/v1/guilds/:guildId/channels",
  DMS: "/v1/dms",
  CHANNEL_READ_PATTERN: "/v1/channels/:channelId/read",
  CHANNEL_MESSAGES_PATTERN: "/v1/channels/:channelId/messages",
  CHANNEL_MEMBERS_PATTERN: "/v1/channels/:channelId/members",
  CHANNEL_WATCH_PATTERN: "/v1/channels/:channelId/watch",
  MESSAGE_REACTIONS_PATTERN:
    "/v1/channels/:channelId/messages/:messageId/reactions",
} as const;

const VALID_WATCH_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(WatchEventTypeValue),
);

// ---------------------------------------------------------------------------
// Snowflake & Route Builders / Matching
// ---------------------------------------------------------------------------

export function isValidSnowflake(value: unknown): value is Snowflake {
  return typeof value === "string" && /^\d{1,22}$/.test(value);
}

function assertSnowflake(value: string, label: string): Snowflake {
  if (!isValidSnowflake(value)) {
    throw new TypeError(`Invalid ${label} "${value}": expected numeric Discord ID.`);
  }
  return value;
}

export function buildUnreadPath(query: UnreadQuery = {}): string {
  const params = new URLSearchParams();
  if (query.includeDms !== undefined) {
    params.set("include_dms", String(query.includeDms));
  }
  if (query.mentionsOnly !== undefined) {
    params.set("mentions_only", String(query.mentionsOnly));
  }
  const qs = params.toString();
  return qs.length > 0 ? `${IPC_ROUTES.UNREAD}?${qs}` : IPC_ROUTES.UNREAD;
}

function parseBooleanQueryParam(raw: string | null): boolean | undefined {
  if (raw === null) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new TypeError(`Invalid boolean query parameter value "${raw}".`);
}

export function parseUnreadQuery(searchParams: URLSearchParams): UnreadQuery {
  const result: UnreadQuery = {};
  const includeDms = parseBooleanQueryParam(searchParams.get("include_dms"));
  if (includeDms !== undefined) {
    result.includeDms = includeDms;
  }
  const mentionsOnly = parseBooleanQueryParam(
    searchParams.get("mentions_only"),
  );
  if (mentionsOnly !== undefined) {
    result.mentionsOnly = mentionsOnly;
  }
  return result;
}

export function parseWatchEventsQuery(
  searchParams: URLSearchParams,
): WatchEventType[] | null {
  const raw = searchParams.get("events");
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const parsed: WatchEventType[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!VALID_WATCH_EVENT_TYPES.has(trimmed)) {
      throw new TypeError(`Unknown watch event filter "${trimmed}".`);
    }
    parsed.push(trimmed as WatchEventType);
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * Normalizes a Unicode emoji or Discord custom emoji (`name:id`, `<:name:id>`, `<a:name:id>`)
 * into a URL-encoded path segment for Discord REST `/reactions/{emoji}/@me`.
 */
export function normalizeEmojiForRest(emoji: string): string {
  const trimmed = emoji.trim();
  if (trimmed.length === 0) {
    throw new TypeError("Emoji must not be empty.");
  }
  const customMatch = /^<a?:([^:>]+:\d+)>$/.exec(trimmed);
  const canonical = customMatch !== null ? customMatch[1]! : trimmed;
  return encodeURIComponent(canonical);
}

/**
 * Extracts a normalized Discord invite code from a raw code or invite URL
 * (`discord.gg/xyz`, `discord.com/invite/xyz`, `discordapp.com/invite/xyz`).
 */
export function parseInviteCode(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("Invite code or URL must be a string.");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new TypeError("Invite code or URL must not be empty.");
  }

  let code: string;
  const looksLikeUrl =
    /^https?:\/\//i.test(trimmed) ||
    /^(?:(?:www|ptb|canary)\.)?(?:discord\.gg|discord\.com|discordapp\.com)(?:[/?#]|$)/i.test(
      trimmed,
    );

  if (looksLikeUrl) {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new TypeError(`Invalid Discord invite URL "${input}".`);
    }

    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter((seg) => seg.length > 0);
    if (/^(?:(?:www|ptb|canary)\.)?discord\.gg$/.test(host)) {
      if (segments.length !== 1) {
        throw new TypeError(
          `Invalid Discord invite URL "${input}": expected discord.gg/<code>.`,
        );
      }
      code = segments[0]!;
    } else if (
      /^(?:(?:www|ptb|canary)\.)?(?:discord\.com|discordapp\.com)$/.test(host)
    ) {
      if (
        segments.length !== 2 ||
        segments[0]!.toLowerCase() !== "invite"
      ) {
        throw new TypeError(
          `Invalid Discord invite URL "${input}": expected /invite/<code>.`,
        );
      }
      code = segments[1]!;
    } else {
      throw new TypeError(
        `Unsupported invite URL host "${url.hostname}". Expected discord.gg, discord.com, or discordapp.com.`,
      );
    }
  } else {
    code = trimmed;
  }

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
    throw new TypeError(
      `Invalid Discord invite code "${code}": expected alphanumeric, "-", or "_" characters.`,
    );
  }
  return code;
}

export function buildInvitesJoinPath(): string {
  return IPC_ROUTES.INVITES_JOIN;
}

export function buildGuildsPath(): string {
  return IPC_ROUTES.GUILDS;
}

export function buildGuildChannelsPath(guildId: Snowflake): string {
  const id = assertSnowflake(guildId, "guildId");
  return `${IPC_API_PREFIX}/guilds/${encodeURIComponent(id)}/channels`;
}

export function buildDmsPath(): string {
  return IPC_ROUTES.DMS;
}

export function buildChannelReadPath(channelId: Snowflake): string {
  const id = assertSnowflake(channelId, "channelId");
  return `${IPC_API_PREFIX}/channels/${encodeURIComponent(id)}/read`;
}

export function buildChannelMessagesPath(channelId: Snowflake): string {
  const id = assertSnowflake(channelId, "channelId");
  return `${IPC_API_PREFIX}/channels/${encodeURIComponent(id)}/messages`;
}

export function buildChannelMembersPath(
  channelId: Snowflake,
  query: ChannelMembersQuery = {},
): string {
  const id = assertSnowflake(channelId, "channelId");
  const base = `${IPC_API_PREFIX}/channels/${encodeURIComponent(id)}/members`;
  if (query.limit !== undefined) {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > MAX_CHANNEL_MEMBERS_LIMIT
    ) {
      throw new RangeError(
        `limit must be an integer between 1 and ${MAX_CHANNEL_MEMBERS_LIMIT}.`,
      );
    }
    const params = new URLSearchParams({ limit: String(query.limit) });
    return `${base}?${params.toString()}`;
  }
  return base;
}

export function parseChannelMembersQuery(
  searchParams: URLSearchParams,
): ChannelMembersQuery {
  const raw = searchParams.get("limit");
  if (raw === null) {
    return {};
  }
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed)
    ? Number.parseInt(trimmed, 10)
    : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_CHANNEL_MEMBERS_LIMIT
  ) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_CHANNEL_MEMBERS_LIMIT}.`,
    );
  }
  return { limit: parsed };
}

export function buildChannelWatchPath(
  channelId: Snowflake,
  events?: readonly WatchEventType[],
): string {
  const id = assertSnowflake(channelId, "channelId");
  const base = `${IPC_API_PREFIX}/channels/${encodeURIComponent(id)}/watch`;
  if (events !== undefined && events.length > 0) {
    const params = new URLSearchParams({ events: events.join(",") });
    return `${base}?${params.toString()}`;
  }
  return base;
}

export function buildMessageReactionsPath(
  channelId: Snowflake,
  messageId: Snowflake,
): string {
  const cid = assertSnowflake(channelId, "channelId");
  const mid = assertSnowflake(messageId, "messageId");
  return `${IPC_API_PREFIX}/channels/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/reactions`;
}

export type MatchedIpcRoute =
  | { route: "status" }
  | { route: "unread" }
  | { route: "daemon_stop" }
  | { route: "invites_join" }
  | { route: "guilds" }
  | { route: "guild_channels"; guildId: Snowflake }
  | { route: "dms_list" }
  | { route: "dm_send" }
  | { route: "channel_read"; channelId: Snowflake }
  | { route: "channel_messages"; channelId: Snowflake }
  | { route: "channel_members"; channelId: Snowflake }
  | { route: "channel_watch"; channelId: Snowflake }
  | { route: "message_reactions"; channelId: Snowflake; messageId: Snowflake };

export function getAllowedMethodsForIpcPath(
  pathname: string,
): readonly HttpMethodValue[] | null {
  if (pathname === IPC_ROUTES.STATUS || pathname === IPC_ROUTES.UNREAD) {
    return [HttpMethod.GET];
  }
  if (
    pathname === IPC_ROUTES.DAEMON_STOP ||
    pathname === IPC_ROUTES.INVITES_JOIN
  ) {
    return [HttpMethod.POST];
  }
  if (pathname === IPC_ROUTES.GUILDS) {
    return [HttpMethod.GET];
  }
  if (/^\/v1\/guilds\/(\d{1,22})\/channels$/.test(pathname)) {
    return [HttpMethod.GET];
  }
  if (pathname === IPC_ROUTES.DMS) {
    return [HttpMethod.GET, HttpMethod.POST];
  }

  const channelActionMatch =
    /^\/v1\/channels\/(\d{1,22})\/(read|messages|members|watch)$/.exec(
      pathname,
    );
  if (channelActionMatch !== null) {
    const action = channelActionMatch[2]!;
    if (action === "read" || action === "messages") {
      return [HttpMethod.POST];
    }
    if (action === "members" || action === "watch") {
      return [HttpMethod.GET];
    }
  }

  if (
    /^\/v1\/channels\/(\d{1,22})\/messages\/(\d{1,22})\/reactions$/.test(
      pathname,
    )
  ) {
    return [HttpMethod.POST];
  }

  return null;
}

export function matchIpcRoute(
  method: string,
  pathname: string,
): MatchedIpcRoute | null {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === HttpMethod.GET && pathname === IPC_ROUTES.STATUS) {
    return { route: "status" };
  }
  if (normalizedMethod === HttpMethod.GET && pathname === IPC_ROUTES.UNREAD) {
    return { route: "unread" };
  }
  if (
    normalizedMethod === HttpMethod.POST &&
    pathname === IPC_ROUTES.DAEMON_STOP
  ) {
    return { route: "daemon_stop" };
  }
  if (
    normalizedMethod === HttpMethod.POST &&
    pathname === IPC_ROUTES.INVITES_JOIN
  ) {
    return { route: "invites_join" };
  }
  if (normalizedMethod === HttpMethod.GET && pathname === IPC_ROUTES.GUILDS) {
    return { route: "guilds" };
  }

  const guildChannelsMatch =
    /^\/v1\/guilds\/(\d{1,22})\/channels$/.exec(pathname);
  if (guildChannelsMatch !== null && normalizedMethod === HttpMethod.GET) {
    return { route: "guild_channels", guildId: guildChannelsMatch[1]! };
  }

  if (pathname === IPC_ROUTES.DMS) {
    if (normalizedMethod === HttpMethod.GET) {
      return { route: "dms_list" };
    }
    if (normalizedMethod === HttpMethod.POST) {
      return { route: "dm_send" };
    }
    return null;
  }

  const channelActionMatch =
    /^\/v1\/channels\/(\d{1,22})\/(read|messages|members|watch)$/.exec(
      pathname,
    );
  if (channelActionMatch !== null) {
    const channelId = channelActionMatch[1]!;
    const action = channelActionMatch[2]!;
    if (action === "read" && normalizedMethod === HttpMethod.POST) {
      return { route: "channel_read", channelId };
    }
    if (action === "messages" && normalizedMethod === HttpMethod.POST) {
      return { route: "channel_messages", channelId };
    }
    if (action === "members" && normalizedMethod === HttpMethod.GET) {
      return { route: "channel_members", channelId };
    }
    if (action === "watch" && normalizedMethod === HttpMethod.GET) {
      return { route: "channel_watch", channelId };
    }
    return null;
  }

  const reactionMatch =
    /^\/v1\/channels\/(\d{1,22})\/messages\/(\d{1,22})\/reactions$/.exec(
      pathname,
    );
  if (reactionMatch !== null && normalizedMethod === HttpMethod.POST) {
    return {
      route: "message_reactions",
      channelId: reactionMatch[1]!,
      messageId: reactionMatch[2]!,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Loopback Host Security Helper
// ---------------------------------------------------------------------------

/**
 * Guards against DNS rebinding by allowing only loopback `Host` headers.
 */
export function isAllowedLoopbackHostHeader(
  hostHeader: string | undefined,
): boolean {
  if (hostHeader === undefined) {
    return true;
  }
  const normalized = hostHeader.trim().toLowerCase();
  return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(normalized);
}

// ---------------------------------------------------------------------------
// Envelope, NDJSON & DTO Validation Helpers
// ---------------------------------------------------------------------------

export function okEnvelope<T>(data: T): IpcSuccessEnvelope<T> {
  return { ok: true, data };
}

export function errorEnvelope(error: IpcErrorPayload): IpcErrorEnvelope {
  return { ok: false, error };
}

export function createIpcError(
  code: IpcErrorCodeValue | string,
  message: string,
  status: number,
  extra?: {
    discordCode?: number;
    retryAfterMs?: number;
    details?: unknown;
  },
): IpcErrorPayload {
  const payload: IpcErrorPayload = { code, message, status };
  if (extra?.discordCode !== undefined) {
    payload.discordCode = extra.discordCode;
  }
  if (extra?.retryAfterMs !== undefined) {
    payload.retryAfterMs = extra.retryAfterMs;
  }
  if (extra?.details !== undefined) {
    payload.details = extra.details;
  }
  return payload;
}

export function serializeJsonEnvelope<T>(
  envelope: IpcResponseEnvelope<T>,
): string {
  return JSON.stringify(envelope);
}

export function parseJsonEnvelope<T>(raw: string): IpcResponseEnvelope<T> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new Error("Invalid IPC JSON response envelope.");
  }
  const record = parsed as Record<string, unknown>;
  if (record["ok"] === true && "data" in record) {
    return parsed as IpcSuccessEnvelope<T>;
  }
  if (
    record["ok"] === false &&
    typeof record["error"] === "object" &&
    record["error"] !== null
  ) {
    const err = record["error"] as Record<string, unknown>;
    if (
      typeof err["code"] === "string" &&
      typeof err["message"] === "string" &&
      typeof err["status"] === "number"
    ) {
      return parsed as IpcErrorEnvelope;
    }
  }
  throw new Error("Malformed IPC JSON envelope fields.");
}

export function serializeNdjsonLine(event: WatchEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseNdjsonLine(line: string): WatchEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Watch NDJSON line is not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["type"] !== "string" ||
    !VALID_WATCH_EVENT_TYPES.has(record["type"]) ||
    typeof record["timestamp"] !== "string" ||
    typeof record["channelId"] !== "string"
  ) {
    throw new Error("Invalid WatchEvent NDJSON payload.");
  }
  return parsed as WatchEvent;
}

function asPlainObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return input as Record<string, unknown>;
}

export function validateReadMessagesRequest(
  input: unknown = {},
): ReadMessagesRequest {
  const obj = asPlainObject(input, "ReadMessagesRequest");
  const result: ReadMessagesRequest = {};

  if (obj["limit"] !== undefined) {
    if (
      typeof obj["limit"] !== "number" ||
      !Number.isInteger(obj["limit"]) ||
      obj["limit"] < 1 ||
      obj["limit"] > MAX_DISCORD_READ_LIMIT
    ) {
      throw new RangeError(
        `limit must be an integer between 1 and ${MAX_DISCORD_READ_LIMIT}.`,
      );
    }
    result.limit = obj["limit"];
  } else {
    result.limit = DEFAULT_READ_LIMIT;
  }

  if (obj["before"] !== undefined) {
    if (!isValidSnowflake(obj["before"])) {
      throw new TypeError("before must be a valid Discord snowflake.");
    }
    result.before = obj["before"];
  }

  if (obj["after"] !== undefined) {
    if (!isValidSnowflake(obj["after"])) {
      throw new TypeError("after must be a valid Discord snowflake.");
    }
    result.after = obj["after"];
  }

  if (obj["markRead"] !== undefined) {
    if (typeof obj["markRead"] !== "boolean") {
      throw new TypeError("markRead must be a boolean.");
    }
    result.markRead = obj["markRead"];
  }

  return result;
}

function validateMessageContent(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TypeError("content must be a string.");
  }
  if (raw.trim().length === 0) {
    throw new RangeError("content must not be empty.");
  }
  if (raw.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw new RangeError(
      `content exceeds Discord's ${MAX_MESSAGE_CONTENT_LENGTH}-character limit.`,
    );
  }
  return raw;
}

function validateOptionalTyping(raw: unknown): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "boolean") {
    throw new TypeError("typing must be a boolean.");
  }
  return raw;
}

export function validateSendMessageRequest(input: unknown): SendMessageRequest {
  const obj = asPlainObject(input, "SendMessageRequest");
  const result: SendMessageRequest = {
    content: validateMessageContent(obj["content"]),
  };
  if (obj["replyToMessageId"] !== undefined) {
    if (!isValidSnowflake(obj["replyToMessageId"])) {
      throw new TypeError("replyToMessageId must be a valid Discord snowflake.");
    }
    result.replyToMessageId = obj["replyToMessageId"];
  }
  const typing = validateOptionalTyping(obj["typing"]);
  if (typing !== undefined) {
    result.typing = typing;
  }
  return result;
}

export function validateJoinGuildRequest(input: unknown): JoinGuildRequest {
  const obj = asPlainObject(input, "JoinGuildRequest");
  if (typeof obj["invite"] !== "string") {
    throw new TypeError("invite must be a string.");
  }
  return { invite: parseInviteCode(obj["invite"]) };
}

export function validateDirectMessageRequest(
  input: unknown,
): DirectMessageRequest {
  const obj = asPlainObject(input, "DirectMessageRequest");
  if (!isValidSnowflake(obj["userId"])) {
    throw new TypeError("userId must be a valid Discord snowflake.");
  }
  const result: DirectMessageRequest = {
    userId: obj["userId"],
    content: validateMessageContent(obj["content"]),
  };
  const typing = validateOptionalTyping(obj["typing"]);
  if (typing !== undefined) {
    result.typing = typing;
  }
  return result;
}

export function validateReactMessageRequest(
  input: unknown,
): ReactMessageRequest {
  const obj = asPlainObject(input, "ReactMessageRequest");
  if (typeof obj["emoji"] !== "string" || obj["emoji"].trim().length === 0) {
    throw new TypeError("emoji must be a non-empty string.");
  }
  const result: ReactMessageRequest = { emoji: obj["emoji"].trim() };
  if (obj["remove"] !== undefined) {
    if (typeof obj["remove"] !== "boolean") {
      throw new TypeError("remove must be a boolean.");
    }
    result.remove = obj["remove"];
  }
  return result;
}

export function formatHttpErrorForCode(
  code: IpcErrorCodeValue,
  message: string,
): IpcErrorPayload {
  switch (code) {
    case IpcErrorCode.UNAUTHORIZED:
      return createIpcError(code, message, HttpStatus.UNAUTHORIZED);
    case IpcErrorCode.BAD_REQUEST:
      return createIpcError(code, message, HttpStatus.BAD_REQUEST);
    case IpcErrorCode.NOT_FOUND:
      return createIpcError(code, message, HttpStatus.NOT_FOUND);
    case IpcErrorCode.METHOD_NOT_ALLOWED:
      return createIpcError(code, message, HttpStatus.METHOD_NOT_ALLOWED);
    case IpcErrorCode.RATE_LIMITED:
      return createIpcError(code, message, HttpStatus.TOO_MANY_REQUESTS);
    case IpcErrorCode.DAEMON_NOT_READY:
    case IpcErrorCode.DAEMON_UNREACHABLE:
      return createIpcError(code, message, HttpStatus.SERVICE_UNAVAILABLE);
    case IpcErrorCode.DISCORD_API_ERROR:
      return createIpcError(code, message, HttpStatus.BAD_GATEWAY);
    case IpcErrorCode.INTERNAL_ERROR:
      return createIpcError(code, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Daemon Lockfile Read / Write / Cleanup Helpers
// ---------------------------------------------------------------------------

export function isValidDaemonLockfile(input: unknown): input is DaemonLockfile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const rec = input as Record<string, unknown>;
  return (
    typeof rec["pid"] === "number" &&
    Number.isInteger(rec["pid"]) &&
    rec["pid"] > 0 &&
    typeof rec["host"] === "string" &&
    rec["host"].length > 0 &&
    typeof rec["port"] === "number" &&
    Number.isInteger(rec["port"]) &&
    rec["port"] >= 1 &&
    rec["port"] <= 65535 &&
    typeof rec["startedAt"] === "string" &&
    rec["startedAt"].length > 0 &&
    (rec["token"] === undefined || typeof rec["token"] === "string") &&
    (rec["version"] === undefined || typeof rec["version"] === "string")
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Atomically writes the daemon lockfile with restrictive permissions (`0o700` dir, `0o600` file).
 */
export async function writeDaemonLockfile(
  lockfilePath: string,
  data: DaemonLockfile,
): Promise<void> {
  if (!isValidDaemonLockfile(data)) {
    throw new TypeError("Cannot write invalid DaemonLockfile payload.");
  }
  const dir = path.dirname(lockfilePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    dir,
    `.${path.basename(lockfilePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, lockfilePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readDaemonLockfile(
  lockfilePath: string,
): Promise<DaemonLockfile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockfilePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isValidDaemonLockfile(parsed)) {
    throw new Error(`Invalid daemon lockfile schema at "${lockfilePath}".`);
  }
  return parsed;
}

export type LockfileInspectionResult =
  | { state: "missing" }
  | { state: "active"; lockfile: DaemonLockfile }
  | { state: "stale"; lockfile: DaemonLockfile; reason: string }
  | { state: "corrupt"; error: string };

export async function inspectDaemonLockfile(
  lockfilePath: string,
): Promise<LockfileInspectionResult> {
  try {
    const lockfile = await readDaemonLockfile(lockfilePath);
    if (lockfile === null) {
      return { state: "missing" };
    }
    if (!isProcessAlive(lockfile.pid)) {
      return {
        state: "stale",
        lockfile,
        reason: `Process ${lockfile.pid} is no longer running.`,
      };
    }
    return { state: "active", lockfile };
  } catch (err) {
    return {
      state: "corrupt",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function removeDaemonLockfile(
  lockfilePath: string,
  expectedPid?: number,
): Promise<boolean> {
  if (expectedPid !== undefined) {
    try {
      const existing = await readDaemonLockfile(lockfilePath);
      if (existing === null || existing.pid !== expectedPid) {
        return false;
      }
    } catch {
      return false;
    }
  }
  try {
    await fs.unlink(lockfilePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function cleanupStaleDaemonLockfile(
  lockfilePath: string,
): Promise<boolean> {
  const inspection = await inspectDaemonLockfile(lockfilePath);
  if (inspection.state === "stale") {
    return removeDaemonLockfile(lockfilePath, inspection.lockfile.pid);
  }
  if (inspection.state === "corrupt") {
    return removeDaemonLockfile(lockfilePath);
  }
  return false;
}
