import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_VERSION,
  resolveDaemonConfig,
  type DaemonRuntimeConfig,
} from "../shared/config.js";
import {
  cleanupStaleDaemonLockfile,
  inspectDaemonLockfile,
  removeDaemonLockfile,
  writeDaemonLockfile,
} from "../shared/ipc-protocol.js";
import type { DaemonLockfile, DiscordAuthMode } from "../shared/types.js";
import { GatewayClient, type GatewayWebSocket } from "./gateway.js";
import { DaemonIpcServer } from "./ipc-server.js";
import { RateLimiter } from "./rate-limiter.js";
import { DiscordRestClient, type FetchLike } from "./rest-client.js";
import { StateCache } from "./state-cache.js";

/**
 * Discord CLI background daemon bootstrapper and lifecycle manager.
 */

export interface DaemonCliArgs {
  port?: string;
  homeDir?: string;
}

export interface StartDaemonOptions {
  port?: number | string;
  homeDir?: string;
  compress?: boolean;
  intents?: number;
  authMode?: DiscordAuthMode;
  autoTyping?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  createWebSocket?: (url: string) => GatewayWebSocket;
  registerSignalHandlers?: boolean;
  log?: (msg: string) => void;
  onStopRequested?: () => void | Promise<void>;
}

export interface RunningDaemonHandle {
  config: DaemonRuntimeConfig;
  lockfile: DaemonLockfile;
  server: DaemonIpcServer;
  gateway: GatewayClient;
  stateCache: StateCache;
  restClient: DiscordRestClient;
  rateLimiter: RateLimiter;
  stop: () => Promise<void>;
}

export function parseDaemonCliArgs(argv: readonly string[]): DaemonCliArgs {
  const result: DaemonCliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--port") {
      if (i + 1 >= argv.length) {
        throw new RangeError('Missing value for flag "--port".');
      }
      i += 1;
      result.port = argv[i]!;
      continue;
    }

    if (token.startsWith("--port=")) {
      result.port = token.slice("--port=".length);
      continue;
    }

    if (token === "--home") {
      if (i + 1 >= argv.length) {
        throw new TypeError('Missing value for flag "--home".');
      }
      i += 1;
      const homeValue = argv[i]!;
      if (homeValue.trim().length === 0) {
        throw new TypeError("--home path must not be empty.");
      }
      result.homeDir = homeValue;
      continue;
    }

    if (token.startsWith("--home=")) {
      const homeValue = token.slice("--home=".length);
      if (homeValue.trim().length === 0) {
        throw new TypeError("--home path must not be empty.");
      }
      result.homeDir = homeValue;
      continue;
    }

    throw new TypeError(`Unknown daemon argument "${token}".`);
  }

  return result;
}

function defaultDaemonLog(msg: string): void {
  process.stderr.write(`[daemon] ${msg}\n`);
}

export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<RunningDaemonHandle> {
  const env = options.env ?? process.env;
  const log = options.log ?? defaultDaemonLog;

  const config = resolveDaemonConfig(
    {
      port: options.port,
      homeDir: options.homeDir,
      compress: options.compress,
      intents: options.intents,
      authMode: options.authMode,
      autoTyping: options.autoTyping,
    },
    env,
  );

  await cleanupStaleDaemonLockfile(config.lockfilePath);
  const existing = await inspectDaemonLockfile(config.lockfilePath);
  if (existing.state === "active") {
    throw new Error(
      `Daemon is already running (PID ${existing.lockfile.pid}, ${existing.lockfile.host}:${existing.lockfile.port}, lockfile "${config.lockfilePath}").`,
    );
  }

  const startedAt = new Date().toISOString();
  const rateLimiter = new RateLimiter();
  const restClient = new DiscordRestClient({
    token: config.discordToken,
    authMode: config.authMode,
    apiBaseUrl: config.apiBaseUrl,
    rateLimiter,
    fetchImpl: options.fetchImpl,
  });
  const stateCache = new StateCache({
    maxMessagesPerChannel: config.maxMessagesPerChannel,
  });

  const gateway = new GatewayClient({
    token: config.discordToken,
    authMode: config.authMode,
    intents: config.authMode === "bot" ? config.intents : undefined,
    compress: config.compress,
    fallbackGatewayUrl: config.gatewayUrl,
    fetchGateway: () => restClient.getGateway(),
    fetchGatewayBot: () => restClient.getGatewayBot(),
    onDispatch: (eventName, data) => {
      stateCache.handleGatewayDispatch(eventName, data);
    },
    onStateChange: (state, detail) => {
      stateCache.emitGatewayState(state, detail);
    },
    createWebSocket: options.createWebSocket,
    log,
  });

  let stopPromise: Promise<void> | null = null;
  let lockfileWritten = false;
  let signalsAttached = false;

  const onSigInt = (): void => {
    log("Received SIGINT; shutting down daemon.");
    void stop();
  };

  const onSigTerm = (): void => {
    log("Received SIGTERM; shutting down daemon.");
    void stop();
  };

  const detachSignals = (): void => {
    if (!signalsAttached) {
      return;
    }
    signalsAttached = false;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const server = new DaemonIpcServer({
    host: config.ipcHost,
    port: config.ipcPort,
    authMode: config.authMode,
    autoTyping: config.autoTyping,
    stateCache,
    restClient,
    rateLimiter,
    gateway,
    startedAt,
    onStopRequested: async () => {
      log("Received IPC stop request; shutting down daemon.");
      await stop();
      await options.onStopRequested?.();
    },
    log,
  });

  const stop = (): Promise<void> => {
    if (stopPromise !== null) {
      return stopPromise;
    }

    stopPromise = (async () => {
      detachSignals();

      await gateway.stop().catch((err: unknown) => {
        log(
          `Error stopping Gateway client: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      await server.stop().catch((err: unknown) => {
        log(
          `Error stopping IPC server: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      if (lockfileWritten) {
        await removeDaemonLockfile(config.lockfilePath, process.pid).catch(
          (err: unknown) => {
            log(
              `Error removing daemon lockfile: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
      }
    })();

    return stopPromise;
  };

  // Start IPC server before Gateway connect so `/v1/status` answers immediately.
  const listenInfo = await server.start();
  const lockfile: DaemonLockfile = {
    pid: process.pid,
    host: listenInfo.host,
    port: listenInfo.port,
    startedAt,
    version: CLI_VERSION,
  };

  try {
    await writeDaemonLockfile(config.lockfilePath, lockfile);
    lockfileWritten = true;
  } catch (err) {
    await server.stop().catch(() => undefined);
    throw err;
  }

  if (options.registerSignalHandlers !== false) {
    signalsAttached = true;
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
  }

  // Initiate Gateway handshake asynchronously without blocking IPC readiness.
  void gateway.start().catch((err: unknown) => {
    log(
      `Gateway startup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return {
    config,
    lockfile,
    server,
    gateway,
    stateCache,
    restClient,
    rateLimiter,
    stop,
  };
}

export async function runDaemonCli(
  argv: readonly string[] = process.argv.slice(2),
  options: Omit<StartDaemonOptions, "port" | "homeDir"> = {},
): Promise<RunningDaemonHandle> {
  const parsed = parseDaemonCliArgs(argv);
  const startOptions: StartDaemonOptions = {
    ...options,
    registerSignalHandlers: options.registerSignalHandlers ?? true,
  };
  if (parsed.port !== undefined) {
    startOptions.port = parsed.port;
  }
  if (parsed.homeDir !== undefined) {
    startOptions.homeDir = parsed.homeDir;
  }
  return startDaemon(startOptions);
}

function isDirectDaemonExecution(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    return false;
  }
  try {
    const selfPath = path.resolve(
      fsSync.realpathSync(fileURLToPath(import.meta.url)),
    );
    const entryPath = path.resolve(fsSync.realpathSync(entry));
    if (process.platform === "win32") {
      return selfPath.toLowerCase() === entryPath.toLowerCase();
    }
    return selfPath === entryPath;
  } catch {
    return false;
  }
}

if (isDirectDaemonExecution()) {
  runDaemonCli(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal daemon error: ${message}\n`);
    process.exitCode = 1;
  });
}
