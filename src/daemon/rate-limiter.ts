import type {
  DiscordRateLimitErrorBody,
  RateLimitBucketSnapshot,
  RateLimitScope,
  RateLimitStatusSnapshot,
} from "../shared/types.js";

/**
 * Discord REST v10 `X-RateLimit-*` bucket queue scheduler and HTTP 429 compliance engine.
 */

const DEFAULT_MAX_RETRIES = 3;
const VALID_SCOPES: ReadonlySet<string> = new Set(["user", "global", "shared"]);

export type RateLimitHeadersInput =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface RateLimitResponseLike {
  readonly status: number;
  readonly headers: RateLimitHeadersInput;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
  clone?: () => RateLimitResponseLike;
  readonly body?: unknown;
}

export interface ParsedRateLimitHeaders {
  bucket?: string;
  limit?: number;
  remaining?: number;
  resetAfterMs?: number;
  global: boolean;
  scope?: RateLimitScope;
  retryAfterMs?: number;
}

export interface RateLimitRouteDescriptor {
  method: string;
  routeTemplate: string;
  majorParam?: string;
}

export interface RateLimiterOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

interface QueuedTask<T extends RateLimitResponseLike> {
  canonicalRouteKey: string;
  majorParam: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export interface BucketQueueState {
  bucketKey: string;
  bucketHash: string | null;
  routeKey: string;
  majorParam: string;
  limit: number;
  remaining: number;
  resetAfterMs: number;
  resetAtMs: number;
  hasLimitInfo: boolean;
  processing: boolean;
  queue: Array<QueuedTask<RateLimitResponseLike>>;
}

export interface RateLimitErrorOptions {
  httpStatus?: number;
  retryAfterMs: number;
  global: boolean;
  scope?: RateLimitScope;
  routeKey: string;
  bucketKey: string;
  attempts: number;
  discordCode?: number;
  body?: unknown;
}

export class RateLimitError extends Error {
  readonly httpStatus: number;
  readonly retryAfterMs: number;
  readonly global: boolean;
  readonly scope?: RateLimitScope;
  readonly routeKey: string;
  readonly bucketKey: string;
  readonly attempts: number;
  readonly discordCode?: number;
  readonly body?: unknown;

  constructor(message: string, options: RateLimitErrorOptions) {
    super(message);
    this.name = "RateLimitError";
    this.httpStatus = options.httpStatus ?? 429;
    this.retryAfterMs = options.retryAfterMs;
    this.global = options.global;
    if (options.scope !== undefined) {
      this.scope = options.scope;
    }
    this.routeKey = options.routeKey;
    this.bucketKey = options.bucketKey;
    this.attempts = options.attempts;
    if (options.discordCode !== undefined) {
      this.discordCode = options.discordCode;
    }
    if (options.body !== undefined) {
      this.body = options.body;
    }
  }
}

function normalizeMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  if (normalized.length === 0) {
    throw new TypeError("HTTP method must not be empty.");
  }
  return normalized;
}

function normalizeRouteTemplate(routeTemplate: string): string {
  const trimmed = routeTemplate.trim();
  const queryIdx = trimmed.indexOf("?");
  const hashIdx = trimmed.indexOf("#");
  const cutIdx =
    queryIdx === -1
      ? hashIdx
      : hashIdx === -1
        ? queryIdx
        : Math.min(queryIdx, hashIdx);
  const stripped = (cutIdx === -1 ? trimmed : trimmed.slice(0, cutIdx)).trim();
  if (stripped.length === 0) {
    throw new TypeError("Route template must not be empty.");
  }
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function normalizeMajorParam(majorParam?: string): string {
  if (majorParam === undefined) {
    return "global";
  }
  const trimmed = majorParam.trim();
  return trimmed.length > 0 ? trimmed : "global";
}

/**
 * Produces canonical route key `METHOD:routeTemplate:majorParam`
 * (where `majorParam` is `guild_id`, `channel_id`, `webhook_id`, or `"global"`).
 */
export function canonicalizeRouteKey(
  method: string,
  routeTemplate: string,
  majorParam?: string,
): string {
  return `${normalizeMethod(method)}:${normalizeRouteTemplate(routeTemplate)}:${normalizeMajorParam(majorParam)}`;
}

export function secondsToMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.ceil(Math.round(seconds * 1_000_000) / 1000);
}

function parseNonNegativeNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    return undefined;
  }
  return num;
}

function parseBooleanHeader(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

function buildHeaderLookup(
  headers: RateLimitHeadersInput,
): (name: string) => string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const webHeaders = headers as Headers;
    return (name: string) => {
      const value = webHeaders.get(name);
      return value === null ? undefined : value;
    };
  }

  const lowerMap = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      lowerMap.set(key.toLowerCase(), value);
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
      lowerMap.set(key.toLowerCase(), value[0]);
    }
  }
  return (name: string) => lowerMap.get(name.toLowerCase());
}

/**
 * Case-insensitively parses Discord `X-RateLimit-*` and `Retry-After` response headers.
 */
export function parseRateLimitHeaders(
  headers: RateLimitHeadersInput,
): ParsedRateLimitHeaders {
  const get = buildHeaderLookup(headers);

  const bucketRaw = get("x-ratelimit-bucket")?.trim();
  const limitRaw = parseNonNegativeNumber(get("x-ratelimit-limit"));
  const remainingRaw = parseNonNegativeNumber(get("x-ratelimit-remaining"));
  const resetAfterSec = parseNonNegativeNumber(get("x-ratelimit-reset-after"));
  const retryAfterSec = parseNonNegativeNumber(get("retry-after"));
  const globalRaw = parseBooleanHeader(get("x-ratelimit-global"));
  const scopeRaw = get("x-ratelimit-scope")?.trim().toLowerCase();

  const parsed: ParsedRateLimitHeaders = {
    global: globalRaw ?? false,
  };

  if (bucketRaw !== undefined && bucketRaw.length > 0) {
    parsed.bucket = bucketRaw;
  }
  if (limitRaw !== undefined) {
    parsed.limit = Math.floor(limitRaw);
  }
  if (remainingRaw !== undefined) {
    parsed.remaining = Math.floor(remainingRaw);
  }
  if (resetAfterSec !== undefined) {
    parsed.resetAfterMs = secondsToMs(resetAfterSec);
  }
  if (retryAfterSec !== undefined) {
    parsed.retryAfterMs = secondsToMs(retryAfterSec);
  }
  if (scopeRaw !== undefined && VALID_SCOPES.has(scopeRaw)) {
    parsed.scope = scopeRaw as RateLimitScope;
  }

  return parsed;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function asRateLimitBody(
  body: unknown,
): Partial<DiscordRateLimitErrorBody> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Partial<DiscordRateLimitErrorBody>;
}

async function read429Body(response: RateLimitResponseLike): Promise<unknown> {
  if (typeof response.clone === "function") {
    const cloned = response.clone();
    if (typeof cloned.text === "function") {
      const text = await cloned.text();
      return parseMaybeJson(text);
    }
    if (typeof cloned.json === "function") {
      try {
        return await cloned.json();
      } catch {
        return undefined;
      }
    }
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    return parseMaybeJson(text);
  }

  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  if ("body" in response && response.body !== undefined) {
    return response.body;
  }

  return undefined;
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

export class RateLimiter {
  private readonly routeToBucket = new Map<string, string>();
  private readonly buckets = new Map<string, BucketQueueState>();
  private globalBlockedUntilMs = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(
        `Invalid maxRetries "${String(maxRetries)}": expected a non-negative integer.`,
      );
    }
    this.maxRetries = maxRetries;
  }

  /**
   * Schedules a Discord REST request through the route's FIFO bucket queue,
   * enforcing preemptive bucket throttling, shared global blocking, and serialized 429 retries.
   */
  execute<T extends RateLimitResponseLike>(
    route: RateLimitRouteDescriptor | string,
    task: () => Promise<T>,
  ): Promise<T> {
    const { canonicalKey, majorParam } = this.resolveRouteIdentity(route);
    const bucketKey = this.resolveBucketKey(canonicalKey, majorParam);
    const bucket = this.getOrCreateBucket(bucketKey, canonicalKey, majorParam);

    return new Promise<T>((resolve, reject) => {
      bucket.queue.push({
        canonicalRouteKey: canonicalKey,
        majorParam,
        task: task as () => Promise<RateLimitResponseLike>,
        resolve: resolve as (value: RateLimitResponseLike) => void,
        reject,
      });
      void this.processBucket(bucket);
    });
  }

  getStatusSnapshot(): RateLimitStatusSnapshot {
    const currentNow = this.now();
    return {
      trackedBuckets: this.buckets.size,
      globalBlockedUntil:
        this.globalBlockedUntilMs > currentNow
          ? new Date(this.globalBlockedUntilMs).toISOString()
          : null,
    };
  }

  getBucketSnapshots(): RateLimitBucketSnapshot[] {
    const currentNow = this.now();
    const snapshots: RateLimitBucketSnapshot[] = [];
    for (const bucket of this.buckets.values()) {
      const remainingResetMs =
        bucket.resetAtMs > currentNow ? bucket.resetAtMs - currentNow : 0;
      snapshots.push({
        routeKey: bucket.routeKey,
        bucketHash: bucket.bucketHash ?? bucket.bucketKey,
        limit: bucket.limit,
        remaining: bucket.remaining,
        resetAfterMs: remainingResetMs,
        resetAt: new Date(
          bucket.resetAtMs > 0 ? bucket.resetAtMs : currentNow,
        ).toISOString(),
        queuedCount: bucket.queue.length,
      });
    }
    return snapshots;
  }

  private resolveRouteIdentity(route: RateLimitRouteDescriptor | string): {
    canonicalKey: string;
    majorParam: string;
  } {
    if (typeof route === "string") {
      const trimmed = route.trim();
      const firstColon = trimmed.indexOf(":");
      const lastColon = trimmed.lastIndexOf(":");
      if (firstColon > 0 && lastColon > firstColon) {
        const method = trimmed.slice(0, firstColon);
        const template = trimmed.slice(firstColon + 1, lastColon);
        const majorParam = normalizeMajorParam(trimmed.slice(lastColon + 1));
        return {
          canonicalKey: canonicalizeRouteKey(method, template, majorParam),
          majorParam,
        };
      }
      throw new TypeError(
        `Invalid route key "${route}": expected "METHOD:/template:majorParam" or descriptor object.`,
      );
    }

    const majorParam = normalizeMajorParam(route.majorParam);
    return {
      canonicalKey: canonicalizeRouteKey(
        route.method,
        route.routeTemplate,
        majorParam,
      ),
      majorParam,
    };
  }

  private resolveBucketKey(canonicalKey: string, majorParam: string): string {
    const bucketHash = this.routeToBucket.get(canonicalKey);
    if (bucketHash !== undefined) {
      return `${bucketHash}:${majorParam}`;
    }
    return canonicalKey;
  }

  private getOrCreateBucket(
    bucketKey: string,
    routeKey: string,
    majorParam: string,
  ): BucketQueueState {
    const existing = this.buckets.get(bucketKey);
    if (existing !== undefined) {
      return existing;
    }

    const bucketHash = this.routeToBucket.get(routeKey) ?? null;
    const created: BucketQueueState = {
      bucketKey,
      bucketHash,
      routeKey,
      majorParam,
      limit: 0,
      remaining: 0,
      resetAfterMs: 0,
      resetAtMs: 0,
      hasLimitInfo: false,
      processing: false,
      queue: [],
    };
    this.buckets.set(bucketKey, created);
    return created;
  }

  private async processBucket(bucket: BucketQueueState): Promise<void> {
    if (bucket.processing) {
      return;
    }
    bucket.processing = true;
    try {
      while (bucket.queue.length > 0) {
        const item = bucket.queue.shift()!;
        try {
          const response = await this.executeItemWithRetries(bucket, item);
          item.resolve(response);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      bucket.processing = false;
      if (bucket.queue.length > 0) {
        void this.processBucket(bucket);
      }
    }
  }

  private async executeItemWithRetries(
    initialBucket: BucketQueueState,
    item: QueuedTask<RateLimitResponseLike>,
  ): Promise<RateLimitResponseLike> {
    let activeBucket = initialBucket;
    let migratedTarget: BucketQueueState | null = null;
    let minWaitUntilMs = 0;

    try {
      for (let attempt = 0; ; attempt += 1) {
        await this.waitForDispatchWindow(activeBucket, minWaitUntilMs);

        const response = await item.task();
        const parsedHeaders = parseRateLimitHeaders(response.headers);
        const responseNow = this.now();
        const rawBody =
          response.status === 429 ? await read429Body(response) : undefined;

        const updatedBucket = this.updateBucketFromHeaders(
          activeBucket,
          item.canonicalRouteKey,
          item.majorParam,
          parsedHeaders,
          responseNow,
          response.status === 429,
        );
        if (updatedBucket !== activeBucket) {
          activeBucket = updatedBucket;
          migratedTarget = updatedBucket;
        }

        if (response.status !== 429) {
          return response;
        }

        const rateLimitBody = asRateLimitBody(rawBody);
        const bodyRetryAfterMs =
          typeof rateLimitBody?.retry_after === "number" &&
          Number.isFinite(rateLimitBody.retry_after)
            ? secondsToMs(rateLimitBody.retry_after)
            : undefined;
        const headerRetryAfterMs = parsedHeaders.retryAfterMs;

        const retryAfterMs =
          headerRetryAfterMs !== undefined || bodyRetryAfterMs !== undefined
            ? Math.max(headerRetryAfterMs ?? 0, bodyRetryAfterMs ?? 0)
            : (parsedHeaders.resetAfterMs ?? 0);

        const isGlobal =
          parsedHeaders.global ||
          rateLimitBody?.global === true ||
          parsedHeaders.scope === "global";
        const scope = parsedHeaders.scope ?? (isGlobal ? "global" : undefined);

        if (isGlobal && retryAfterMs > 0) {
          this.globalBlockedUntilMs = Math.max(
            this.globalBlockedUntilMs,
            responseNow + retryAfterMs,
          );
        } else if (scope !== "shared" && !isGlobal) {
          activeBucket.hasLimitInfo = true;
          activeBucket.remaining = parsedHeaders.remaining ?? 0;
          const effectiveResetAfter = Math.max(
            retryAfterMs,
            parsedHeaders.resetAfterMs ?? 0,
          );
          activeBucket.resetAfterMs = effectiveResetAfter;
          activeBucket.resetAtMs = Math.max(
            activeBucket.resetAtMs,
            responseNow + effectiveResetAfter,
          );
        }

        const attempts = attempt + 1;
        if (attempt >= this.maxRetries) {
          const message =
            typeof rateLimitBody?.message === "string" &&
            rateLimitBody.message.length > 0
              ? `Discord rate limit exceeded (HTTP 429): ${rateLimitBody.message}`
              : `Discord rate limit exceeded (HTTP 429) on ${item.canonicalRouteKey} after ${attempts} attempts.`;
          const errorOptions: RateLimitErrorOptions = {
            httpStatus: 429,
            retryAfterMs,
            global: isGlobal,
            routeKey: item.canonicalRouteKey,
            bucketKey: activeBucket.bucketKey,
            attempts,
          };
          if (scope !== undefined) {
            errorOptions.scope = scope;
          }
          if (typeof rateLimitBody?.code === "number") {
            errorOptions.discordCode = rateLimitBody.code;
          }
          if (rawBody !== undefined) {
            errorOptions.body = rawBody;
          }
          throw new RateLimitError(message, errorOptions);
        }

        minWaitUntilMs = responseNow + retryAfterMs;
      }
    } finally {
      if (
        migratedTarget !== null &&
        migratedTarget.queue.length > 0 &&
        !migratedTarget.processing
      ) {
        void this.processBucket(migratedTarget);
      }
    }
  }

  private async waitForDispatchWindow(
    bucket: BucketQueueState,
    minWaitUntilMs: number,
  ): Promise<void> {
    while (true) {
      const currentNow = this.now();
      const bucketBlockedUntil =
        bucket.hasLimitInfo && bucket.remaining <= 0 ? bucket.resetAtMs : 0;
      const targetUntilMs = Math.max(
        this.globalBlockedUntilMs,
        bucketBlockedUntil,
        minWaitUntilMs,
      );
      const waitMs = targetUntilMs - currentNow;
      if (waitMs <= 0) {
        break;
      }

      const observedGlobalUntil = this.globalBlockedUntilMs;
      await this.sleep(waitMs);
      const afterSleepNow = this.now();
      if (
        afterSleepNow <= currentNow &&
        this.globalBlockedUntilMs <= observedGlobalUntil
      ) {
        // Guard against unit-test stubbed sleep() paired with a non-advancing clock.
        break;
      }
    }
  }

  private updateBucketFromHeaders(
    currentBucket: BucketQueueState,
    canonicalRouteKey: string,
    majorParam: string,
    parsed: ParsedRateLimitHeaders,
    responseNow: number,
    is429: boolean,
  ): BucketQueueState {
    let bucket = currentBucket;
    bucket.routeKey = canonicalRouteKey;

    if (parsed.bucket !== undefined) {
      this.routeToBucket.set(canonicalRouteKey, parsed.bucket);
      const targetKey = `${parsed.bucket}:${majorParam}`;
      if (bucket.bucketKey !== targetKey) {
        bucket = this.migrateBucket(bucket, targetKey, parsed.bucket);
      } else {
        bucket.bucketHash = parsed.bucket;
      }
    }

    if (parsed.global) {
      const globalMs = Math.max(
        parsed.retryAfterMs ?? 0,
        parsed.resetAfterMs ?? 0,
      );
      if (globalMs > 0) {
        this.globalBlockedUntilMs = Math.max(
          this.globalBlockedUntilMs,
          responseNow + globalMs,
        );
      }
    }

    // Do not overwrite personal bucket remaining/limits on shared-scope 429s.
    if (is429 && parsed.scope === "shared") {
      return bucket;
    }

    if (
      parsed.limit !== undefined ||
      parsed.remaining !== undefined ||
      parsed.resetAfterMs !== undefined
    ) {
      bucket.hasLimitInfo = true;
      if (parsed.limit !== undefined) {
        bucket.limit = parsed.limit;
      }
      if (parsed.remaining !== undefined) {
        bucket.remaining = parsed.remaining;
      }
      if (parsed.resetAfterMs !== undefined) {
        bucket.resetAfterMs = parsed.resetAfterMs;
        bucket.resetAtMs = responseNow + parsed.resetAfterMs;
      }
    }

    return bucket;
  }

  private migrateBucket(
    source: BucketQueueState,
    targetKey: string,
    bucketHash: string,
  ): BucketQueueState {
    const existingTarget = this.buckets.get(targetKey);
    if (existingTarget === undefined) {
      this.buckets.delete(source.bucketKey);
      source.bucketKey = targetKey;
      source.bucketHash = bucketHash;
      this.buckets.set(targetKey, source);
      return source;
    }

    if (existingTarget === source) {
      source.bucketHash = bucketHash;
      return source;
    }

    this.buckets.delete(source.bucketKey);
    existingTarget.bucketHash = bucketHash;
    existingTarget.routeKey = source.routeKey;
    if (source.queue.length > 0) {
      existingTarget.queue.push(...source.queue);
      source.queue.length = 0;
    }
    return existingTarget;
  }
}
