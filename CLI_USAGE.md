# `discord-cli` Operational Reference (`CLI_USAGE.md`)

**Version:** `0.1.0`  
**Protocol:** Discord API v10 (Gateway WebSocket + REST — User & Bot Auth Modes)  
**Source References:** [package.json](./package.json), [config.ts](./src/shared/config.ts), [types.ts](./src/shared/types.ts), [ipc-protocol.ts](./src/shared/ipc-protocol.ts), [args.ts](./src/cli/args.ts), [commands.ts](./src/cli/commands.ts), [ipc-client.ts](./src/cli/ipc-client.ts), [index.ts](./src/cli/index.ts), [daemon/index.ts](./src/daemon/index.ts), [ipc-server.ts](./src/daemon/ipc-server.ts), [gateway.ts](./src/daemon/gateway.ts), [rest-client.ts](./src/daemon/rest-client.ts), [state-cache.ts](./src/daemon/state-cache.ts)

`discord-cli` is a standalone two-process Discord API v10 tool supporting both **User auth mode** (default for raw tokens) and **Bot auth mode** (auto-detected from `"Bot "`-prefixed tokens or forced via `DISCORD_AUTH_MODE=bot`):
1. **Background Daemon (`src/daemon/index.ts`)** — maintains a single persistent Gateway WebSocket connection, an authoritative in-memory guild/channel/DM/member/user/message cache, an unread & mention watermark tracker, an `X-RateLimit-*` REST queue, and a zero-overhead loopback HTTP/1.1 + NDJSON IPC server on `127.0.0.1`.
2. **CLI Client (`src/cli/index.ts`)** — short-lived per-invocation client that discovers the running daemon via `$DISCORD_CLI_HOME/daemon.json` and emits either human-readable text or strict `--json` / `JSONL` output.

---

## 1. Prerequisites, Installation & Global Binary Usage

### Prerequisites
- **Node.js `>= 22.0.0`** (`engines.node` in [package.json](./package.json); uses native `fetch`, `node:http`, `node:zlib`, `node:test`, and ESM `"type": "module"`).
- A **Discord Token** supplied explicitly via `DISCORD_TOKEN` (or `DISCORD_BOT_TOKEN`):
  - **User Mode (default for raw tokens):** A raw user account token.
  - **Bot Mode:** A Bot token from the Discord Developer Portal (`Bot` -> `Token`), either prefixed with `"Bot "` or paired with `DISCORD_AUTH_MODE=bot` (enable `MESSAGE CONTENT INTENT` if using default bot intents).

### Build & Global Binary Installation (`npm link`)
From `<repo-root>`:

```bash
npm install
npm run build
```

[package.json](./package.json) declares the global binary mapping:

```json
"bin": {
  "discord-cli": "./dist/cli/index.js"
}
```

[src/cli/index.ts](./src/cli/index.ts) (compiled to `dist/cli/index.js`) starts with `#!/usr/bin/env node` on line 1 and uses `fs.realpathSync` in `isDirectCliExecution()` so symlinked global execution works across POSIX and Windows. Link it globally on `PATH` with:

```bash
npm link
# or install globally from the local directory:
npm install -g .
```

Optional verification scripts defined in [package.json](./package.json):
- `npm run typecheck` — runs `tsc --noEmit`
- `npm test` — runs `npm run build && node --test`

### Invocation Methods
Once built (and optionally linked with `npm link`), all commands can be invoked in any of three ways:

```bash
# 1. Global binary (after `npm link` in the repo root)
discord-cli status --json

# 2. Direct built entrypoint
node dist/cli/index.js status --json

# 3. Via npm script (note the `--` separator before CLI flags/args)
npm run cli -- status --json
```

To run the daemon entrypoint directly without the CLI wrapper:
```bash
npm run daemon -- --port 47832 --home ~/.discord-cli
# or:
node dist/daemon/index.js --port 47832 --home ~/.discord-cli
```

---

## 2. Protocol, Auth Modes, Environment Variables & Typing

### Security & Desktop Isolation Guarantee
- **`discord-cli` has zero access to desktop Discord user data.** It **never** reads, inspects, or touches Discord Desktop directories (`%APPDATA%\Discord`, `~/.config/discord`), `userDataCache.json`, `settings.json`, Electron `safeStorage`, LevelDB/cookies, or Discord Desktop RPC named pipes.
- Authentication uses **exclusively** an explicit token read from `DISCORD_TOKEN` (falling back to `DISCORD_BOT_TOKEN`).
- **Privilege Separation:**
  - `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN` is required **only** when starting the daemon (`daemon start` when not already running, `daemon start --foreground`, `daemon run`, or direct `dist/daemon/index.js`).
  - All client commands (`status`, `join`, `guilds`, `channels`, `members`, `dms`, `dm`, `unread`, `read`, `send`, `react`, `watch`, `daemon status`, `daemon stop`) do **not** read `DISCORD_TOKEN`; they communicate over loopback `127.0.0.1` to the port discovered in `$DISCORD_CLI_HOME/daemon.json`.
  - The Discord token is **never** written to `daemon.json`, **never** logged, and **never** returned in any IPC or CLI output.
- **Agent Operational Rules:** AI agents running in user mode must follow [AGENT.md](./AGENT.md).

### Auth Modes (`DISCORD_AUTH_MODE=user|bot`)
Mode resolution (`resolveDiscordAuthMode` / `resolveDiscordTokenInfo` in [config.ts](./src/shared/config.ts)):
1. If `DISCORD_AUTH_MODE` is set (case-insensitive): must be `"user"` or `"bot"` (throws `RangeError` otherwise; CLI exits `2` on `daemon start` / `daemon run`).
2. If `DISCORD_AUTH_MODE` is unset or blank:
   - `"bot"` is auto-detected when the raw token starts with `"Bot "` (`inferDiscordAuthModeFromToken`).
   - `"user"` is the default for all raw tokens without a `"Bot "` prefix.
3. Internally, any leading `"Bot "` prefix is stripped from the stored normalized token (`resolveDiscordToken`), and `formatDiscordAuthorizationHeader(token, authMode)` formats the `Authorization` header according to the resolved `authMode`.

| Behavior | `user` Mode (Default for raw tokens) | `bot` Mode (`DISCORD_AUTH_MODE=bot` or `"Bot "` prefix) |
|---|---|---|
| REST `Authorization` header | `<token>` (raw normalized token) | `Bot <token>` |
| REST `User-Agent` header | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9268 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36` (`DEFAULT_USER_MODE_USER_AGENT`) | `DiscordBot (https://github.com/local/discord-cli, 0.1.0)` (`DEFAULT_USER_AGENT`) |
| Extra User-Mode REST Headers | `Origin: https://discord.com` (`DEFAULT_DISCORD_ORIGIN`), `Referer: https://discord.com/channels/@me` (`DEFAULT_DISCORD_REFERER`), `X-Debug-Options: bugReporterEnabled` (`DEFAULT_DISCORD_DEBUG_OPTIONS`), `X-Discord-Locale: en-US` (`DEFAULT_DISCORD_LOCALE`), `X-Discord-Timezone` (`Intl.DateTimeFormat().resolvedOptions().timeZone \|\| "UTC"` unless overridden), and `X-Super-Properties` (Base64 JSON of `DEFAULT_SUPER_PROPERTIES`); `POST /invites/{code}` also adds `X-Context-Properties` (`encodeInviteContextProperties()`) | *(none)* |
| Gateway WebSocket Headers | `User-Agent` (`DEFAULT_USER_MODE_USER_AGENT`) and `Origin: https://discord.com` via `buildUserModeGatewayHeaders()` passed to `new WebSocket(url, { headers })` | *(none)* (`new WebSocket(url)`) |
| Gateway Bootstrap Endpoint | `GET /gateway` (falls back to `DISCORD_GATEWAY_URL` on non-401 error; HTTP `401` is `fatal`) | `GET /gateway/bot` (checks `session_start_limit`; HTTP `401` is `fatal`; non-401 retries with backoff or uses explicit non-default `DISCORD_GATEWAY_URL`) |
| `Op 2 IDENTIFY` `properties` | `{ "$os": "Windows", "$browser": "Discord Client", "$device": "desktop" }` (`DEFAULT_USER_GATEWAY_PROPERTIES`) | `{ "os": process.platform, "browser": "discord-cli", "device": "discord-cli" }` |
| `Op 2 IDENTIFY` `intents` | **Omitted** (`DISCORD_INTENTS` is ignored in user mode) | Included (`DISCORD_INTENTS`, default `46593`) |
| `Op 2 IDENTIFY` `compress` | `{ compress: true }` included only when zlib transport is enabled (`DISCORD_CLI_ZLIB=true`) | `compress: boolean` always included |
| `READY` Hydration (`StateCache`) | Hydrates full `guilds` (`properties`, `channels`, `threads`, `members`, `member_count`), `private_channels` (open DMs/Group DMs), `users`, `relationships` (`Map<Snowflake, DiscordRelationship>`, exposed via `getRelationships()`, plus `relationships[].user` upserted into `users`, updated live on `RELATIONSHIP_ADD`/`RELATIONSHIP_REMOVE`), `user_settings` (stored in `userSettings`, exposed via `getUserSettings()`, merged on `USER_SETTINGS_UPDATE`), and `merged_members` (`guildMembers` + `botRoleIds`) | `guilds` normally arrive as `{ id, unavailable: true }` stubs and hydrate via subsequent `GUILD_CREATE` dispatches; `private_channels` / `relationships` / `user_settings` / `merged_members` also hydrated if present |

**User-Mode `X-Super-Properties` Payload (`DEFAULT_SUPER_PROPERTIES`):**
```json
{
  "os": "Windows",
  "browser": "Discord Client",
  "release_channel": "stable",
  "client_version": "1.0.9268",
  "os_version": "10.0.22631",
  "os_arch": "x64",
  "app_arch": "x64",
  "system_locale": "en-US",
  "browser_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9268 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36",
  "browser_version": "44.9.3",
  "client_build_number": 520000,
  "native_build_number": 85000,
  "client_event_source": null
}
```
Encoded as UTF-8 Base64 in the `X-Super-Properties` header (`encodeSuperProperties()` in [config.ts](./src/shared/config.ts)). Invite joins (`POST /invites/{code}`) in `user` mode also send `X-Context-Properties` containing UTF-8 Base64 `{"location":"Accept Invite Page"}` (`encodeInviteContextProperties()`).

### Environment Variables

| Variable | Default | Valid Values / Format | Scope | Description |
|---|---|---|---|---|
| `DISCORD_TOKEN` | *(none)* | User or Bot token string (leading `"Bot "` stripped internally) | Daemon start/run | Primary Discord API v10 token. Required on `daemon start` (if not already running) and `daemon run`. |
| `DISCORD_BOT_TOKEN` | *(none)* | Token string | Daemon start/run | Fallback alias used if `DISCORD_TOKEN` is unset or blank. |
| `DISCORD_AUTH_MODE` | Auto (`"bot"` if `"Bot "` prefix, else `"user"`) | `"user"` or `"bot"` (case-insensitive) | Daemon start/run | Explicitly selects User or Bot auth mode. |
| `DISCORD_AUTO_TYPING` | `false` (`DEFAULT_AUTO_TYPING_ENABLED`) | `1`, `true`, `yes` or `0`, `false`, `no` (case-insensitive) | Daemon | Enables automatic typing indicator (`POST /channels/{id}/typing`) + natural delay before `send` / `dm` when `typing` is not explicitly overridden. |
| `DISCORD_CLI_HOME` | `~/.discord-cli` (`%USERPROFILE%\.discord-cli` on Windows) | Directory path (resolved to absolute) | Daemon & CLI | State directory holding `daemon.json` and `daemon.log`. Overridden by `--home <path>`. |
| `DISCORD_CLI_PORT` | `47832` (`DEFAULT_IPC_PORT`) | Integer `0..65535` (`0` = OS ephemeral port at daemon start) | Daemon & CLI | Loopback TCP port on `127.0.0.1`. Overridden by `--port <number>`. See port-matching note below. |
| `DISCORD_INTENTS` | `46593` (`DEFAULT_GATEWAY_INTENTS`) | Decimal int, hex `0x...`, or comma-separated `GatewayIntentBits` names | Daemon (`bot` mode only) | Gateway v10 intent bitmask (case-insensitive names). Ignored in `user` mode. |
| `DISCORD_CLI_ZLIB` | `true` | `1`, `true`, `yes` or `0`, `false`, `no` (case-insensitive) | Daemon | Enables `compress=zlib-stream` Gateway WebSocket transport using `node:zlib`. |
| `DISCORD_CLI_MAX_MESSAGES_PER_CHANNEL` | `200` (`DEFAULT_MAX_MESSAGES_PER_CHANNEL`) | Integer `1..10000` | Daemon | Maximum cached messages retained per channel in memory. |
| `DISCORD_API_BASE_URL` | `https://discord.com/api/v10` | HTTP/HTTPS base URL (trailing slashes stripped) | Daemon | Discord REST API v10 base URL (useful for local mock servers/testing). |
| `DISCORD_GATEWAY_URL` | `wss://gateway.discord.gg/?v=10&encoding=json` | `ws://` or `wss://` URL | Daemon | Fallback Gateway URL if `GET /gateway` (`user` mode) fails (non-401) or `GET /gateway/bot` (`bot` mode) fails with a non-default Gateway host configured. |

> **Port Precedence & Ephemeral Port Note:**
> - For daemon startup (`daemon start` / `daemon run`), precedence is `--port <n>` > `DISCORD_CLI_PORT` > `47832`. Passing `0` lets the OS pick an ephemeral port, which the daemon writes into `daemon.json`.
> - For CLI client commands, if neither `--port` nor `DISCORD_CLI_PORT` is set, the CLI connects directly to the `port` recorded in `daemon.json`. If `--port` or `DISCORD_CLI_PORT` **is** set, the client verifies it equals `lockfile.port` and exits `3` (`DAEMON_UNREACHABLE`) on mismatch—unset `DISCORD_CLI_PORT` when invoking client commands against an ephemeral-port (`0`) daemon.

### Typing Delay Mechanics (`DISCORD_AUTO_TYPING` & `--typing`)
- Applies to both `send` (`POST /v1/channels/:channelId/messages`) and `dm` (`POST /v1/dms`).
- Resolution rule in [ipc-server.ts](./src/daemon/ipc-server.ts): `shouldType = req.typing ?? this.autoTyping`.
  - When `--typing` is passed on the CLI, the CLI sets `typing: true` in the IPC JSON payload.
  - When `--typing` is **omitted** on the CLI, the CLI omits `typing` from the IPC JSON payload so the daemon falls back to `DISCORD_AUTO_TYPING`.
  - Direct HTTP IPC callers can explicitly pass `"typing": false` to suppress typing even when `DISCORD_AUTO_TYPING=true`.
- When typing is active (`shouldType === true`):
  1. Daemon calls Discord REST `POST /channels/{channel_id}/typing` (queued through `RateLimiter` with `majorParam: channelId`).
  2. Daemon waits `calculateTypingDelayMs(content)` (`40ms` per character, clamped to `800..3500` ms; `TYPING_MS_PER_CHAR = 40`, `MIN_TYPING_DELAY_MS = 800`, `MAX_TYPING_DELAY_MS = 3500`).
     - Example: `"hi"` (2 chars) -> `800ms`; 50 chars -> `2000ms`; 100 chars -> `3500ms`.
  3. Daemon calls `POST /channels/{channel_id}/messages` and returns the created message.

### Gateway Intents & `MESSAGE_CONTENT` (`4014`) *(Bot Mode Only)*
- In `user` mode, `intents` are never sent on `Op 2 IDENTIFY` and `DISCORD_INTENTS` is ignored.
- In `bot` mode:
  - **Default (`DEFAULT_GATEWAY_INTENTS = 46593`):**
    `GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS | MESSAGE_CONTENT`
  - **Unprivileged Baseline (`BASE_UNPRIVILEGED_GATEWAY_INTENTS = 13825`):**
    `GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS`
  - If `MESSAGE_CONTENT` (`1 << 15`) is not enabled in **Discord Developer Portal -> Bot -> Privileged Gateway Intents**, Discord closes the Gateway with code `4014` (`fatal`). Either enable `MESSAGE_CONTENT` in the Developer Portal or start the bot daemon with unprivileged intents:
    ```bash
    DISCORD_AUTH_MODE=bot DISCORD_INTENTS=GUILDS,GUILD_MESSAGES,GUILD_MESSAGE_REACTIONS,DIRECT_MESSAGES,DIRECT_MESSAGE_REACTIONS discord-cli daemon start
    ```
  - **All Supported `GatewayIntentBits` Names (case-insensitive in `DISCORD_INTENTS`):**
    `GUILDS` (`1<<0`), `GUILD_MEMBERS` (`1<<1`), `GUILD_MODERATION` (`1<<2`), `GUILD_EXPRESSIONS` (`1<<3`), `GUILD_INTEGRATIONS` (`1<<4`), `GUILD_WEBHOOKS` (`1<<5`), `GUILD_INVITES` (`1<<6`), `GUILD_VOICE_STATES` (`1<<7`), `GUILD_PRESENCES` (`1<<8`), `GUILD_MESSAGES` (`1<<9`), `GUILD_MESSAGE_REACTIONS` (`1<<10`), `GUILD_MESSAGE_TYPING` (`1<<11`), `DIRECT_MESSAGES` (`1<<12`), `DIRECT_MESSAGE_REACTIONS` (`1<<13`), `DIRECT_MESSAGE_TYPING` (`1<<14`), `MESSAGE_CONTENT` (`1<<15`), `GUILD_SCHEDULED_EVENTS` (`1<<16`), `AUTO_MODERATION_CONFIGURATION` (`1<<20`), `AUTO_MODERATION_EXECUTION` (`1<<21`), `GUILD_MESSAGE_POLLS` (`1<<24`), `DIRECT_MESSAGE_POLLS` (`1<<25`).

---

## 3. Daemon Lifecycle, Zero-Overhead Local IPC, Lockfile & Logs

### Lifecycle Commands
- **`daemon start [--foreground]`**:
  - Without `--foreground`:
    1. Inspects `$DISCORD_CLI_HOME/daemon.json` first and cleans up stale or corrupt lockfiles.
    2. If an active daemon is already running and responds on `GET /v1/status`, returns it immediately with `"alreadyRunning": true` (no `DISCORD_TOKEN` needed). If `--port <N>` (`N != 0`) was passed and differs from the running daemon's port, exits `2` (`BAD_REQUEST`).
    3. Otherwise validates `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN` and `DISCORD_AUTH_MODE` (exit `2` if missing or invalid `DISCORD_AUTH_MODE`), creates `$DISCORD_CLI_HOME` (`0o700`), opens `$DISCORD_CLI_HOME/daemon.log` (`0o600`, append), spawns `dist/daemon/index.js` detached (`windowsHide: true`), and polls up to **10,000 ms** (100 ms intervals) until `daemon.json` exists and `GET /v1/status` succeeds (`alreadyRunning: false`).
    4. Note: IPC starts **before** the Gateway handshake completes, so `status.gateway.state` may briefly be `"connecting"` or `"identifying"` right after `daemon start` returns before transitioning to `"ready"`.
  - With `--foreground`: runs in the foreground (identical to `daemon run`).
- **`daemon run`**:
  - Requires `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN` (and valid `DISCORD_AUTH_MODE` if set; exit `2` otherwise). Spawns `dist/daemon/index.js` with `stdio: "inherit"` and forwards `SIGINT`/`SIGTERM` for graceful shutdown (closes Gateway `1000`, stops IPC server, removes `daemon.json`).
- **`daemon status`** (alias of top-level `status`):
  - Queries `GET /v1/status`. Returns `DaemonStatusResult` or exits `3` (`DAEMON_UNREACHABLE`) if not running.
- **`daemon stop`**:
  - Sends `POST /v1/daemon/stop` (`{}`), receives `{ stopping: true, pid }`, and polls up to **2,000 ms** (100 ms intervals) until `daemon.json` is removed/stale or the daemon PID exits.

### Lockfile: `$DISCORD_CLI_HOME/daemon.json`
Written atomically via temp file + rename (`0o700` directory, `0o600` file on POSIX; inherits per-user Windows profile ACLs on Windows).

```json
{
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 47832,
  "startedAt": "2026-11-13T17:00:00.000Z",
  "version": "0.1.0"
}
```

- **Schema (`DaemonLockfile`):** `pid` (positive integer), `host` (`"127.0.0.1"`), `port` (`1..65535`), `startedAt` (ISO 8601), `version?` (`"0.1.0"`). There is **no `token` field** written to `daemon.json` (`isValidDaemonLockfile` tolerates an optional string `token` only for backward compatibility with older files on disk).
- **Stale/Corrupt Cleanup:** Both the daemon on startup and CLI client commands inspect `isProcessAlive(pid)` (`process.kill(pid, 0)`) and clean up stale/corrupt lockfiles automatically, including removing the lockfile when TCP connection fails (`ECONNREFUSED`, `ECONNRESET`, etc.).

### Zero-Overhead Local IPC Security
- **Loopback Binding Only:** `DaemonIpcServer` validates the bind host (`assertLoopbackBindHost` permits only `"127.0.0.1"` or `"localhost"`, defaulting to `DEFAULT_IPC_HOST = "127.0.0.1"`).
- **No Local Bearer Authentication:** Neither `DaemonIpcClient` nor `DaemonIpcServer` sends or checks local `Authorization: Bearer ...` headers. Requests on `127.0.0.1` succeed directly with zero token-exchange overhead.
- **DNS Rebinding Guard (`Host` Header Validation):** `isAllowedLoopbackHostHeader(req.headers.host)` accepts omitted `Host` (`undefined`) or `/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/` (case-insensitive). Requests with any other `Host` header fail immediately with HTTP `403` and `error.code = "FORBIDDEN"`.
- **Body Size Limit:** IPC JSON bodies are capped at `DEFAULT_MAX_IPC_BODY_BYTES = 1048576` (1 MiB); larger payloads are rejected with HTTP `413` (`error.code = "BAD_REQUEST"`).

### Daemon Logs
- **Detached mode (`daemon start`):** `stdout` and `stderr` of the daemon process are appended to **`$DISCORD_CLI_HOME/daemon.log`** (mode `0o600`). Log lines are prefixed with `[daemon] ...`.
- **Foreground mode (`daemon run` / `daemon start --foreground` / `npm run daemon`):** Logs are written directly to `stderr`.

---

## 4. Complete Command & Flag Reference

### Verbatim `--help` Output
Verified against `node dist/cli/index.js --help`:

```text
discord-cli v0.1.0 — Discord API v10 daemon & CLI

Usage:
  discord-cli [global flags] <command> [options]

Global Flags (accepted before or after the subcommand):
  --json               Emit JSON envelope on stdout/stderr
  --port <number>      Override daemon IPC port (0..65535)
  --home <path>        Override DISCORD_CLI_HOME directory
  --help, -h           Show this help text
  --version, -v        Print CLI version
  --                   End of flags (allows message text starting with "-")

Commands:
  status
      Show daemon, auth mode, Gateway, user, cache, and rate-limit status
  join <invite_code_or_url>
      Join a Discord guild using an invite code or URL (discord.gg/..., discord.com/invite/...)
  guilds
      List joined Discord guilds (servers)
  channels <guild_id>
      List accessible channels, categories, and active threads in a guild
  members <channel_id> [--limit N]
      List unique users seen in a channel (1..1000, default 50)
  dms
      List open DM and group DM channels
  dm <user_id> <message...> [--typing]
      Send a direct message (1..2000 chars) to a user, optionally triggering typing first
  unread [--mentions-only] [--no-dms]
      List channels/DMs with unread messages and mention counts
  read <channel_id> [--limit N] [--mark-read] [--before <id>] [--after <id>]
      Read up to N (1..100, default 50) messages from cache or REST
  send <channel_id> <message...> [--reply <message_id>] [--typing]
      Send a message (1..2000 chars) through the daemon REST queue
  react <channel_id> <message_id> <emoji> [--remove]
      Add or remove a reaction (Unicode or custom <:name:id>)
  watch <channel_id> [--events e1,e2]
      Stream live WatchEvent JSONL records to stdout
  daemon start [--foreground]
      Start the background daemon (or run in foreground with --foreground)
  daemon stop
      Stop the running daemon
  daemon status
      Query running daemon status
  daemon run
      Run the daemon in the foreground

Environment Variables:
  DISCORD_TOKEN / DISCORD_BOT_TOKEN   Discord token (required for daemon start/run)
  DISCORD_AUTH_MODE                   Auth mode: "user" (default) or "bot" (auto-detected from "Bot " prefix)
  DISCORD_AUTO_TYPING                 Auto-trigger typing before sends ("true"/"1" or "false"/"0", default: false)
  DISCORD_CLI_HOME                    State directory (default: ~/.discord-cli)
  DISCORD_CLI_PORT                    Default IPC port (default: 47832)

Exit Codes:
  0  Success
  1  Runtime, IPC, or Discord API error
  2  Invalid CLI arguments or missing DISCORD_TOKEN on daemon start/run
  3  Daemon not running or unreachable
```

### Global Flags & Parsing Rules

| Flag | Value | Scope / Behavior |
|---|---|---|
| `--json` | Boolean (no value) | Emits `{ "ok": true, "data": ... }` on `stdout` or `{ "ok": false, "error": ... }` on `stderr`. For `watch`, `stdout` already emits JSONL lines identically with or without `--json`, while errors use the JSON error envelope on `stderr`. |
| `--port <number>` | Integer `0..65535` | Overrides `DISCORD_CLI_PORT`. Supports `--port 47832` or `--port=47832`. |
| `--home <path>` | Non-empty path | Overrides `DISCORD_CLI_HOME`. Supports `--home /tmp/dc` or `--home=/tmp/dc`. |
| `--help`, `-h` | Boolean (no value) | Prints help text (or `{ "ok": true, "data": { "help": "..." } }` with `--json`) and exits `0`. |
| `--version`, `-v` | Boolean (no value) | Prints `0.1.0` (or `{ "ok": true, "data": { "version": "0.1.0" } }` with `--json`) and exits `0`. |
| `--` | Delimiter | Ends flag parsing; all remaining tokens are treated as positional arguments (allows `send` / `dm` text beginning with `-`). **Important:** `--json`, `--typing`, and other flags must appear **before** `--`. |

**Parser Rules ([args.ts](./src/cli/args.ts)):**
- Global flags and command flags may appear **before or after** the subcommand (e.g., `discord-cli --json unread --mentions-only` and `discord-cli unread --mentions-only --json` are identical).
- Long value flags accept both `--flag value` and `--flag=value`. Boolean flags (`--json`, `--help`, `--version`, `--mentions-only`, `--no-dms`, `--mark-read`, `--typing`, `--remove`, `--foreground`) reject `=value` (`BAD_REQUEST`, exit `2`).
- Unsupported flags on any command are strictly rejected with `CliParseError` (`BAD_REQUEST`, exit `2`).
- Repeated value flags use the **last** provided value.
- All `<channel_id>`, `<guild_id>`, `<user_id>`, `<message_id>`, `--before`, `--after`, and `--reply` values must be valid Discord snowflakes matching `/^\d{1,22}$/`.

---

### Command Details & Examples

#### 1. `daemon start [--foreground]`
Starts the background daemon (or foreground with `--foreground`).

```bash
# User mode (default for raw token) — start detached daemon
DISCORD_TOKEN="your_user_token" discord-cli daemon start

# Bot mode — auto-detected from "Bot " prefix or explicit DISCORD_AUTH_MODE=bot
DISCORD_TOKEN="Bot your_bot_token" discord-cli daemon start
DISCORD_AUTH_MODE=bot DISCORD_TOKEN="your_bot_token" discord-cli daemon start

# Programmatic --json — start on custom home & ephemeral port with auto-typing
DISCORD_TOKEN="your_user_token" DISCORD_AUTO_TYPING=1 discord-cli --home /tmp/dc --port 0 --json daemon start

# Foreground (same as `daemon run`)
DISCORD_TOKEN="your_user_token" discord-cli daemon start --foreground
```

#### 2. `daemon run`
Runs the daemon in the foreground attached to the terminal (`SIGINT`/`SIGTERM` triggers clean shutdown).

```bash
DISCORD_TOKEN="your_user_token" node dist/cli/index.js daemon run
DISCORD_AUTH_MODE=bot DISCORD_TOKEN="your_bot_token" discord-cli --home /tmp/dc --port 47832 daemon run
```

#### 3. `daemon stop`
Gracefully shuts down the running daemon and waits for lockfile cleanup.

```bash
# Human
discord-cli daemon stop

# Programmatic --json
discord-cli --json daemon stop
```

#### 4. `status` / `daemon status`
Reports daemon process info, `authMode` (`"user"` or `"bot"`), Gateway connection state/latency/seq/errors, authenticated account (`botUser` in JSON; formatted as `User:` in user mode or `Bot User:` in bot mode), cache counts, unread summary, and rate-limit snapshot.

```bash
# Human
discord-cli status
discord-cli daemon status

# Programmatic --json
discord-cli status --json
discord-cli --json daemon status --home /tmp/dc
```

#### 5. `join <invite_code_or_url>`
Joins a Discord guild using an invite code or URL by calling `POST /invites/{code}` (`{}` body; includes `X-Context-Properties: encodeInviteContextProperties()` in `user` mode) and caching the resulting guild/channel in `StateCache`.
- Accepted formats (`parseInviteCode`):
  - Raw invite code matching `/^[A-Za-z0-9_-]{1,128}$/` (e.g., `discord-developers`)
  - `discord.gg/<code>`, `www.discord.gg/<code>`, `ptb.discord.gg/<code>`, or `canary.discord.gg/<code>` (with optional `http(s)://`, query/hash)
  - `discord.com/invite/<code>` or `discordapp.com/invite/<code>` (with optional `http(s)://` and `www.`/`ptb.`/`canary.` subdomain)

```bash
# Human
discord-cli join discord.gg/abc123
discord-cli join https://discord.com/invite/abc123
discord-cli join abc123

# Programmatic --json
discord-cli join https://discord.gg/abc123 --json
```

#### 6. `guilds`
Lists joined Discord guilds.
- **Cache vs. REST (`source`):** Returns `source: "cache"` when `StateCache` already holds one or more guilds and all of them have non-empty names (such as after user-mode `READY` or `GUILD_CREATE` hydration). Otherwise fetches `GET /users/@me/guilds?with_counts=true`, caches the summaries, and returns `source: "rest"`.

```bash
# Human
discord-cli guilds

# Programmatic --json
discord-cli guilds --json
```

#### 7. `channels <guild_id>`
Lists accessible channels, categories, and active threads in `<guild_id>`, partitioned into non-overlapping `categories`, `channels`, and `threads` arrays sorted by `position` ascending then `id` ascending.
- **Cache vs. REST (`source`):** Returns `source: "cache"` if the guild's channels were already hydrated (via user-mode `READY`, bot `GUILD_CREATE`, or a prior `channels` call). Otherwise fetches `GET /guilds/{guild_id}/channels` and `GET /guilds/{guild_id}/threads/active` (skipping threads gracefully on `403`/`404`), updates cache, and returns `source: "rest"`.

```bash
# Human
discord-cli channels 111111111111111111

# Programmatic --json
discord-cli channels 111111111111111111 --json
```

#### 8. `members <channel_id> [--limit N]`
Extracts unique users observed in recent message activity of `<channel_id>` (walking newest-to-oldest, plus DM `recipientIds` when applicable), enriched with cached guild `nickname`, `roleIds`, and `joinedAt` from `StateCache.guildMembers`.
- `--limit N`: integer `1..1000` (default `50` / `DEFAULT_CHANNEL_MEMBERS_LIMIT`; `MAX_CHANNEL_MEMBERS_LIMIT = 1000`).
- **Cache vs. REST (`source`):** Let `fetchLimit = min(limit, 100)`. If the channel is already REST-hydrated with at least `fetchLimit` cached messages, returns `source: "cache"`. Otherwise fetches `GET /channels/{id}/messages?limit={fetchLimit}`, merges messages into cache, and returns `source: "mixed"` (if members were already present in cache before the REST fetch) or `"rest"` (if none were cached beforehand).

```bash
# Human
discord-cli members 123456789012345678
discord-cli members 123456789012345678 --limit 100

# Programmatic --json
discord-cli members 123456789012345678 --limit 25 --json
```

#### 9. `dms`
Lists open DM (`type: 1`) and Group DM (`type: 3`) channels, sorted by `lastMessageId` descending (`null` last).
- **Cache vs. REST (`source`):** Returns `source: "cache"` when `StateCache.dmChannels` is non-empty (e.g., hydrated from user-mode `READY.private_channels`, prior `dm`, or live DM messages). Otherwise fetches `GET /users/@me/channels`, caches the DMs, and returns `source: "rest"`.

```bash
# Human
discord-cli dms

# Programmatic --json
discord-cli dms --json
```

#### 10. `dm <user_id> <message...> [--typing]`
Sends a direct message (`1..2000` characters, non-whitespace) to `<user_id>`.
- Multiple positional tokens after `<user_id>` are joined with `" "`.
- Resolves the DM channel from `StateCache` (`findDmChannelByUserId`) when cached; on cache miss, calls `POST /users/@me/channels` with `{ recipient_id: user_id }` and caches the new DM channel.
- `--typing`: triggers `POST /channels/{dm_channel_id}/typing` and waits `clamp(40 * length, 800, 3500)` ms before sending (or honors daemon `DISCORD_AUTO_TYPING` when omitted).
- Use `--` before message text starting with `-` (place `--json` and `--typing` **before** `--`).

```bash
# Human
discord-cli dm 333333333333333333 "Hey, got a minute?"
discord-cli dm 333333333333333333 "Typing first..." --typing

# Message text starting with "-"
discord-cli --json dm 333333333333333333 --typing -- "- bullet point"

# Programmatic --json
discord-cli dm 333333333333333333 "Build complete" --json
```

#### 11. `unread [--mentions-only] [--no-dms]`
Lists channels/DMs with `unreadCount > 0` sorted newest-message-first (`lastMessageId` descending).
- `--mentions-only`: include only channels where `mentionCount > 0` (direct `@self`, `@everyone`/`@here`, bot/user role mention, or DM).
- `--no-dms`: exclude DM and Group DM channels (`isDm: true`).
- Note: Messages authored by the authenticated account itself (`botUser.id`) do not increment unread counts.

```bash
# Human
discord-cli unread
discord-cli unread --mentions-only --no-dms

# Programmatic --json
discord-cli unread --json
discord-cli unread --mentions-only --json
```

#### 12. `read <channel_id> [--limit N] [--mark-read] [--before <id>] [--after <id>]`
Reads messages in `<channel_id>`, returned ordered **oldest-to-newest**.
- `--limit N`: integer `1..100` (default `50`).
- `--mark-read`: advances the channel watermark (`lastReadMessageId`) to the newest returned message ID (`markedReadUpTo`), clearing or recalculating `unreadCount` and `mentionCount`.
- `--before <id>` / `--after <id>`: Discord snowflake pagination cursors.
- **Cache vs. REST (`source`):** Returns `source: "cache"` only when neither `--before` nor `--after` is specified, the channel has already been tail-hydrated via REST (`restHydratedChannels`), and the in-memory buffer holds at least `limit` messages. Otherwise fetches via Discord REST (`GET /channels/{id}/messages`), merges tail reads into cache, and returns `source: "rest"`.

```bash
# Human
discord-cli read 123456789012345678 --limit 20 --mark-read

# Programmatic --json (pagination + mark read)
discord-cli read 123456789012345678 --limit 10 --before 999888777666555444 --json
discord-cli read 123456789012345678 --limit 50 --mark-read --json
```

#### 13. `send <channel_id> <message...> [--reply <message_id>] [--typing]`
Sends a message (`1..2000` characters, must contain non-whitespace) through the daemon's rate-limited REST queue and caches the resulting message without incrementing unread counts or falsely marking an unhydrated channel as fully REST-hydrated.
- Multiple positional tokens after `<channel_id>` are joined with `" "`.
- `--reply <message_id>`: sends a Discord reply (`message_reference.message_id`).
- `--typing`: triggers `POST /channels/{channel_id}/typing` and waits `clamp(40 * length, 800, 3500)` ms before sending (or honors daemon `DISCORD_AUTO_TYPING` when omitted).
- Use `--` before message text that starts with `-` (and put `--json`, `--reply`, and `--typing` **before** `--`).

```bash
# Human
discord-cli send 123456789012345678 "Hello from discord-cli"
discord-cli send 123456789012345678 --reply 987654321098765432 "Acknowledged!"
discord-cli send 123456789012345678 "Hello with typing" --typing

# Message text starting with "-" (flags must precede "--")
discord-cli --json send 123456789012345678 --reply 987654321098765432 --typing -- "- bullet line"

# Programmatic --json
discord-cli send 123456789012345678 "Build succeeded" --json
```

#### 14. `react <channel_id> <message_id> <emoji> [--remove]`
Adds (or with `--remove`, removes the account's own `@me`) reaction on `<message_id>`.
- `<emoji>` accepts:
  - Unicode emoji (e.g., `👍`, `🔥`)
  - Custom emoji in `name:id`, `<:name:id>`, or `<a:name:id>` format (angle brackets are stripped and URL-encoded before calling Discord REST).

```bash
# Human (Unicode and custom emoji)
discord-cli react 123456789012345678 987654321098765432 "👍"
discord-cli react 123456789012345678 987654321098765432 "<:shipit:112233445566778899>" --remove

# Programmatic --json
discord-cli react 123456789012345678 987654321098765432 "partyparrot:112233445566778899" --json
```

#### 15. `watch <channel_id> [--events e1,e2]`
Streams live channel events as **JSONL** (one compact JSON object per `\n`-terminated line) to `stdout` over HTTP/1.1 NDJSON.
- Emits the exact same JSONL lines in both default and `--json` mode (`--json` additionally formats any errors on `stderr` as JSON envelopes).
- Immediately emits a `ready` event on connect (unless excluded by `--events`), then stays open streaming live events until `SIGINT`/`SIGTERM` (`Ctrl+C`, exits `0`) or daemon shutdown (`0` on clean close; `3` on unexpected socket drop).
- `--events` accepts a comma-separated subset of:
  `ready`, `message_create`, `message_update`, `message_delete`, `reaction_add`, `reaction_remove`, `gateway_state`.

```bash
# Stream all WatchEvent JSONL lines
discord-cli watch 123456789012345678

# Filter to message_create and reaction_add only, with JSON error envelope on stderr
discord-cli watch 123456789012345678 --events message_create,reaction_add --json
```

---

## 5. IPC Endpoints, Exact JSON Schemas, `WatchEvent` JSONL & Exit Codes

### 5.1 Local HTTP/1.1 IPC Endpoints (`IPC_ROUTES`)
Base URL: `http://127.0.0.1:<port>` (discovered from `$DISCORD_CLI_HOME/daemon.json`).  
No `Authorization` header is required; `Host` must be `127.0.0.1[:port]` or `localhost[:port]` (or omitted). Requests to a valid path with an unsupported HTTP method return HTTP `405` (`METHOD_NOT_ALLOWED`) with an `Allow` header.

| Method & Path | Query / JSON Request Body | Response `data` Type |
|---|---|---|
| `GET /v1/status` | *(none)* | `DaemonStatusResult` |
| `POST /v1/invites/join` | `{ "invite": string }` (`JoinGuildRequest`) | `JoinGuildResult` |
| `GET /v1/guilds` | *(none)* | `GuildsResult` |
| `GET /v1/guilds/:guildId/channels` | *(none)* | `GuildChannelsResult` |
| `GET /v1/channels/:channelId/members` | `?limit=N` (`1..1000`, default `50`) | `ChannelMembersResult` |
| `GET /v1/dms` | *(none)* | `DmChannelsResult` |
| `POST /v1/dms` | `{ "userId": Snowflake, "content": string, "typing"?: boolean }` (`DirectMessageRequest`) | `DirectMessageResult` |
| `GET /v1/unread` | `?include_dms=bool&mentions_only=bool` (`true`/`false`/`1`/`0`) | `UnreadResult` |
| `POST /v1/channels/:channelId/read` | `{ "limit"?: number, "before"?: Snowflake, "after"?: Snowflake, "markRead"?: boolean }` (`ReadMessagesRequest`; empty body `{}` allowed) | `ReadMessagesResult` |
| `POST /v1/channels/:channelId/messages` | `{ "content": string, "replyToMessageId"?: Snowflake, "typing"?: boolean }` (`SendMessageRequest`) | `SendMessageResult` |
| `POST /v1/channels/:channelId/messages/:messageId/reactions` | `{ "emoji": string, "remove"?: boolean }` (`ReactMessageRequest`) | `ReactMessageResult` |
| `GET /v1/channels/:channelId/watch` | `?events=e1,e2,...` | `application/x-ndjson` stream of `WatchEvent` |
| `POST /v1/daemon/stop` | `{}` (empty body allowed) | `DaemonStopResult` |

---

### 5.2 JSON Output Envelopes & Error Codes

**Success Envelope** (`stdout`, exit code `0`, single-line JSON):
```json
{
  "ok": true,
  "data": {}
}
```
- `--help --json` returns `{ "ok": true, "data": { "help": "<help text>" } }`.
- `--version --json` returns `{ "ok": true, "data": { "version": "0.1.0" } }`.

**Error Envelope** (`stderr`, exit code `1 | 2 | 3`, single-line JSON when `--json` is passed):
```json
{
  "ok": false,
  "error": {
    "code": "DISCORD_API_ERROR",
    "message": "Missing Access",
    "status": 502,
    "discordCode": 50001,
    "details": {
      "httpStatus": 403,
      "body": { "message": "Missing Access", "code": 50001 }
    }
  }
}
```

**`IpcErrorPayload` Schema:**
| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `string` | Yes | Machine error code (see table below). |
| `message` | `string` | Yes | Human-readable error message. |
| `status` | `number` | Yes | HTTP status (e.g., `400`, `403`, `404`, `405`, `413`, `429`, `500`, `502`, `503`). |
| `discordCode` | `number` | No | Discord REST JSON `code` when returned by Discord API. |
| `retryAfterMs` | `number` | No | Milliseconds until retry when `code === "RATE_LIMITED"`. |
| `details` | `unknown` | No | Optional structured diagnostic details (e.g. `{ httpStatus, body }` for `DISCORD_API_ERROR`). |

**Error Code Values & HTTP/Exit Code Mapping:**
| `error.code` | `error.status` | CLI Exit Code | Trigger |
|---|---|---|---|
| `BAD_REQUEST` | `400` (or `413` if IPC body > 1 MiB) | `2` | Invalid CLI args/flags/snowflakes/invite/port/limit/events, missing `DISCORD_TOKEN` or invalid `DISCORD_AUTH_MODE` on start/run, invalid JSON/query in IPC |
| `DAEMON_UNREACHABLE` | `503` | `3` | Missing/stale/corrupt `daemon.json`, `--port` mismatch, TCP connection/timeout failure, `daemon start` timeout |
| `FORBIDDEN` | `403` | `1` | Non-loopback IPC `Host` header (DNS rebinding guard) |
| `NOT_FOUND` | `404` | `1` | Unknown IPC path |
| `METHOD_NOT_ALLOWED` | `405` | `1` | Unsupported HTTP method on valid IPC route (includes `Allow` header) |
| `DAEMON_NOT_READY` | `503` | `1` | Service unavailable error status from IPC response |
| `DISCORD_API_ERROR` | `502` | `1` | Non-429 Discord REST failure (e.g. `401`, `403`, `404`, `400`, `5xx`) |
| `RATE_LIMITED` | `429` | `1` | Discord REST `429` persisted after bounded rate-limiter retries (includes `Retry-After` header) |
| `INTERNAL_ERROR` | `500` | `1` | Unexpected daemon/CLI failure, early daemon exit, or malformed IPC response |
| `UNAUTHORIZED` *(reserved)* | `401` | `1` | Present in `IpcErrorCode` ([types.ts](./src/shared/types.ts)) and HTTP `401` client fallback parsing; not emitted by zero-overhead local IPC |

---

### 5.3 Shared Nested JSON Schemas

- **`Snowflake`**: `string` matching `/^\d{1,22}$/`
- **`IsoTimestamp`**: `string` (ISO 8601 UTC timestamp, e.g. `"2026-11-13T17:00:00.000Z"`)
- **`DiscordAuthMode`**: `"user" | "bot"`
- **`GatewayConnectionState`**: `"disconnected" | "connecting" | "identifying" | "resuming" | "ready" | "reconnecting" | "fatal"`
- **`DiscordChannelType` numeric values**: `0` (`GUILD_TEXT`), `1` (`DM`), `2` (`GUILD_VOICE`), `3` (`GROUP_DM`), `4` (`GUILD_CATEGORY`), `5` (`GUILD_ANNOUNCEMENT`), `10` (`ANNOUNCEMENT_THREAD`), `11` (`PUBLIC_THREAD`), `12` (`PRIVATE_THREAD`), `13` (`GUILD_STAGE_VOICE`), `15` (`GUILD_FORUM`), `16` (`GUILD_MEDIA`)

```ts
interface CachedUser {
  id: Snowflake;
  username: string;
  discriminator: string;
  globalName: string | null;
  bot: boolean;
  updatedAt: IsoTimestamp;
}

interface CachedChannel {
  id: Snowflake;
  type: number;
  guildId: Snowflake | null;
  name: string;
  topic: string | null;
  parentId: Snowflake | null;
  position?: number | null;
  nsfw?: boolean;
  recipientIds: Snowflake[];
  lastMessageId: Snowflake | null;
  isDm: boolean;
  updatedAt: IsoTimestamp;
}

interface CachedAttachment {
  id: Snowflake;
  filename: string;
  size: number;
  url: string;
  contentType: string | null;
}

interface CachedReaction {
  emojiKey: string;         // Unicode char (e.g. "👍") or "name:id" for custom emoji
  emojiName: string | null;
  emojiId: Snowflake | null;
  animated: boolean;
  count: number;
  me: boolean;
}

interface CachedMessage {
  id: Snowflake;
  channelId: Snowflake;
  guildId: Snowflake | null;
  author: CachedUser;
  content: string;
  timestamp: IsoTimestamp;
  editedTimestamp: IsoTimestamp | null;
  mentionsBot: boolean;
  mentionEveryone: boolean;
  mentionUserIds: Snowflake[];
  mentionRoleIds: Snowflake[];
  attachments: CachedAttachment[];
  reactions: CachedReaction[];
  replyToMessageId: Snowflake | null;
}
```

---

### 5.4 Exact Command `data` Schemas

#### `DaemonStatusResult` (`status`, `daemon status`)
```ts
interface GatewayStatusSnapshot {
  state: GatewayConnectionState;
  authMode?: DiscordAuthMode;
  sessionId: string | null;
  seq: number | null;
  gatewayUrl: string | null;
  resumeGatewayUrl: string | null;
  heartbeatIntervalMs: number | null;
  lastHeartbeatAt: IsoTimestamp | null;
  lastHeartbeatAckAt: IsoTimestamp | null;
  latencyMs: number | null;
  reconnectAttempts: number;
  lastError: string | null;
}

interface CacheStatusSnapshot {
  guilds: number;
  channels: number;
  dmChannels: number;
  users: number;
  cachedMessages: number;
  unreadChannels: number;
  totalUnreadMessages: number;
  totalMentions: number;
  activeWatchers: number;
}

interface RateLimitStatusSnapshot {
  trackedBuckets: number;
  globalBlockedUntil: IsoTimestamp | null;
}

interface DaemonStatusResult {
  pid: number;
  startedAt: IsoTimestamp;
  uptimeMs: number;
  host: string;
  port: number;
  authMode?: DiscordAuthMode;
  gateway: GatewayStatusSnapshot;
  botUser: CachedUser | null;   // Authenticated account in both "user" and "bot" modes
  cache: CacheStatusSnapshot;
  rateLimits: RateLimitStatusSnapshot;
}
```

#### `DaemonStartResult` (`daemon start` without `--foreground`)
Includes all fields of `DaemonStatusResult`, plus `alreadyRunning`:
```ts
interface DaemonStartResult extends DaemonStatusResult {
  alreadyRunning: boolean;
}
```

#### `DaemonStopResult` (`daemon stop`)
```ts
interface DaemonStopResult {
  stopping: true;
  pid: number;
}
```

#### `JoinGuildResult` (`join`)
```ts
interface GuildSummary {
  id: Snowflake;
  name: string;
  icon: string | null;
  ownerId: Snowflake | null;
  owner?: boolean;
  memberCount: number | null;
  approximatePresenceCount?: number | null;
  unavailable?: boolean;
}

interface JoinGuildChannelInfo {
  id: Snowflake;
  name: string | null;
  type: number;
}

interface JoinGuildResult {
  inviteCode: string;
  guild: GuildSummary | null;
  channel: JoinGuildChannelInfo | null;
}
```

#### `GuildsResult` (`guilds`)
```ts
interface GuildsResult {
  totalGuilds: number;
  guilds: GuildSummary[];
  source: "cache" | "rest";
}
```

#### `GuildChannelsResult` (`channels`)
```ts
interface GuildChannelSummary {
  id: Snowflake;
  guildId: Snowflake;
  name: string;
  type: number;
  topic: string | null;
  parentId: Snowflake | null;
  position: number | null;
  nsfw?: boolean;
  lastMessageId: Snowflake | null;
  isCategory: boolean;
  isThread: boolean;
}

interface GuildChannelsResult {
  guildId: Snowflake;
  guildName: string | null;
  totalChannels: number;
  channels: GuildChannelSummary[];
  categories: GuildChannelSummary[];
  threads: GuildChannelSummary[];
  source: "cache" | "rest";
}
```

#### `ChannelMembersResult` (`members`)
```ts
interface ChannelMemberSummary {
  userId: Snowflake;
  username: string;
  discriminator: string;
  globalName: string | null;
  nickname: string | null;
  bot: boolean;
  roleIds: Snowflake[];
  joinedAt?: IsoTimestamp | null;
}

interface ChannelMembersResult {
  channelId: Snowflake;
  guildId: Snowflake | null;
  totalMembers: number;
  members: ChannelMemberSummary[];
  source: "cache" | "rest" | "mixed";
}
```

#### `DmChannelsResult` (`dms`)
```ts
interface DmRecipientSummary {
  id: Snowflake;
  username: string;
  discriminator: string;
  globalName: string | null;
  bot: boolean;
}

interface DmChannelSummary {
  channelId: Snowflake;
  type: number;
  name: string;
  recipientId: Snowflake | null;
  recipientIds: Snowflake[];
  username: string | null;
  globalName: string | null;
  recipients: DmRecipientSummary[];
  lastMessageId: Snowflake | null;
}

interface DmChannelsResult {
  totalDms: number;
  dms: DmChannelSummary[];
  source: "cache" | "rest";
}
```

#### `DirectMessageResult` (`dm`)
```ts
interface DirectMessageResult {
  channel: CachedChannel;
  message: CachedMessage;
}
```

#### `UnreadResult` (`unread`)
```ts
interface UnreadRecord {
  channelId: Snowflake;
  channelName: string;
  guildId: Snowflake | null;
  guildName: string | null;
  isDm: boolean;
  lastReadMessageId: Snowflake | null;
  lastMessageId: Snowflake;
  unreadCount: number;
  mentionCount: number;
  hasMention: boolean;
  latestMessageTimestamp: IsoTimestamp;
  latestMessagePreview: string; // whitespace-collapsed, <=120 chars, or "[attachment: <filename>]"
  latestAuthorName: string;
}

interface UnreadResult {
  totalUnreadChannels: number;
  totalUnreadMessages: number;
  totalMentions: number;
  items: UnreadRecord[];
}
```

#### `ReadMessagesResult` (`read`)
```ts
interface ReadMessagesResult {
  channel: CachedChannel;
  messages: CachedMessage[];    // ordered oldest-to-newest
  source: "cache" | "rest";
  markedReadUpTo: Snowflake | null;
}
```

#### `SendMessageResult` (`send`)
```ts
interface SendMessageResult {
  message: CachedMessage;
}
```

#### `ReactMessageResult` (`react`)
```ts
interface ReactMessageResult {
  channelId: Snowflake;
  messageId: Snowflake;
  emoji: string;
  action: "added" | "removed";
}
```

---

### 5.5 Exact `WatchEvent` JSONL Line Schemas (`watch`)

Each line emitted to `stdout` by `watch <channel_id>` is a standalone JSON object (not wrapped in `{ ok, data }`) discriminated by `type`:

```ts
type WatchEvent =
  | WatchReadyEvent
  | WatchMessageCreateEvent
  | WatchMessageUpdateEvent
  | WatchMessageDeleteEvent
  | WatchReactionAddEvent
  | WatchReactionRemoveEvent
  | WatchGatewayStateEvent;
```

1. **`ready` (`WatchReadyEvent`)** — emitted immediately on stream subscribe (unless filtered by `--events`):
   ```ts
   interface WatchReadyEvent {
     type: "ready";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     channel: CachedChannel | null;
     gatewayState: GatewayConnectionState;
   }
   ```
   Example line:
   ```json
   {"type":"ready","timestamp":"2026-11-13T17:05:00.000Z","channelId":"123456789012345678","channel":null,"gatewayState":"ready"}
   ```

2. **`message_create` (`WatchMessageCreateEvent`)**:
   ```ts
   interface WatchMessageCreateEvent {
     type: "message_create";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     message: CachedMessage;
   }
   ```
   Example line:
   ```json
   {"type":"message_create","timestamp":"2026-11-13T17:05:01.123Z","channelId":"123456789012345678","message":{"id":"222222222222222222","channelId":"123456789012345678","guildId":"111111111111111111","author":{"id":"333333333333333333","username":"alice","discriminator":"0","globalName":"Alice","bot":false,"updatedAt":"2026-11-13T17:05:01.123Z"},"content":"hello","timestamp":"2026-11-13T17:05:01.100Z","editedTimestamp":null,"mentionsBot":false,"mentionEveryone":false,"mentionUserIds":[],"mentionRoleIds":[],"attachments":[],"reactions":[],"replyToMessageId":null}}
   ```

3. **`message_update` (`WatchMessageUpdateEvent`)**:
   ```ts
   interface WatchMessageUpdateEvent {
     type: "message_update";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     message: CachedMessage;
   }
   ```
   Example line:
   ```json
   {"type":"message_update","timestamp":"2026-11-13T17:05:10.000Z","channelId":"123456789012345678","message":{"id":"222222222222222222","channelId":"123456789012345678","guildId":"111111111111111111","author":{"id":"333333333333333333","username":"alice","discriminator":"0","globalName":"Alice","bot":false,"updatedAt":"2026-11-13T17:05:01.123Z"},"content":"hello (edited)","timestamp":"2026-11-13T17:05:01.100Z","editedTimestamp":"2026-11-13T17:05:09.900Z","mentionsBot":false,"mentionEveryone":false,"mentionUserIds":[],"mentionRoleIds":[],"attachments":[],"reactions":[],"replyToMessageId":null}}
   ```

4. **`message_delete` (`WatchMessageDeleteEvent`)** — emitted for both `MESSAGE_DELETE` and each ID in `MESSAGE_DELETE_BULK`:
   ```ts
   interface WatchMessageDeleteEvent {
     type: "message_delete";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     guildId: Snowflake | null;
     messageId: Snowflake;
   }
   ```
   Example line:
   ```json
   {"type":"message_delete","timestamp":"2026-11-13T17:05:15.000Z","channelId":"123456789012345678","guildId":"111111111111111111","messageId":"222222222222222222"}
   ```

5. **`reaction_add` (`WatchReactionAddEvent`)**:
   ```ts
   interface WatchReactionAddEvent {
     type: "reaction_add";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     guildId: Snowflake | null;
     messageId: Snowflake;
     userId: Snowflake;
     emojiKey: string;
     emojiName: string | null;
     emojiId: Snowflake | null;
     animated: boolean;
   }
   ```
   Example line:
   ```json
   {"type":"reaction_add","timestamp":"2026-11-13T17:05:20.000Z","channelId":"123456789012345678","guildId":"111111111111111111","messageId":"222222222222222222","userId":"333333333333333333","emojiKey":"👍","emojiName":"👍","emojiId":null,"animated":false}
   ```

6. **`reaction_remove` (`WatchReactionRemoveEvent`)**:
   ```ts
   interface WatchReactionRemoveEvent {
     type: "reaction_remove";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     guildId: Snowflake | null;
     messageId: Snowflake;
     userId: Snowflake;
     emojiKey: string;
     emojiName: string | null;
     emojiId: Snowflake | null;
     animated: boolean;
   }
   ```
   Example line:
   ```json
   {"type":"reaction_remove","timestamp":"2026-11-13T17:05:25.000Z","channelId":"123456789012345678","guildId":"111111111111111111","messageId":"222222222222222222","userId":"333333333333333333","emojiKey":"shipit:112233445566778899","emojiName":"shipit","emojiId":"112233445566778899","animated":false}
   ```

7. **`gateway_state` (`WatchGatewayStateEvent`)** — emitted when the daemon's Gateway connection state transitions:
   ```ts
   interface WatchGatewayStateEvent {
     type: "gateway_state";
     timestamp: IsoTimestamp;
     channelId: Snowflake;
     state: GatewayConnectionState;
     detail: string | null;
   }
   ```
   Example line:
   ```json
   {"type":"gateway_state","timestamp":"2026-11-13T17:05:30.000Z","channelId":"123456789012345678","state":"reconnecting","detail":"Reconnecting in 1240ms (close 4000)"}
   ```

---

### 5.6 Exit Codes

| Code | Meaning | Conditions |
|---|---|---|
| `0` | Success | Command completed (`ok: true`), `--help`/`--version`, or `watch` closed cleanly / interrupted via `SIGINT`/`SIGTERM`. |
| `1` | Runtime, IPC, or Discord API Error | `DISCORD_API_ERROR`, `RATE_LIMITED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `DAEMON_NOT_READY`, `UNAUTHORIZED`, `INTERNAL_ERROR`, daemon process failed to spawn or exited early, or `daemon run` exited non-zero. |
| `2` | Invalid CLI Arguments or Token/Config Error | `CliParseError` (unknown flag/command, unsupported flag, invalid snowflake/invite/limit/port/events), invalid `DISCORD_CLI_PORT` / `DISCORD_CLI_HOME`, missing `DISCORD_TOKEN`/`DISCORD_BOT_TOKEN` or invalid `DISCORD_AUTH_MODE` on `daemon start`/`daemon run`, or `daemon start --port` mismatch against already-running daemon. |
| `3` | Daemon Not Running or Unreachable | `DAEMON_UNREACHABLE`: missing, stale, or corrupt `$DISCORD_CLI_HOME/daemon.json`; `--port` / `DISCORD_CLI_PORT` mismatch against `daemon.json`; TCP connection failure/timeout; `daemon start` readiness timeout; or unexpected `watch` socket drop. |
