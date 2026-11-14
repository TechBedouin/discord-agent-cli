import {
  CLI_VERSION,
  DEFAULT_CHANNEL_MEMBERS_LIMIT,
  DEFAULT_READ_LIMIT,
  MAX_CHANNEL_MEMBERS_LIMIT,
  MAX_DISCORD_READ_LIMIT,
  parsePortValue,
} from "../shared/config.js";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  isValidSnowflake,
  parseInviteCode,
} from "../shared/ipc-protocol.js";
import {
  IpcErrorCode,
  WatchEventTypeValue,
  type Snowflake,
  type WatchEventType,
} from "../shared/types.js";

/**
 * Pure CLI argument parser and help text formatter.
 */

export class CliParseError extends Error {
  readonly exitCode = 2;
  readonly code = IpcErrorCode.BAD_REQUEST;

  constructor(message: string) {
    super(message);
    this.name = "CliParseError";
  }
}

export interface CliGlobalOptions {
  json: boolean;
  port?: number;
  home?: string;
}

export interface HelpCliCommand {
  command: "help";
  globals: CliGlobalOptions;
}

export interface VersionCliCommand {
  command: "version";
  globals: CliGlobalOptions;
}

export interface StatusCliCommand {
  command: "status";
  globals: CliGlobalOptions;
}

export interface UnreadCliCommand {
  command: "unread";
  globals: CliGlobalOptions;
  mentionsOnly: boolean;
  includeDms: boolean;
}

export interface ReadCliCommand {
  command: "read";
  globals: CliGlobalOptions;
  channelId: Snowflake;
  limit: number;
  markRead: boolean;
  before?: Snowflake;
  after?: Snowflake;
}

export interface SendCliCommand {
  command: "send";
  globals: CliGlobalOptions;
  channelId: Snowflake;
  content: string;
  replyToMessageId?: Snowflake;
  typing?: boolean;
}

export interface JoinCliCommand {
  command: "join";
  globals: CliGlobalOptions;
  invite: string;
}

export interface GuildsCliCommand {
  command: "guilds";
  globals: CliGlobalOptions;
}

export interface ChannelsCliCommand {
  command: "channels";
  globals: CliGlobalOptions;
  guildId: Snowflake;
}

export interface MembersCliCommand {
  command: "members";
  globals: CliGlobalOptions;
  channelId: Snowflake;
  limit: number;
}

export interface DmCliCommand {
  command: "dm";
  globals: CliGlobalOptions;
  userId: Snowflake;
  content: string;
  typing?: boolean;
}

export interface DmsCliCommand {
  command: "dms";
  globals: CliGlobalOptions;
}

export interface ReactCliCommand {
  command: "react";
  globals: CliGlobalOptions;
  channelId: Snowflake;
  messageId: Snowflake;
  emoji: string;
  remove: boolean;
}

export interface WatchCliCommand {
  command: "watch";
  globals: CliGlobalOptions;
  channelId: Snowflake;
  events?: WatchEventType[];
}

export type DaemonSubcommand = "start" | "stop" | "status" | "run";

export type DaemonCliCommand =
  | {
      command: "daemon";
      subcommand: "start";
      globals: CliGlobalOptions;
      foreground: boolean;
    }
  | {
      command: "daemon";
      subcommand: "stop" | "status" | "run";
      globals: CliGlobalOptions;
    };

export type ParsedCliCommand =
  | HelpCliCommand
  | VersionCliCommand
  | StatusCliCommand
  | UnreadCliCommand
  | ReadCliCommand
  | SendCliCommand
  | JoinCliCommand
  | GuildsCliCommand
  | ChannelsCliCommand
  | MembersCliCommand
  | DmCliCommand
  | DmsCliCommand
  | ReactCliCommand
  | WatchCliCommand
  | DaemonCliCommand;

type FlagKind = "boolean" | "value";

interface FlagSpec {
  kind: FlagKind;
  scope: "global" | "command";
}

const FLAG_SPECS: Readonly<Record<string, FlagSpec>> = {
  "--json": { kind: "boolean", scope: "global" },
  "--help": { kind: "boolean", scope: "global" },
  "-h": { kind: "boolean", scope: "global" },
  "--version": { kind: "boolean", scope: "global" },
  "-v": { kind: "boolean", scope: "global" },
  "--port": { kind: "value", scope: "global" },
  "--home": { kind: "value", scope: "global" },

  "--mentions-only": { kind: "boolean", scope: "command" },
  "--no-dms": { kind: "boolean", scope: "command" },
  "--limit": { kind: "value", scope: "command" },
  "--mark-read": { kind: "boolean", scope: "command" },
  "--before": { kind: "value", scope: "command" },
  "--after": { kind: "value", scope: "command" },
  "--reply": { kind: "value", scope: "command" },
  "--typing": { kind: "boolean", scope: "command" },
  "--remove": { kind: "boolean", scope: "command" },
  "--events": { kind: "value", scope: "command" },
  "--foreground": { kind: "boolean", scope: "command" },
};

const VALID_WATCH_EVENTS: ReadonlySet<string> = new Set(
  Object.values(WatchEventTypeValue),
);

interface ParsedFlagEntry {
  name: string;
  value: string | true;
}

function splitFlagToken(token: string): {
  name: string;
  inlineValue: string | undefined;
} {
  if (token.startsWith("--")) {
    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      return {
        name: token.slice(0, eqIdx),
        inlineValue: token.slice(eqIdx + 1),
      };
    }
  }
  return { name: token, inlineValue: undefined };
}

function assertSnowflakeArg(raw: string, label: string): Snowflake {
  if (!isValidSnowflake(raw)) {
    throw new CliParseError(
      `Invalid ${label} "${raw}": expected numeric Discord snowflake ID.`,
    );
  }
  return raw;
}

function parseLimitArg(raw: string, max = MAX_DISCORD_READ_LIMIT): number {
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new CliParseError(
      `Invalid --limit "${raw}": expected an integer between 1 and ${max}.`,
    );
  }
  return parsed;
}

function parseMessageContentArgs(parts: readonly string[]): string {
  const content = parts.join(" ");
  if (content.trim().length === 0) {
    throw new CliParseError("Message content must not be empty.");
  }
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw new CliParseError(
      `Message content exceeds ${MAX_MESSAGE_CONTENT_LENGTH} characters (got ${content.length}).`,
    );
  }
  return content;
}

function parseInviteArg(raw: string): string {
  try {
    return parseInviteCode(raw);
  } catch (err) {
    throw new CliParseError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

function requireSinglePositional(
  command: string,
  rest: readonly string[],
  argPlaceholder: string,
): string {
  if (rest.length === 0) {
    throw new CliParseError(
      `Missing required ${argPlaceholder} for command "${command}".`,
    );
  }
  if (rest.length > 1) {
    throw new CliParseError(
      `Unexpected extra argument "${rest[1]}" for command "${command}".`,
    );
  }
  return rest[0]!;
}

function parseTargetAndMessage(
  command: string,
  rest: readonly string[],
  idLabel: string,
): { targetId: Snowflake; content: string } {
  if (rest.length === 0) {
    throw new CliParseError(
      `Missing required <${idLabel}> and <message> for command "${command}".`,
    );
  }
  const targetId = assertSnowflakeArg(rest[0]!, idLabel);
  if (rest.length < 2) {
    throw new CliParseError(
      `Missing required <message> for command "${command}".`,
    );
  }
  return {
    targetId,
    content: parseMessageContentArgs(rest.slice(1)),
  };
}

function parseWatchEventsArg(raw: string): WatchEventType[] {
  const parts = raw.split(",");
  const events: WatchEventType[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!VALID_WATCH_EVENTS.has(trimmed)) {
      const validList = Array.from(VALID_WATCH_EVENTS).join(", ");
      throw new CliParseError(
        `Unknown watch event "${trimmed}". Valid events: ${validList}.`,
      );
    }
    const typed = trimmed as WatchEventType;
    if (!events.includes(typed)) {
      events.push(typed);
    }
  }
  if (events.length === 0) {
    const validList = Array.from(VALID_WATCH_EVENTS).join(", ");
    throw new CliParseError(
      `--events must specify at least one valid event (${validList}).`,
    );
  }
  return events;
}

function assertAllowedFlags(
  commandLabel: string,
  entries: readonly ParsedFlagEntry[],
  allowed: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new CliParseError(
        `Flag "${entry.name}" is not valid for command "${commandLabel}".`,
      );
    }
  }
}

function getLastFlagValue(
  entries: readonly ParsedFlagEntry[],
  name: string,
): string | undefined {
  let found: string | undefined;
  for (const entry of entries) {
    if (entry.name === name && typeof entry.value === "string") {
      found = entry.value;
    }
  }
  return found;
}

function hasBooleanFlag(
  entries: readonly ParsedFlagEntry[],
  name: string,
): boolean {
  return entries.some((entry) => entry.name === name && entry.value === true);
}

/**
 * Checks whether `--json` appears as a flag (before `--`) in raw argv tokens.
 */
export function hasJsonFlagInArgv(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") {
      break;
    }
    if (token === "--json") {
      return true;
    }
  }
  return false;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  const globals: CliGlobalOptions = { json: false };
  const commandFlags: ParsedFlagEntry[] = [];
  const positionals: string[] = [];

  let helpRequested = false;
  let versionRequested = false;
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (afterDoubleDash) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const { name, inlineValue } = splitFlagToken(token);
      const spec = FLAG_SPECS[name];
      if (spec === undefined) {
        throw new CliParseError(
          `Unknown flag "${name}". Pass "--" before positional text starting with "-".`,
        );
      }

      if (spec.kind === "boolean") {
        if (inlineValue !== undefined) {
          throw new CliParseError(`Flag "${name}" does not accept a value.`);
        }
        if (name === "--json") {
          globals.json = true;
        } else if (name === "--help" || name === "-h") {
          helpRequested = true;
        } else if (name === "--version" || name === "-v") {
          versionRequested = true;
        } else {
          commandFlags.push({ name, value: true });
        }
        continue;
      }

      let rawValue = inlineValue;
      if (rawValue === undefined) {
        if (i + 1 >= argv.length) {
          throw new CliParseError(`Missing value for flag "${name}".`);
        }
        i += 1;
        rawValue = argv[i]!;
      }

      if (name === "--port") {
        try {
          globals.port = parsePortValue(rawValue, "--port");
        } catch (err) {
          throw new CliParseError(
            err instanceof Error ? err.message : String(err),
          );
        }
      } else if (name === "--home") {
        if (rawValue.trim().length === 0) {
          throw new CliParseError(`--home path must not be empty.`);
        }
        globals.home = rawValue;
      } else {
        commandFlags.push({ name, value: rawValue });
      }
      continue;
    }

    positionals.push(token);
  }

  if (helpRequested) {
    return { command: "help", globals };
  }
  if (versionRequested) {
    return { command: "version", globals };
  }

  if (positionals.length === 0) {
    throw new CliParseError("Missing command. Run with --help for usage.");
  }

  const command = positionals[0]!;
  const rest = positionals.slice(1);

  switch (command) {
    case "status":
    case "guilds":
    case "dms": {
      assertAllowedFlags(command, commandFlags, new Set());
      if (rest.length > 0) {
        throw new CliParseError(
          `Unexpected argument "${rest[0]}" for command "${command}".`,
        );
      }
      return { command, globals };
    }

    case "join": {
      assertAllowedFlags("join", commandFlags, new Set());
      const rawInvite = requireSinglePositional(
        "join",
        rest,
        "<invite_code_or_url>",
      );
      return {
        command: "join",
        globals,
        invite: parseInviteArg(rawInvite),
      };
    }

    case "channels": {
      assertAllowedFlags("channels", commandFlags, new Set());
      const rawGuildId = requireSinglePositional("channels", rest, "<guild_id>");
      return {
        command: "channels",
        globals,
        guildId: assertSnowflakeArg(rawGuildId, "guild_id"),
      };
    }

    case "members": {
      assertAllowedFlags("members", commandFlags, new Set(["--limit"]));
      const rawChannelId = requireSinglePositional(
        "members",
        rest,
        "<channel_id>",
      );
      const channelId = assertSnowflakeArg(rawChannelId, "channel_id");
      const rawLimit = getLastFlagValue(commandFlags, "--limit");
      const limit =
        rawLimit !== undefined
          ? parseLimitArg(rawLimit, MAX_CHANNEL_MEMBERS_LIMIT)
          : DEFAULT_CHANNEL_MEMBERS_LIMIT;
      return {
        command: "members",
        globals,
        channelId,
        limit,
      };
    }

    case "unread": {
      assertAllowedFlags(
        "unread",
        commandFlags,
        new Set(["--mentions-only", "--no-dms"]),
      );
      if (rest.length > 0) {
        throw new CliParseError(
          `Unexpected argument "${rest[0]}" for command "unread".`,
        );
      }
      return {
        command: "unread",
        globals,
        mentionsOnly: hasBooleanFlag(commandFlags, "--mentions-only"),
        includeDms: !hasBooleanFlag(commandFlags, "--no-dms"),
      };
    }

    case "read": {
      assertAllowedFlags(
        "read",
        commandFlags,
        new Set(["--limit", "--mark-read", "--before", "--after"]),
      );
      const rawChannelId = requireSinglePositional(
        "read",
        rest,
        "<channel_id>",
      );
      const channelId = assertSnowflakeArg(rawChannelId, "channel_id");
      const rawLimit = getLastFlagValue(commandFlags, "--limit");
      const limit =
        rawLimit !== undefined ? parseLimitArg(rawLimit) : DEFAULT_READ_LIMIT;
      const rawBefore = getLastFlagValue(commandFlags, "--before");
      const rawAfter = getLastFlagValue(commandFlags, "--after");

      const parsed: ReadCliCommand = {
        command: "read",
        globals,
        channelId,
        limit,
        markRead: hasBooleanFlag(commandFlags, "--mark-read"),
      };
      if (rawBefore !== undefined) {
        parsed.before = assertSnowflakeArg(rawBefore, "--before");
      }
      if (rawAfter !== undefined) {
        parsed.after = assertSnowflakeArg(rawAfter, "--after");
      }
      return parsed;
    }

    case "send": {
      assertAllowedFlags("send", commandFlags, new Set(["--reply", "--typing"]));
      const { targetId: channelId, content } = parseTargetAndMessage(
        "send",
        rest,
        "channel_id",
      );

      const parsed: SendCliCommand = {
        command: "send",
        globals,
        channelId,
        content,
      };
      const rawReply = getLastFlagValue(commandFlags, "--reply");
      if (rawReply !== undefined) {
        parsed.replyToMessageId = assertSnowflakeArg(rawReply, "--reply");
      }
      if (hasBooleanFlag(commandFlags, "--typing")) {
        parsed.typing = true;
      }
      return parsed;
    }

    case "dm": {
      assertAllowedFlags("dm", commandFlags, new Set(["--typing"]));
      const { targetId: userId, content } = parseTargetAndMessage(
        "dm",
        rest,
        "user_id",
      );

      const parsed: DmCliCommand = {
        command: "dm",
        globals,
        userId,
        content,
      };
      if (hasBooleanFlag(commandFlags, "--typing")) {
        parsed.typing = true;
      }
      return parsed;
    }

    case "react": {
      assertAllowedFlags("react", commandFlags, new Set(["--remove"]));
      if (rest.length < 3) {
        throw new CliParseError(
          `Command "react" requires <channel_id> <message_id> <emoji>.`,
        );
      }
      if (rest.length > 3) {
        throw new CliParseError(
          `Unexpected extra argument "${rest[3]}" for command "react".`,
        );
      }
      const channelId = assertSnowflakeArg(rest[0]!, "channel_id");
      const messageId = assertSnowflakeArg(rest[1]!, "message_id");
      const emoji = rest[2]!.trim();
      if (emoji.length === 0) {
        throw new CliParseError("Emoji must not be empty.");
      }
      return {
        command: "react",
        globals,
        channelId,
        messageId,
        emoji,
        remove: hasBooleanFlag(commandFlags, "--remove"),
      };
    }

    case "watch": {
      assertAllowedFlags("watch", commandFlags, new Set(["--events"]));
      const rawChannelId = requireSinglePositional(
        "watch",
        rest,
        "<channel_id>",
      );
      const channelId = assertSnowflakeArg(rawChannelId, "channel_id");
      const parsed: WatchCliCommand = {
        command: "watch",
        globals,
        channelId,
      };
      const rawEvents = getLastFlagValue(commandFlags, "--events");
      if (rawEvents !== undefined) {
        parsed.events = parseWatchEventsArg(rawEvents);
      }
      return parsed;
    }

    case "daemon": {
      if (rest.length === 0) {
        throw new CliParseError(
          `Missing daemon subcommand. Expected one of: start, stop, status, run.`,
        );
      }
      const subcommand = rest[0]!;
      if (rest.length > 1) {
        throw new CliParseError(
          `Unexpected extra argument "${rest[1]}" for "daemon ${subcommand}".`,
        );
      }
      switch (subcommand) {
        case "start": {
          assertAllowedFlags(
            "daemon start",
            commandFlags,
            new Set(["--foreground"]),
          );
          return {
            command: "daemon",
            subcommand: "start",
            globals,
            foreground: hasBooleanFlag(commandFlags, "--foreground"),
          };
        }
        case "stop":
        case "status":
        case "run": {
          assertAllowedFlags(`daemon ${subcommand}`, commandFlags, new Set());
          return {
            command: "daemon",
            subcommand,
            globals,
          };
        }
        default:
          throw new CliParseError(
            `Unknown daemon subcommand "${subcommand}". Expected one of: start, stop, status, run.`,
          );
      }
    }

    default:
      throw new CliParseError(
        `Unknown command "${command}". Run with --help for usage.`,
      );
  }
}

export function formatHelpText(): string {
  return [
    `discord-cli v${CLI_VERSION} — Discord API v10 daemon & CLI`,
    ``,
    `Usage:`,
    `  discord-cli [global flags] <command> [options]`,
    ``,
    `Global Flags (accepted before or after the subcommand):`,
    `  --json               Emit JSON envelope on stdout/stderr`,
    `  --port <number>      Override daemon IPC port (0..65535)`,
    `  --home <path>        Override DISCORD_CLI_HOME directory`,
    `  --help, -h           Show this help text`,
    `  --version, -v        Print CLI version`,
    `  --                   End of flags (allows message text starting with "-")`,
    ``,
    `Commands:`,
    `  status`,
    `      Show daemon, auth mode, Gateway, user, cache, and rate-limit status`,
    `  join <invite_code_or_url>`,
    `      Join a Discord guild using an invite code or URL (discord.gg/..., discord.com/invite/...)`,
    `  guilds`,
    `      List joined Discord guilds (servers)`,
    `  channels <guild_id>`,
    `      List accessible channels, categories, and active threads in a guild`,
    `  members <channel_id> [--limit N]`,
    `      List unique users seen in a channel (1..${MAX_CHANNEL_MEMBERS_LIMIT}, default ${DEFAULT_CHANNEL_MEMBERS_LIMIT})`,
    `  dms`,
    `      List open DM and group DM channels`,
    `  dm <user_id> <message...> [--typing]`,
    `      Send a direct message (1..${MAX_MESSAGE_CONTENT_LENGTH} chars) to a user, optionally triggering typing first`,
    `  unread [--mentions-only] [--no-dms]`,
    `      List channels/DMs with unread messages and mention counts`,
    `  read <channel_id> [--limit N] [--mark-read] [--before <id>] [--after <id>]`,
    `      Read up to N (1..${MAX_DISCORD_READ_LIMIT}, default ${DEFAULT_READ_LIMIT}) messages from cache or REST`,
    `  send <channel_id> <message...> [--reply <message_id>] [--typing]`,
    `      Send a message (1..${MAX_MESSAGE_CONTENT_LENGTH} chars) through the daemon REST queue`,
    `  react <channel_id> <message_id> <emoji> [--remove]`,
    `      Add or remove a reaction (Unicode or custom <:name:id>)`,
    `  watch <channel_id> [--events e1,e2]`,
    `      Stream live WatchEvent JSONL records to stdout`,
    `  daemon start [--foreground]`,
    `      Start the background daemon (or run in foreground with --foreground)`,
    `  daemon stop`,
    `      Stop the running daemon`,
    `  daemon status`,
    `      Query running daemon status`,
    `  daemon run`,
    `      Run the daemon in the foreground`,
    ``,
    `Environment Variables:`,
    `  DISCORD_TOKEN / DISCORD_BOT_TOKEN   Discord token (required for daemon start/run)`,
    `  DISCORD_AUTH_MODE                   Auth mode: "user" (default) or "bot" (auto-detected from "Bot " prefix)`,
    `  DISCORD_AUTO_TYPING                 Auto-trigger typing before sends ("true"/"1" or "false"/"0", default: false)`,
    `  DISCORD_CLI_HOME                    State directory (default: ~/.discord-cli)`,
    `  DISCORD_CLI_PORT                    Default IPC port (default: 47832)`,
    ``,
    `Exit Codes:`,
    `  0  Success`,
    `  1  Runtime, IPC, or Discord API error`,
    `  2  Invalid CLI arguments or missing DISCORD_TOKEN on daemon start/run`,
    `  3  Daemon not running or unreachable`,
  ].join("\n");
}
