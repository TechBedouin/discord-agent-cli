import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { parseCliArgs } from "../dist/cli/args.js";
import { runCliCommand } from "../dist/cli/commands.js";
import { startDaemon, type RunningDaemonHandle } from "../dist/daemon/index.js";
import {
  DiscordChannelType,
  GatewayOpcode,
  type ChannelMembersResult,
  type DaemonStatusResult,
  type DirectMessageResult,
  type DiscordChannel,
  type DiscordGuildMember,
  type DiscordInvite,
  type DiscordMessage,
  type DiscordPartialGuild,
  type DiscordUser,
  type DmChannelsResult,
  type GuildChannelsResult,
  type GuildsResult,
  type IpcErrorEnvelope,
  type IpcSuccessEnvelope,
  type JoinGuildResult,
  type ReactMessageResult,
  type ReadMessagesResult,
  type SendMessageResult,
  type UnreadResult,
  type WatchEvent,
} from "../dist/shared/types.js";

const CLI_ENTRY_PATH = fileURLToPath(
  new URL("../dist/cli/index.js", import.meta.url),
);

const BOT_USER: DiscordUser = {
  id: "100000000000000099",
  username: "E2eBot",
  discriminator: "0",
  global_name: "E2E Bot",
  bot: true,
};

const USER_SELF: DiscordUser = {
  id: "100000000000000088",
  username: "useraccount",
  discriminator: "0",
  global_name: "User Account",
  bot: false,
};

const ALICE: DiscordUser = {
  id: "200000000000000099",
  username: "alice",
  discriminator: "0",
  global_name: "Alice",
};

const BOB: DiscordUser = {
  id: "200000000000000101",
  username: "bob",
  discriminator: "0",
  global_name: "Bob",
};

const CHARLIE: DiscordUser = {
  id: "200000000000000102",
  username: "charlie",
  discriminator: "0",
  global_name: "Charlie",
};

type RestMessageWithMember = DiscordMessage & {
  member?: Omit<DiscordGuildMember, "user">;
};

interface RecordedRestRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  perfMs: number;
}

interface RecordedIdentifyPayload {
  op: number;
  d: Record<string, unknown>;
}

interface MockRestRouteResponse {
  status: number;
  body?: unknown;
}

function makeCleanTestEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean["DISCORD_TOKEN"];
  delete clean["DISCORD_BOT_TOKEN"];
  delete clean["DISCORD_AUTH_MODE"];
  delete clean["DISCORD_AUTO_TYPING"];
  delete clean["DISCORD_INTENTS"];
  delete clean["DISCORD_CLI_HOME"];
  delete clean["DISCORD_CLI_PORT"];
  delete clean["DISCORD_API_BASE_URL"];
  delete clean["DISCORD_GATEWAY_URL"];
  delete clean["DISCORD_CLI_ZLIB"];
  return { ...clean, ...overrides };
}

async function runCliSubprocess(
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY_PATH, ...args], {
      env: envOverrides,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function runInProcessCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdoutStream.on("data", (chunk: Buffer) => outChunks.push(chunk));
  stderrStream.on("data", (chunk: Buffer) => errChunks.push(chunk));

  const parsed = parseCliArgs(args);
  const exitCode = await runCliCommand(parsed, {
    stdout: stdoutStream,
    stderr: stderrStream,
    env,
    pollIntervalMs: 25,
    stopTimeoutMs: 2000,
  });

  return {
    exitCode,
    stdout: Buffer.concat(outChunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createMockDiscordServers(options: {
  onIdentify: (
    payload: RecordedIdentifyPayload,
    wsUrl: string,
    pushDispatch: (eventName: string, data: unknown) => void,
  ) => void;
  handleRest: (
    req: RecordedRestRequest,
    wsUrl: string,
  ) => MockRestRouteResponse | Promise<MockRestRouteResponse>;
}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const wsAddress = wss.address();
  assert.ok(wsAddress && typeof wsAddress === "object");
  const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

  let activeWs: WebSocket | null = null;
  let seqCounter = 0;
  const identifyPayloads: RecordedIdentifyPayload[] = [];
  const restRequests: RecordedRestRequest[] = [];

  const pushGatewayDispatch = (eventName: string, data: unknown): void => {
    assert.ok(activeWs, "Expected active gateway WebSocket connection");
    seqCounter += 1;
    activeWs.send(
      JSON.stringify({
        op: GatewayOpcode.DISPATCH,
        s: seqCounter,
        t: eventName,
        d: data,
      }),
    );
  };

  wss.on("connection", (ws) => {
    activeWs = ws;
    ws.send(
      JSON.stringify({
        op: GatewayOpcode.HELLO,
        d: { heartbeat_interval: 5000 },
        s: null,
        t: null,
      }),
    );
    ws.on("message", (raw) => {
      const payload = JSON.parse(raw.toString("utf8")) as {
        op: number;
        d?: Record<string, unknown>;
      };
      if (payload.op === GatewayOpcode.IDENTIFY) {
        const recorded: RecordedIdentifyPayload = {
          op: payload.op,
          d: payload.d ?? {},
        };
        identifyPayloads.push(recorded);
        options.onIdentify(recorded, wsUrl, pushGatewayDispatch);
      } else if (payload.op === GatewayOpcode.HEARTBEAT) {
        ws.send(
          JSON.stringify({
            op: GatewayOpcode.HEARTBEAT_ACK,
            d: null,
            s: null,
            t: null,
          }),
        );
      }
    });
  });

  const discordHttpServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const recorded: RecordedRestRequest = {
      method: (req.method ?? "GET").toUpperCase(),
      pathname: reqUrl.pathname,
      searchParams: reqUrl.searchParams,
      headers: req.headers,
      bodyText,
      perfMs: performance.now(),
    };
    restRequests.push(recorded);

    const response = await options.handleRest(recorded, wsUrl);
    if (response.status === 204 || response.body === undefined) {
      res.writeHead(response.status);
      res.end();
      return;
    }
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response.body));
  });

  await new Promise<void>((resolve) => {
    discordHttpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const httpAddress = discordHttpServer.address();
  assert.ok(httpAddress && typeof httpAddress === "object");

  const close = async (): Promise<void> => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // Ignore terminate errors.
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      discordHttpServer.closeAllConnections();
      discordHttpServer.close(() => resolve());
    });
  };

  return {
    wsUrl,
    apiBaseUrl: `http://127.0.0.1:${httpAddress.port}/api/v10`,
    identifyPayloads,
    restRequests,
    pushGatewayDispatch,
    close,
  };
}

async function assertLockfileWithoutToken(
  daemon: RunningDaemonHandle,
): Promise<void> {
  assert.equal("token" in daemon.lockfile, false);
  const rawDisk = await fs.readFile(daemon.config.lockfilePath, "utf8");
  const diskLockfile = JSON.parse(rawDisk) as Record<string, unknown>;
  assert.equal("token" in diskLockfile, false);
  assert.equal(diskLockfile["token"], undefined);
  assert.equal(diskLockfile["pid"], process.pid);
  assert.equal(diskLockfile["host"], "127.0.0.1");
  assert.equal(diskLockfile["port"], daemon.lockfile.port);
  assert.equal(typeof diskLockfile["startedAt"], "string");
}

async function assertZeroAuthIpcAndHostGuard(port: number): Promise<void> {
  const noAuthStatus = await fetch(`http://127.0.0.1:${port}/v1/status`);
  assert.equal(noAuthStatus.status, 200);
  const okBody = (await noAuthStatus.json()) as IpcSuccessEnvelope<DaemonStatusResult>;
  assert.equal(okBody.ok, true);
  assert.equal(okBody.data.port, port);

  const badHost = await new Promise<{ status: number; bodyText: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/status",
          method: "GET",
          headers: {
            Host: "evil.example.com",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.once("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              bodyText: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.once("error", reject);
      req.end();
    },
  );
  assert.equal(badHost.status, 403);
  const errBody = JSON.parse(badHost.bodyText) as IpcErrorEnvelope;
  assert.equal(errBody.ok, false);
  assert.equal(errBody.error.code, "FORBIDDEN");
  assert.equal(errBody.error.status, 403);
}

function assertUserModeRestHeaders(
  headers: http.IncomingHttpHeaders,
  expectedToken: string,
): void {
  assert.equal(headers["authorization"], expectedToken);
  assert.equal(headers["x-discord-locale"], "en-US");

  const ua = headers["user-agent"];
  assert.equal(typeof ua, "string");
  assert.ok(typeof ua === "string" && ua.includes("discord/"), `Unexpected User-Agent: ${String(ua)}`);

  const rawSuperProps = headers["x-super-properties"];
  assert.equal(typeof rawSuperProps, "string");
  assert.ok(typeof rawSuperProps === "string" && rawSuperProps.length > 0);

  const decodedJson = Buffer.from(rawSuperProps, "base64").toString("utf8");
  const superProps = JSON.parse(decodedJson) as Record<string, unknown>;
  assert.equal(superProps["os"], "Windows");
  assert.equal(superProps["browser"], "Discord Client");
  assert.equal(superProps["system_locale"], "en-US");
  assert.equal(typeof superProps["client_build_number"], "number");
}

function parseJsonStdout<T>(result: {
  code?: number | null;
  exitCode?: number;
  stdout: string;
  stderr: string;
}): T {
  const code = result.code ?? result.exitCode;
  assert.equal(code, 0, `Expected exit 0, got ${String(code)}; stderr: ${result.stderr}`);
  const env = JSON.parse(result.stdout) as IpcSuccessEnvelope<T>;
  assert.equal(env.ok, true);
  return env.data;
}

describe("end-to-end daemon + CLI flows", () => {
  const tempDirs: string[] = [];
  const cleanupTasks: Array<() => Promise<void>> = [];

  after(async () => {
    for (const task of cleanupTasks.reverse()) {
      await task().catch(() => undefined);
    }
    await Promise.all(
      tempDirs.map((dir) =>
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  it("bot-mode E2E (DISCORD_AUTH_MODE=bot): /gateway/bot, Bot auth headers, IPC zero-auth + 403 Host guard, unread/read/send/react/watch/stop", async () => {
    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "discord-cli-e2e-bot-"),
    );
    tempDirs.push(tempHome);

    let getMessagesCalls = 0;
    const recordedSentBodies: Array<{
      content: string;
      message_reference?: { message_id: string };
    }> = [];
    const recordedReactions: Array<{
      method: string;
      url: string;
    }> = [];

    const restMessages: DiscordMessage[] = [
      {
        id: "7002",
        channel_id: "100",
        guild_id: "10",
        author: ALICE,
        content: "ping <@100000000000000099>",
        timestamp: "2026-11-13T18:01:00.000Z",
        mentions: [BOT_USER],
        type: 0,
      },
      {
        id: "7001",
        channel_id: "100",
        guild_id: "10",
        author: ALICE,
        content: "earlier context",
        timestamp: "2026-11-13T18:00:00.000Z",
        type: 0,
      },
    ];

    const servers = await createMockDiscordServers({
      onIdentify: (_payload, wsUrl, pushDispatch) => {
        pushDispatch("READY", {
          v: 10,
          user: BOT_USER,
          guilds: [{ id: "10", unavailable: true }],
          session_id: "e2e-bot-session-1",
          resume_gateway_url: wsUrl,
          application: { id: BOT_USER.id, flags: 0 },
        });
        pushDispatch("GUILD_CREATE", {
          id: "10",
          name: "E2E Bot Guild",
          owner_id: ALICE.id,
          channels: [
            {
              id: "100",
              type: DiscordChannelType.GUILD_TEXT,
              guild_id: "10",
              name: "general",
            },
          ],
          members: [
            {
              user: BOT_USER,
              roles: ["500"],
              joined_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      },
      handleRest: (req, wsUrl) => {
        if (req.method === "GET" && req.pathname === "/api/v10/gateway/bot") {
          return {
            status: 200,
            body: {
              url: wsUrl,
              shards: 1,
              session_start_limit: {
                total: 1000,
                remaining: 999,
                reset_after: 0,
                max_concurrency: 1,
              },
            },
          };
        }

        if (req.method === "GET" && req.pathname === "/api/v10/channels/100") {
          return {
            status: 200,
            body: {
              id: "100",
              type: DiscordChannelType.GUILD_TEXT,
              guild_id: "10",
              name: "general",
            },
          };
        }

        if (
          req.method === "GET" &&
          req.pathname === "/api/v10/channels/100/messages"
        ) {
          getMessagesCalls += 1;
          const limit = Number(req.searchParams.get("limit") ?? "50");
          return {
            status: 200,
            body: restMessages.slice(0, limit),
          };
        }

        if (
          req.method === "POST" &&
          req.pathname === "/api/v10/channels/100/messages"
        ) {
          const parsed = JSON.parse(req.bodyText) as {
            content: string;
            message_reference?: { message_id: string };
          };
          recordedSentBodies.push(parsed);
          const created: DiscordMessage = {
            id: "7003",
            channel_id: "100",
            guild_id: "10",
            author: BOT_USER,
            content: parsed.content,
            timestamp: "2026-11-13T18:02:00.000Z",
            type: parsed.message_reference ? 19 : 0,
            ...(parsed.message_reference
              ? {
                  message_reference: {
                    message_id: parsed.message_reference.message_id,
                  },
                }
              : {}),
          };
          return { status: 200, body: created };
        }

        if (
          (req.method === "PUT" || req.method === "DELETE") &&
          req.pathname.startsWith("/api/v10/channels/100/messages/7001/reactions/")
        ) {
          recordedReactions.push({ method: req.method, url: req.pathname });
          return { status: 204 };
        }

        return { status: 404, body: { code: 10003, message: "Not Found" } };
      },
    });
    cleanupTasks.push(servers.close);

    const daemonEnv = makeCleanTestEnv({
      DISCORD_TOKEN: "mock-e2e-bot-token",
      DISCORD_AUTH_MODE: "bot",
      DISCORD_API_BASE_URL: servers.apiBaseUrl,
      DISCORD_CLI_HOME: tempHome,
    });

    const daemon = await startDaemon({
      port: 0,
      homeDir: tempHome,
      compress: false,
      registerSignalHandlers: false,
      env: daemonEnv,
      log: () => undefined,
    });
    cleanupTasks.push(async () => {
      await daemon.stop();
    });

    await waitUntil(
      () =>
        daemon.gateway.getConnectionState() === "ready" &&
        daemon.stateCache.guilds.has("10"),
      5000,
      "bot daemon gateway ready and guild hydrated",
    );

    // Verify bot-mode bootstrap & Op 2 IDENTIFY.
    assert.equal(
      servers.restRequests.filter((r) => r.pathname === "/api/v10/gateway/bot")
        .length,
      1,
    );
    assert.equal(
      servers.restRequests.filter((r) => r.pathname === "/api/v10/gateway")
        .length,
      0,
    );
    assert.equal(servers.identifyPayloads.length, 1);
    const botIdentify = servers.identifyPayloads[0]!.d;
    assert.equal(botIdentify["token"], "mock-e2e-bot-token");
    assert.equal(typeof botIdentify["intents"], "number");
    assert.equal(
      (botIdentify["properties"] as Record<string, unknown>)["browser"],
      "discord-cli",
    );

    // Verify daemon.json lockfile has no token + zero-auth IPC + 403 Host guard.
    await assertLockfileWithoutToken(daemon);
    await assertZeroAuthIpcAndHostGuard(daemon.lockfile.port);

    // status --json.
    const statusData = parseJsonStdout<DaemonStatusResult>(
      await runInProcessCli(["status", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(statusData.port, daemon.lockfile.port);
    assert.equal(statusData.authMode, "bot");
    assert.equal(statusData.gateway.authMode, "bot");
    assert.equal(statusData.gateway.state, "ready");
    assert.equal(statusData.botUser?.id, BOT_USER.id);

    // Push live mention MESSAGE_CREATE -> verify unread --json.
    servers.pushGatewayDispatch("MESSAGE_CREATE", restMessages[0]);
    await waitUntil(() => daemon.stateCache.getUnread().totalUnreadMessages === 1);

    const unreadData = parseJsonStdout<UnreadResult>(
      await runInProcessCli(["--json", "unread", "--home", tempHome], daemonEnv),
    );
    assert.equal(unreadData.totalUnreadChannels, 1);
    assert.equal(unreadData.totalUnreadMessages, 1);
    assert.equal(unreadData.totalMentions, 1);

    // read 100 --limit 2 --mark-read --json (REST then cache hit).
    const read1 = parseJsonStdout<ReadMessagesResult>(
      await runInProcessCli(
        ["read", "100", "--limit", "2", "--mark-read", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(read1.source, "rest");
    assert.equal(read1.markedReadUpTo, "7002");
    assert.deepEqual(
      read1.messages.map((m) => m.id),
      ["7001", "7002"],
    );
    assert.equal(getMessagesCalls, 1);

    const unreadAfter = parseJsonStdout<UnreadResult>(
      await runInProcessCli(["unread", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(unreadAfter.totalUnreadMessages, 0);

    const read2 = parseJsonStdout<ReadMessagesResult>(
      await runInProcessCli(
        ["read", "100", "--limit", "2", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(read2.source, "cache");
    assert.equal(getMessagesCalls, 1);

    // send via real CLI subprocess (testing --reply and no unread increment).
    const sendData = parseJsonStdout<SendMessageResult>(
      await runCliSubprocess(
        ["send", "100", "hello from e2e", "--reply", "7001", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(sendData.message.id, "7003");
    assert.equal(sendData.message.content, "hello from e2e");
    assert.equal(sendData.message.replyToMessageId, "7001");
    assert.equal(recordedSentBodies[0]?.content, "hello from e2e");
    assert.equal(recordedSentBodies[0]?.message_reference?.message_id, "7001");
    assert.equal(daemon.stateCache.getUnread().totalUnreadMessages, 0);

    // react add + --remove --json.
    const reactAdd = parseJsonStdout<ReactMessageResult>(
      await runInProcessCli(
        ["react", "100", "7001", "<:party:555>", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(reactAdd.action, "added");

    const reactRemove = parseJsonStdout<ReactMessageResult>(
      await runInProcessCli(
        ["react", "100", "7001", "<:party:555>", "--remove", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(reactRemove.action, "removed");
    assert.deepEqual(recordedReactions, [
      {
        method: "PUT",
        url: "/api/v10/channels/100/messages/7001/reactions/party%3A555/@me",
      },
      {
        method: "DELETE",
        url: "/api/v10/channels/100/messages/7001/reactions/party%3A555/@me",
      },
    ]);

    // Verify all bot REST calls carried Authorization: Bot ... and lacked user headers.
    assert.ok(servers.restRequests.length > 0);
    for (const req of servers.restRequests) {
      assert.equal(req.headers["authorization"], "Bot mock-e2e-bot-token");
      assert.equal(req.headers["x-super-properties"], undefined);
      assert.equal(req.headers["x-discord-locale"], undefined);
    }

    // watch <cid> real-time NDJSON streaming via real subprocess.
    const watchChild = spawn(
      process.execPath,
      [CLI_ENTRY_PATH, "watch", "100", "--home", tempHome],
      {
        env: daemonEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const watchEvents: WatchEvent[] = [];
    let watchLineBuf = "";
    watchChild.stdout.setEncoding("utf8");
    watchChild.stdout.on("data", (chunk: string) => {
      watchLineBuf += chunk;
      let idx = watchLineBuf.indexOf("\n");
      while (idx !== -1) {
        const line = watchLineBuf.slice(0, idx).trim();
        watchLineBuf = watchLineBuf.slice(idx + 1);
        if (line.length > 0) {
          watchEvents.push(JSON.parse(line) as WatchEvent);
        }
        idx = watchLineBuf.indexOf("\n");
      }
    });

    try {
      await waitUntil(
        () => watchEvents.some((e) => e.type === "ready"),
        5000,
        "watch ready JSONL event",
      );

      servers.pushGatewayDispatch("MESSAGE_CREATE", {
        id: "7004",
        channel_id: "100",
        guild_id: "10",
        author: ALICE,
        content: "live watch event",
        timestamp: "2026-11-13T18:03:00.000Z",
        type: 0,
      });
      servers.pushGatewayDispatch("MESSAGE_REACTION_ADD", {
        user_id: ALICE.id,
        channel_id: "100",
        message_id: "7004",
        guild_id: "10",
        emoji: { id: null, name: "🔥" },
      });

      await waitUntil(
        () =>
          watchEvents.some((e) => e.type === "message_create") &&
          watchEvents.some((e) => e.type === "reaction_add"),
        5000,
        "live watch message_create and reaction_add events",
      );

      const msgEv = watchEvents.find((e) => e.type === "message_create");
      assert.ok(msgEv && msgEv.type === "message_create");
      assert.equal(msgEv.message.content, "live watch event");
    } finally {
      watchChild.kill();
      await new Promise<void>((resolve) => {
        if (watchChild.exitCode !== null || watchChild.signalCode !== null) {
          resolve();
          return;
        }
        watchChild.once("close", () => resolve());
      });
    }

    // daemon status & daemon stop via real CLI subprocesses, verifying lockfile cleanup.
    const daemonStatusData = parseJsonStdout<DaemonStatusResult>(
      await runCliSubprocess(
        ["daemon", "status", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(daemonStatusData.pid, process.pid);

    const stopData = parseJsonStdout<{ stopping: true; pid: number }>(
      await runCliSubprocess(
        ["daemon", "stop", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(stopData.stopping, true);

    await waitUntil(async () => {
      try {
        await fs.access(daemon.config.lockfilePath);
        return false;
      } catch {
        return true;
      }
    }, 3000, "daemon.json lockfile cleanup");

    const afterStopSub = await runCliSubprocess(
      ["status", "--home", tempHome, "--json"],
      daemonEnv,
    );
    assert.equal(afterStopSub.code, 3);
    const errEnv = JSON.parse(afterStopSub.stderr) as IpcErrorEnvelope;
    assert.equal(errEnv.ok, false);
    assert.equal(errEnv.error.code, "DAEMON_UNREACHABLE");
  });

  it("user-mode E2E (default raw token): /gateway, Op 2 properties without intents, REST headers, READY hydration, join/guilds/channels/members/dms/dm/send --typing", async () => {
    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "discord-cli-e2e-user-"),
    );
    tempDirs.push(tempHome);

    const userToken = "mfa.mock-user-e2e-token";
    let nextMessageId = 7200;
    let getUserGuildsCalls = 0;
    let getUserDmsCalls = 0;
    let createDmCalls = 0;
    let getJoinedGuildChannelsCalls = 0;
    let getJoinedGuildThreadsCalls = 0;
    const channel100HistoryCalls: Array<number | null> = [];
    const createdDmBodies: Array<{ recipient_id: string }> = [];
    const joinBodies: Array<{ code: string; body: unknown }> = [];
    const typingEvents: Array<{ channelId: string; perfMs: number }> = [];
    const messageEvents: Array<{
      channelId: string;
      content: string;
      perfMs: number;
    }> = [];

    const channel100History: RestMessageWithMember[] = [
      {
        id: "7014",
        channel_id: "100",
        guild_id: "10",
        author: CHARLIE,
        content: "charlie latest",
        timestamp: "2026-11-13T18:04:00.000Z",
        type: 0,
      },
      {
        id: "7013",
        channel_id: "100",
        guild_id: "10",
        author: BOB,
        content: "bob message",
        timestamp: "2026-11-13T18:03:00.000Z",
        type: 0,
        member: {
          nick: "Bobby",
          roles: ["503"],
          joined_at: "2026-02-01T00:00:00.000Z",
        },
      },
      {
        id: "7012",
        channel_id: "100",
        guild_id: "10",
        author: ALICE,
        content: "alice recent",
        timestamp: "2026-11-13T18:02:00.000Z",
        type: 0,
      },
      {
        id: "7011",
        channel_id: "100",
        guild_id: "10",
        author: ALICE,
        content: "alice earlier",
        timestamp: "2026-11-13T18:01:00.000Z",
        type: 0,
      },
    ];

    const joinedGuildChannels: DiscordChannel[] = [
      {
        id: "301",
        type: DiscordChannelType.GUILD_CATEGORY,
        guild_id: "30",
        name: "Info",
        position: 0,
      },
      {
        id: "300",
        type: DiscordChannelType.GUILD_TEXT,
        guild_id: "30",
        name: "welcome",
        parent_id: "301",
        position: 1,
        topic: "Say hello",
      },
      {
        id: "302",
        type: DiscordChannelType.GUILD_ANNOUNCEMENT,
        guild_id: "30",
        name: "announcements",
        parent_id: "301",
        position: 2,
      },
    ];

    const joinedGuildThreads: DiscordChannel[] = [
      {
        id: "303",
        type: DiscordChannelType.PUBLIC_THREAD,
        guild_id: "30",
        name: "rules-thread",
        parent_id: "300",
        last_message_id: "7300",
      },
    ];

    const servers = await createMockDiscordServers({
      onIdentify: (_payload, wsUrl, pushDispatch) => {
        pushDispatch("READY", {
          v: 10,
          user: USER_SELF,
          users: [ALICE, BOB, CHARLIE],
          relationships: [
            { id: ALICE.id, type: 1, user: ALICE },
            { id: BOB.id, type: 1, user: BOB },
          ],
          user_settings: {
            locale: "en-US",
            theme: "dark",
            status: "online",
          },
          private_channels: [
            {
              id: "900",
              type: DiscordChannelType.DM,
              last_message_id: "8500",
              recipients: [ALICE],
            },
          ],
          guilds: [
            {
              id: "10",
              properties: {
                id: "10",
                name: "User Ready Guild",
                owner_id: ALICE.id,
              },
              member_count: 42,
              channels: [
                {
                  id: "101",
                  type: DiscordChannelType.GUILD_CATEGORY,
                  name: "General Category",
                  position: 0,
                },
                {
                  id: "100",
                  type: DiscordChannelType.GUILD_TEXT,
                  name: "general",
                  parent_id: "101",
                  position: 1,
                  topic: "Main hangout",
                  last_message_id: "7000",
                },
                {
                  id: "102",
                  type: DiscordChannelType.GUILD_VOICE,
                  name: "Voice Lounge",
                  parent_id: "101",
                  position: 2,
                },
              ],
              threads: [
                {
                  id: "103",
                  type: DiscordChannelType.PUBLIC_THREAD,
                  name: "e2e-thread",
                  parent_id: "100",
                  last_message_id: "7001",
                },
              ],
              members: [
                {
                  user: ALICE,
                  nick: "Ally",
                  roles: ["501", "502"],
                  joined_at: "2026-01-02T00:00:00.000Z",
                },
              ],
            },
          ],
          merged_members: [
            [
              {
                user_id: USER_SELF.id,
                nick: "SelfNick",
                roles: ["500"],
                joined_at: "2026-01-01T00:00:00.000Z",
              } as unknown as DiscordGuildMember,
            ],
          ],
          session_id: "e2e-user-session-1",
          resume_gateway_url: wsUrl,
        });
      },
      handleRest: (req, wsUrl) => {
        if (req.method === "GET" && req.pathname === "/api/v10/gateway") {
          return { status: 200, body: { url: wsUrl } };
        }

        if (req.method === "GET" && req.pathname === "/api/v10/users/@me/guilds") {
          getUserGuildsCalls += 1;
          return { status: 200, body: [] };
        }

        if (
          req.method === "POST" &&
          req.pathname === "/api/v10/invites/e2e-guild-invite"
        ) {
          const parsedBody = JSON.parse(req.bodyText) as unknown;
          joinBodies.push({ code: "e2e-guild-invite", body: parsedBody });
          const invite: DiscordInvite = {
            code: "e2e-guild-invite",
            type: 0,
            guild: {
              id: "30",
              name: "Joined E2E Guild",
              icon: "joined_icon",
            },
            channel: {
              id: "300",
              name: "welcome",
              type: DiscordChannelType.GUILD_TEXT,
            },
            inviter: CHARLIE,
            approximate_member_count: 15,
            approximate_presence_count: 4,
          };
          return { status: 200, body: invite };
        }

        if (req.method === "GET" && req.pathname === "/api/v10/guilds/30/channels") {
          getJoinedGuildChannelsCalls += 1;
          return { status: 200, body: joinedGuildChannels };
        }

        if (
          req.method === "GET" &&
          req.pathname === "/api/v10/guilds/30/threads/active"
        ) {
          getJoinedGuildThreadsCalls += 1;
          return {
            status: 200,
            body: { threads: joinedGuildThreads, has_more: false },
          };
        }

        if (
          req.method === "GET" &&
          req.pathname === "/api/v10/channels/100/messages"
        ) {
          const rawLimit = req.searchParams.get("limit");
          const limit = rawLimit !== null ? Number(rawLimit) : null;
          channel100HistoryCalls.push(limit);
          return {
            status: 200,
            body: channel100History.slice(0, limit ?? 50),
          };
        }

        if (req.method === "GET" && req.pathname === "/api/v10/users/@me/channels") {
          getUserDmsCalls += 1;
          return { status: 200, body: [] };
        }

        if (
          req.method === "POST" &&
          req.pathname === "/api/v10/users/@me/channels"
        ) {
          createDmCalls += 1;
          const body = JSON.parse(req.bodyText) as { recipient_id: string };
          createdDmBodies.push(body);
          assert.equal(body.recipient_id, BOB.id);
          const createdDm: DiscordChannel = {
            id: "901",
            type: DiscordChannelType.DM,
            recipients: [BOB],
          };
          return { status: 200, body: createdDm };
        }

        const typingMatch = /^\/api\/v10\/channels\/(\d+)\/typing$/.exec(
          req.pathname,
        );
        if (req.method === "POST" && typingMatch !== null) {
          typingEvents.push({
            channelId: typingMatch[1]!,
            perfMs: req.perfMs,
          });
          return { status: 204 };
        }

        const msgMatch = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(
          req.pathname,
        );
        if (req.method === "POST" && msgMatch !== null) {
          const channelId = msgMatch[1]!;
          const parsed = JSON.parse(req.bodyText) as { content: string };
          messageEvents.push({
            channelId,
            content: parsed.content,
            perfMs: req.perfMs,
          });
          nextMessageId += 1;
          const created: DiscordMessage = {
            id: String(nextMessageId),
            channel_id: channelId,
            ...(channelId === "100" ? { guild_id: "10" } : {}),
            author: USER_SELF,
            content: parsed.content,
            timestamp: "2026-11-13T18:10:00.000Z",
            type: 0,
          };
          return { status: 200, body: created };
        }

        return { status: 404, body: { code: 10003, message: "Not Found" } };
      },
    });
    cleanupTasks.push(servers.close);

    // No DISCORD_AUTH_MODE set -> raw token must auto-resolve to "user".
    const daemonEnv = makeCleanTestEnv({
      DISCORD_TOKEN: userToken,
      DISCORD_API_BASE_URL: servers.apiBaseUrl,
      DISCORD_CLI_HOME: tempHome,
    });

    const daemon = await startDaemon({
      port: 0,
      homeDir: tempHome,
      compress: false,
      registerSignalHandlers: false,
      env: daemonEnv,
      log: () => undefined,
    });
    cleanupTasks.push(async () => {
      await daemon.stop();
    });

    await waitUntil(
      () =>
        daemon.gateway.getConnectionState() === "ready" &&
        daemon.stateCache.guilds.has("10") &&
        daemon.stateCache.dmChannels.has("900"),
      5000,
      "user daemon gateway ready with READY guilds and private_channels hydrated",
    );

    // Verify /gateway (not /gateway/bot) and Op 2 IDENTIFY properties without intents.
    assert.equal(
      servers.restRequests.filter((r) => r.pathname === "/api/v10/gateway")
        .length,
      1,
    );
    assert.equal(
      servers.restRequests.filter((r) => r.pathname === "/api/v10/gateway/bot")
        .length,
      0,
    );
    assert.equal(servers.identifyPayloads.length, 1);
    const identifyData = servers.identifyPayloads[0]!.d;
    assert.equal(identifyData["token"], userToken);
    assert.equal("intents" in identifyData, false);
    assert.equal(identifyData["intents"], undefined);
    const identifyProps = identifyData["properties"] as Record<string, unknown>;
    assert.equal(identifyProps["$os"], "Windows");
    assert.equal(identifyProps["$browser"], "Discord Client");
    assert.equal(identifyProps["$device"], "desktop");

    // Verify daemon.json lockfile has no token + zero-auth IPC + 403 Host guard.
    await assertLockfileWithoutToken(daemon);
    await assertZeroAuthIpcAndHostGuard(daemon.lockfile.port);

    // 1. status --json via CLI subprocess.
    const statusData = parseJsonStdout<DaemonStatusResult>(
      await runCliSubprocess(
        ["status", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(statusData.authMode, "user");
    assert.equal(statusData.gateway.authMode, "user");
    assert.equal(statusData.botUser?.id, USER_SELF.id);
    assert.equal(statusData.botUser?.bot, false);
    assert.equal(statusData.cache.guilds, 1);
    assert.equal(statusData.cache.channels, 4);
    assert.equal(statusData.cache.dmChannels, 1);

    // 2. guilds --json served from StateCache READY hydration (0 REST calls).
    const guildsCached = parseJsonStdout<GuildsResult>(
      await runCliSubprocess(
        ["guilds", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(guildsCached.source, "cache");
    assert.equal(guildsCached.totalGuilds, 1);
    assert.equal(guildsCached.guilds[0]?.id, "10");
    assert.equal(guildsCached.guilds[0]?.name, "User Ready Guild");
    assert.equal(guildsCached.guilds[0]?.memberCount, 42);
    assert.equal(getUserGuildsCalls, 0);

    // 3. channels 10 --json served from StateCache READY hydration (categories, channels, active threads).
    const channels10 = parseJsonStdout<GuildChannelsResult>(
      await runCliSubprocess(
        ["channels", "10", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(channels10.source, "cache");
    assert.equal(channels10.guildId, "10");
    assert.equal(channels10.guildName, "User Ready Guild");
    assert.equal(channels10.totalChannels, 4);
    assert.deepEqual(
      channels10.categories.map((c) => c.id),
      ["101"],
    );
    assert.deepEqual(
      channels10.channels.map((c) => c.id),
      ["100", "102"],
    );
    assert.deepEqual(
      channels10.threads.map((t) => t.id),
      ["103"],
    );

    // 4. members 100 --limit 10 --json (REST hydration + unique active users + cached READY & message.member metadata).
    const membersRest = parseJsonStdout<ChannelMembersResult>(
      await runCliSubprocess(
        ["members", "100", "--limit", "10", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.deepEqual(channel100HistoryCalls, [10]);
    assert.equal(membersRest.source, "rest");
    assert.equal(membersRest.channelId, "100");
    assert.equal(membersRest.guildId, "10");
    assert.equal(membersRest.totalMembers, 3);
    assert.deepEqual(
      membersRest.members.map((m) => m.userId),
      [CHARLIE.id, BOB.id, ALICE.id],
    );
    const aliceMember = membersRest.members.find((m) => m.userId === ALICE.id);
    assert.equal(aliceMember?.nickname, "Ally");
    assert.deepEqual(aliceMember?.roleIds, ["501", "502"]);
    const bobMember = membersRest.members.find((m) => m.userId === BOB.id);
    assert.equal(bobMember?.nickname, "Bobby");
    assert.deepEqual(bobMember?.roleIds, ["503"]);
    const charlieMember = membersRest.members.find((m) => m.userId === CHARLIE.id);
    assert.equal(charlieMember?.nickname, null);
    assert.deepEqual(charlieMember?.roleIds, []);

    // members 100 --limit 2 --json serves from cache and caps to 2 unique members.
    const membersLimited = parseJsonStdout<ChannelMembersResult>(
      await runCliSubprocess(
        ["members", "100", "--limit", "2", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(membersLimited.source, "cache");
    assert.equal(membersLimited.totalMembers, 2);
    assert.deepEqual(
      membersLimited.members.map((m) => m.userId),
      [CHARLIE.id, BOB.id],
    );
    assert.deepEqual(channel100HistoryCalls, [10]);

    // 5. join <invite_url> -> POST /invites/{code} with {}, caches joined guild, returns JoinGuildResult.
    const joinData = parseJsonStdout<JoinGuildResult>(
      await runCliSubprocess(
        ["join", "https://discord.gg/e2e-guild-invite", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.deepEqual(joinBodies, [{ code: "e2e-guild-invite", body: {} }]);
    assert.equal(joinData.inviteCode, "e2e-guild-invite");
    assert.equal(joinData.guild?.id, "30");
    assert.equal(joinData.guild?.name, "Joined E2E Guild");
    assert.equal(joinData.guild?.memberCount, 15);
    assert.equal(joinData.channel?.id, "300");
    assert.equal(joinData.channel?.name, "welcome");
    assert.equal(daemon.stateCache.guilds.has("30"), true);

    // 6. channels 30 --json -> REST fallback GET /guilds/30/channels + threads/active, then cache hit.
    const channels30Rest = parseJsonStdout<GuildChannelsResult>(
      await runCliSubprocess(
        ["channels", "30", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(channels30Rest.source, "rest");
    assert.equal(channels30Rest.guildId, "30");
    assert.equal(channels30Rest.guildName, "Joined E2E Guild");
    assert.equal(channels30Rest.totalChannels, 4);
    assert.deepEqual(
      channels30Rest.categories.map((c) => c.id),
      ["301"],
    );
    assert.deepEqual(
      channels30Rest.channels.map((c) => c.id),
      ["300", "302"],
    );
    assert.deepEqual(
      channels30Rest.threads.map((t) => t.id),
      ["303"],
    );
    assert.equal(getJoinedGuildChannelsCalls, 1);
    assert.equal(getJoinedGuildThreadsCalls, 1);

    const channels30Cached = parseJsonStdout<GuildChannelsResult>(
      await runCliSubprocess(
        ["channels", "30", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(channels30Cached.source, "cache");
    assert.equal(getJoinedGuildChannelsCalls, 1);
    assert.equal(getJoinedGuildThreadsCalls, 1);

    // 7. dms --json served from StateCache READY hydration (0 REST calls).
    const dmsCached = parseJsonStdout<DmChannelsResult>(
      await runCliSubprocess(
        ["dms", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(dmsCached.source, "cache");
    assert.equal(dmsCached.totalDms, 1);
    assert.equal(dmsCached.dms[0]?.channelId, "900");
    assert.equal(dmsCached.dms[0]?.recipientId, ALICE.id);
    assert.equal(dmsCached.dms[0]?.username, ALICE.username);
    assert.equal(getUserDmsCalls, 0);

    // 8. dm cache hit (existing DM in StateCache -> NO POST /users/@me/channels).
    const dmHit = parseJsonStdout<DirectMessageResult>(
      await runCliSubprocess(
        ["dm", ALICE.id, "hi alice", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(createDmCalls, 0);
    assert.equal(typingEvents.length, 0);
    assert.equal(dmHit.channel.id, "900");
    assert.equal(dmHit.channel.isDm, true);
    assert.equal(dmHit.message.channelId, "900");
    assert.equal(dmHit.message.content, "hi alice");

    // 9. dm cache miss + --typing -> POST /users/@me/channels + POST /channels/901/typing + >=800ms delay + POST /channels/901/messages.
    const dmMissContent = "hi there typing test!"; // 21 chars -> 840ms delay
    const dmMiss = parseJsonStdout<DirectMessageResult>(
      await runCliSubprocess(
        ["dm", BOB.id, dmMissContent, "--typing", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(createDmCalls, 1);
    assert.deepEqual(createdDmBodies, [{ recipient_id: BOB.id }]);
    assert.equal(dmMiss.channel.id, "901");
    assert.equal(dmMiss.message.channelId, "901");
    assert.equal(dmMiss.message.content, dmMissContent);

    const dmTyping = typingEvents.find((ev) => ev.channelId === "901");
    const dmSent = messageEvents.find((ev) => ev.channelId === "901");
    assert.ok(dmTyping, "Expected POST /channels/901/typing");
    assert.ok(dmSent, "Expected POST /channels/901/messages");
    assert.ok(
      dmSent.perfMs - dmTyping.perfMs >= 800,
      `Expected >=800ms delay between typing and message send, got ${(dmSent.perfMs - dmTyping.perfMs).toFixed(1)}ms`,
    );

    // Subsequent DM to Bob hits newly cached DM channel "901" without calling POST /users/@me/channels.
    const dmSecondBob = parseJsonStdout<DirectMessageResult>(
      await runCliSubprocess(
        ["dm", BOB.id, "second dm", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(createDmCalls, 1);
    assert.equal(dmSecondBob.channel.id, "901");

    // 10. send <channel_id> <message> --typing -> POST /channels/100/typing + >=800ms delay + POST /channels/100/messages.
    const sendTypingContent = "hi there send typing!"; // 21 chars -> 840ms delay
    const sendTyping = parseJsonStdout<SendMessageResult>(
      await runCliSubprocess(
        ["send", "100", sendTypingContent, "--typing", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(sendTyping.message.channelId, "100");
    assert.equal(sendTyping.message.content, sendTypingContent);

    const sendTypingEv = typingEvents.find((ev) => ev.channelId === "100");
    const sendMsgEv = messageEvents.find((ev) => ev.channelId === "100");
    assert.ok(sendTypingEv, "Expected POST /channels/100/typing");
    assert.ok(sendMsgEv, "Expected POST /channels/100/messages");
    assert.ok(
      sendMsgEv.perfMs - sendTypingEv.perfMs >= 800,
      `Expected >=800ms delay between typing and send, got ${(sendMsgEv.perfMs - sendTypingEv.perfMs).toFixed(1)}ms`,
    );

    // Verify EVERY REST call in user mode carried raw Authorization, X-Discord-Locale, base64 X-Super-Properties, and desktop User-Agent.
    assert.ok(servers.restRequests.length >= 10);
    for (const req of servers.restRequests) {
      assertUserModeRestHeaders(req.headers, userToken);
    }

    // Stop daemon cleanly via CLI subprocess.
    const stopData = parseJsonStdout<{ stopping: true; pid: number }>(
      await runCliSubprocess(
        ["daemon", "stop", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(stopData.stopping, true);
  });

  it("user-mode REST fallbacks (guilds, dms, raw invite code join) + DISCORD_AUTO_TYPING=1 natural typing delay", async () => {
    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "discord-cli-e2e-fallback-"),
    );
    tempDirs.push(tempHome);

    const userToken = "mfa.mock-user-fallback-token";
    let getUserGuildsCalls = 0;
    let getUserDmsCalls = 0;
    let nextMessageId = 8100;
    const joinBodies: Array<{ code: string; body: unknown }> = [];
    const typingEvents: Array<{ channelId: string; perfMs: number }> = [];
    const messageEvents: Array<{
      channelId: string;
      content: string;
      perfMs: number;
    }> = [];

    const restPartialGuilds: DiscordPartialGuild[] = [
      {
        id: "10",
        name: "REST Fallback Guild",
        icon: "rest_icon",
        owner: true,
        approximate_member_count: 25,
        approximate_presence_count: 6,
      },
    ];

    const restDms: DiscordChannel[] = [
      {
        id: "900",
        type: DiscordChannelType.DM,
        last_message_id: "8500",
        recipients: [ALICE],
      },
    ];

    const servers = await createMockDiscordServers({
      onIdentify: (_payload, wsUrl, pushDispatch) => {
        // Empty guilds and private_channels so guilds/dms exercise REST fallback.
        pushDispatch("READY", {
          v: 10,
          user: USER_SELF,
          guilds: [],
          private_channels: [],
          session_id: "e2e-user-fallback-session",
          resume_gateway_url: wsUrl,
        });
      },
      handleRest: (req, wsUrl) => {
        if (req.method === "GET" && req.pathname === "/api/v10/gateway") {
          return { status: 200, body: { url: wsUrl } };
        }

        if (req.method === "GET" && req.pathname === "/api/v10/users/@me/guilds") {
          getUserGuildsCalls += 1;
          assert.equal(req.searchParams.get("with_counts"), "true");
          return { status: 200, body: restPartialGuilds };
        }

        if (req.method === "GET" && req.pathname === "/api/v10/users/@me/channels") {
          getUserDmsCalls += 1;
          return { status: 200, body: restDms };
        }

        if (
          req.method === "POST" &&
          req.pathname === "/api/v10/invites/e2e-raw-invite"
        ) {
          joinBodies.push({
            code: "e2e-raw-invite",
            body: JSON.parse(req.bodyText) as unknown,
          });
          return {
            status: 200,
            body: {
              code: "e2e-raw-invite",
              type: 0,
              guild: { id: "40", name: "Raw Invite Guild", icon: null },
              channel: {
                id: "400",
                name: "lobby",
                type: DiscordChannelType.GUILD_TEXT,
              },
              approximate_member_count: 9,
            } satisfies DiscordInvite,
          };
        }

        const typingMatch = /^\/api\/v10\/channels\/(\d+)\/typing$/.exec(
          req.pathname,
        );
        if (req.method === "POST" && typingMatch !== null) {
          typingEvents.push({
            channelId: typingMatch[1]!,
            perfMs: req.perfMs,
          });
          return { status: 204 };
        }

        const msgMatch = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(
          req.pathname,
        );
        if (req.method === "POST" && msgMatch !== null) {
          const channelId = msgMatch[1]!;
          const parsed = JSON.parse(req.bodyText) as { content: string };
          messageEvents.push({
            channelId,
            content: parsed.content,
            perfMs: req.perfMs,
          });
          nextMessageId += 1;
          return {
            status: 200,
            body: {
              id: String(nextMessageId),
              channel_id: channelId,
              ...(channelId === "100" ? { guild_id: "10" } : {}),
              author: USER_SELF,
              content: parsed.content,
              timestamp: "2026-11-13T18:15:00.000Z",
              type: 0,
            } satisfies DiscordMessage,
          };
        }

        return { status: 404, body: { code: 10003, message: "Not Found" } };
      },
    });
    cleanupTasks.push(servers.close);

    const daemonEnv = makeCleanTestEnv({
      DISCORD_TOKEN: userToken,
      DISCORD_AUTO_TYPING: "1",
      DISCORD_API_BASE_URL: servers.apiBaseUrl,
      DISCORD_CLI_HOME: tempHome,
    });

    const daemon = await startDaemon({
      port: 0,
      homeDir: tempHome,
      compress: false,
      registerSignalHandlers: false,
      env: daemonEnv,
      log: () => undefined,
    });
    cleanupTasks.push(async () => {
      await daemon.stop();
    });

    await waitUntil(
      () => daemon.gateway.getConnectionState() === "ready",
      5000,
      "fallback user daemon gateway ready",
    );

    // 1. guilds REST fallback -> then cache hit.
    const guildsRest = parseJsonStdout<GuildsResult>(
      await runInProcessCli(["guilds", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(guildsRest.source, "rest");
    assert.equal(guildsRest.totalGuilds, 1);
    assert.equal(guildsRest.guilds[0]?.id, "10");
    assert.equal(guildsRest.guilds[0]?.name, "REST Fallback Guild");
    assert.equal(guildsRest.guilds[0]?.owner, true);
    assert.equal(getUserGuildsCalls, 1);

    const guildsCached = parseJsonStdout<GuildsResult>(
      await runInProcessCli(["guilds", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(guildsCached.source, "cache");
    assert.equal(getUserGuildsCalls, 1);

    // 2. dms REST fallback -> then cache hit.
    const dmsRest = parseJsonStdout<DmChannelsResult>(
      await runInProcessCli(["dms", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(dmsRest.source, "rest");
    assert.equal(dmsRest.totalDms, 1);
    assert.equal(dmsRest.dms[0]?.channelId, "900");
    assert.equal(dmsRest.dms[0]?.recipientId, ALICE.id);
    assert.equal(getUserDmsCalls, 1);

    const dmsCached = parseJsonStdout<DmChannelsResult>(
      await runInProcessCli(["dms", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(dmsCached.source, "cache");
    assert.equal(getUserDmsCalls, 1);

    // 3. join with raw invite code.
    const joinRaw = parseJsonStdout<JoinGuildResult>(
      await runCliSubprocess(
        ["join", "e2e-raw-invite", "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.deepEqual(joinBodies, [{ code: "e2e-raw-invite", body: {} }]);
    assert.equal(joinRaw.inviteCode, "e2e-raw-invite");
    assert.equal(joinRaw.guild?.id, "40");

    // 4. DISCORD_AUTO_TYPING=1 triggers typing + >=800ms delay on send & dm WITHOUT --typing flag.
    const autoSendContent = "hi auto typing check!"; // 21 chars -> 840ms delay
    const autoSend = parseJsonStdout<SendMessageResult>(
      await runCliSubprocess(
        ["send", "100", autoSendContent, "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(autoSend.message.content, autoSendContent);
    const autoSendTyping = typingEvents.find((e) => e.channelId === "100");
    const autoSendMsg = messageEvents.find((e) => e.channelId === "100");
    assert.ok(autoSendTyping && autoSendMsg);
    assert.ok(
      autoSendMsg.perfMs - autoSendTyping.perfMs >= 800,
      `Expected >=800ms auto-typing delay on send, got ${(autoSendMsg.perfMs - autoSendTyping.perfMs).toFixed(1)}ms`,
    );

    const autoDmContent = "hi auto dm typing ok!"; // 21 chars -> 840ms delay
    const autoDm = parseJsonStdout<DirectMessageResult>(
      await runCliSubprocess(
        ["dm", ALICE.id, autoDmContent, "--home", tempHome, "--json"],
        daemonEnv,
      ),
    );
    assert.equal(autoDm.channel.id, "900");
    assert.equal(autoDm.message.content, autoDmContent);
    const autoDmTyping = typingEvents.find((e) => e.channelId === "900");
    const autoDmMsg = messageEvents.find((e) => e.channelId === "900");
    assert.ok(autoDmTyping && autoDmMsg);
    assert.ok(
      autoDmMsg.perfMs - autoDmTyping.perfMs >= 800,
      `Expected >=800ms auto-typing delay on dm, got ${(autoDmMsg.perfMs - autoDmTyping.perfMs).toFixed(1)}ms`,
    );

    for (const req of servers.restRequests) {
      assertUserModeRestHeaders(req.headers, userToken);
    }

    await daemon.stop();
  });

  it("bot-mode auto-detection from \"Bot \" token prefix without DISCORD_AUTH_MODE", async () => {
    const tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "discord-cli-e2e-bot-prefix-"),
    );
    tempDirs.push(tempHome);

    const servers = await createMockDiscordServers({
      onIdentify: (_payload, wsUrl, pushDispatch) => {
        pushDispatch("READY", {
          v: 10,
          user: BOT_USER,
          guilds: [],
          session_id: "e2e-bot-prefix-session",
          resume_gateway_url: wsUrl,
        });
      },
      handleRest: (req, wsUrl) => {
        if (req.method === "GET" && req.pathname === "/api/v10/gateway/bot") {
          return {
            status: 200,
            body: {
              url: wsUrl,
              shards: 1,
              session_start_limit: {
                total: 1000,
                remaining: 999,
                reset_after: 0,
                max_concurrency: 1,
              },
            },
          };
        }
        return { status: 404, body: { code: 10003, message: "Not Found" } };
      },
    });
    cleanupTasks.push(servers.close);

    const daemonEnv = makeCleanTestEnv({
      DISCORD_TOKEN: "Bot mock-prefix-bot-token",
      DISCORD_API_BASE_URL: servers.apiBaseUrl,
      DISCORD_CLI_HOME: tempHome,
    });

    const daemon = await startDaemon({
      port: 0,
      homeDir: tempHome,
      compress: false,
      registerSignalHandlers: false,
      env: daemonEnv,
      log: () => undefined,
    });
    cleanupTasks.push(async () => {
      await daemon.stop();
    });

    await waitUntil(
      () => daemon.gateway.getConnectionState() === "ready",
      5000,
      "Bot-prefix daemon gateway ready",
    );

    assert.equal(
      servers.restRequests.filter((r) => r.pathname === "/api/v10/gateway/bot")
        .length,
      1,
    );
    assert.equal(
      servers.restRequests.filter((r) => r.pathname === "/api/v10/gateway")
        .length,
      0,
    );
    assert.equal(
      servers.restRequests[0]?.headers["authorization"],
      "Bot mock-prefix-bot-token",
    );
    assert.equal(typeof servers.identifyPayloads[0]?.d["intents"], "number");

    const statusData = parseJsonStdout<DaemonStatusResult>(
      await runInProcessCli(["status", "--home", tempHome, "--json"], daemonEnv),
    );
    assert.equal(statusData.authMode, "bot");

    await daemon.stop();
  });
});
