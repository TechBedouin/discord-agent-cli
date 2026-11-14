import {
  DEFAULT_DISCORD_API_BASE_URL,
  MAX_DISCORD_READ_LIMIT,
  buildDiscordRestHeaders,
  encodeInviteContextProperties,
  inferDiscordAuthModeFromToken,
  resolveDiscordToken,
  type DiscordSuperProperties,
} from "../shared/config.js";
import {
  normalizeEmojiForRest,
  parseInviteCode,
} from "../shared/ipc-protocol.js";
import type {
  DiscordActiveThreadsResponse,
  DiscordAuthMode,
  DiscordChannel,
  DiscordCreateDmBody,
  DiscordCreateMessageBody,
  DiscordGuild,
  DiscordInvite,
  DiscordMessage,
  DiscordPartialGuild,
  DiscordRestErrorBody,
  DiscordUser,
  GatewayBotInfo,
  RateLimitBucketSnapshot,
  RateLimitStatusSnapshot,
  Snowflake,
} from "../shared/types.js";
import {
  RateLimitError,
  RateLimiter,
  parseRateLimitHeaders,
  secondsToMs,
  type RateLimitRouteDescriptor,
} from "./rate-limiter.js";

/**
 * Discord API v10 REST client (user and bot auth modes) backed by native `fetch` and `RateLimiter`.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscordRestErrorOptions {
  httpStatus: number;
  discordCode?: number;
  retryAfterMs?: number;
  isRateLimit: boolean;
  body?: unknown;
  cause?: unknown;
}

export class DiscordRestError extends Error {
  readonly httpStatus: number;
  readonly discordCode?: number;
  readonly retryAfterMs?: number;
  readonly isRateLimit: boolean;
  readonly body?: unknown;

  constructor(message: string, options: DiscordRestErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DiscordRestError";
    this.httpStatus = options.httpStatus;
    this.isRateLimit = options.isRateLimit;
    if (options.discordCode !== undefined) {
      this.discordCode = options.discordCode;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.body !== undefined) {
      this.body = options.body;
    }
  }
}

export interface DiscordRestClientOptions {
  token: string;
  authMode?: DiscordAuthMode;
  apiBaseUrl?: string;
  baseUrl?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  superProperties?: string | Partial<DiscordSuperProperties>;
  rateLimiter?: RateLimiter;
  maxRateLimitRetries?: number;
  fetchImpl?: FetchLike;
}

export interface GetChannelMessagesOptions {
  limit?: number;
  before?: Snowflake;
  after?: Snowflake;
}

function assertNonEmptyId(id: string, label: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
  return trimmed;
}

function resolveInviteCodeForRest(codeOrUrl: string): string {
  const trimmed = assertNonEmptyId(codeOrUrl, "inviteCode");
  if (
    /^https?:\/\//i.test(trimmed) ||
    /^(?:(?:www|ptb|canary)\.)?(?:discord\.gg|discord\.com|discordapp\.com)(?:[/?#]|$)/i.test(
      trimmed,
    )
  ) {
    return parseInviteCode(trimmed);
  }
  return trimmed;
}

function parseDiscordErrorBody(
  rawText: string,
): { parsedBody: unknown; discordCode?: number; message?: string } {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { parsedBody: undefined };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(trimmed) as unknown;
  } catch {
    return { parsedBody: rawText };
  }

  if (
    typeof parsedBody === "object" &&
    parsedBody !== null &&
    !Array.isArray(parsedBody)
  ) {
    const rec = parsedBody as Partial<DiscordRestErrorBody>;
    const result: {
      parsedBody: unknown;
      discordCode?: number;
      message?: string;
    } = { parsedBody };
    if (typeof rec.code === "number") {
      result.discordCode = rec.code;
    }
    if (typeof rec.message === "string" && rec.message.length > 0) {
      result.message = rec.message;
    }
    return result;
  }

  return { parsedBody };
}

export class DiscordRestClient {
  readonly rateLimiter: RateLimiter;
  readonly authMode: DiscordAuthMode;
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: FetchLike;

  constructor(options: DiscordRestClientOptions) {
    const resolvedToken = resolveDiscordToken({ DISCORD_TOKEN: options.token });
    if (resolvedToken === null) {
      throw new TypeError("Discord token must not be empty.");
    }
    this.token = resolvedToken;
    this.authMode =
      options.authMode ?? inferDiscordAuthModeFromToken(options.token);
    const rawBaseUrl =
      options.apiBaseUrl ?? options.baseUrl ?? DEFAULT_DISCORD_API_BASE_URL;
    this.apiBaseUrl = rawBaseUrl.replace(/\/+$/, "");

    const headers = buildDiscordRestHeaders({
      token: this.token,
      authMode: this.authMode,
      userAgent: options.userAgent,
      locale: options.locale,
      timezone: options.timezone,
      superProperties:
        typeof options.superProperties === "object" &&
        options.superProperties !== null
          ? options.superProperties
          : undefined,
    });
    if (
      this.authMode === "user" &&
      typeof options.superProperties === "string" &&
      options.superProperties.trim().length > 0
    ) {
      headers["X-Super-Properties"] = options.superProperties.trim();
    }
    this.defaultHeaders = headers;

    this.rateLimiter =
      options.rateLimiter ??
      new RateLimiter(
        options.maxRateLimitRetries !== undefined
          ? { maxRetries: options.maxRateLimitRetries }
          : undefined,
      );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  getAuthMode(): DiscordAuthMode {
    return this.authMode;
  }

  getRateLimitStatus(): RateLimitStatusSnapshot {
    return this.rateLimiter.getStatusSnapshot();
  }

  getRateLimitBuckets(): RateLimitBucketSnapshot[] {
    return this.rateLimiter.getBucketSnapshots();
  }

  getGateway(): Promise<{ url: string }> {
    return this.requestJson<{ url: string }>(
      { method: "GET", routeTemplate: "/gateway" },
      "/gateway",
    );
  }

  getGatewayBot(): Promise<GatewayBotInfo> {
    return this.requestJson<GatewayBotInfo>(
      { method: "GET", routeTemplate: "/gateway/bot" },
      "/gateway/bot",
    );
  }

  acceptInvite(code: string): Promise<DiscordInvite> {
    const inviteCode = resolveInviteCodeForRest(code);
    const extraHeaders =
      this.authMode === "user"
        ? { "X-Context-Properties": encodeInviteContextProperties() }
        : undefined;
    return this.requestJson<DiscordInvite>(
      { method: "POST", routeTemplate: "/invites/:code" },
      `/invites/${encodeURIComponent(inviteCode)}`,
      {},
      extraHeaders,
    );
  }

  getCurrentUser(): Promise<DiscordUser> {
    return this.requestJson<DiscordUser>(
      { method: "GET", routeTemplate: "/users/@me" },
      "/users/@me",
    );
  }

  getCurrentUserGuilds(): Promise<DiscordPartialGuild[]> {
    return this.requestJson<DiscordPartialGuild[]>(
      { method: "GET", routeTemplate: "/users/@me/guilds" },
      "/users/@me/guilds?with_counts=true",
    );
  }

  getChannel(channelId: Snowflake): Promise<DiscordChannel> {
    const cid = assertNonEmptyId(channelId, "channelId");
    return this.requestJson<DiscordChannel>(
      {
        method: "GET",
        routeTemplate: "/channels/:id",
        majorParam: cid,
      },
      `/channels/${encodeURIComponent(cid)}`,
    );
  }

  getGuild(guildId: Snowflake): Promise<DiscordGuild> {
    const gid = assertNonEmptyId(guildId, "guildId");
    return this.requestJson<DiscordGuild>(
      {
        method: "GET",
        routeTemplate: "/guilds/:id",
        majorParam: gid,
      },
      `/guilds/${encodeURIComponent(gid)}`,
    );
  }

  getGuildChannels(guildId: Snowflake): Promise<DiscordChannel[]> {
    const gid = assertNonEmptyId(guildId, "guildId");
    return this.requestJson<DiscordChannel[]>(
      {
        method: "GET",
        routeTemplate: "/guilds/:id/channels",
        majorParam: gid,
      },
      `/guilds/${encodeURIComponent(gid)}/channels`,
    );
  }

  getGuildActiveThreads(
    guildId: Snowflake,
  ): Promise<DiscordActiveThreadsResponse> {
    const gid = assertNonEmptyId(guildId, "guildId");
    return this.requestJson<DiscordActiveThreadsResponse>(
      {
        method: "GET",
        routeTemplate: "/guilds/:id/threads/active",
        majorParam: gid,
      },
      `/guilds/${encodeURIComponent(gid)}/threads/active`,
    );
  }

  getUserDms(): Promise<DiscordChannel[]> {
    return this.requestJson<DiscordChannel[]>(
      { method: "GET", routeTemplate: "/users/@me/channels" },
      "/users/@me/channels",
    );
  }

  createDm(recipientId: Snowflake): Promise<DiscordChannel> {
    const rid = assertNonEmptyId(recipientId, "recipientId");
    const body: DiscordCreateDmBody = { recipient_id: rid };
    return this.requestJson<DiscordChannel>(
      { method: "POST", routeTemplate: "/users/@me/channels" },
      "/users/@me/channels",
      body,
    );
  }

  async triggerTyping(channelId: Snowflake): Promise<void> {
    const cid = assertNonEmptyId(channelId, "channelId");
    await this.requestVoid(
      {
        method: "POST",
        routeTemplate: "/channels/:id/typing",
        majorParam: cid,
      },
      `/channels/${encodeURIComponent(cid)}/typing`,
    );
  }

  getChannelMessages(
    channelId: Snowflake,
    opts?: GetChannelMessagesOptions,
  ): Promise<DiscordMessage[]> {
    const cid = assertNonEmptyId(channelId, "channelId");
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) {
      if (
        !Number.isInteger(opts.limit) ||
        opts.limit < 1 ||
        opts.limit > MAX_DISCORD_READ_LIMIT
      ) {
        throw new RangeError(
          `limit must be an integer between 1 and ${MAX_DISCORD_READ_LIMIT}.`,
        );
      }
      params.set("limit", String(opts.limit));
    }
    if (opts?.before !== undefined) {
      params.set("before", assertNonEmptyId(opts.before, "before"));
    }
    if (opts?.after !== undefined) {
      params.set("after", assertNonEmptyId(opts.after, "after"));
    }

    const qs = params.toString();
    const path =
      qs.length > 0
        ? `/channels/${encodeURIComponent(cid)}/messages?${qs}`
        : `/channels/${encodeURIComponent(cid)}/messages`;

    return this.requestJson<DiscordMessage[]>(
      {
        method: "GET",
        routeTemplate: "/channels/:id/messages",
        majorParam: cid,
      },
      path,
    );
  }

  createMessage(
    channelId: Snowflake,
    body: DiscordCreateMessageBody,
  ): Promise<DiscordMessage> {
    const cid = assertNonEmptyId(channelId, "channelId");
    return this.requestJson<DiscordMessage>(
      {
        method: "POST",
        routeTemplate: "/channels/:id/messages",
        majorParam: cid,
      },
      `/channels/${encodeURIComponent(cid)}/messages`,
      body,
    );
  }

  async addReaction(
    channelId: Snowflake,
    messageId: Snowflake,
    emoji: string,
  ): Promise<void> {
    const cid = assertNonEmptyId(channelId, "channelId");
    const mid = assertNonEmptyId(messageId, "messageId");
    const encodedEmoji = normalizeEmojiForRest(emoji);

    await this.requestVoid(
      {
        method: "PUT",
        routeTemplate: "/channels/:id/messages/:id/reactions/:emoji/@me",
        majorParam: cid,
      },
      `/channels/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/reactions/${encodedEmoji}/@me`,
    );
  }

  async removeOwnReaction(
    channelId: Snowflake,
    messageId: Snowflake,
    emoji: string,
  ): Promise<void> {
    const cid = assertNonEmptyId(channelId, "channelId");
    const mid = assertNonEmptyId(messageId, "messageId");
    const encodedEmoji = normalizeEmojiForRest(emoji);

    await this.requestVoid(
      {
        method: "DELETE",
        routeTemplate: "/channels/:id/messages/:id/reactions/:emoji/@me",
        majorParam: cid,
      },
      `/channels/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/reactions/${encodedEmoji}/@me`,
    );
  }

  private async requestJson<T>(
    route: RateLimitRouteDescriptor,
    path: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<T> {
    const response = await this.dispatch(route, path, body, extraHeaders);
    const rawText = await this.readResponseText(response);

    if (!response.ok) {
      throw this.buildHttpError(response, rawText);
    }

    if (response.status === 204 || rawText.trim().length === 0) {
      return undefined as T;
    }

    try {
      return JSON.parse(rawText) as T;
    } catch (err) {
      throw new DiscordRestError(
        `Invalid JSON response from Discord REST API (${response.status} ${route.method} ${route.routeTemplate}).`,
        {
          httpStatus: response.status,
          isRateLimit: false,
          body: rawText,
          cause: err,
        },
      );
    }
  }

  private async requestVoid(
    route: RateLimitRouteDescriptor,
    path: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const response = await this.dispatch(route, path, body, extraHeaders);
    const rawText = await this.readResponseText(response);

    if (!response.ok) {
      throw this.buildHttpError(response, rawText);
    }
  }

  private async dispatch(
    route: RateLimitRouteDescriptor,
    path: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const url = `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(extraHeaders ?? {}),
    };

    const init: RequestInit = {
      method: route.method,
      headers,
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    try {
      return await this.rateLimiter.execute(route, () =>
        this.fetchImpl(url, init),
      );
    } catch (err) {
      if (err instanceof RateLimitError) {
        const errOptions: DiscordRestErrorOptions = {
          httpStatus: err.httpStatus,
          retryAfterMs: err.retryAfterMs,
          isRateLimit: true,
          cause: err,
        };
        if (err.discordCode !== undefined) {
          errOptions.discordCode = err.discordCode;
        }
        if (err.body !== undefined) {
          errOptions.body = err.body;
        }
        throw new DiscordRestError(err.message, errOptions);
      }
      throw err;
    }
  }

  private async readResponseText(response: Response): Promise<string> {
    if (typeof response.text === "function") {
      return response.text();
    }
    return "";
  }

  private buildHttpError(response: Response, rawText: string): DiscordRestError {
    const { parsedBody, discordCode, message } = parseDiscordErrorBody(rawText);
    const isRateLimit = response.status === 429;
    const parsedHeaders = parseRateLimitHeaders(response.headers);
    const bodyRecord =
      typeof parsedBody === "object" &&
      parsedBody !== null &&
      !Array.isArray(parsedBody)
        ? (parsedBody as Record<string, unknown>)
        : null;
    const bodyRetryAfterMs =
      bodyRecord !== null &&
      typeof bodyRecord["retry_after"] === "number" &&
      Number.isFinite(bodyRecord["retry_after"])
        ? secondsToMs(bodyRecord["retry_after"])
        : undefined;

    const retryAfterMs =
      parsedHeaders.retryAfterMs !== undefined || bodyRetryAfterMs !== undefined
        ? Math.max(parsedHeaders.retryAfterMs ?? 0, bodyRetryAfterMs ?? 0)
        : undefined;

    const errOptions: DiscordRestErrorOptions = {
      httpStatus: response.status,
      isRateLimit,
    };
    if (discordCode !== undefined) {
      errOptions.discordCode = discordCode;
    }
    if (retryAfterMs !== undefined) {
      errOptions.retryAfterMs = retryAfterMs;
    }
    if (parsedBody !== undefined) {
      errOptions.body = parsedBody;
    }

    return new DiscordRestError(
      message ?? `Discord REST API error (HTTP ${response.status}).`,
      errOptions,
    );
  }
}
