import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  CLI_VERSION,
  requireDiscordTokenInfo,
  resolveCliConfig,
  resolveDaemonLogPath,
} from "../shared/config.js";
import {
  HttpStatus,
  cleanupStaleDaemonLockfile,
  createIpcError,
  errorEnvelope,
  inspectDaemonLockfile,
  isProcessAlive,
  okEnvelope,
  serializeJsonEnvelope,
  serializeNdjsonLine,
} from "../shared/ipc-protocol.js";
import {
  DiscordChannelType,
  IpcErrorCode,
  type CachedMessage,
  type CachedReaction,
  type ChannelMembersResult,
  type DaemonStatusResult,
  type DaemonStopResult,
  type DirectMessageRequest,
  type DirectMessageResult,
  type DmChannelsResult,
  type GuildChannelSummary,
  type GuildChannelsResult,
  type GuildsResult,
  type IpcErrorPayload,
  type JoinGuildResult,
  type ReactMessageResult,
  type ReadMessagesResult,
  type SendMessageRequest,
  type SendMessageResult,
  type Snowflake,
  type UnreadResult,
} from "../shared/types.js";
import {
  CliParseError,
  formatHelpText,
  type DaemonCliCommand,
  type ParsedCliCommand,
} from "./args.js";
import { CliRuntimeError, DaemonIpcClient } from "./ipc-client.js";

/**
 * CLI command execution and human/JSON formatters.
 */

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CliCommandDeps {
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  fetchImpl?: typeof fetch;
  daemonEntryPath?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DaemonStartResult extends DaemonStatusResult {
  alreadyRunning: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveDefaultDaemonEntryPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const adjacentDist = path.resolve(moduleDir, "../daemon/index.js");
  if (fsSync.existsSync(adjacentDist)) {
    return adjacentDist;
  }
  const repoDist = path.resolve(moduleDir, "../../dist/daemon/index.js");
  if (fsSync.existsSync(repoDist)) {
    return repoDist;
  }
  return adjacentDist;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatReactionSummary(reaction: CachedReaction): string {
  const label =
    reaction.emojiId !== null
      ? `:${reaction.emojiName ?? reaction.emojiKey}:`
      : (reaction.emojiName ?? reaction.emojiKey);
  return `${label} x${reaction.count}${reaction.me ? "*" : ""}`;
}

function formatSingleLinePreview(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

const CHANNEL_TYPE_LABELS: Readonly<Record<number, string>> = {
  [DiscordChannelType.GUILD_TEXT]: "text",
  [DiscordChannelType.DM]: "dm",
  [DiscordChannelType.GUILD_VOICE]: "voice",
  [DiscordChannelType.GROUP_DM]: "group_dm",
  [DiscordChannelType.GUILD_CATEGORY]: "category",
  [DiscordChannelType.GUILD_ANNOUNCEMENT]: "announcement",
  [DiscordChannelType.ANNOUNCEMENT_THREAD]: "announcement_thread",
  [DiscordChannelType.PUBLIC_THREAD]: "public_thread",
  [DiscordChannelType.PRIVATE_THREAD]: "private_thread",
  [DiscordChannelType.GUILD_STAGE_VOICE]: "stage",
  [DiscordChannelType.GUILD_FORUM]: "forum",
  [DiscordChannelType.GUILD_MEDIA]: "media",
};

function formatChannelType(type: number): string {
  return CHANNEL_TYPE_LABELS[type] ?? `type:${type}`;
}

export function formatStatusOutput(status: DaemonStatusResult): string {
  const authMode = status.authMode ?? status.gateway.authMode;
  const accountPrefix = authMode === "user" ? "User:     " : "Bot User: ";
  const userLabel =
    status.botUser !== null
      ? `${status.botUser.globalName ?? status.botUser.username} (@${status.botUser.username}, id: ${status.botUser.id})`
      : "(not identified yet)";

  const latencyLabel =
    status.gateway.latencyMs !== null ? `${status.gateway.latencyMs}ms` : "n/a";
  const seqLabel = status.gateway.seq !== null ? String(status.gateway.seq) : "null";

  const lines = [
    `Daemon:   PID ${status.pid} | ${status.host}:${status.port} | uptime ${formatDurationMs(status.uptimeMs)} | started ${status.startedAt}`,
  ];

  if (authMode !== undefined) {
    lines.push(`AuthMode: ${authMode}`);
  }

  lines.push(
    `${accountPrefix}${userLabel}`,
    `Gateway:  ${status.gateway.state} | latency ${latencyLabel} | seq ${seqLabel} | reconnects ${status.gateway.reconnectAttempts}`,
  );

  if (status.gateway.lastError !== null) {
    lines.push(`Gateway Error: ${status.gateway.lastError}`);
  }

  lines.push(
    `Cache:    ${status.cache.guilds} guild(s), ${status.cache.channels} channel(s), ${status.cache.dmChannels} DM(s), ${status.cache.users} user(s), ${status.cache.cachedMessages} message(s)`,
    `Unread:   ${status.cache.totalUnreadMessages} message(s) in ${status.cache.unreadChannels} channel(s) (${status.cache.totalMentions} mention(s)), ${status.cache.activeWatchers} active watcher(s)`,
    `RateLim:  ${status.rateLimits.trackedBuckets} tracked bucket(s)${status.rateLimits.globalBlockedUntil ? ` | global blocked until ${status.rateLimits.globalBlockedUntil}` : ""}`,
  );

  return lines.join("\n");
}

export function formatUnreadOutput(unread: UnreadResult): string {
  const lines = [
    `Unread: ${unread.totalUnreadMessages} message(s) across ${unread.totalUnreadChannels} channel(s) (${unread.totalMentions} mention(s))`,
  ];

  if (unread.items.length === 0) {
    lines.push("No unread messages.");
    return lines.join("\n");
  }

  for (const item of unread.items) {
    const location = item.isDm
      ? `DM (${item.channelName})`
      : `${item.guildName ?? item.guildId ?? "Guild"} #${item.channelName}`;
    const mentionTag =
      item.mentionCount > 0 ? ` | mentions=${item.mentionCount}` : "";
    const preview = formatSingleLinePreview(item.latestMessagePreview);
    lines.push(
      `- ${location} [${item.channelId}]: unread=${item.unreadCount}${mentionTag} | ${item.latestAuthorName} @ ${item.latestMessageTimestamp}: ${preview}`,
    );
  }

  return lines.join("\n");
}

function formatMessageLine(msg: CachedMessage): string[] {
  const authorName = msg.author.globalName ?? msg.author.username;
  const botTag = msg.author.bot ? " [BOT]" : "";
  const editedTag = msg.editedTimestamp !== null ? " (edited)" : "";
  const replyTag =
    msg.replyToMessageId !== null ? ` (reply to ${msg.replyToMessageId})` : "";
  const bodyText =
    msg.content.length > 0
      ? msg.content
      : msg.attachments.length > 0
        ? "(attachment-only message)"
        : "(empty)";

  const lines = [
    `[${msg.timestamp}] ${authorName}${botTag} (id: ${msg.id})${editedTag}${replyTag}: ${bodyText}`,
  ];

  if (msg.attachments.length > 0) {
    const attachmentSummary = msg.attachments
      .map((att) => `${att.filename} (${att.size}B)`)
      .join(", ");
    lines.push(`  attachments (${msg.attachments.length}): ${attachmentSummary}`);
  }

  if (msg.reactions.length > 0) {
    const reactionSummary = msg.reactions
      .map((reaction) => formatReactionSummary(reaction))
      .join("  ");
    lines.push(`  reactions: ${reactionSummary}`);
  }

  return lines;
}

export function formatReadOutput(result: ReadMessagesResult): string {
  const channelLabel = result.channel.isDm
    ? `DM ${result.channel.name}`
    : `#${result.channel.name}`;
  const markReadNote =
    result.markedReadUpTo !== null
      ? ` | marked read up to ${result.markedReadUpTo}`
      : "";
  const lines = [
    `Channel ${channelLabel} (${result.channel.id}) — ${result.messages.length} message(s) [source: ${result.source}${markReadNote}]`,
  ];

  if (result.messages.length === 0) {
    lines.push("No messages.");
    return lines.join("\n");
  }

  for (const msg of result.messages) {
    lines.push(...formatMessageLine(msg));
  }
  return lines.join("\n");
}

export function formatSendOutput(result: SendMessageResult): string {
  const replyPart =
    result.message.replyToMessageId !== null
      ? ` (reply to ${result.message.replyToMessageId})`
      : "";
  return `Sent message ${result.message.id} to channel ${result.message.channelId}${replyPart}.`;
}

export function formatReactOutput(result: ReactMessageResult): string {
  const verb = result.action === "added" ? "Added" : "Removed";
  return `${verb} reaction ${result.emoji} on message ${result.messageId} in channel ${result.channelId}.`;
}

export function formatJoinOutput(result: JoinGuildResult): string {
  const guildLabel =
    result.guild !== null
      ? `${result.guild.name} (id: ${result.guild.id})`
      : "(unknown guild)";
  const memberLabel =
    result.guild?.memberCount !== null && result.guild?.memberCount !== undefined
      ? ` | members: ${result.guild.memberCount}`
      : "";
  const channelLabel =
    result.channel !== null
      ? ` | channel: ${result.channel.name !== null ? `#${result.channel.name}` : "(unnamed)"} (id: ${result.channel.id}, type: ${formatChannelType(result.channel.type)})`
      : "";
  return `Joined guild ${guildLabel}${memberLabel} via invite ${result.inviteCode}${channelLabel}.`;
}

function formatGuildOwnerLabel(
  owner: boolean | undefined,
  ownerId: Snowflake | null,
): string {
  if (owner === true && ownerId !== null) {
    return `owner=yes (${ownerId})`;
  }
  if (owner === true) {
    return "owner=yes";
  }
  if (ownerId !== null) {
    return `owner=${ownerId}`;
  }
  if (owner === false) {
    return "owner=no";
  }
  return "owner=n/a";
}

export function formatGuildsOutput(result: GuildsResult): string {
  const lines = [
    `Guilds: ${result.totalGuilds} guild(s) [source: ${result.source}]`,
  ];

  if (result.guilds.length === 0) {
    lines.push("No joined guilds.");
    return lines.join("\n");
  }

  for (const guild of result.guilds) {
    const name = guild.name.length > 0 ? guild.name : "(unnamed guild)";
    const unavailableTag = guild.unavailable === true ? " [unavailable]" : "";
    const membersLabel =
      guild.memberCount !== null ? String(guild.memberCount) : "n/a";
    const ownerLabel = formatGuildOwnerLabel(guild.owner, guild.ownerId);
    lines.push(
      `- ${name}${unavailableTag} [id: ${guild.id}] | members: ${membersLabel} | ${ownerLabel}`,
    );
  }

  return lines.join("\n");
}

function formatChannelSummaryLine(
  channel: GuildChannelSummary,
  nameById: ReadonlyMap<Snowflake, string>,
  prefix = "",
): string {
  const parts = [
    `- ${prefix}${channel.name} [id: ${channel.id}]`,
    `type: ${formatChannelType(channel.type)}`,
  ];
  if (channel.parentId !== null) {
    const parentName = nameById.get(channel.parentId);
    parts.push(
      parentName !== undefined
        ? `parent: ${parentName} (${channel.parentId})`
        : `parent: ${channel.parentId}`,
    );
  }
  if (channel.topic !== null && channel.topic.trim().length > 0) {
    parts.push(`topic: ${formatSingleLinePreview(channel.topic, 80)}`);
  }
  return parts.join(" | ");
}

export function formatChannelsOutput(result: GuildChannelsResult): string {
  const guildLabel =
    result.guildName !== null && result.guildName.length > 0
      ? `${result.guildName} (${result.guildId})`
      : result.guildId;
  const catWord = result.categories.length === 1 ? "category" : "categories";
  const lines = [
    `Guild ${guildLabel} — ${result.totalChannels} total (${result.channels.length} channel(s), ${result.categories.length} ${catWord}, ${result.threads.length} thread(s)) [source: ${result.source}]`,
  ];

  const allItems = [
    ...result.categories,
    ...result.channels,
    ...result.threads,
  ];
  if (allItems.length === 0) {
    lines.push("No accessible channels.");
    return lines.join("\n");
  }

  const nameById = new Map<Snowflake, string>();
  for (const item of allItems) {
    nameById.set(item.id, item.name);
  }

  const categoryIds = new Set(result.categories.map((c) => c.id));
  const threadIds = new Set(result.threads.map((t) => t.id));
  const regularChannels = result.channels.filter(
    (c) => !categoryIds.has(c.id) && !threadIds.has(c.id),
  );

  const sections: Array<{
    heading: string;
    items: readonly GuildChannelSummary[];
    prefix: string;
  }> = [
    { heading: "Categories:", items: result.categories, prefix: "" },
    { heading: "Channels:", items: regularChannels, prefix: "#" },
    { heading: "Active Threads:", items: result.threads, prefix: "" },
  ];

  for (const section of sections) {
    if (section.items.length === 0) {
      continue;
    }
    lines.push(section.heading);
    for (const item of section.items) {
      lines.push(formatChannelSummaryLine(item, nameById, section.prefix));
    }
  }

  return lines.join("\n");
}

export function formatMembersOutput(result: ChannelMembersResult): string {
  const guildPart =
    result.guildId !== null ? ` (guild ${result.guildId})` : "";
  const lines = [
    `Channel ${result.channelId}${guildPart} — ${result.totalMembers} member(s) [source: ${result.source}]`,
  ];

  if (result.members.length === 0) {
    lines.push("No members found in recent channel activity.");
    return lines.join("\n");
  }

  for (const member of result.members) {
    const usernameLabel =
      member.discriminator && member.discriminator !== "0"
        ? `${member.username}#${member.discriminator}`
        : member.username;
    const botTag = member.bot ? " [BOT]" : "";
    const globalLabel = member.globalName ?? "(none)";
    const parts = [
      `- ${usernameLabel}${botTag} [id: ${member.userId}]`,
      `global: ${globalLabel}`,
    ];
    if (member.nickname !== null) {
      parts.push(`nick: ${member.nickname}`);
    }
    if (member.roleIds.length > 0) {
      parts.push(`roles: ${member.roleIds.join(", ")}`);
    }
    lines.push(parts.join(" | "));
  }

  return lines.join("\n");
}

export function formatDmOutput(result: DirectMessageResult): string {
  const recipientLabel =
    result.channel.recipientIds.length > 0
      ? result.channel.recipientIds.join(", ")
      : result.channel.name;
  return `Sent DM message ${result.message.id} to user ${recipientLabel} in channel ${result.channel.id}: ${result.message.content}`;
}

export function formatDmsOutput(result: DmChannelsResult): string {
  const lines = [
    `DM Channels: ${result.totalDms} channel(s) [source: ${result.source}]`,
  ];

  if (result.dms.length === 0) {
    lines.push("No open DM channels.");
    return lines.join("\n");
  }

  for (const dm of result.dms) {
    const recipientIdLabel =
      dm.recipientId ??
      (dm.recipientIds.length > 0 ? dm.recipientIds.join(", ") : "(none)");

    let userLabel: string;
    if (dm.recipients.length > 1) {
      const members = dm.recipients
        .map((r) =>
          r.globalName !== null
            ? `${r.globalName} (@${r.username})`
            : `@${r.username}`,
        )
        .join(", ");
      userLabel = dm.name.length > 0 ? `${dm.name} (${members})` : members;
    } else {
      const primary = dm.recipients[0];
      const username = dm.username ?? primary?.username ?? null;
      const globalName = dm.globalName ?? primary?.globalName ?? null;
      if (globalName !== null && username !== null) {
        userLabel = `${globalName} (@${username})`;
      } else if (username !== null) {
        userLabel = `@${username}`;
      } else if (globalName !== null) {
        userLabel = globalName;
      } else {
        userLabel = dm.name.length > 0 ? dm.name : "(unknown)";
      }
    }

    const lastMsgLabel = dm.lastMessageId ?? "none";
    lines.push(
      `- ${userLabel} [channel: ${dm.channelId}] | recipient: ${recipientIdLabel} | lastMessageId: ${lastMsgLabel}`,
    );
  }

  return lines.join("\n");
}

export function formatDaemonStartOutput(result: DaemonStartResult): string {
  const prefix = result.alreadyRunning
    ? "Daemon is already running"
    : "Daemon started";
  return `${prefix} (PID ${result.pid}, ${result.host}:${result.port}, gateway: ${result.gateway.state}).`;
}

export function formatDaemonStopOutput(result: DaemonStopResult): string {
  return `Daemon stopped (PID ${result.pid}).`;
}

function assertDiscordTokenConfigured(env: NodeJS.ProcessEnv): string {
  try {
    return requireDiscordTokenInfo(env).token;
  } catch (err) {
    throw new CliRuntimeError(
      createIpcError(
        IpcErrorCode.BAD_REQUEST,
        err instanceof Error ? err.message : String(err),
        HttpStatus.BAD_REQUEST,
      ),
      2,
      { cause: err },
    );
  }
}

function resolveCliConfigOrThrow(
  globals: ParsedCliCommand["globals"],
  env: NodeJS.ProcessEnv,
) {
  try {
    return resolveCliConfig(
      { homeDir: globals.home, port: globals.port },
      env,
    );
  } catch (err) {
    throw new CliRuntimeError(
      createIpcError(
        IpcErrorCode.BAD_REQUEST,
        err instanceof Error ? err.message : String(err),
        HttpStatus.BAD_REQUEST,
      ),
      2,
      { cause: err },
    );
  }
}

function buildDaemonChildEnv(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  portOverride?: number,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DISCORD_CLI_HOME: homeDir,
  };
  if (portOverride !== undefined) {
    childEnv["DISCORD_CLI_PORT"] = String(portOverride);
  }
  return childEnv;
}

function assertDaemonEntryAvailable(
  daemonEntryPath: string,
  usingCustomSpawn: boolean,
): void {
  if (!usingCustomSpawn && !fsSync.existsSync(daemonEntryPath)) {
    throw new CliRuntimeError(
      createIpcError(
        IpcErrorCode.INTERNAL_ERROR,
        `Compiled daemon entrypoint not found at "${daemonEntryPath}". Run "npm run build" first.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
      1,
    );
  }
}

async function runDaemonForeground(
  parsed: DaemonCliCommand,
  deps: {
    env: NodeJS.ProcessEnv;
    spawnFn: SpawnFn;
    usingCustomSpawn: boolean;
    daemonEntryPath: string;
  },
): Promise<number> {
  assertDiscordTokenConfigured(deps.env);
  const config = resolveCliConfigOrThrow(parsed.globals, deps.env);
  assertDaemonEntryAvailable(deps.daemonEntryPath, deps.usingCustomSpawn);

  const childEnv = buildDaemonChildEnv(
    deps.env,
    config.homeDir,
    parsed.globals.port,
  );
  const child = deps.spawnFn(process.execPath, [deps.daemonEntryPath], {
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });

  const onSigInt = (): void => {
    child.kill("SIGINT");
  };
  const onSigTerm = (): void => {
    child.kill("SIGTERM");
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      child.once("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new CliRuntimeError(
            createIpcError(
              IpcErrorCode.INTERNAL_ERROR,
              `Failed to run daemon process: ${err.message}`,
              HttpStatus.INTERNAL_SERVER_ERROR,
            ),
            1,
            { cause: err },
          ),
        );
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(code ?? 1);
      });
    });
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

async function startDetachedDaemon(
  parsed: Extract<DaemonCliCommand, { subcommand: "start" }>,
  deps: {
    env: NodeJS.ProcessEnv;
    spawnFn: SpawnFn;
    usingCustomSpawn: boolean;
    fetchImpl?: typeof fetch;
    daemonEntryPath: string;
    startTimeoutMs: number;
    pollIntervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<DaemonStartResult> {
  const config = resolveCliConfigOrThrow(parsed.globals, deps.env);

  // Check if a daemon is already alive before requiring DISCORD_TOKEN.
  const initialInspection = await inspectDaemonLockfile(config.lockfilePath);
  if (initialInspection.state === "stale" || initialInspection.state === "corrupt") {
    await cleanupStaleDaemonLockfile(config.lockfilePath).catch(() => undefined);
  } else if (initialInspection.state === "active") {
    const probeClient = new DaemonIpcClient({
      lockfilePath: config.lockfilePath,
      explicitPort: null,
      fetchImpl: deps.fetchImpl,
      requestTimeoutMs: 2_000,
    });
    try {
      const existing = await probeClient.getStatus({ timeoutMs: 2_000 });
      if (
        parsed.globals.port !== undefined &&
        parsed.globals.port !== 0 &&
        parsed.globals.port !== existing.port
      ) {
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.BAD_REQUEST,
            `Daemon is already running on port ${existing.port} in "${config.homeDir}" (requested --port ${parsed.globals.port}). Stop it first or use a different --home.`,
            HttpStatus.BAD_REQUEST,
          ),
          2,
        );
      }
      return { ...existing, alreadyRunning: true };
    } catch (err) {
      if (
        !(err instanceof CliRuntimeError) ||
        err.code !== IpcErrorCode.DAEMON_UNREACHABLE
      ) {
        throw err;
      }
      // Lockfile was cleaned up because daemon was unreachable; continue starting.
    }
  }

  assertDiscordTokenConfigured(deps.env);
  assertDaemonEntryAvailable(deps.daemonEntryPath, deps.usingCustomSpawn);

  await fs.mkdir(config.homeDir, { recursive: true, mode: 0o700 });
  const logPath = resolveDaemonLogPath(config.homeDir, deps.env);
  const childEnv = buildDaemonChildEnv(
    deps.env,
    config.homeDir,
    parsed.globals.port,
  );

  const logHandle = await fs.open(logPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = deps.spawnFn(process.execPath, [deps.daemonEntryPath], {
      detached: true,
      windowsHide: true,
      env: childEnv,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close().catch(() => undefined);
  }

  let spawnError: Error | null = null;
  let exitedInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;

  const onError = (err: Error): void => {
    spawnError = err;
  };
  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    exitedInfo = { code, signal };
  };

  child.on("error", onError);
  child.on("exit", onExit);

  const effectivePort =
    parsed.globals.port === 0 ? null : config.explicitPort;
  const pollClient = new DaemonIpcClient({
    lockfilePath: config.lockfilePath,
    explicitPort: effectivePort,
    fetchImpl: deps.fetchImpl,
    requestTimeoutMs: 1_500,
  });

  const deadline = Date.now() + deps.startTimeoutMs;
  try {
    while (true) {
      if (spawnError !== null) {
        const errObj = spawnError as Error;
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.INTERNAL_ERROR,
            `Failed to start daemon process: ${errObj.message}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
          ),
          1,
          { cause: errObj },
        );
      }
      if (
        exitedInfo === null &&
        (child.exitCode !== null || child.signalCode !== null)
      ) {
        exitedInfo = { code: child.exitCode, signal: child.signalCode };
      }
      if (exitedInfo !== null) {
        const info = exitedInfo as {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.INTERNAL_ERROR,
            `Daemon process exited early (code=${String(info.code)}, signal=${String(info.signal)}). See "${logPath}".`,
            HttpStatus.INTERNAL_SERVER_ERROR,
          ),
          1,
        );
      }

      const inspection = await inspectDaemonLockfile(config.lockfilePath);
      if (inspection.state === "active") {
        try {
          const status = await pollClient.getStatus({ timeoutMs: 1_500 });
          if (typeof child.unref === "function") {
            child.unref();
          }
          return { ...status, alreadyRunning: false };
        } catch (err) {
          if (
            !(err instanceof CliRuntimeError) ||
            err.code !== IpcErrorCode.DAEMON_UNREACHABLE
          ) {
            throw err;
          }
        }
      }

      if (Date.now() >= deadline) {
        if (typeof child.unref === "function") {
          child.unref();
        }
        throw new CliRuntimeError(
          createIpcError(
            IpcErrorCode.DAEMON_UNREACHABLE,
            `Timed out waiting ${deps.startTimeoutMs}ms for daemon to become ready. Check "${logPath}".`,
            HttpStatus.SERVICE_UNAVAILABLE,
          ),
          3,
        );
      }

      await deps.sleep(deps.pollIntervalMs);
    }
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

async function stopDaemonAndWait(
  client: DaemonIpcClient,
  lockfilePath: string,
  stopTimeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<DaemonStopResult> {
  const result = await client.stopDaemon();
  const deadline = Date.now() + stopTimeoutMs;

  while (Date.now() < deadline) {
    const inspection = await inspectDaemonLockfile(lockfilePath);
    if (inspection.state === "missing") {
      break;
    }
    if (inspection.state === "stale") {
      await cleanupStaleDaemonLockfile(lockfilePath).catch(() => undefined);
      break;
    }
    if (!isProcessAlive(result.pid)) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  return result;
}

function writeSuccess<T>(
  stdout: Writable,
  json: boolean,
  data: T,
  humanFormatter: (value: T) => string,
): void {
  if (json) {
    stdout.write(`${serializeJsonEnvelope(okEnvelope(data))}\n`);
  } else {
    stdout.write(`${humanFormatter(data)}\n`);
  }
}

function toIpcErrorAndExitCode(err: unknown): {
  payload: IpcErrorPayload;
  exitCode: number;
} {
  if (err instanceof CliRuntimeError) {
    return { payload: err.toIpcError(), exitCode: err.exitCode };
  }
  if (err instanceof CliParseError) {
    return {
      payload: createIpcError(err.code, err.message, HttpStatus.BAD_REQUEST),
      exitCode: err.exitCode,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    payload: createIpcError(
      IpcErrorCode.INTERNAL_ERROR,
      message,
      HttpStatus.INTERNAL_SERVER_ERROR,
    ),
    exitCode: 1,
  };
}

function writeCliError(
  stderr: Writable,
  json: boolean,
  payload: IpcErrorPayload,
): void {
  if (json) {
    stderr.write(`${serializeJsonEnvelope(errorEnvelope(payload))}\n`);
    return;
  }
  const extras: string[] = [];
  if (payload.discordCode !== undefined) {
    extras.push(`discordCode=${payload.discordCode}`);
  }
  if (payload.retryAfterMs !== undefined) {
    extras.push(`retryAfterMs=${payload.retryAfterMs}`);
  }
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  stderr.write(`Error [${payload.code}]: ${payload.message}${suffix}\n`);
}

function createIpcClient(
  globals: ParsedCliCommand["globals"],
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): DaemonIpcClient {
  const config = resolveCliConfigOrThrow(globals, env);
  return new DaemonIpcClient({
    lockfilePath: config.lockfilePath,
    explicitPort: config.explicitPort,
    fetchImpl,
  });
}

export async function runCliCommand(
  parsed: ParsedCliCommand,
  deps: CliCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const spawnFn = deps.spawnFn ?? spawn;
  const usingCustomSpawn = deps.spawnFn !== undefined;
  const daemonEntryPath =
    deps.daemonEntryPath ?? resolveDefaultDaemonEntryPath();
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = deps.sleep ?? defaultSleep;

  try {
    switch (parsed.command) {
      case "help": {
        const helpText = formatHelpText();
        if (parsed.globals.json) {
          stdout.write(
            `${serializeJsonEnvelope(okEnvelope({ help: helpText }))}\n`,
          );
        } else {
          stdout.write(`${helpText}\n`);
        }
        return 0;
      }

      case "version": {
        if (parsed.globals.json) {
          stdout.write(
            `${serializeJsonEnvelope(okEnvelope({ version: CLI_VERSION }))}\n`,
          );
        } else {
          stdout.write(`${CLI_VERSION}\n`);
        }
        return 0;
      }

      case "status": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const status = await client.getStatus();
        writeSuccess(stdout, parsed.globals.json, status, formatStatusOutput);
        return 0;
      }

      case "join": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.joinGuild({ invite: parsed.invite });
        writeSuccess(stdout, parsed.globals.json, result, formatJoinOutput);
        return 0;
      }

      case "guilds": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.listGuilds();
        writeSuccess(stdout, parsed.globals.json, result, formatGuildsOutput);
        return 0;
      }

      case "channels": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.listGuildChannels(parsed.guildId);
        writeSuccess(stdout, parsed.globals.json, result, formatChannelsOutput);
        return 0;
      }

      case "members": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.listChannelMembers(parsed.channelId, {
          limit: parsed.limit,
        });
        writeSuccess(stdout, parsed.globals.json, result, formatMembersOutput);
        return 0;
      }

      case "dm": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const request: DirectMessageRequest = {
          userId: parsed.userId,
          content: parsed.content,
        };
        if (parsed.typing !== undefined) {
          request.typing = parsed.typing;
        }
        const result = await client.sendDirectMessage(request);
        writeSuccess(stdout, parsed.globals.json, result, formatDmOutput);
        return 0;
      }

      case "dms": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.listDms();
        writeSuccess(stdout, parsed.globals.json, result, formatDmsOutput);
        return 0;
      }

      case "unread": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const unread = await client.getUnread({
          includeDms: parsed.includeDms,
          mentionsOnly: parsed.mentionsOnly,
        });
        writeSuccess(stdout, parsed.globals.json, unread, formatUnreadOutput);
        return 0;
      }

      case "read": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.readMessages(parsed.channelId, {
          limit: parsed.limit,
          markRead: parsed.markRead,
          before: parsed.before,
          after: parsed.after,
        });
        writeSuccess(stdout, parsed.globals.json, result, formatReadOutput);
        return 0;
      }

      case "send": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const request: SendMessageRequest = {
          content: parsed.content,
        };
        if (parsed.replyToMessageId !== undefined) {
          request.replyToMessageId = parsed.replyToMessageId;
        }
        if (parsed.typing !== undefined) {
          request.typing = parsed.typing;
        }
        const result = await client.sendMessage(parsed.channelId, request);
        writeSuccess(stdout, parsed.globals.json, result, formatSendOutput);
        return 0;
      }

      case "react": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const result = await client.reactMessage(
          parsed.channelId,
          parsed.messageId,
          {
            emoji: parsed.emoji,
            remove: parsed.remove,
          },
        );
        writeSuccess(stdout, parsed.globals.json, result, formatReactOutput);
        return 0;
      }

      case "watch": {
        const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
        const abortController = new AbortController();
        const onAbortSignal = (): void => {
          abortController.abort();
        };
        process.on("SIGINT", onAbortSignal);
        process.on("SIGTERM", onAbortSignal);

        try {
          await client.streamWatch(parsed.channelId, {
            events: parsed.events,
            signal: abortController.signal,
            onEvent: (event) => {
              stdout.write(serializeNdjsonLine(event));
            },
          });
          return 0;
        } finally {
          process.off("SIGINT", onAbortSignal);
          process.off("SIGTERM", onAbortSignal);
        }
      }

      case "daemon": {
        switch (parsed.subcommand) {
          case "run":
            return await runDaemonForeground(parsed, {
              env,
              spawnFn,
              usingCustomSpawn,
              daemonEntryPath,
            });

          case "start": {
            if (parsed.foreground) {
              return await runDaemonForeground(parsed, {
                env,
                spawnFn,
                usingCustomSpawn,
                daemonEntryPath,
              });
            }
            const result = await startDetachedDaemon(parsed, {
              env,
              spawnFn,
              usingCustomSpawn,
              fetchImpl: deps.fetchImpl,
              daemonEntryPath,
              startTimeoutMs,
              pollIntervalMs,
              sleep,
            });
            writeSuccess(
              stdout,
              parsed.globals.json,
              result,
              formatDaemonStartOutput,
            );
            return 0;
          }

          case "stop": {
            const config = resolveCliConfigOrThrow(parsed.globals, env);
            const client = new DaemonIpcClient({
              lockfilePath: config.lockfilePath,
              explicitPort: config.explicitPort,
              fetchImpl: deps.fetchImpl,
            });
            const result = await stopDaemonAndWait(
              client,
              config.lockfilePath,
              stopTimeoutMs,
              pollIntervalMs,
              sleep,
            );
            writeSuccess(
              stdout,
              parsed.globals.json,
              result,
              formatDaemonStopOutput,
            );
            return 0;
          }

          case "status": {
            const client = createIpcClient(parsed.globals, env, deps.fetchImpl);
            const status = await client.getStatus();
            writeSuccess(
              stdout,
              parsed.globals.json,
              status,
              formatStatusOutput,
            );
            return 0;
          }
        }
      }
    }
  } catch (err) {
    const { payload, exitCode } = toIpcErrorAndExitCode(err);
    writeCliError(stderr, parsed.globals.json, payload);
    return exitCode;
  }
}
