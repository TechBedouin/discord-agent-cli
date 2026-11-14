# Discord CLI — Architecture & Protocol Design

**Project Root:** `<repo-root>`  
**Baseline Reference:** [ARCHITECTURE_NOTES.md](./ARCHITECTURE_NOTES.md)  
**Operational Docs:** [README.md](./README.md), [CLI_USAGE.md](./CLI_USAGE.md), [AGENT.md](./AGENT.md)  
**Shared Contracts:** [types.ts](./src/shared/types.ts), [config.ts](./src/shared/config.ts), [ipc-protocol.ts](./src/shared/ipc-protocol.ts)

---

## 1. Architectural Overview & Rationale

Per [ARCHITECTURE_NOTES.md](./ARCHITECTURE_NOTES.md), Discord Desktop (`app-1.0.9268`, Electron `44.9.3`) delegates its Gateway WebSocket driver, REST resource clients, `X-RateLimit-*` bucket queues, and entity stores to a remotely loaded Electron renderer bundle (`https://discord.com/app`), exposing only local host primitives (`window.DiscordNative`, `discord_erlpack`, `discord_zstd`, `discord_rpc`).

`discord-cli` therefore implements a self-contained, two-process **Discord API v10** architecture in strict ESM TypeScript for Node.js (`>=22.0.0`, `"type": "module"` in [package.json](./package.json)), supporting both **User Mode** (`DISCORD_AUTH_MODE=user`, default for raw tokens) and **Bot Mode** (`DISCORD_AUTH_MODE=bot` or `"Bot "`-prefixed tokens):

```text
+-------------------------------------------------------------------+
| CLI Process (`src/cli/index.ts`) — Short-lived per invocation     |
|  - Global binary entrypoint (`bin: discord-cli`, `fs.realpathSync`)
|  - Parses global flags (`--json`, `--port`, `--home`) & commands  |
|  - Reads `$DISCORD_CLI_HOME/daemon.json` (`{ pid, host, port }`)  |
|  - Zero-auth HTTP/1.1 requests over loopback `127.0.0.1`          |
|  - Emits `--json` envelope or human text; streams `watch` JSONL   |
+---------------------------------+---------------------------------+
                                  |
         Loopback TCP 127.0.0.1   |   HTTP/1.1 JSON + NDJSON stream
         (Host DNS-rebind guard)  |   (no local Bearer token)
                                  v
+-------------------------------------------------------------------+
| Background Daemon (`src/daemon/index.ts`) — Persistent single-host|
|  1. `GatewayClient` (`ws` + optional `node:zlib` inflate stream)  |
|  2. Authoritative `StateCache` + Unread/Mention Watermark Tracker |
|  3. Real-Time Channel Pub/Sub Bus (feeds `watch` NDJSON streams)  |
|  4. `DiscordRestClient` & `RateLimiter` (`X-RateLimit-*` queues)  |
|  5. `DaemonIpcServer` (`127.0.0.1`) + Atomic Lockfile Manager     |
+---------------------------------+---------------------------------+
                                  |
         WSS v10 + HTTPS v10      |   `user` mode: `<token>` + desktop/browser headers
                                  |   `bot` mode: `Bot <token>` + `DiscordBot` UA
                                  v
                          Discord API v10
        (`wss://gateway.discord.gg` & `https://discord.com/api/v10`)
```

Keeping a persistent local daemon avoids spawning a new Gateway WebSocket session on every CLI command (preventing `Op 2 IDENTIFY` churn, `session_start_limit` exhaustion, and cold-start `READY`/`GUILD_CREATE` hydration latency) while serving cache-backed queries (`status`, `guilds`, `channels`, `dms`, `unread`), live `watch` NDJSON streams, optional typing delays, and serialized REST rate-limit queues across concurrent CLI invocations.

---

## 2. Authentication Modes & Security Isolation

- **Token & Auth Mode Resolution ([config.ts](./src/shared/config.ts)):**
  - Primary environment variable: `DISCORD_TOKEN` (fallback alias: `DISCORD_BOT_TOKEN`).
  - `resolveDiscordAuthMode()` resolves `DISCORD_AUTH_MODE`:
    - If set to `"user"` or `"bot"` (case-insensitive), uses that mode (invalid values throw `RangeError`, CLI exits `2`).
    - If unset, `"bot"` is auto-detected when the raw token starts with `"Bot "` (`inferDiscordAuthModeFromToken`); raw tokens without a `"Bot "` prefix default to `"user"`.
  - Leading `"Bot "` is stripped when storing the normalized internal token (`resolveDiscordToken` / `resolveDiscordTokenInfo`), and `formatDiscordAuthorizationHeader(token, authMode)` emits `<token>` in `"user"` mode or `Bot <token>` in `"bot"` mode.
  - **Strict Desktop Isolation:** Desktop Discord user profile directories (`%APPDATA%\Discord`, `AppData\Roaming\Discord`, `~/.config/discord`), `userDataCache.json`, `settings.json`, Electron `safeStorage`, LevelDB, cookies, and RPC named pipes are **never** accessed.
- **Separation of Daemon vs. CLI Privilege:**
  - `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN` is required **only** by the daemon process (`daemon start`, `daemon run`, or direct `dist/daemon/index.js`).
  - Routine CLI commands (`status`, `join`, `guilds`, `channels`, `members`, `dms`, `dm`, `unread`, `read`, `send`, `react`, `watch`, `daemon stop`, `daemon status`) never read `DISCORD_TOKEN`. They discover the running daemon via `$DISCORD_CLI_HOME/daemon.json`.
  - Neither the Discord token nor any local Bearer token is written to `daemon.json`, logged to `daemon.log`, or returned in IPC responses.

---

## 3. Background Daemon Architecture (`src/daemon/*`)

### 3.1 Discord API v10 Gateway Manager (`GatewayClient` in `src/daemon/gateway.ts`)

1. **Mode-Aware Bootstrap & WebSocket Headers:**
   - **`user` mode:** Calls `GET /gateway` (falls back to `DISCORD_GATEWAY_URL` on non-401 error; HTTP `401` transitions Gateway state to `"fatal"`). Opens `new WebSocket(wsUrl, { headers: buildUserModeGatewayHeaders(this.userAgent) })` supplying `User-Agent` (`DEFAULT_USER_MODE_USER_AGENT`) and `Origin: "https://discord.com"`.
   - **`bot` mode:** Calls `GET /gateway/bot` (`GatewayBotInfo`: checks `session_start_limit.remaining` and waits `session_start_limit.reset_after` before connecting; HTTP `401` transitions to `"fatal"`). Opens `new WebSocket(wsUrl)`.
2. **Transport & Optional `zlib-stream` Compression:**
   - Connects via `ws` with query parameters `?v=10&encoding=json` and optional `&compress=zlib-stream` (enabled by default, configurable via `DISCORD_CLI_ZLIB=false`).
   - When `zlib-stream` is enabled, each connection owns a dedicated `zlib.createInflate()` stream (`node:zlib`) that accumulates binary chunks until the 4-byte ZLIB sync flush suffix `0x00 0x00 0xff 0xff` and parses complete JSON frames — recreating a clean `inflate` context on every reconnect.
3. **Gateway v10 Opcode State Machine (`GatewayOpcode` in [types.ts](./src/shared/types.ts)):**
   - **`Op 10 HELLO`:** Extracts `heartbeat_interval`, schedules initial `Op 1` heartbeat after `heartbeat_interval * Math.random()` jitter, and runs periodic `Op 1` heartbeats. Sends `Op 6 RESUME` if `(sessionId !== null && seq !== null && resumeGatewayUrl !== null)`, otherwise sends `Op 2 IDENTIFY`.
   - **`Op 1 HEARTBEAT` (inbound server request):** Immediately responds with `Op 1` using current `seq`.
   - **`Op 11 HEARTBEAT_ACK`:** Records `lastHeartbeatAckAt` and `latencyMs`. If a heartbeat interval fires while `awaitingAck === true`, terminates the zombie connection (`4000`) and reconnects via `Op 6 RESUME`.
   - **`Op 2 IDENTIFY`:**
     - **`user` mode:** Sends `properties: DEFAULT_USER_GATEWAY_PROPERTIES` (`{ $os: "Windows", $browser: "Discord Client", $device: "desktop" }`), **omits `intents`** (`DISCORD_INTENTS` is ignored), and includes `compress: true` only when zlib transport is enabled.
     - **`bot` mode:** Sends `properties: { os: process.platform, browser: "discord-cli", device: "discord-cli" }`, `intents` (`DEFAULT_GATEWAY_INTENTS = 46593`, `BASE_UNPRIVILEGED_GATEWAY_INTENTS = 13825`, or custom `DISCORD_INTENTS` in [config.ts](./src/shared/config.ts)), and `compress: boolean`.
   - **`Op 6 RESUME` & `Op 7 RECONNECT` & `Op 9 INVALID_SESSION`:** Resumes against `resume_gateway_url` with `{ token, session_id, seq }` (or clears session on `Op 9` with `d === false` after `1000–5000ms` jittered delay before fresh `Op 2 IDENTIFY`).
   - **`Op 0 DISPATCH`:** Updates `seq` monotonically and routes typed events (`READY`, `RESUMED`, `GUILD_CREATE`, `GUILD_UPDATE`, `GUILD_DELETE`, `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`, `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE`, `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, `MESSAGE_REACTION_REMOVE_EMOJI`, `RELATIONSHIP_ADD`, `RELATIONSHIP_REMOVE`, `USER_SETTINGS_UPDATE`) into `StateCache`.
4. **Close Code Handling & Exponential Backoff:**
   - Fatal close codes (`FATAL_GATEWAY_CLOSE_CODES`: `4004`, `4010`, `4011`, `4012`, `4013`, `4014`) transition Gateway state to `"fatal"`, set `lastError`, and halt reconnect loops while keeping IPC alive so `status` reports the error cleanly.
   - Recoverable disconnects reconnect with jittered exponential backoff (`min(1000 * 2^attempt, 30000) + jitter`).

### 3.2 Authoritative In-Memory State Cache & Unread Tracker (`StateCache` in `src/daemon/state-cache.ts`)

`StateCache` maintains normalized live state hydrated from Gateway dispatches and supplemented on demand by REST reads:

- **Primary Maps & Accessors:**
  - `botUser: CachedUser | null` (authenticated account in both `"user"` and `"bot"` modes from `READY.user`)
  - `guilds: Map<Snowflake, CachedGuild>` (user-mode `READY.guilds` hydrates full guild `properties`, `channels`, `threads`, `members`, and `member_count`; bot-mode `READY.guilds` initializes unavailable stubs hydrated by subsequent `GUILD_CREATE` dispatches; `merged_members` hydrates guild member records and `botRoleIds`)
  - `channels: Map<Snowflake, CachedChannel>` (guild channels and active threads)
  - `dmChannels: Map<Snowflake, CachedChannel>` (open DM `type === 1` and Group DM `type === 3` channels hydrated from `READY.private_channels`, `CHANNEL_CREATE`, DM `MESSAGE_CREATE`, `dms` REST fallback, or `dm` creation)
  - `users: Map<Snowflake, CachedUser>` (authors, mention targets, DM recipients, `relationships[].user`, guild members)
  - `guildMembers: Map<Snowflake, Map<Snowflake, CachedGuildMember>>` (guild nicknames, role IDs, `joinedAt`)
  - `relationships: Map<Snowflake, DiscordRelationship>` (`getRelationships()`, hydrated on `READY` and updated live on `RELATIONSHIP_ADD` / `RELATIONSHIP_REMOVE`)
  - `userSettings: DiscordUserSettings | null` (`getUserSettings()`, hydrated on `READY.user_settings` and shallow-merged on `USER_SETTINGS_UPDATE`)
  - `messagesByChannel: Map<Snowflake, CachedMessage[]>` (ordered oldest-to-newest per channel, capped by `DEFAULT_MAX_MESSAGES_PER_CHANNEL = 200` / `DISCORD_CLI_MAX_MESSAGES_PER_CHANNEL` `1..10000`) and `restHydratedChannels: Set<Snowflake>`
- **Mention, DM & Unread Watermark Tracker (`ChannelWatermark` -> `UnreadRecord`):**
  - Tracks `{ lastReadMessageId, lastMessageId, unreadCount, mentionCount, updatedAt }` per channel.
  - Excludes messages authored by `botUser.id`; evaluates `mentionsBot` via user mention, `@everyone`, matched guild roles (`botRoleIds`), or DM channels; recalculates or clears unread state when `read <channel_id> --mark-read` advances `lastReadMessageId`.
- **Real-Time Pub/Sub (`subscribersByChannel`):**
  - Fans out `WatchEvent` records (`ready`, `message_create`, `message_update`, `message_delete`, `reaction_add`, `reaction_remove`, `gateway_state`) to active NDJSON `watch` subscribers.

### 3.3 REST Client, Rate-Limit Engine & Typing Delay (`DiscordRestClient` & `RateLimiter`)

Targets `https://discord.com/api/v10` (overridable via `DISCORD_API_BASE_URL`) using native `fetch`:

- **Mode-Aware Request Headers (`buildDiscordRestHeaders` in [config.ts](./src/shared/config.ts)):**
  - **`user` mode:** `Authorization: <token>`, `User-Agent: DEFAULT_USER_MODE_USER_AGENT` (`discord/1.0.9268 Chrome/152.0.7977.167 Electron/44.9.3`), `Origin: https://discord.com`, `Referer: https://discord.com/channels/@me`, `X-Debug-Options: bugReporterEnabled`, `X-Discord-Locale` (default `en-US`), `X-Discord-Timezone` (non-empty override or `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"`), and `X-Super-Properties` (UTF-8 Base64 JSON of `DEFAULT_SUPER_PROPERTIES` with `browser_version: "44.9.3"`, `client_build_number: 520000`, `native_build_number: 85000`). On `acceptInvite()` (`POST /invites/{code}`), additionally injects `X-Context-Properties: encodeInviteContextProperties()` (`{"location":"Accept Invite Page"}`).
  - **`bot` mode:** `Authorization: Bot <token>`, `User-Agent: DiscordBot (https://github.com/local/discord-cli, 0.1.0)`.
- **Optional Typing Flow (`DISCORD_AUTO_TYPING` / `--typing`):**
  - On `send` and `dm`, `DaemonIpcServer` evaluates `shouldType = req.typing ?? this.autoTyping`. When `true`, it triggers `POST /channels/{id}/typing` through `RateLimiter`, waits `calculateTypingDelayMs(content)` (`40ms` per character clamped to `800..3500` ms), and then calls `POST /channels/{id}/messages`.
- **Rate-Limit Bucket Engine (`src/daemon/rate-limiter.ts`):**
  - Strips query/hash suffixes when normalizing route templates (`METHOD:/template:majorParam` where `majorParam` is `guild_id`, `channel_id`, or `webhook_id`), maps routes to `X-RateLimit-Bucket` hashes, serializes per-bucket FIFO queues, pauses preemptively on `remaining === 0` until `resetAfterMs`, enforces shared `globalBlockedUntilMs` gates (`X-RateLimit-Global`), and retries `HTTP 429` within bounded retry limits without corrupting personal bucket state on `X-RateLimit-Scope: "shared"`.

---

## 4. Local IPC Protocol, Streaming & Security

### 4.1 Loopback HTTP/1.1 + NDJSON Transport

`discord-cli` uses **loopback HTTP/1.1 (`127.0.0.1`) + NDJSON streaming** (`application/x-ndjson`) via Node's built-in `node:http` and `fetch`, behaving identically across Windows, macOS, and Linux with clean framing for request/response commands and unbuffered chunk delivery for `watch`.

### 4.2 Binding, Discovery Lockfile & Permissions

- **Strict Loopback Binding:** `assertLoopbackBindHost` permits only `"127.0.0.1"` or `"localhost"` (default `DEFAULT_IPC_HOST = "127.0.0.1"`).
- **Port Resolution (`resolveIpcPort` in [config.ts](./src/shared/config.ts)):** `--port <n>` > `DISCORD_CLI_PORT` > `DEFAULT_IPC_PORT` (`47832`). Port `0` selects an OS-assigned ephemeral port recorded in `daemon.json`.
- **Lockfile Schema (`DaemonLockfile` at `$DISCORD_CLI_HOME/daemon.json`):**
  ```json
  {
    "pid": 12345,
    "host": "127.0.0.1",
    "port": 47832,
    "startedAt": "2026-11-14T20:00:00.000Z",
    "version": "0.1.0"
  }
  ```
  There is **no `token` field** written to `daemon.json` (`isValidDaemonLockfile` tolerates an optional legacy `token` string only for backward compatibility). Directory uses `0o700` and lockfile/log use `0o600` on POSIX (per-user profile ACLs on Windows), written atomically via temp file + rename (`writeDaemonLockfile`), with automatic stale/dead PID cleanup (`inspectDaemonLockfile`, `removeDaemonLockfile`).

### 4.3 Zero-Overhead Local IPC Hardening

- **Zero Local Bearer Overhead:** Neither `DaemonIpcClient` nor `DaemonIpcServer` sends or checks local `Authorization: Bearer ...` headers on `127.0.0.1`.
- **DNS Rebinding Guard:** `isAllowedLoopbackHostHeader(req.headers.host)` allows omitted `Host` or `127.0.0.1[:port]` / `localhost[:port]` only; any non-loopback `Host` header is rejected immediately with HTTP `403 FORBIDDEN`.
- **Body & Path Validation:** Request bodies are capped at `DEFAULT_MAX_IPC_BODY_BYTES = 1048576` (1 MiB, returning `413 BAD_REQUEST`), unsupported methods on valid routes return `405 METHOD_NOT_ALLOWED` with `Allow`, and snowflake params are validated against `/^\d{1,22}$/` (`isValidSnowflake`, `matchIpcRoute`).

### 4.4 IPC Endpoint Table (`IPC_ROUTES` in [ipc-protocol.ts](./src/shared/ipc-protocol.ts))

All endpoints return UTF-8 JSON (`IpcResponseEnvelope<T>`) except `watch`, which streams `application/x-ndjson`.

| CLI Command | Method & Path | Request Payload / Query | Success `data` / Stream |
|---|---|---|---|
| `status` / `daemon status` | `GET /v1/status` | — | `DaemonStatusResult` |
| `join <invite>` | `POST /v1/invites/join` | `{ invite }` (`JoinGuildRequest`) | `JoinGuildResult` |
| `guilds` | `GET /v1/guilds` | — | `GuildsResult` |
| `channels <guild_id>` | `GET /v1/guilds/:guildId/channels` | — | `GuildChannelsResult` |
| `members <channel_id>` | `GET /v1/channels/:channelId/members` | `?limit=N` (`1..1000`, default `50`) | `ChannelMembersResult` |
| `dms` | `GET /v1/dms` | — | `DmChannelsResult` |
| `dm <user_id> <msg>` | `POST /v1/dms` | `{ userId, content, typing? }` (`DirectMessageRequest`) | `DirectMessageResult` |
| `unread` | `GET /v1/unread` | `?include_dms=bool&mentions_only=bool` | `UnreadResult` |
| `read <channel_id>` | `POST /v1/channels/:channelId/read` | `{ limit?, before?, after?, markRead? }` (`ReadMessagesRequest`) | `ReadMessagesResult` |
| `send <channel_id> <msg>` | `POST /v1/channels/:channelId/messages` | `{ content, replyToMessageId?, typing? }` (`SendMessageRequest`) | `SendMessageResult` |
| `react <cid> <mid> <emoji>` | `POST /v1/channels/:channelId/messages/:messageId/reactions` | `{ emoji, remove? }` (`ReactMessageRequest`) | `ReactMessageResult` |
| `watch <channel_id>` | `GET /v1/channels/:channelId/watch` | `?events=e1,e2,...` | NDJSON stream of `WatchEvent` |
| `daemon stop` | `POST /v1/daemon/stop` | `{}` | `DaemonStopResult` |

---

## 5. CLI Client & Command Contracts (`src/cli/*`)

### 5.1 Entrypoint, Global Flags & Subcommands

- **Global Binary Entrypoint (`src/cli/index.ts`):** Compiled to `./dist/cli/index.js` (`"bin": { "discord-cli": "./dist/cli/index.js" }` in [package.json](./package.json)) with `#!/usr/bin/env node` and `fs.realpathSync` direct-execution check for `npm link` symlink compatibility.
- **Global Flags (accepted before or after subcommands; before `--`):** `--json`, `--port <number>`, `--home <path>`, `--help`/`-h`, `--version`/`-v`, `--`.
- **Commands (`src/cli/args.ts`, `src/cli/commands.ts`):**
  - `status` / `daemon status` — daemon PID, `authMode`, Gateway status, account (`botUser`), cache & unread summary, rate-limit state
  - `join <invite_code_or_url>` — accepts codes, `discord.gg/<code>` (`www`/`ptb`/`canary`), or `discord.com/invite/<code>` / `discordapp.com/invite/<code>`
  - `guilds` — lists joined guilds (cache-first with REST fallback)
  - `channels <guild_id>` — lists sorted channels, categories, and active threads
  - `members <channel_id> [--limit N]` — unique users seen in channel activity (`1..1000`, default `50`)
  - `dms` — lists open DM and Group DM channels
  - `dm <user_id> <message...> [--typing]` — sends DM (`1..2000` chars) with optional typing
  - `unread [--mentions-only] [--no-dms]` — unread channels/DMs and mention counts from `StateCache`
  - `read <channel_id> [--limit N] [--mark-read] [--before <id>] [--after <id>]` — reads `1..100` messages (default `50`) oldest-to-newest
  - `send <channel_id> <message...> [--reply <message_id>] [--typing]` — sends message (`1..2000` chars) with optional reply & typing
  - `react <channel_id> <message_id> <emoji> [--remove]` — adds/removes Unicode or custom `<:name:id>` reaction
  - `watch <channel_id> [--events e1,e2]` — streams live `WatchEvent` JSONL records to `stdout`
  - `daemon start [--foreground]`, `daemon stop`, `daemon status`, `daemon run`

### 5.2 JSON Envelopes, `WatchEvent` JSONL & Exit Codes

- **Success Envelope (`stdout`, exit `0`):** `{ "ok": true, "data": ... }`
- **Error Envelope (`stderr`, non-zero exit):** `{ "ok": false, "error": { "code", "message", "status", "discordCode"?, "retryAfterMs"?, "details"? } }`
- **`WatchEvent` JSONL (`watch` on `stdout`):** `ready`, `message_create`, `message_update`, `message_delete`, `reaction_add`, `reaction_remove`, `gateway_state`.
- **CLI Exit Codes:**
  - `0`: Success (`ok: true`, `--help`/`--version`, or clean `watch` exit / `SIGINT` / `SIGTERM`)
  - `1`: Runtime, IPC, or Discord API error (`DISCORD_API_ERROR`, `RATE_LIMITED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `DAEMON_NOT_READY`, `INTERNAL_ERROR`)
  - `2`: Invalid CLI arguments, flags, config, or missing `DISCORD_TOKEN` / invalid `DISCORD_AUTH_MODE` on `daemon start`/`run` (`BAD_REQUEST`)
  - `3`: Daemon not running or unreachable (`DAEMON_UNREACHABLE`)

---

## 6. Project Structure & TypeScript Build / Test Model

```text
<repo-root>/
  package.json              # ESM ("type": "module"), bin: ./dist/cli/index.js
  tsconfig.json             # Strict TypeScript, ES2024, NodeNext, rootDir: src, outDir: dist
  tsconfig.test.json        # Typechecks both src/**/*.ts and tests/**/*.ts (--noEmit)
  README.md                 # Public overview, ToS/security warnings & quickstart
  AGENT.md                  # Mandatory operational safety rules for user-mode agents
  CLI_USAGE.md              # Full operational reference, schemas & verbatim --help
  DESIGN.md                 # Architecture & protocol design specification
  ARCHITECTURE_NOTES.md     # Discord Desktop local boundary investigation notes
  LICENSE                   # MIT License
  src/
    shared/
      types.ts              # Discord v10, cache, unread, IPC DTO & WatchEvent types
      config.ts             # Env/path/port/auth-mode/header/typing/intent resolvers
      ipc-protocol.ts       # IPC_ROUTES, host guard, invite/query/body validators, lockfile
    daemon/
      index.ts              # Daemon bootstrap, lockfile management & signal shutdown
      gateway.ts            # Gateway v10 WebSocket client (user/bot modes, zlib-stream)
      rest-client.ts        # Native fetch Discord v10 REST client
      rate-limiter.ts       # Per-bucket FIFO queue & global 429 rate-limit engine
      state-cache.ts        # In-memory StateCache, watermarks & watch pub/sub
      ipc-server.ts         # Zero-auth loopback 127.0.0.1 HTTP/1.1 + NDJSON IPC server
    cli/
      index.ts              # CLI entrypoint (#!/usr/bin/env node, fs.realpathSync)
      args.ts               # Flag/subcommand parser & --help formatter
      ipc-client.ts         # Lockfile discovery & HTTP/NDJSON IPC client
      commands.ts           # Command handlers & human/JSON output formatters
  tests/
    args.test.ts            # Argument & flag parsing tests
    state-cache.test.ts     # StateCache hydration, watermarks & watch pub/sub tests
    rate-limiter.test.ts    # RateLimiter, REST headers & typing tests
    gateway.test.ts         # Gateway WS opcode, compression & mode header tests
    e2e.test.ts             # End-to-end CLI <-> daemon <-> mock Discord tests
```

- **`erasableSyntaxOnly` Compatibility:** Source files avoid TypeScript `enum` and constructor parameter properties (using `as const` objects and union types) so all modules compile cleanly under `tsc` (`npm run typecheck`, `npm run build`) and execute directly under `node --test`.
- **Testing Strategy (`node:test`):** `npm test` runs `npm run build && node --test`. All unit and integration tests (`tests/*.test.ts`) import compiled ESM modules from `../dist/...js` and run against local mock HTTP/WebSocket servers (`node:http` / `ws.WebSocketServer`) with zero live Discord credentials.
