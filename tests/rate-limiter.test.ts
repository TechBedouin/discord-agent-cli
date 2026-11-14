import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";

import {
  RateLimitError,
  RateLimiter,
  canonicalizeRouteKey,
  parseRateLimitHeaders,
  secondsToMs,
  type RateLimitResponseLike,
} from "../dist/daemon/rate-limiter.js";
import {
  DiscordRestClient,
  DiscordRestError,
} from "../dist/daemon/rest-client.js";
import {
  DEFAULT_DISCORD_DEBUG_OPTIONS,
  DEFAULT_DISCORD_LOCALE,
  DEFAULT_DISCORD_ORIGIN,
  DEFAULT_DISCORD_REFERER,
  DEFAULT_INVITE_CONTEXT_LOCATION,
  DEFAULT_SUPER_PROPERTIES,
  DEFAULT_USER_AGENT,
  DEFAULT_USER_MODE_USER_AGENT,
  MAX_TYPING_DELAY_MS,
  MIN_TYPING_DELAY_MS,
  buildUserModeDefaultHeaders,
  buildUserModeGatewayHeaders,
  calculateTypingDelayMs,
  encodeInviteContextProperties,
  resolveAutoTypingEnabled,
  resolveDiscordAuthMode,
  resolveDiscordTokenInfo,
} from "../dist/shared/config.js";
import { parseInviteCode } from "../dist/shared/ipc-protocol.js";
import {
  DiscordChannelType,
  type DiscordActiveThreadsResponse,
  type DiscordChannel,
  type DiscordInvite,
  type DiscordMessage,
  type DiscordPartialGuild,
} from "../dist/shared/types.js";

function createFakeClock(initialMs = 1_700_000_000_000) {
  let currentMs = initialMs;
  const sleeps: number[] = [];
  const onSleepHooks: Array<(ms: number, nowMs: number) => void | Promise<void>> = [];

  return {
    now: () => currentMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      const targetMs = currentMs + ms;
      for (const hook of onSleepHooks) {
        await hook(ms, currentMs);
      }
      currentMs = Math.max(currentMs, targetMs);
    },
    advance: (ms: number) => {
      currentMs += ms;
    },
    onSleep: (hook: (ms: number, nowMs: number) => void | Promise<void>) => {
      onSleepHooks.push(hook);
    },
    get sleeps() {
      return sleeps;
    },
  };
}

function makeMockResponse(
  status: number,
  headers: Record<string, string> = {},
  body?: unknown,
): RateLimitResponseLike {
  const headerObj = new Headers(headers);
  const rawBody =
    body === undefined
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body);

  return {
    status,
    headers: headerObj,
    text: async () => rawBody,
    json: async () => JSON.parse(rawBody) as unknown,
    clone: () => makeMockResponse(status, headers, body),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("rate-limiter & rest-client", () => {
  describe("canonicalizeRouteKey & header parsing", () => {
    it("canonicalizes METHOD:template:majorParam consistently", () => {
      assert.equal(
        canonicalizeRouteKey("post", "/channels/:id/messages", "123456"),
        "POST:/channels/:id/messages:123456",
      );
      assert.equal(
        canonicalizeRouteKey("get", "users/@me"),
        "GET:/users/@me:global",
      );
      assert.equal(
        canonicalizeRouteKey("DELETE", "guilds/:id/bans/:id", "   "),
        "DELETE:/guilds/:id/bans/:id:global",
      );
      assert.equal(
        canonicalizeRouteKey("get", "/users/@me/guilds?with_counts=true"),
        "GET:/users/@me/guilds:global",
      );
      assert.equal(
        canonicalizeRouteKey("POST", "/invites/:code?foo=bar#frag"),
        "POST:/invites/:code:global",
      );
      assert.throws(() => canonicalizeRouteKey("", "/channels/:id"), TypeError);
      assert.throws(() => canonicalizeRouteKey("GET", "   "), TypeError);
    });

    it("parses X-RateLimit-* and Retry-After headers case-insensitively", () => {
      const parsedFromHeaders = parseRateLimitHeaders(
        new Headers({
          "X-RateLimit-Bucket": "abc123",
          "x-ratelimit-limit": "5",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset-After": "1.25",
          "Retry-After": "2.5",
          "X-RateLimit-Global": "true",
          "X-RateLimit-Scope": "GLOBAL",
        }),
      );
      assert.deepEqual(parsedFromHeaders, {
        bucket: "abc123",
        limit: 5,
        remaining: 0,
        resetAfterMs: 1250,
        retryAfterMs: 2500,
        global: true,
        scope: "global",
      });

      const parsedFromRecord = parseRateLimitHeaders({
        "X-RATELIMIT-BUCKET": ["bucket-x"],
        "X-Ratelimit-Limit": "10",
        "X-Ratelimit-Remaining": "9",
        "X-Ratelimit-Reset-After": "0.125",
        "X-Ratelimit-Scope": "shared",
      });
      assert.deepEqual(parsedFromRecord, {
        bucket: "bucket-x",
        limit: 10,
        remaining: 9,
        resetAfterMs: 125,
        global: false,
        scope: "shared",
      });

      assert.equal(secondsToMs(0), 0);
      assert.equal(secondsToMs(-1), 0);
      assert.equal(secondsToMs(Number.NaN), 0);
      assert.equal(secondsToMs(0.0005), 1);
    });
  });

  describe("FIFO queuing & majorParam isolation", () => {
    it("serializes concurrent tasks on the same bucket in strict FIFO order without overlap", async () => {
      const clock = createFakeClock();
      const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep });

      const executionLog: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;

      const gate0 = createDeferred<void>();
      const gate1 = createDeferred<void>();

      const route = {
        method: "POST",
        routeTemplate: "/channels/:id/messages",
        majorParam: "chan-1",
      };

      const p0 = limiter.execute(route, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        executionLog.push("start-0");
        await gate0.promise;
        executionLog.push("end-0");
        inFlight -= 1;
        return makeMockResponse(200, {
          "X-RateLimit-Bucket": "msg-bucket",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "4",
          "X-RateLimit-Reset-After": "1",
        });
      });

      const p1 = limiter.execute(route, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        executionLog.push("start-1");
        await gate1.promise;
        executionLog.push("end-1");
        inFlight -= 1;
        return makeMockResponse(200);
      });

      const p2 = limiter.execute(route, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        executionLog.push("start-2");
        executionLog.push("end-2");
        inFlight -= 1;
        return makeMockResponse(200);
      });

      await Promise.resolve();
      assert.deepEqual(executionLog, ["start-0"]);

      gate0.resolve();
      await p0;
      await Promise.resolve();
      assert.deepEqual(executionLog, ["start-0", "end-0", "start-1"]);

      gate1.resolve();
      await Promise.all([p1, p2]);

      assert.equal(maxInFlight, 1);
      assert.deepEqual(executionLog, [
        "start-0",
        "end-0",
        "start-1",
        "end-1",
        "start-2",
        "end-2",
      ]);
    });

    it("runs different majorParams concurrently on separate buckets", async () => {
      const clock = createFakeClock();
      const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep });

      const started: string[] = [];
      const gateA = createDeferred<void>();
      const gateB = createDeferred<void>();

      const pA = limiter.execute(
        {
          method: "POST",
          routeTemplate: "/channels/:id/messages",
          majorParam: "chan-A",
        },
        async () => {
          started.push("A");
          await gateA.promise;
          return makeMockResponse(200);
        },
      );

      const pB = limiter.execute(
        {
          method: "POST",
          routeTemplate: "/channels/:id/messages",
          majorParam: "chan-B",
        },
        async () => {
          started.push("B");
          await gateB.promise;
          return makeMockResponse(200);
        },
      );

      await Promise.resolve();
      assert.deepEqual(started, ["A", "B"]);

      gateA.resolve();
      gateB.resolve();
      await Promise.all([pA, pB]);
      assert.equal(limiter.getStatusSnapshot().trackedBuckets, 2);
    });
  });

  describe("preemptive throttling, bucket migration, global gate & 429 retries", () => {
    it("preemptively throttles next request until X-RateLimit-Reset-After when remaining === 0", async () => {
      const clock = createFakeClock(10_000);
      const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep });
      const route = {
        method: "POST",
        routeTemplate: "/channels/:id/messages",
        majorParam: "c1",
      };

      const dispatchTimes: number[] = [];

      await limiter.execute(route, async () => {
        dispatchTimes.push(clock.now());
        return makeMockResponse(200, {
          "X-RateLimit-Bucket": "b-send",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset-After": "1.5",
        });
      });

      const snapshotsBeforeWait = limiter.getBucketSnapshots();
      assert.equal(snapshotsBeforeWait.length, 1);
      assert.equal(snapshotsBeforeWait[0]!.remaining, 0);
      assert.equal(snapshotsBeforeWait[0]!.limit, 5);
      assert.equal(snapshotsBeforeWait[0]!.resetAfterMs, 1500);

      await limiter.execute(route, async () => {
        dispatchTimes.push(clock.now());
        return makeMockResponse(200, {
          "X-RateLimit-Bucket": "b-send",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "4",
          "X-RateLimit-Reset-After": "5",
        });
      });

      assert.deepEqual(clock.sleeps, [1500]);
      assert.deepEqual(dispatchTimes, [10_000, 11_500]);
      assert.equal(limiter.getBucketSnapshots()[0]!.remaining, 4);
    });

    it("migrates provisional route buckets to X-RateLimit-Bucket hashes and merges queued tasks", async () => {
      const clock = createFakeClock(50_000);
      const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep });

      const routeGet = {
        method: "GET",
        routeTemplate: "/channels/:id/messages",
        majorParam: "chan-9",
      };
      const routeDelete = {
        method: "DELETE",
        routeTemplate: "/channels/:id/messages/:id",
        majorParam: "chan-9",
      };

      // First route discovers shared hash "shared-hash-1".
      await limiter.execute(routeGet, async () =>
        makeMockResponse(200, {
          "X-RateLimit-Bucket": "shared-hash-1",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "3",
          "X-RateLimit-Reset-After": "4",
        }),
      );
      assert.equal(limiter.getStatusSnapshot().trackedBuckets, 1);
      assert.equal(limiter.getBucketSnapshots()[0]!.bucketHash, "shared-hash-1");

      // Second route starts in its own provisional bucket while two items enqueue,
      // then discovers it shares "shared-hash-1" and merges the queued task cleanly.
      const order: string[] = [];
      const gateFirstDelete = createDeferred<void>();

      const d1 = limiter.execute(routeDelete, async () => {
        order.push("d1");
        await gateFirstDelete.promise;
        return makeMockResponse(204, {
          "X-RateLimit-Bucket": "shared-hash-1",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset-After": "1.25",
        });
      });

      const d2 = limiter.execute(routeDelete, async () => {
        order.push(`d2@${clock.now()}`);
        return makeMockResponse(204, {
          "X-RateLimit-Bucket": "shared-hash-1",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "4",
          "X-RateLimit-Reset-After": "5",
        });
      });

      await Promise.resolve();
      // While d1 is still in flight, provisional bucket exists alongside shared-hash-1:chan-9.
      assert.equal(limiter.getStatusSnapshot().trackedBuckets, 2);

      gateFirstDelete.resolve();
      await Promise.all([d1, d2]);

      assert.equal(limiter.getStatusSnapshot().trackedBuckets, 1);
      assert.deepEqual(clock.sleeps, [1250]);
      assert.deepEqual(order, ["d1", "d2@51250"]);

      // Subsequent call on routeDelete resolves straight to "shared-hash-1:chan-9".
      await limiter.execute(routeDelete, async () => makeMockResponse(204));
      assert.equal(limiter.getStatusSnapshot().trackedBuckets, 1);
    });

    it("enforces X-RateLimit-Global / body global:true across all buckets", async () => {
      const clock = createFakeClock(100_000);
      const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep });

      const bucketA = {
        method: "POST",
        routeTemplate: "/channels/:id/messages",
        majorParam: "chan-A",
      };
      const bucketB = {
        method: "GET",
        routeTemplate: "/guilds/:id",
        majorParam: "guild-B",
      };

      const times: Record<string, number[]> = { A: [], B: [] };
      let aCalls = 0;
      const firstSleepEntered = createDeferred<void>();
      const releaseSleeps = createDeferred<void>();
      let firstSleepSignaled = false;

      clock.onSleep(async () => {
        if (!firstSleepSignaled) {
          firstSleepSignaled = true;
          firstSleepEntered.resolve();
        }
        await releaseSleeps.promise;
      });

      const pA = limiter.execute(bucketA, async () => {
        aCalls += 1;
        times["A"]!.push(clock.now());
        if (aCalls === 1) {
          return makeMockResponse(
            429,
            {
              "X-RateLimit-Global": "true",
              "Retry-After": "2.0",
            },
            {
              message: "Global rate limit hit",
              retry_after: 2.5,
              global: true,
            },
          );
        }
        return makeMockResponse(200);
      });

      await firstSleepEntered.promise;
      assert.equal(
        limiter.getStatusSnapshot().globalBlockedUntil,
        new Date(102_500).toISOString(),
      );

      const pB = limiter.execute(bucketB, async () => {
        times["B"]!.push(clock.now());
        return makeMockResponse(200);
      });

      // Let pB enter waitForDispatchWindow -> sleep(2500) before releasing sleeps.
      await Promise.resolve();
      releaseSleeps.resolve();

      await Promise.all([pA, pB]);

      assert.deepEqual(times["A"], [100_000, 102_500]);
      assert.deepEqual(times["B"], [102_500]);
      assert.equal(limiter.getStatusSnapshot().globalBlockedUntil, null);
    });

    it("retries HTTP 429 using max(header Retry-After, body retry_after) and throws RateLimitError on exhaustion", async () => {
      const clock = createFakeClock(200_000);
      const retryLimiter = new RateLimiter({
        now: clock.now,
        sleep: clock.sleep,
        maxRetries: 2,
      });

      const route = "POST:/channels/:id/messages:c1";
      let calls = 0;
      const res = await retryLimiter.execute(route, async () => {
        calls += 1;
        if (calls === 1) {
          return makeMockResponse(
            429,
            {
              "X-RateLimit-Bucket": "retry-bucket",
              "Retry-After": "0.5",
            },
            {
              message: "Bucket limit",
              retry_after: 1.75,
              global: false,
            },
          );
        }
        return makeMockResponse(200, { "X-RateLimit-Remaining": "4" });
      });

      assert.equal(res.status, 200);
      assert.equal(calls, 2);
      assert.deepEqual(clock.sleeps, [1750]);

      const exhaustClock = createFakeClock(300_000);
      const exhaustLimiter = new RateLimiter({
        now: exhaustClock.now,
        sleep: exhaustClock.sleep,
        maxRetries: 2,
      });
      let failAttempts = 0;

      await assert.rejects(
        () =>
          exhaustLimiter.execute(route, async () => {
            failAttempts += 1;
            return makeMockResponse(
              429,
              {
                "X-RateLimit-Bucket": "exhaust-b",
                "Retry-After": "0.25",
              },
              {
                code: 20016,
                message: "Slow down",
                retry_after: 0.25,
                global: false,
              },
            );
          }),
        (err: unknown) => {
          assert.ok(err instanceof RateLimitError);
          assert.equal(err.httpStatus, 429);
          assert.equal(err.attempts, 3);
          assert.equal(err.retryAfterMs, 250);
          assert.equal(err.global, false);
          assert.equal(err.discordCode, 20016);
          assert.equal(err.routeKey, "POST:/channels/:id/messages:c1");
          assert.equal(err.bucketKey, "exhaust-b:c1");
          assert.match(err.message, /Slow down/);
          return true;
        },
      );
      assert.equal(failAttempts, 3);
      assert.deepEqual(exhaustClock.sleeps, [250, 250]);
    });

    it('preserves personal bucket remaining on X-RateLimit-Scope: "shared" 429s', async () => {
      const clock = createFakeClock(400_000);
      const limiter = new RateLimiter({
        now: clock.now,
        sleep: clock.sleep,
        maxRetries: 1,
      });
      const route = {
        method: "POST",
        routeTemplate: "/channels/:id/messages",
        majorParam: "shared-chan",
      };

      await limiter.execute(route, async () =>
        makeMockResponse(200, {
          "X-RateLimit-Bucket": "personal-bucket",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "4",
          "X-RateLimit-Reset-After": "10",
        }),
      );

      let remainingDuringSharedBackoff: number | undefined;
      clock.onSleep(() => {
        remainingDuringSharedBackoff = limiter.getBucketSnapshots()[0]?.remaining;
      });

      let attempt = 0;
      const result = await limiter.execute(route, async () => {
        attempt += 1;
        if (attempt === 1) {
          return makeMockResponse(
            429,
            {
              "X-RateLimit-Bucket": "personal-bucket",
              "X-RateLimit-Limit": "5",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": "0.5",
              "X-RateLimit-Scope": "shared",
              "Retry-After": "0.5",
            },
            {
              message: "Shared resource rate limit",
              retry_after: 0.5,
              global: false,
            },
          );
        }
        return makeMockResponse(200, {
          "X-RateLimit-Bucket": "personal-bucket",
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "3",
          "X-RateLimit-Reset-After": "9",
        });
      });

      assert.equal(result.status, 200);
      assert.equal(remainingDuringSharedBackoff, 4);
      assert.equal(limiter.getBucketSnapshots()[0]!.remaining, 3);
      assert.deepEqual(clock.sleeps, [500]);

      // Also verify exhaustion on shared 429 preserves personal remaining & records scope="shared".
      await assert.rejects(
        () =>
          limiter.execute(route, async () =>
            makeMockResponse(
              429,
              {
                "X-RateLimit-Bucket": "personal-bucket",
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Scope": "shared",
                "Retry-After": "0.2",
              },
              { message: "Still shared limited", retry_after: 0.2, global: false },
            ),
          ),
        (err: unknown) => {
          assert.ok(err instanceof RateLimitError);
          assert.equal(err.scope, "shared");
          return true;
        },
      );
      assert.equal(limiter.getBucketSnapshots()[0]!.remaining, 3);
    });
  });

  describe("DiscordRestClient", () => {
    const serversToClose: http.Server[] = [];

    after(async () => {
      await Promise.all(
        serversToClose.map(
          (srv) =>
            new Promise<void>((resolve, reject) => {
              srv.closeAllConnections();
              srv.close((err) => (err ? reject(err) : resolve()));
            }),
        ),
      );
    });

    it("injects Authorization: Bot header, handles 204 No Content, normalizes emojis, and maps Discord errors over local HTTP", async () => {
      const captured: Array<{
        method: string | undefined;
        url: string | undefined;
        auth: string | undefined;
        contentType: string | undefined;
        body: string;
      }> = [];

      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bodyText = Buffer.concat(chunks).toString("utf8");
        captured.push({
          method: req.method,
          url: req.url,
          auth: req.headers["authorization"],
          contentType: req.headers["content-type"],
          body: bodyText,
        });

        if (req.method === "GET" && req.url === "/api/v10/users/@me") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "1001",
              username: "TestBot",
              discriminator: "0",
              bot: true,
            }),
          );
          return;
        }

        if (
          req.method === "POST" &&
          req.url === "/api/v10/channels/2002/messages"
        ) {
          const parsed = JSON.parse(bodyText) as { content: string };
          const msg: DiscordMessage = {
            id: "3003",
            channel_id: "2002",
            author: {
              id: "1001",
              username: "TestBot",
              discriminator: "0",
              bot: true,
            },
            content: parsed.content,
            timestamp: "2026-11-13T18:00:00.000Z",
            type: 0,
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(msg));
          return;
        }

        if (
          (req.method === "PUT" || req.method === "DELETE") &&
          req.url?.startsWith("/api/v10/channels/2002/messages/3003/reactions/")
        ) {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/api/v10/channels/9999") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: 50001,
              message: "Missing Access",
            }),
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 10003, message: "Unknown Channel" }));
      });

      serversToClose.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");

      const client = new DiscordRestClient({
        token: "Bot secret-bot-token",
        apiBaseUrl: `http://127.0.0.1:${address.port}/api/v10`,
      });

      const me = await client.getCurrentUser();
      assert.equal(me.id, "1001");

      const sent = await client.createMessage("2002", {
        content: "hello from test",
        message_reference: { message_id: "2999", fail_if_not_exists: false },
      });
      assert.equal(sent.id, "3003");
      assert.equal(sent.content, "hello from test");

      await client.addReaction("2002", "3003", "🔥");
      await client.addReaction("2002", "3003", "<:party:12345>");
      await client.removeOwnReaction("2002", "3003", "<a:spin:67890>");

      await assert.rejects(
        () => client.getChannel("9999"),
        (err: unknown) => {
          assert.ok(err instanceof DiscordRestError);
          assert.equal(err.httpStatus, 403);
          assert.equal(err.discordCode, 50001);
          assert.equal(err.isRateLimit, false);
          assert.equal(err.message, "Missing Access");
          return true;
        },
      );

      assert.equal(captured[0]!.auth, "Bot secret-bot-token");
      assert.equal(captured[0]!.contentType, undefined);
      assert.equal(captured[1]!.contentType, "application/json");
      assert.equal(
        captured[2]!.url,
        "/api/v10/channels/2002/messages/3003/reactions/%F0%9F%94%A5/@me",
      );
      assert.equal(
        captured[3]!.url,
        "/api/v10/channels/2002/messages/3003/reactions/party%3A12345/@me",
      );
      assert.equal(
        captured[4]!.url,
        "/api/v10/channels/2002/messages/3003/reactions/spin%3A67890/@me",
      );
    });

    it("maps exhausted RateLimitError into DiscordRestError with isRateLimit=true and validates inputs", async () => {
      const clock = createFakeClock();
      const limiter = new RateLimiter({
        now: clock.now,
        sleep: clock.sleep,
        maxRetries: 1,
      });

      const client = new DiscordRestClient({
        token: "test-token",
        rateLimiter: limiter,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              code: 20016,
              message: "Too many messages",
              retry_after: 0.75,
              global: false,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0.75",
              },
            },
          ),
      });

      await assert.rejects(
        () => client.getChannelMessages("555", { limit: 10, before: "600" }),
        (err: unknown) => {
          assert.ok(err instanceof DiscordRestError);
          assert.equal(err.httpStatus, 429);
          assert.equal(err.isRateLimit, true);
          assert.equal(err.retryAfterMs, 750);
          assert.equal(err.discordCode, 20016);
          return true;
        },
      );

      assert.throws(
        () => client.getChannelMessages("555", { limit: 101 }),
        RangeError,
      );
      assert.throws(() => new DiscordRestClient({ token: "   " }), TypeError);
      assert.throws(() => new DiscordRestClient({ token: "" }), TypeError);
    });

    it("supports user mode headers/raw token vs bot mode headers and executes all new REST endpoints with canonical rate-limit keys", async () => {
      const captured: Array<{
        method: string | undefined;
        url: string | undefined;
        headers: http.IncomingHttpHeaders;
        body: string;
      }> = [];

      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bodyText = Buffer.concat(chunks).toString("utf8");
        captured.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: bodyText,
        });

        if (req.method === "GET" && req.url === "/api/v10/gateway") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ url: "wss://gateway.discord.gg" }));
          return;
        }

        if (req.method === "POST" && req.url === "/api/v10/invites/xyz123") {
          const invite: DiscordInvite = {
            code: "xyz123",
            guild: { id: "700", name: "Joined Guild", icon: "icon-1" },
            channel: {
              id: "701",
              name: "welcome",
              type: DiscordChannelType.GUILD_TEXT,
            },
            approximate_member_count: 42,
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(invite));
          return;
        }

        if (
          req.method === "GET" &&
          req.url === "/api/v10/users/@me/guilds?with_counts=true"
        ) {
          const guilds: DiscordPartialGuild[] = [
            {
              id: "700",
              name: "Joined Guild",
              owner: true,
              approximate_member_count: 42,
              approximate_presence_count: 10,
            },
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(guilds));
          return;
        }

        if (req.method === "GET" && req.url === "/api/v10/guilds/700/channels") {
          const channels: DiscordChannel[] = [
            {
              id: "701",
              type: DiscordChannelType.GUILD_TEXT,
              guild_id: "700",
              name: "welcome",
              position: 0,
            },
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(channels));
          return;
        }

        if (
          req.method === "GET" &&
          req.url === "/api/v10/guilds/700/threads/active"
        ) {
          const threadsResp: DiscordActiveThreadsResponse = {
            threads: [
              {
                id: "702",
                type: DiscordChannelType.PUBLIC_THREAD,
                guild_id: "700",
                parent_id: "701",
                name: "active-topic",
              },
            ],
            has_more: false,
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(threadsResp));
          return;
        }

        if (req.method === "GET" && req.url === "/api/v10/users/@me/channels") {
          const dms: DiscordChannel[] = [
            {
              id: "801",
              type: DiscordChannelType.DM,
              recipients: [
                { id: "901", username: "alice", discriminator: "0" },
              ],
            },
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(dms));
          return;
        }

        if (req.method === "POST" && req.url === "/api/v10/users/@me/channels") {
          const parsed = JSON.parse(bodyText) as { recipient_id: string };
          const dm: DiscordChannel = {
            id: "802",
            type: DiscordChannelType.DM,
            recipients: [
              {
                id: parsed.recipient_id,
                username: "bob",
                discriminator: "0",
              },
            ],
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(dm));
          return;
        }

        if (req.method === "POST" && req.url === "/api/v10/channels/802/typing") {
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0, message: "Not Found" }));
      });

      serversToClose.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const apiBaseUrl = `http://127.0.0.1:${address.port}/api/v10`;

      // User mode (default inferred from raw token without "Bot " prefix).
      const userClient = new DiscordRestClient({
        token: "raw-user-token-abc",
        apiBaseUrl,
      });
      assert.equal(userClient.getAuthMode(), "user");
      assert.equal(userClient.authMode, "user");

      const gw = await userClient.getGateway();
      assert.equal(gw.url, "wss://gateway.discord.gg");

      const invite = await userClient.acceptInvite(
        "https://discord.com/invite/xyz123?event=1",
      );
      assert.equal(invite.code, "xyz123");
      assert.equal(invite.guild?.id, "700");

      const guilds = await userClient.getCurrentUserGuilds();
      assert.equal(guilds.length, 1);
      assert.equal(guilds[0]!.id, "700");

      const channels = await userClient.getGuildChannels("700");
      assert.equal(channels[0]!.id, "701");

      const activeThreads = await userClient.getGuildActiveThreads("700");
      assert.equal(activeThreads.threads[0]!.id, "702");

      const dms = await userClient.getUserDms();
      assert.equal(dms[0]!.id, "801");

      const createdDm = await userClient.createDm("902");
      assert.equal(createdDm.id, "802");

      const typingResult = await userClient.triggerTyping("802");
      assert.equal(typingResult, undefined);

      // Verify user-mode headers on captured requests.
      const firstReq = captured[0]!;
      assert.equal(firstReq.headers["authorization"], "raw-user-token-abc");
      assert.equal(firstReq.headers["user-agent"], DEFAULT_USER_MODE_USER_AGENT);
      assert.equal(firstReq.headers["origin"], DEFAULT_DISCORD_ORIGIN);
      assert.equal(firstReq.headers["referer"], DEFAULT_DISCORD_REFERER);
      assert.equal(
        firstReq.headers["x-debug-options"],
        DEFAULT_DISCORD_DEBUG_OPTIONS,
      );
      assert.equal(firstReq.headers["x-discord-locale"], DEFAULT_DISCORD_LOCALE);
      assert.equal(typeof firstReq.headers["x-discord-timezone"], "string");
      assert.ok((firstReq.headers["x-discord-timezone"] as string).length > 0);
      assert.equal(firstReq.headers["x-context-properties"], undefined);
      const rawSuperProps = firstReq.headers["x-super-properties"];
      assert.equal(typeof rawSuperProps, "string");
      const decodedProps = JSON.parse(
        Buffer.from(rawSuperProps as string, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      assert.equal(decodedProps["os"], "Windows");
      assert.equal(decodedProps["browser"], "Discord Client");
      assert.equal(
        decodedProps["browser_user_agent"],
        DEFAULT_USER_MODE_USER_AGENT,
      );
      assert.equal(decodedProps["browser_version"], "44.9.3");
      assert.equal(decodedProps["client_build_number"], 520000);
      assert.equal(decodedProps["native_build_number"], 85000);
      assert.equal(decodedProps["system_locale"], DEFAULT_DISCORD_LOCALE);

      // Verify acceptInvite sent `{}` JSON body and X-Context-Properties header in user mode.
      assert.equal(captured[1]!.body, "{}");
      assert.equal(captured[1]!.headers["content-type"], "application/json");
      const rawInviteContext = captured[1]!.headers["x-context-properties"];
      assert.equal(typeof rawInviteContext, "string");
      assert.deepEqual(
        JSON.parse(
          Buffer.from(rawInviteContext as string, "base64").toString("utf8"),
        ),
        { location: DEFAULT_INVITE_CONTEXT_LOCATION },
      );
      // Verify createDm sent `{ recipient_id: "902" }`.
      assert.deepEqual(JSON.parse(captured[6]!.body), { recipient_id: "902" });

      // Verify rate limiter bucket routeKeys (including ?with_counts=true stripped).
      const routeKeys = userClient
        .getRateLimitBuckets()
        .map((b) => b.routeKey);
      assert.ok(routeKeys.includes("GET:/gateway:global"));
      assert.ok(routeKeys.includes("POST:/invites/:code:global"));
      assert.ok(routeKeys.includes("GET:/users/@me/guilds:global"));
      assert.ok(routeKeys.includes("GET:/guilds/:id/channels:700"));
      assert.ok(routeKeys.includes("GET:/guilds/:id/threads/active:700"));
      assert.ok(routeKeys.includes("GET:/users/@me/channels:global"));
      assert.ok(routeKeys.includes("POST:/users/@me/channels:global"));
      assert.ok(routeKeys.includes("POST:/channels/:id/typing:802"));

      // Bot mode (explicit authMode: "bot" with raw token, and inferred from "Bot " prefix).
      const botClient = new DiscordRestClient({
        token: "raw-bot-token",
        authMode: "bot",
        apiBaseUrl,
      });
      assert.equal(botClient.getAuthMode(), "bot");
      await botClient.getGateway();
      const botReq = captured[captured.length - 1]!;
      assert.equal(botReq.headers["authorization"], "Bot raw-bot-token");
      assert.equal(botReq.headers["user-agent"], DEFAULT_USER_AGENT);
      assert.equal(botReq.headers["origin"], undefined);
      assert.equal(botReq.headers["referer"], undefined);
      assert.equal(botReq.headers["x-debug-options"], undefined);
      assert.equal(botReq.headers["x-discord-locale"], undefined);
      assert.equal(botReq.headers["x-discord-timezone"], undefined);
      assert.equal(botReq.headers["x-super-properties"], undefined);
      assert.equal(botReq.headers["x-context-properties"], undefined);

      await botClient.acceptInvite("xyz123");
      const botInviteReq = captured[captured.length - 1]!;
      assert.equal(botInviteReq.headers["x-context-properties"], undefined);

      // Explicit authMode: "user" overrides a "Bot " prefixed token.
      const forcedUserClient = new DiscordRestClient({
        token: "Bot forced-user-tok",
        authMode: "user",
        locale: "fr",
        timezone: "Europe/Berlin",
        superProperties: { os: "Linux" },
        apiBaseUrl,
      });
      assert.equal(forcedUserClient.getAuthMode(), "user");
      await forcedUserClient.getGateway();
      const forcedReq = captured[captured.length - 1]!;
      assert.equal(forcedReq.headers["authorization"], "forced-user-tok");
      assert.equal(forcedReq.headers["origin"], DEFAULT_DISCORD_ORIGIN);
      assert.equal(forcedReq.headers["referer"], DEFAULT_DISCORD_REFERER);
      assert.equal(
        forcedReq.headers["x-debug-options"],
        DEFAULT_DISCORD_DEBUG_OPTIONS,
      );
      assert.equal(forcedReq.headers["x-discord-locale"], "fr");
      assert.equal(forcedReq.headers["x-discord-timezone"], "Europe/Berlin");
      const forcedProps = JSON.parse(
        Buffer.from(forcedReq.headers["x-super-properties"] as string, "base64").toString(
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(forcedProps["os"], "Linux");
      assert.equal(forcedProps["system_locale"], "fr");

      // Input validation on new REST methods.
      assert.throws(() => userClient.acceptInvite("   "), TypeError);
      assert.throws(() => userClient.getGuildChannels(""), TypeError);
      assert.throws(() => userClient.getGuildActiveThreads("  "), TypeError);
      assert.throws(() => userClient.createDm(""), TypeError);
      await assert.rejects(() => userClient.triggerTyping("   "), TypeError);
    });
  });

  describe("auth mode, token info, typing delay & invite helpers", () => {
    it("resolves DISCORD_AUTH_MODE=user|bot and DISCORD_TOKEN / DISCORD_BOT_TOKEN metadata", () => {
      // Defaults to user mode for raw tokens or empty env.
      assert.equal(resolveDiscordAuthMode({}), "user");
      assert.equal(resolveDiscordAuthMode({ DISCORD_TOKEN: "raw-u" }), "user");
      // Auto-detects bot mode when token starts with "Bot ".
      assert.equal(
        resolveDiscordAuthMode({ DISCORD_TOKEN: "Bot secret-b" }),
        "bot",
      );
      assert.equal(
        resolveDiscordAuthMode({ DISCORD_BOT_TOKEN: "Bot fallback-b" }),
        "bot",
      );
      // Explicit DISCORD_AUTH_MODE overrides token prefix (case-insensitive).
      assert.equal(
        resolveDiscordAuthMode({
          DISCORD_AUTH_MODE: "USER",
          DISCORD_TOKEN: "Bot overridden",
        }),
        "user",
      );
      assert.equal(
        resolveDiscordAuthMode({
          DISCORD_AUTH_MODE: "bot",
          DISCORD_TOKEN: "raw-bot",
        }),
        "bot",
      );
      assert.throws(
        () => resolveDiscordAuthMode({ DISCORD_AUTH_MODE: "invalid" }),
        RangeError,
      );

      assert.equal(resolveDiscordTokenInfo({}), null);
      assert.equal(resolveDiscordTokenInfo({ DISCORD_TOKEN: "   " }), null);

      assert.deepEqual(
        resolveDiscordTokenInfo({ DISCORD_TOKEN: "user-token-1" }),
        {
          token: "user-token-1",
          rawToken: "user-token-1",
          authMode: "user",
          authorizationHeader: "user-token-1",
        },
      );

      assert.deepEqual(
        resolveDiscordTokenInfo({ DISCORD_TOKEN: "Bot bot-token-1" }),
        {
          token: "bot-token-1",
          rawToken: "Bot bot-token-1",
          authMode: "bot",
          authorizationHeader: "Bot bot-token-1",
        },
      );

      assert.deepEqual(
        resolveDiscordTokenInfo({
          DISCORD_AUTH_MODE: "bot",
          DISCORD_BOT_TOKEN: "raw-bot-fallback",
        }),
        {
          token: "raw-bot-fallback",
          rawToken: "raw-bot-fallback",
          authMode: "bot",
          authorizationHeader: "Bot raw-bot-fallback",
        },
      );

      assert.deepEqual(
        resolveDiscordTokenInfo({
          DISCORD_AUTH_MODE: "user",
          DISCORD_TOKEN: "Bot forced-raw",
        }),
        {
          token: "forced-raw",
          rawToken: "Bot forced-raw",
          authMode: "user",
          authorizationHeader: "forced-raw",
        },
      );
    });

    it("calculates typing delay clamped to 800..3500ms and resolves DISCORD_AUTO_TYPING", () => {
      assert.equal(calculateTypingDelayMs(""), MIN_TYPING_DELAY_MS);
      assert.equal(calculateTypingDelayMs("hi"), MIN_TYPING_DELAY_MS);
      assert.equal(calculateTypingDelayMs(20), 800);
      assert.equal(calculateTypingDelayMs("a".repeat(30)), 1200);
      assert.equal(calculateTypingDelayMs(50), 2000);
      assert.equal(calculateTypingDelayMs("a".repeat(200)), MAX_TYPING_DELAY_MS);
      assert.equal(calculateTypingDelayMs(Number.NaN), MIN_TYPING_DELAY_MS);
      assert.equal(calculateTypingDelayMs(-10), MIN_TYPING_DELAY_MS);

      assert.equal(resolveAutoTypingEnabled(undefined, {}), false);
      assert.equal(
        resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "1" }),
        true,
      );
      assert.equal(
        resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "TRUE" }),
        true,
      );
      assert.equal(
        resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "yes" }),
        true,
      );
      assert.equal(
        resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "0" }),
        false,
      );
      assert.equal(
        resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "false" }),
        false,
      );
      assert.equal(
        resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "no" }),
        false,
      );
      assert.equal(
        resolveAutoTypingEnabled(true, { DISCORD_AUTO_TYPING: "false" }),
        true,
      );
      assert.equal(
        resolveAutoTypingEnabled(false, { DISCORD_AUTO_TYPING: "1" }),
        false,
      );
      assert.throws(
        () => resolveAutoTypingEnabled(undefined, { DISCORD_AUTO_TYPING: "maybe" }),
        RangeError,
      );
    });

    it("parses raw invite codes and Discord invite URLs and rejects invalid inputs", () => {
      assert.equal(parseInviteCode("discord-api"), "discord-api");
      assert.equal(parseInviteCode("  abc_123-XYZ "), "abc_123-XYZ");
      assert.equal(parseInviteCode("discord.gg/xyz"), "xyz");
      assert.equal(parseInviteCode("www.discord.gg/xyz"), "xyz");
      assert.equal(parseInviteCode("ptb.discord.gg/ptb-code"), "ptb-code");
      assert.equal(
        parseInviteCode("https://canary.discord.gg/canary-code?event=1"),
        "canary-code",
      );
      assert.equal(parseInviteCode("https://discord.gg/xyz/"), "xyz");
      assert.equal(
        parseInviteCode("https://discord.com/invite/xyz?event=1"),
        "xyz",
      );
      assert.equal(
        parseInviteCode("ptb.discord.com/invite/ptb-invite"),
        "ptb-invite",
      );
      assert.equal(
        parseInviteCode("http://canary.discordapp.com/invite/my_code#frag"),
        "my_code",
      );

      assert.throws(() => parseInviteCode("   "), TypeError);
      assert.throws(
        () => parseInviteCode("https://example.com/invite/xyz"),
        TypeError,
      );
      assert.throws(
        () => parseInviteCode("https://foo.discord.gg/xyz"),
        TypeError,
      );
      assert.throws(
        () => parseInviteCode("https://discord.com/channels/123"),
        TypeError,
      );
      assert.throws(() => parseInviteCode("discord.gg/a/b"), TypeError);
      assert.throws(() => parseInviteCode("invalid code!"), TypeError);
    });

    it("hardens user-mode default headers, gateway headers, and invite context properties", () => {
      assert.match(
        DEFAULT_USER_MODE_USER_AGENT,
        /Chrome\/152\.0\.7977\.167 Electron\/44\.9\.3/,
      );
      assert.equal(
        DEFAULT_SUPER_PROPERTIES.browser_user_agent,
        DEFAULT_USER_MODE_USER_AGENT,
      );
      assert.equal(DEFAULT_SUPER_PROPERTIES.browser_version, "44.9.3");
      assert.equal(DEFAULT_SUPER_PROPERTIES.client_build_number, 520000);
      assert.equal(DEFAULT_SUPER_PROPERTIES.native_build_number, 85000);

      assert.deepEqual(buildUserModeGatewayHeaders(), {
        "User-Agent": DEFAULT_USER_MODE_USER_AGENT,
        Origin: DEFAULT_DISCORD_ORIGIN,
      });
      assert.deepEqual(buildUserModeGatewayHeaders("CustomAgent/1.0"), {
        "User-Agent": "CustomAgent/1.0",
        Origin: DEFAULT_DISCORD_ORIGIN,
      });

      const defaultInviteCtx = encodeInviteContextProperties();
      assert.deepEqual(
        JSON.parse(Buffer.from(defaultInviteCtx, "base64").toString("utf8")),
        { location: DEFAULT_INVITE_CONTEXT_LOCATION },
      );
      const customInviteCtx = encodeInviteContextProperties("Join Guild");
      assert.deepEqual(
        JSON.parse(Buffer.from(customInviteCtx, "base64").toString("utf8")),
        { location: "Join Guild" },
      );

      const explicitHeaders = buildUserModeDefaultHeaders({
        userAgent: "CustomElectron/1.0",
        locale: "de",
        timezone: "America/New_York",
        superProperties: { os: "Linux" },
      });
      assert.equal(explicitHeaders["User-Agent"], "CustomElectron/1.0");
      assert.equal(explicitHeaders["Origin"], DEFAULT_DISCORD_ORIGIN);
      assert.equal(explicitHeaders["Referer"], DEFAULT_DISCORD_REFERER);
      assert.equal(
        explicitHeaders["X-Debug-Options"],
        DEFAULT_DISCORD_DEBUG_OPTIONS,
      );
      assert.equal(explicitHeaders["X-Discord-Locale"], "de");
      assert.equal(explicitHeaders["X-Discord-Timezone"], "America/New_York");
      const decodedExplicitProps = JSON.parse(
        Buffer.from(explicitHeaders["X-Super-Properties"]!, "base64").toString(
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(decodedExplicitProps["os"], "Linux");
      assert.equal(decodedExplicitProps["system_locale"], "de");

      const defaultHeaders = buildUserModeDefaultHeaders({ timezone: "   " });
      assert.equal(
        defaultHeaders["X-Discord-Timezone"],
        buildUserModeDefaultHeaders()["X-Discord-Timezone"],
      );
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (systemTz) {
        assert.equal(defaultHeaders["X-Discord-Timezone"], systemTz);
      }
    });
  });
});
