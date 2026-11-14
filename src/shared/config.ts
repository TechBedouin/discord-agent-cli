import os from "node:os";
import path from "node:path";

import type {
  DiscordAuthMode,
  GatewayIdentifyProperties,
} from "./types.js";

export type { DiscordAuthMode };

/**
 * Shared configuration defaults, auth mode / header helpers, Gateway intent bitmasks,
 * and environment/path resolvers.
 *
 * Authentication tokens are read exclusively from explicit environment variables
 * (`DISCORD_TOKEN`, falling back to `DISCORD_BOT_TOKEN`). Desktop Discord user profile
 * directories are never accessed.
 */

export const CLI_VERSION = "0.1.0";
export const DISCORD_API_VERSION = 10;
export const DEFAULT_DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const DEFAULT_DISCORD_GATEWAY_URL =
  "wss://gateway.discord.gg/?v=10&encoding=json";

export const DEFAULT_IPC_HOST = "127.0.0.1";
export const DEFAULT_IPC_PORT = 47832;

export const DEFAULT_HOME_DIR_NAME = ".discord-cli";
export const DAEMON_LOCKFILE_NAME = "daemon.json";
export const DAEMON_LOG_FILE_NAME = "daemon.log";

export const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 200;
export const DEFAULT_READ_LIMIT = 50;
export const MAX_DISCORD_READ_LIMIT = 100;
export const DEFAULT_CHANNEL_MEMBERS_LIMIT = 50;
export const MAX_CHANNEL_MEMBERS_LIMIT = 1000;

export const DEFAULT_USER_AGENT =
  `DiscordBot (https://github.com/local/discord-cli, ${CLI_VERSION})`;
export const DEFAULT_DISCORD_LOCALE = "en-US";
export const DEFAULT_DISCORD_CLIENT_VERSION = "1.0.9268";
export const DEFAULT_DISCORD_ORIGIN = "https://discord.com";
export const DEFAULT_DISCORD_REFERER = "https://discord.com/channels/@me";
export const DEFAULT_DISCORD_DEBUG_OPTIONS = "bugReporterEnabled";
export const DEFAULT_INVITE_CONTEXT_LOCATION = "Accept Invite Page";
export const DEFAULT_USER_MODE_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${DEFAULT_DISCORD_CLIENT_VERSION} Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36`;

export const DEFAULT_AUTO_TYPING_ENABLED = false;
export const TYPING_MS_PER_CHAR = 40;
export const MIN_TYPING_DELAY_MS = 800;
export const MAX_TYPING_DELAY_MS = 3500;

/**
 * Standard Discord Gateway v10 intent bits.
 * Privileged intents (`GUILD_MEMBERS`, `GUILD_PRESENCES`, `MESSAGE_CONTENT`) require
 * explicit opt-in inside the Discord Developer Portal for the bot application.
 */
export const GatewayIntentBits = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
  GUILD_MESSAGE_POLLS: 1 << 24,
  DIRECT_MESSAGE_POLLS: 1 << 25,
} as const;

export type GatewayIntentName = keyof typeof GatewayIntentBits;

export function computeIntentsBitmask(...bits: number[]): number {
  let mask = 0;
  for (const bit of bits) {
    mask |= bit;
  }
  return mask;
}

/**
 * Unprivileged intents sufficient for guild/channel/DM discovery and reactions.
 */
export const BASE_UNPRIVILEGED_GATEWAY_INTENTS = computeIntentsBitmask(
  GatewayIntentBits.GUILDS,
  GatewayIntentBits.GUILD_MESSAGES,
  GatewayIntentBits.GUILD_MESSAGE_REACTIONS,
  GatewayIntentBits.DIRECT_MESSAGES,
  GatewayIntentBits.DIRECT_MESSAGE_REACTIONS,
);

/**
 * Default daemon Gateway intents including `MESSAGE_CONTENT` so cached/streamed
 * guild messages retain full `content`, `attachments`, and `embeds`.
 */
export const DEFAULT_GATEWAY_INTENTS = computeIntentsBitmask(
  BASE_UNPRIVILEGED_GATEWAY_INTENTS,
  GatewayIntentBits.MESSAGE_CONTENT,
);

export interface DaemonRuntimeConfig {
  discordToken: string;
  authMode: DiscordAuthMode;
  homeDir: string;
  lockfilePath: string;
  logPath: string;
  ipcHost: string;
  ipcPort: number;
  apiBaseUrl: string;
  gatewayUrl: string;
  intents: number;
  compress: boolean;
  maxMessagesPerChannel: number;
  autoTyping: boolean;
}

export interface CliRuntimeConfig {
  homeDir: string;
  lockfilePath: string;
  ipcHost: string;
  explicitPort: number | null;
}

export interface ResolveConfigOptions {
  homeDir?: string;
  port?: number | string;
  compress?: boolean;
  intents?: number;
  authMode?: DiscordAuthMode;
  autoTyping?: boolean;
}

export interface DiscordTokenInfo {
  token: string;
  rawToken: string;
  authMode: DiscordAuthMode;
  authorizationHeader: string;
}

export interface DiscordSuperProperties {
  os: string;
  browser: string;
  device?: string;
  release_channel: string;
  client_version: string;
  os_version: string;
  os_arch: string;
  app_arch: string;
  system_locale: string;
  browser_user_agent: string;
  browser_version: string;
  client_build_number: number;
  native_build_number: number;
  client_event_source: string | null;
  [key: string]: unknown;
}

export const DEFAULT_SUPER_PROPERTIES: Readonly<DiscordSuperProperties> = {
  os: "Windows",
  browser: "Discord Client",
  release_channel: "stable",
  client_version: DEFAULT_DISCORD_CLIENT_VERSION,
  os_version: "10.0.22631",
  os_arch: "x64",
  app_arch: "x64",
  system_locale: DEFAULT_DISCORD_LOCALE,
  browser_user_agent: DEFAULT_USER_MODE_USER_AGENT,
  browser_version: "44.9.3",
  client_build_number: 520000,
  native_build_number: 85000,
  client_event_source: null,
};

export const DEFAULT_USER_GATEWAY_PROPERTIES: Readonly<GatewayIdentifyProperties> =
  {
    $os: "Windows",
    $browser: "Discord Client",
    $device: "desktop",
  };

export interface BuildDiscordRestHeadersOptions {
  token: string;
  authMode: DiscordAuthMode;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  superProperties?: Partial<DiscordSuperProperties>;
}

function trimNonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripBotTokenPrefix(rawToken: string): string {
  const trimmed = rawToken.trim();
  return trimmed.startsWith("Bot ") ? trimmed.slice(4).trim() : trimmed;
}

function resolveRawDiscordToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    trimNonEmpty(env["DISCORD_TOKEN"]) ??
    trimNonEmpty(env["DISCORD_BOT_TOKEN"])
  );
}

/**
 * Infers `"bot"` if the raw token carries a `"Bot "` prefix, otherwise `"user"`.
 */
export function inferDiscordAuthModeFromToken(
  rawToken: string,
): DiscordAuthMode {
  return rawToken.trim().startsWith("Bot ") ? "bot" : "user";
}

/**
 * Resolves Discord auth mode from `DISCORD_AUTH_MODE` (`"user"` | `"bot"`),
 * or auto-detects `"bot"` when the token starts with `"Bot "` and defaults to `"user"`.
 */
export function resolveDiscordAuthMode(
  env: NodeJS.ProcessEnv = process.env,
  rawTokenOverride?: string,
): DiscordAuthMode {
  const rawMode = trimNonEmpty(env["DISCORD_AUTH_MODE"]);
  if (rawMode !== null) {
    const normalized = rawMode.toLowerCase();
    if (normalized === "user" || normalized === "bot") {
      return normalized;
    }
    throw new RangeError(
      `Invalid DISCORD_AUTH_MODE "${rawMode}": expected "user" or "bot".`,
    );
  }

  const candidate =
    trimNonEmpty(rawTokenOverride) ?? resolveRawDiscordToken(env);
  if (candidate !== null && candidate.startsWith("Bot ")) {
    return "bot";
  }
  return "user";
}

/**
 * Formats the Discord `Authorization` header value for the given auth mode.
 */
export function formatDiscordAuthorizationHeader(
  token: string,
  authMode: DiscordAuthMode,
): string {
  const normalized = stripBotTokenPrefix(token);
  if (normalized.length === 0) {
    throw new TypeError("Discord token must not be empty.");
  }
  return authMode === "bot" ? `Bot ${normalized}` : normalized;
}

/**
 * Reads the normalized Discord token from `DISCORD_TOKEN` with `DISCORD_BOT_TOKEN` fallback.
 * Strips a leading `"Bot "` prefix if supplied in the env var.
 */
export function resolveDiscordToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = resolveRawDiscordToken(env);
  if (raw === null) {
    return null;
  }
  return trimNonEmpty(stripBotTokenPrefix(raw));
}

export function requireDiscordToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = resolveDiscordToken(env);
  if (token === null) {
    throw new Error(
      "Missing Discord token. Set DISCORD_TOKEN (or DISCORD_BOT_TOKEN) in your environment.",
    );
  }
  return token;
}

/**
 * Resolves the normalized token, detected/configured `authMode`, and `Authorization` header.
 */
export function resolveDiscordTokenInfo(
  env: NodeJS.ProcessEnv = process.env,
): DiscordTokenInfo | null {
  const rawToken = resolveRawDiscordToken(env);
  if (rawToken === null) {
    return null;
  }
  const token = trimNonEmpty(stripBotTokenPrefix(rawToken));
  if (token === null) {
    return null;
  }
  const authMode = resolveDiscordAuthMode(env, rawToken);
  return {
    token,
    rawToken,
    authMode,
    authorizationHeader: formatDiscordAuthorizationHeader(token, authMode),
  };
}

export function requireDiscordTokenInfo(
  env: NodeJS.ProcessEnv = process.env,
): DiscordTokenInfo {
  const info = resolveDiscordTokenInfo(env);
  if (info === null) {
    throw new Error(
      "Missing Discord token. Set DISCORD_TOKEN (or DISCORD_BOT_TOKEN) in your environment.",
    );
  }
  return info;
}

export function buildSuperProperties(
  overrides: Partial<DiscordSuperProperties> = {},
): DiscordSuperProperties {
  return {
    ...DEFAULT_SUPER_PROPERTIES,
    ...overrides,
  };
}

export function encodeSuperProperties(
  overrides: Partial<DiscordSuperProperties> = {},
): string {
  return Buffer.from(
    JSON.stringify(buildSuperProperties(overrides)),
    "utf8",
  ).toString("base64");
}

function resolveDefaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function encodeInviteContextProperties(
  location: string = DEFAULT_INVITE_CONTEXT_LOCATION,
): string {
  return Buffer.from(JSON.stringify({ location }), "utf8").toString("base64");
}

export function buildUserModeGatewayHeaders(
  userAgent: string = DEFAULT_USER_MODE_USER_AGENT,
): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Origin: DEFAULT_DISCORD_ORIGIN,
  };
}

export function buildUserModeDefaultHeaders(
  options: {
    userAgent?: string;
    locale?: string;
    timezone?: string;
    superProperties?: Partial<DiscordSuperProperties>;
  } = {},
): Record<string, string> {
  const userAgent = options.userAgent ?? DEFAULT_USER_MODE_USER_AGENT;
  const locale = options.locale ?? DEFAULT_DISCORD_LOCALE;
  const timezone = trimNonEmpty(options.timezone) ?? resolveDefaultTimezone();
  return {
    "User-Agent": userAgent,
    Origin: DEFAULT_DISCORD_ORIGIN,
    Referer: DEFAULT_DISCORD_REFERER,
    "X-Debug-Options": DEFAULT_DISCORD_DEBUG_OPTIONS,
    "X-Discord-Locale": locale,
    "X-Discord-Timezone": timezone,
    "X-Super-Properties": encodeSuperProperties({
      browser_user_agent: userAgent,
      system_locale: locale,
      ...options.superProperties,
    }),
  };
}

export function buildDiscordRestHeaders(
  options: BuildDiscordRestHeadersOptions,
): Record<string, string> {
  const authorization = formatDiscordAuthorizationHeader(
    options.token,
    options.authMode,
  );
  if (options.authMode === "user") {
    return {
      Authorization: authorization,
      ...buildUserModeDefaultHeaders({
        userAgent: options.userAgent,
        locale: options.locale,
        timezone: options.timezone,
        superProperties: options.superProperties,
      }),
    };
  }
  return {
    Authorization: authorization,
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
  };
}

export function buildGatewayIdentifyProperties(
  authMode: DiscordAuthMode = "user",
): GatewayIdentifyProperties {
  if (authMode === "user") {
    return { ...DEFAULT_USER_GATEWAY_PROPERTIES };
  }
  return {
    os: process.platform,
    browser: "discord-cli",
    device: "discord-cli",
  };
}

/**
 * Resolves the CLI state directory (`DISCORD_CLI_HOME`, defaulting to `~/.discord-cli`).
 */
export function resolveCliHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homeOverride?: string,
): string {
  const candidate =
    trimNonEmpty(homeOverride) ?? trimNonEmpty(env["DISCORD_CLI_HOME"]);
  if (candidate !== null) {
    return path.resolve(candidate);
  }
  return path.join(os.homedir(), DEFAULT_HOME_DIR_NAME);
}

export function resolveLockfilePath(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    homeDir !== undefined ? path.resolve(homeDir) : resolveCliHomeDir(env),
    DAEMON_LOCKFILE_NAME,
  );
}

export function resolveDaemonLogPath(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    homeDir !== undefined ? path.resolve(homeDir) : resolveCliHomeDir(env),
    DAEMON_LOG_FILE_NAME,
  );
}

/**
 * Parses and validates an IPC TCP port in `0..65535` (`0` selects an ephemeral port).
 */
export function parsePortValue(raw: number | string, label = "port"): number {
  const numeric =
    typeof raw === "number"
      ? raw
      : /^\d+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) {
    throw new RangeError(
      `Invalid ${label} "${String(raw)}": expected an integer between 0 and 65535.`,
    );
  }
  return numeric;
}

export function resolveIpcPort(
  portOverride?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (portOverride !== undefined) {
    return parsePortValue(portOverride, "--port");
  }
  const envPort = trimNonEmpty(env["DISCORD_CLI_PORT"]);
  if (envPort !== null) {
    return parsePortValue(envPort, "DISCORD_CLI_PORT");
  }
  return DEFAULT_IPC_PORT;
}

/**
 * Resolves Gateway intents from `DISCORD_INTENTS` (decimal/hex integer or comma-separated
 * `GatewayIntentBits` names) or returns `DEFAULT_GATEWAY_INTENTS`.
 */
export function resolveGatewayIntents(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = trimNonEmpty(env["DISCORD_INTENTS"]);
  if (raw === null) {
    return DEFAULT_GATEWAY_INTENTS;
  }
  if (/^(?:0x[\da-f]+|\d+)$/i.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new RangeError(`Invalid DISCORD_INTENTS bitmask: "${raw}".`);
    }
    return parsed;
  }

  let mask = 0;
  for (const part of raw.split(",")) {
    const name = part.trim().toUpperCase();
    if (name.length === 0) {
      continue;
    }
    if (!(name in GatewayIntentBits)) {
      throw new RangeError(`Unknown Gateway intent name "${name}" in DISCORD_INTENTS.`);
    }
    mask |= GatewayIntentBits[name as GatewayIntentName];
  }
  return mask;
}

export function resolveDiscordApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = trimNonEmpty(env["DISCORD_API_BASE_URL"]);
  return (raw ?? DEFAULT_DISCORD_API_BASE_URL).replace(/\/+$/, "");
}

export function resolveDiscordGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return trimNonEmpty(env["DISCORD_GATEWAY_URL"]) ?? DEFAULT_DISCORD_GATEWAY_URL;
}

function parseBooleanEnvFlag(
  envVarName: string,
  rawValue: string | undefined,
  defaultValue: boolean,
): boolean {
  const raw = trimNonEmpty(rawValue)?.toLowerCase();
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === "1" || raw === "true" || raw === "yes") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  throw new RangeError(
    `Invalid ${envVarName} value "${raw}": expected true/false or 1/0.`,
  );
}

export function resolveCompressEnabled(
  compressOverride?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (compressOverride !== undefined) {
    return compressOverride;
  }
  return parseBooleanEnvFlag("DISCORD_CLI_ZLIB", env["DISCORD_CLI_ZLIB"], true);
}

export function resolveMaxMessagesPerChannel(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = trimNonEmpty(env["DISCORD_CLI_MAX_MESSAGES_PER_CHANNEL"]);
  if (raw === null) {
    return DEFAULT_MAX_MESSAGES_PER_CHANNEL;
  }
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) {
    throw new RangeError(
      `Invalid DISCORD_CLI_MAX_MESSAGES_PER_CHANNEL "${raw}": expected 1..10000.`,
    );
  }
  return parsed;
}

export function resolveAutoTypingEnabled(
  autoTypingOverride?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (autoTypingOverride !== undefined) {
    return autoTypingOverride;
  }
  return parseBooleanEnvFlag(
    "DISCORD_AUTO_TYPING",
    env["DISCORD_AUTO_TYPING"],
    DEFAULT_AUTO_TYPING_ENABLED,
  );
}

export function resolveDiscordAutoTyping(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveAutoTypingEnabled(undefined, env);
}

/**
 * Calculates human-like typing delay (`40ms` per character, clamped to `800ms..3500ms`).
 */
export function calculateTypingDelayMs(contentOrLength: string | number): number {
  const length =
    typeof contentOrLength === "string"
      ? contentOrLength.length
      : Number.isFinite(contentOrLength)
        ? Math.max(0, contentOrLength)
        : 0;
  const rawDelayMs = Math.round(length * TYPING_MS_PER_CHAR);
  return Math.min(MAX_TYPING_DELAY_MS, Math.max(MIN_TYPING_DELAY_MS, rawDelayMs));
}

/**
 * Resolves full daemon runtime configuration (requiring `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN`).
 */
export function resolveDaemonConfig(
  options: ResolveConfigOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): DaemonRuntimeConfig {
  const homeDir = resolveCliHomeDir(env, options.homeDir);
  const discordToken = requireDiscordToken(env);
  const authMode = options.authMode ?? resolveDiscordAuthMode(env);
  return {
    discordToken,
    authMode,
    homeDir,
    lockfilePath: resolveLockfilePath(homeDir, env),
    logPath: resolveDaemonLogPath(homeDir, env),
    ipcHost: DEFAULT_IPC_HOST,
    ipcPort: resolveIpcPort(options.port, env),
    apiBaseUrl: resolveDiscordApiBaseUrl(env),
    gatewayUrl: resolveDiscordGatewayUrl(env),
    intents: options.intents ?? resolveGatewayIntents(env),
    compress: resolveCompressEnabled(options.compress, env),
    maxMessagesPerChannel: resolveMaxMessagesPerChannel(env),
    autoTyping: resolveAutoTypingEnabled(options.autoTyping, env),
  };
}

/**
 * Resolves CLI client configuration without requiring `DISCORD_TOKEN` (since CLI commands
 * talk to the local daemon via `daemon.json`).
 */
export function resolveCliConfig(
  options: Pick<ResolveConfigOptions, "homeDir" | "port"> = {},
  env: NodeJS.ProcessEnv = process.env,
): CliRuntimeConfig {
  const homeDir = resolveCliHomeDir(env, options.homeDir);
  const envPort = trimNonEmpty(env["DISCORD_CLI_PORT"]);
  const explicitPort =
    options.port !== undefined
      ? parsePortValue(options.port, "--port")
      : envPort !== null
        ? parsePortValue(envPort, "DISCORD_CLI_PORT")
        : null;
  return {
    homeDir,
    lockfilePath: resolveLockfilePath(homeDir, env),
    ipcHost: DEFAULT_IPC_HOST,
    explicitPort,
  };
}
