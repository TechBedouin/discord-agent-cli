import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { after, describe, it } from "node:test";
import zlib from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";

import {
  GatewayClient,
  buildGatewayWsUrl,
  type GatewayWebSocketOptions,
} from "../dist/daemon/gateway.js";
import {
  DEFAULT_DISCORD_ORIGIN,
  DEFAULT_USER_MODE_USER_AGENT,
} from "../dist/shared/config.js";
import {
  GatewayCloseCode,
  GatewayOpcode,
  type GatewayBotInfo,
  type GatewayConnectionState,
  type GatewayPayload,
} from "../dist/shared/types.js";

interface MockWsServer {
  url: string;
  wss: WebSocketServer;
  connections: WebSocket[];
  getRequestUrl: (ws: WebSocket) => string;
  getRequestHeaders: (ws: WebSocket) => IncomingHttpHeaders;
  waitForConnection: (index?: number, timeoutMs?: number) => Promise<WebSocket>;
  close: () => Promise<void>;
}

async function createMockWsServer(): Promise<MockWsServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP address from mock WebSocketServer");
  }
  const url = `ws://127.0.0.1:${address.port}`;
  const connections: WebSocket[] = [];
  const requestUrls = new WeakMap<WebSocket, string>();
  const requestHeaders = new WeakMap<WebSocket, IncomingHttpHeaders>();
  const waiters: Array<{ index: number; resolve: (ws: WebSocket) => void }> = [];

  wss.on("connection", (ws, req) => {
    requestUrls.set(ws, req.url ?? "");
    requestHeaders.set(ws, req.headers);
    connections.push(ws);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i]!;
      if (connections.length > w.index) {
        waiters.splice(i, 1);
        w.resolve(connections[w.index]!);
      }
    }
  });

  return {
    url,
    wss,
    connections,
    getRequestUrl: (ws: WebSocket) => requestUrls.get(ws) ?? "",
    getRequestHeaders: (ws: WebSocket) => requestHeaders.get(ws) ?? {},
    waitForConnection: (index = 0, timeoutMs = 3000) => {
      if (connections.length > index) {
        return Promise.resolve(connections[index]!);
      }
      return new Promise<WebSocket>((resolve, reject) => {
        const entry = {
          index,
          resolve: (ws: WebSocket) => {
            clearTimeout(timer);
            resolve(ws);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
          }
          reject(new Error(`Timed out waiting for WS connection #${index}`));
        }, timeoutMs);
        waiters.push(entry);
      });
    },
    close: async () => {
      for (const ws of connections) {
        try {
          ws.terminate();
        } catch {
          // Ignore close errors.
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

function createMessageReader(ws: WebSocket) {
  const queue: GatewayPayload[] = [];
  const pending: Array<(payload: GatewayPayload) => void> = [];

  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString("utf8")) as GatewayPayload;
    const waiter = pending.shift();
    if (waiter !== undefined) {
      waiter(parsed);
    } else {
      queue.push(parsed);
    }
  });

  return {
    next: (timeoutMs = 3000): Promise<GatewayPayload> => {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise<GatewayPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = pending.indexOf(onMsg);
          if (idx !== -1) {
            pending.splice(idx, 1);
          }
          reject(new Error("Timed out waiting for client WS payload"));
        }, timeoutMs);
        const onMsg = (payload: GatewayPayload): void => {
          clearTimeout(timer);
          resolve(payload);
        };
        pending.push(onMsg);
      });
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

function createStatefulDeflater() {
  const deflate = zlib.createDeflate();
  return {
    compress: (payload: unknown): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer): void => {
          chunks.push(chunk);
        };
        const onError = (err: Error): void => {
          deflate.off("data", onData);
          deflate.off("error", onError);
          reject(err);
        };
        deflate.on("data", onData);
        deflate.on("error", onError);
        deflate.write(Buffer.from(JSON.stringify(payload), "utf8"));
        deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
          deflate.off("data", onData);
          deflate.off("error", onError);
          resolve(Buffer.concat(chunks));
        });
      }),
    close: (): void => {
      deflate.destroy();
    },
  };
}

function defaultBotInfo(url: string): GatewayBotInfo {
  return {
    url,
    shards: 1,
    session_start_limit: {
      total: 1000,
      remaining: 999,
      reset_after: 0,
      max_concurrency: 1,
    },
  };
}

describe("daemon/gateway GatewayClient", () => {
  const serversToClose: MockWsServer[] = [];
  const clientsToStop: GatewayClient[] = [];

  after(async () => {
    await Promise.all(clientsToStop.map((c) => c.stop().catch(() => undefined)));
    await Promise.all(serversToClose.map((s) => s.close().catch(() => undefined)));
  });

  it("buildGatewayWsUrl appends v=10, encoding=json, and toggles compress=zlib-stream", () => {
    assert.equal(
      buildGatewayWsUrl("wss://gateway.discord.gg", true),
      "wss://gateway.discord.gg/?v=10&encoding=json&compress=zlib-stream",
    );
    assert.equal(
      buildGatewayWsUrl(
        "wss://gateway.discord.gg/?v=9&compress=zlib-stream",
        false,
      ),
      "wss://gateway.discord.gg/?v=10&encoding=json",
    );
  });

  it("bootstraps via /gateway/bot, runs HELLO -> IDENTIFY -> READY, and tracks Op 1 / Op 11 heartbeats and latency", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    const dispatches: Array<{ eventName: string; data: unknown }> = [];
    const states: GatewayConnectionState[] = [];
    let fakeNow = 1_700_000_000_000;
    let bootstrapCalls = 0;

    const client = new GatewayClient({
      token: "bot-token-123",
      intents: 46593,
      compress: false,
      fetchGatewayBot: async () => {
        bootstrapCalls += 1;
        return defaultBotInfo(server.url);
      },
      onDispatch: (eventName, data) => {
        dispatches.push({ eventName, data });
      },
      onStateChange: (state) => {
        states.push(state);
      },
      random: () => 0.5,
      now: () => fakeNow,
    });
    clientsToStop.push(client);

    await client.start();
    const ws = await server.waitForConnection(0);
    const wsHeaders = server.getRequestHeaders(ws);
    assert.equal(wsHeaders["origin"], undefined);
    const reader = createMessageReader(ws);

    sendJson(ws, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 100 },
      s: null,
      t: null,
    });

    const identify = await reader.next();
    assert.equal(identify.op, GatewayOpcode.IDENTIFY);
    assert.deepEqual((identify.d as { token: string; intents: number }).token, "bot-token-123");
    assert.equal((identify.d as { intents: number }).intents, 46593);

    sendJson(ws, {
      op: GatewayOpcode.DISPATCH,
      s: 1,
      t: "READY",
      d: {
        v: 10,
        user: { id: "1001", username: "CliBot", discriminator: "0", bot: true },
        guilds: [],
        session_id: "sess-1",
        resume_gateway_url: server.url,
        application: { id: "1001", flags: 0 },
      },
    });

    await waitUntil(() => client.getConnectionState() === "ready");
    assert.equal(bootstrapCalls, 1);

    // Wait for scheduled Op 1 heartbeat (jitter=0 -> fires immediately with seq=1).
    const hb = await reader.next();
    assert.equal(hb.op, GatewayOpcode.HEARTBEAT);
    assert.equal(hb.d, 1);

    // Advance fakeNow by 42ms before replying Op 11 HEARTBEAT_ACK to verify latency tracking.
    fakeNow += 42;
    sendJson(ws, { op: GatewayOpcode.HEARTBEAT_ACK, d: null, s: null, t: null });
    await waitUntil(() => client.getStatusSnapshot().latencyMs === 42);

    // Inbound server Op 1 request triggers immediate Op 1 heartbeat reply.
    sendJson(ws, { op: GatewayOpcode.HEARTBEAT, d: null, s: null, t: null });
    const immediateHb = await reader.next();
    assert.equal(immediateHb.op, GatewayOpcode.HEARTBEAT);
    assert.equal(immediateHb.d, 1);

    const snapshot = client.getStatusSnapshot();
    assert.equal(snapshot.authMode, "bot");
    assert.equal(snapshot.sessionId, "sess-1");
    assert.equal(snapshot.seq, 1);
    assert.equal(snapshot.resumeGatewayUrl, server.url);
    assert.ok(snapshot.lastHeartbeatAt !== null);
    assert.ok(snapshot.lastHeartbeatAckAt !== null);
    assert.equal(dispatches[0]!.eventName, "READY");
    assert.ok(states.includes("identifying"));
    assert.ok(states.includes("ready"));

    await client.stop();
    assert.equal(client.getConnectionState(), "disconnected");
  });

  it("closes zombie connections with 4000 on missed HEARTBEAT_ACK and recovers with Op 6 RESUME", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    const client = new GatewayClient({
      token: "bot-token-resume",
      intents: 513,
      compress: false,
      fetchGatewayBot: async () => defaultBotInfo(server.url),
      onDispatch: () => undefined,
      random: () => 0.5,
      baseReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    clientsToStop.push(client);

    await client.start();
    const ws1 = await server.waitForConnection(0);
    const reader1 = createMessageReader(ws1);

    const ws1ClosePromise = new Promise<number>((resolve) => {
      ws1.once("close", (code) => resolve(code));
    });

    sendJson(ws1, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 80 },
      s: null,
      t: null,
    });
    assert.equal((await reader1.next()).op, GatewayOpcode.IDENTIFY);

    sendJson(ws1, {
      op: GatewayOpcode.DISPATCH,
      s: 7,
      t: "READY",
      d: {
        v: 10,
        user: { id: "1001", username: "CliBot", discriminator: "0", bot: true },
        guilds: [],
        session_id: "sess-zombie",
        resume_gateway_url: `${server.url}/resume-here`,
        application: { id: "1001", flags: 0 },
      },
    });

    // Client sends first heartbeat, server intentionally omits HEARTBEAT_ACK.
    const hb1 = await reader1.next();
    assert.equal(hb1.op, GatewayOpcode.HEARTBEAT);
    assert.equal(hb1.d, 7);

    // Next heartbeat interval sees awaitingAck=true and closes with 4000.
    const closeCode = await ws1ClosePromise;
    assert.equal(closeCode, GatewayCloseCode.UNKNOWN_ERROR);

    // Client reconnects to resume_gateway_url and sends Op 6 RESUME.
    const ws2 = await server.waitForConnection(1);
    const reader2 = createMessageReader(ws2);
    assert.ok(server.getRequestUrl(ws2).includes("/resume-here"));

    sendJson(ws2, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const resume = await reader2.next();
    assert.equal(resume.op, GatewayOpcode.RESUME);
    assert.deepEqual(resume.d, {
      token: "bot-token-resume",
      session_id: "sess-zombie",
      seq: 7,
    });

    sendJson(ws2, {
      op: GatewayOpcode.DISPATCH,
      s: 8,
      t: "RESUMED",
      d: {},
    });
    await waitUntil(() => client.getConnectionState() === "ready");
    assert.equal(client.getStatusSnapshot().seq, 8);

    await client.stop();
  });

  it("handles Op 7 RECONNECT immediately with Op 6 RESUME, and Op 9 INVALID_SESSION (d:true vs d:false)", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    let bootstrapCalls = 0;
    const client = new GatewayClient({
      token: "bot-token-op79",
      intents: 513,
      compress: false,
      fetchGatewayBot: async () => {
        bootstrapCalls += 1;
        return defaultBotInfo(server.url);
      },
      onDispatch: () => undefined,
      random: () => 0,
      baseReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    clientsToStop.push(client);

    await client.start();
    const ws1 = await server.waitForConnection(0);
    const r1 = createMessageReader(ws1);

    sendJson(ws1, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    assert.equal((await r1.next()).op, GatewayOpcode.IDENTIFY);
    sendJson(ws1, {
      op: GatewayOpcode.DISPATCH,
      s: 3,
      t: "READY",
      d: {
        v: 10,
        user: { id: "1001", username: "CliBot", discriminator: "0", bot: true },
        guilds: [],
        session_id: "sess-op79",
        resume_gateway_url: server.url,
        application: { id: "1001", flags: 0 },
      },
    });
    await waitUntil(() => client.getConnectionState() === "ready");

    // 1. Op 7 RECONNECT -> immediate reconnect preserving session -> Op 6 RESUME.
    sendJson(ws1, { op: GatewayOpcode.RECONNECT, d: null, s: null, t: null });
    const ws2 = await server.waitForConnection(1);
    const r2 = createMessageReader(ws2);
    sendJson(ws2, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const resumeAfterOp7 = await r2.next();
    assert.equal(resumeAfterOp7.op, GatewayOpcode.RESUME);
    assert.equal(bootstrapCalls, 1);

    sendJson(ws2, { op: GatewayOpcode.DISPATCH, s: 4, t: "RESUMED", d: {} });
    await waitUntil(() => client.getConnectionState() === "ready");

    // 2. Op 9 INVALID_SESSION (d: true) -> waits 1000ms (random=0), reconnects with Op 6 RESUME.
    sendJson(ws2, { op: GatewayOpcode.INVALID_SESSION, d: true, s: null, t: null });
    const ws3 = await server.waitForConnection(2, 4000);
    const r3 = createMessageReader(ws3);
    sendJson(ws3, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const resumeAfterOp9True = await r3.next();
    assert.equal(resumeAfterOp9True.op, GatewayOpcode.RESUME);
    assert.deepEqual(resumeAfterOp9True.d, {
      token: "bot-token-op79",
      session_id: "sess-op79",
      seq: 4,
    });
    assert.equal(bootstrapCalls, 1);

    // 3. Op 9 INVALID_SESSION (d: false) -> clears session, waits 1000ms, re-bootstraps & sends Op 2 IDENTIFY.
    sendJson(ws3, { op: GatewayOpcode.INVALID_SESSION, d: false, s: null, t: null });
    const ws4 = await server.waitForConnection(3, 4000);
    const r4 = createMessageReader(ws4);
    assert.equal(bootstrapCalls, 2);
    assert.equal(client.getStatusSnapshot().sessionId, null);
    assert.equal(client.getStatusSnapshot().seq, null);

    sendJson(ws4, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const identifyAfterOp9False = await r4.next();
    assert.equal(identifyAfterOp9False.op, GatewayOpcode.IDENTIFY);

    await client.stop();
  });

  it("halts reconnect loops on fatal close codes (4004, 4014) and HTTP 401 bootstrap errors", async () => {
    for (const closeCode of [
      GatewayCloseCode.AUTHENTICATION_FAILED,
      GatewayCloseCode.DISALLOWED_INTENTS,
    ]) {
      const server = await createMockWsServer();
      serversToClose.push(server);

      let connectAttempts = 0;
      const client = new GatewayClient({
        token: "bad-token",
        intents: 46593,
        compress: false,
        fetchGatewayBot: async () => {
          connectAttempts += 1;
          return defaultBotInfo(server.url);
        },
        onDispatch: () => undefined,
        baseReconnectDelayMs: 5,
      });
      clientsToStop.push(client);

      await client.start();
      const ws = await server.waitForConnection(0);
      ws.close(closeCode, "fatal test");

      await waitUntil(() => client.getConnectionState() === "fatal");
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(connectAttempts, 1);
      assert.equal(server.connections.length, 1);

      const errMsg = client.getStatusSnapshot().lastError ?? "";
      assert.match(errMsg, new RegExp(String(closeCode)));
      if (closeCode === GatewayCloseCode.DISALLOWED_INTENTS) {
        assert.match(errMsg, /MESSAGE_CONTENT/);
      }
      await client.stop();
    }

    const unauthorizedClient = new GatewayClient({
      token: "invalid-token",
      intents: 513,
      compress: false,
      fetchGatewayBot: async () => {
        const err = Object.assign(new Error("401 Unauthorized"), {
          httpStatus: 401,
        });
        throw err;
      },
      onDispatch: () => undefined,
    });
    clientsToStop.push(unauthorizedClient);

    await unauthorizedClient.start();
    assert.equal(unauthorizedClient.getConnectionState(), "fatal");
    assert.match(
      unauthorizedClient.getStatusSnapshot().lastError ?? "",
      /401/,
    );
    await unauthorizedClient.stop();
  });

  it("decompresses multi-frame zlib-stream binary payloads (0x00 0x00 0xff 0xff sync suffix) across consecutive dispatches", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    const dispatches: Array<{ eventName: string; data: unknown }> = [];
    const client = new GatewayClient({
      token: "zlib-token",
      intents: 46593,
      compress: true,
      fallbackGatewayUrl: server.url,
      // Also exercises explicit non-default fallbackGatewayUrl when fetchGatewayBot transiently fails.
      fetchGatewayBot: async () => {
        throw new Error("transient gateway/bot outage");
      },
      onDispatch: (eventName, data) => {
        dispatches.push({ eventName, data });
      },
      random: () => 0,
    });
    clientsToStop.push(client);

    await client.start();
    const ws = await server.waitForConnection(0);
    assert.ok(server.getRequestUrl(ws).includes("compress=zlib-stream"));
    const reader = createMessageReader(ws);
    const deflater = createStatefulDeflater();

    try {
      // 1. Compress HELLO and split right before the 4-byte ZLIB sync suffix 0x00 0x00 0xff 0xff.
      const helloCompressed = await deflater.compress({
        op: GatewayOpcode.HELLO,
        d: { heartbeat_interval: 5000 },
        s: null,
        t: null,
      });
      assert.deepEqual(
        helloCompressed.subarray(helloCompressed.length - 4),
        Buffer.from([0x00, 0x00, 0xff, 0xff]),
      );
      ws.send(helloCompressed.subarray(0, helloCompressed.length - 4), {
        binary: true,
      });
      ws.send(helloCompressed.subarray(helloCompressed.length - 4), {
        binary: true,
      });

      const identify = await reader.next();
      assert.equal(identify.op, GatewayOpcode.IDENTIFY);

      // 2. Compress READY using the SAME deflate stream and split across two binary frames.
      const readyCompressed = await deflater.compress({
        op: GatewayOpcode.DISPATCH,
        s: 1,
        t: "READY",
        d: {
          v: 10,
          user: { id: "1001", username: "CliBot", discriminator: "0", bot: true },
          guilds: [],
          session_id: "sess-zlib",
          resume_gateway_url: server.url,
          application: { id: "1001", flags: 0 },
        },
      });
      const midpoint = Math.floor(readyCompressed.length / 2);
      ws.send(readyCompressed.subarray(0, midpoint), { binary: true });
      ws.send(readyCompressed.subarray(midpoint), { binary: true });

      await waitUntil(() => client.getConnectionState() === "ready");

      // 3. Compress MESSAGE_CREATE on the same zlib stream.
      const msgCompressed = await deflater.compress({
        op: GatewayOpcode.DISPATCH,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "9001",
          channel_id: "100",
          author: { id: "200", username: "alice", discriminator: "0" },
          content: "compressed hello",
          timestamp: "2026-11-13T18:20:00.000Z",
          type: 0,
        },
      });
      ws.send(msgCompressed, { binary: true });

      await waitUntil(() => dispatches.length >= 2);
      assert.equal(dispatches[0]!.eventName, "READY");
      assert.equal(dispatches[1]!.eventName, "MESSAGE_CREATE");
      assert.equal(
        (dispatches[1]!.data as { content: string }).content,
        "compressed hello",
      );
    } finally {
      deflater.close();
      await client.stop();
    }
  });

  it("supports user-mode Gateway via GET /gateway, sends Windows/Discord Client/desktop IDENTIFY without intents, and reports authMode=user", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    const dispatches: Array<{ eventName: string; data: unknown }> = [];
    let gatewayCalls = 0;
    let gatewayBotCalls = 0;

    const client = new GatewayClient({
      token: "user-session-token-xyz",
      compress: false,
      fetchGateway: async () => {
        gatewayCalls += 1;
        return { url: server.url };
      },
      fetchGatewayBot: async () => {
        gatewayBotCalls += 1;
        return defaultBotInfo(server.url);
      },
      onDispatch: (eventName, data) => {
        dispatches.push({ eventName, data });
      },
      random: () => 0.5,
    });
    clientsToStop.push(client);

    assert.equal(client.getAuthMode(), "user");
    assert.equal(client.getStatusSnapshot().authMode, "user");

    await client.start();
    const ws = await server.waitForConnection(0);
    const wsHeaders = server.getRequestHeaders(ws);
    assert.equal(wsHeaders["user-agent"], DEFAULT_USER_MODE_USER_AGENT);
    assert.equal(wsHeaders["origin"], DEFAULT_DISCORD_ORIGIN);
    const reader = createMessageReader(ws);

    sendJson(ws, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });

    const identify = await reader.next();
    assert.equal(identify.op, GatewayOpcode.IDENTIFY);
    const identifyData = identify.d as Record<string, unknown>;
    assert.equal(identifyData["token"], "user-session-token-xyz");
    assert.equal("intents" in identifyData, false);
    assert.equal(identifyData["intents"], undefined);
    assert.deepEqual(identifyData["properties"], {
      $os: "Windows",
      $browser: "Discord Client",
      $device: "desktop",
    });

    sendJson(ws, {
      op: GatewayOpcode.DISPATCH,
      s: 1,
      t: "READY",
      d: {
        v: 10,
        user: {
          id: "2001",
          username: "real_user",
          discriminator: "0",
          bot: false,
        },
        guilds: [
          {
            id: "10",
            properties: { name: "User Guild", owner_id: "2001" },
            channels: [],
          },
        ],
        private_channels: [],
        relationships: [],
        user_settings: { locale: "en-US", status: "online" },
        session_id: "user-sess-1",
        resume_gateway_url: server.url,
      },
    });

    await waitUntil(() => client.getConnectionState() === "ready");
    assert.equal(gatewayCalls, 1);
    assert.equal(gatewayBotCalls, 0);

    const snapshot = client.getStatusSnapshot();
    assert.equal(snapshot.authMode, "user");
    assert.equal(snapshot.sessionId, "user-sess-1");
    assert.equal(snapshot.seq, 1);
    assert.equal(dispatches[0]!.eventName, "READY");

    await client.stop();
  });

  it("falls back to fallbackGatewayUrl on non-401 GET /gateway failure and halts fatally on 401 in user mode", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    let fallbackFetchAttempts = 0;
    const fallbackClient = new GatewayClient({
      token: "user-fallback-token",
      authMode: "user",
      compress: false,
      fallbackGatewayUrl: server.url,
      fetchGateway: async () => {
        fallbackFetchAttempts += 1;
        throw Object.assign(new Error("HTTP 503 Service Unavailable"), {
          httpStatus: 503,
        });
      },
      onDispatch: () => undefined,
      random: () => 0.5,
    });
    clientsToStop.push(fallbackClient);

    await fallbackClient.start();
    const ws = await server.waitForConnection(0);
    const reader = createMessageReader(ws);

    sendJson(ws, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const identify = await reader.next();
    assert.equal(identify.op, GatewayOpcode.IDENTIFY);
    assert.equal(
      "intents" in (identify.d as Record<string, unknown>),
      false,
    );

    sendJson(ws, {
      op: GatewayOpcode.DISPATCH,
      s: 1,
      t: "READY",
      d: {
        v: 10,
        user: { id: "2002", username: "fallback_user", discriminator: "0" },
        guilds: [],
        session_id: "user-sess-fallback",
        resume_gateway_url: server.url,
      },
    });
    await waitUntil(() => fallbackClient.getConnectionState() === "ready");
    assert.equal(fallbackFetchAttempts, 1);
    assert.equal(fallbackClient.getStatusSnapshot().authMode, "user");
    await fallbackClient.stop();

    // HTTP 401 on GET /gateway must NOT fall back and must enter "fatal".
    const connectionsBefore401 = server.connections.length;
    const unauthorizedUserClient = new GatewayClient({
      token: "bad-user-token",
      authMode: "user",
      compress: false,
      fallbackGatewayUrl: server.url,
      fetchGateway: async () => {
        throw Object.assign(new Error("401 Unauthorized"), {
          httpStatus: 401,
        });
      },
      onDispatch: () => undefined,
    });
    clientsToStop.push(unauthorizedUserClient);

    await unauthorizedUserClient.start();
    assert.equal(unauthorizedUserClient.getConnectionState(), "fatal");
    assert.equal(unauthorizedUserClient.getStatusSnapshot().authMode, "user");
    assert.match(
      unauthorizedUserClient.getStatusSnapshot().lastError ?? "",
      /401/,
    );
    assert.equal(server.connections.length, connectionsBefore401);
    await unauthorizedUserClient.stop();
  });

  it("strips leading \"Bot \" prefix from token in Op 2 IDENTIFY and Op 6 RESUME", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    assert.throws(
      () =>
        new GatewayClient({
          token: "   ",
          onDispatch: () => undefined,
        }),
      TypeError,
    );

    const client = new GatewayClient({
      token: "Bot direct-bot-token",
      compress: false,
      fetchGatewayBot: async () => defaultBotInfo(server.url),
      onDispatch: () => undefined,
      random: () => 0,
      baseReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    clientsToStop.push(client);

    assert.equal(client.getAuthMode(), "bot");
    await client.start();

    const ws1 = await server.waitForConnection(0);
    const reader1 = createMessageReader(ws1);
    sendJson(ws1, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });

    const identify = await reader1.next();
    assert.equal(identify.op, GatewayOpcode.IDENTIFY);
    assert.equal(
      (identify.d as { token: string }).token,
      "direct-bot-token",
    );

    sendJson(ws1, {
      op: GatewayOpcode.DISPATCH,
      s: 2,
      t: "READY",
      d: {
        v: 10,
        user: { id: "1001", username: "CliBot", discriminator: "0", bot: true },
        guilds: [],
        session_id: "sess-strip-bot",
        resume_gateway_url: server.url,
        application: { id: "1001", flags: 0 },
      },
    });
    await waitUntil(() => client.getConnectionState() === "ready");

    sendJson(ws1, { op: GatewayOpcode.RECONNECT, d: null, s: null, t: null });
    const ws2 = await server.waitForConnection(1);
    const reader2 = createMessageReader(ws2);
    sendJson(ws2, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const resume = await reader2.next();
    assert.equal(resume.op, GatewayOpcode.RESUME);
    assert.deepEqual(resume.d, {
      token: "direct-bot-token",
      session_id: "sess-strip-bot",
      seq: 2,
    });

    await client.stop();
  });

  it("passes hardened User-Agent and Origin WS headers only in user mode", async () => {
    const server = await createMockWsServer();
    serversToClose.push(server);

    let userCreateArgCount = 0;
    let userCreateOptions: GatewayWebSocketOptions | undefined;

    const userClient = new GatewayClient({
      token: "user-header-tok",
      authMode: "user",
      userAgent: "CustomDiscordElectron/44.9.3",
      compress: false,
      fetchGateway: async () => ({ url: server.url }),
      onDispatch: () => {},
      createWebSocket: (...args) => {
        userCreateArgCount = args.length;
        userCreateOptions = args[1];
        return new WebSocket(args[0], args[1]);
      },
      random: () => 0.5,
    });
    clientsToStop.push(userClient);

    await userClient.start();
    const wsUser = await server.waitForConnection(0);
    const userReader = createMessageReader(wsUser);

    assert.equal(userCreateArgCount, 2);
    assert.deepEqual(userCreateOptions, {
      headers: {
        "User-Agent": "CustomDiscordElectron/44.9.3",
        Origin: DEFAULT_DISCORD_ORIGIN,
      },
    });
    assert.equal(
      server.getRequestHeaders(wsUser)["user-agent"],
      "CustomDiscordElectron/44.9.3",
    );
    assert.equal(
      server.getRequestHeaders(wsUser)["origin"],
      DEFAULT_DISCORD_ORIGIN,
    );

    sendJson(wsUser, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const userIdentify = await userReader.next();
    assert.equal(userIdentify.op, GatewayOpcode.IDENTIFY);
    await userClient.stop();

    let botCreateArgCount = 0;
    let botCreateOptions: GatewayWebSocketOptions | undefined = {
      headers: { Sentinel: "should-be-cleared" },
    };

    const botClient = new GatewayClient({
      token: "bot-header-tok",
      authMode: "bot",
      intents: 1,
      compress: false,
      fetchGatewayBot: async () => defaultBotInfo(server.url),
      onDispatch: () => {},
      createWebSocket: (...args) => {
        botCreateArgCount = args.length;
        botCreateOptions = args[1];
        return new WebSocket(args[0], args[1]);
      },
      random: () => 0.5,
    });
    clientsToStop.push(botClient);

    await botClient.start();
    const wsBot = await server.waitForConnection(1);
    const botReader = createMessageReader(wsBot);

    assert.equal(botCreateArgCount, 1);
    assert.equal(botCreateOptions, undefined);
    assert.equal(server.getRequestHeaders(wsBot)["origin"], undefined);

    sendJson(wsBot, {
      op: GatewayOpcode.HELLO,
      d: { heartbeat_interval: 5000 },
      s: null,
      t: null,
    });
    const botIdentify = await botReader.next();
    assert.equal(botIdentify.op, GatewayOpcode.IDENTIFY);
    await botClient.stop();
  });
});
