# `discord-cli` Agent Operational Safety Rules (`AGENT.md`)

Strict operational rules for AI agents invoking `discord-cli` on a Discord **user account** (`DISCORD_AUTH_MODE=user`). Violating these practices elevates account lock, CAPTCHA, or suspension risk—treat every rule below as mandatory.

For full protocol details, flags, IPC schemas, and exit codes, see [CLI_USAGE.md](./CLI_USAGE.md).

---

## 1. Connection & Session Hygiene

- **Explicit User Mode:** Ensure the daemon runs with `DISCORD_AUTH_MODE=user` (or a raw user token without a `"Bot "` prefix, which defaults to `"user"`). Verify `data.authMode === "user"` via `discord-cli status --json`.
- **User's Own Device & Residential IP Only:** Run `discord-cli` strictly on the user's own local machine and standard residential/home network. Never deploy or proxy user-mode sessions from cloud VMs, VPSs, CI runners, or rotating/datacenter IPs.
- **One Persistent Daemon (Zero Session Churn):** Call `discord-cli daemon start --json` once and reuse that single daemon process across all subsequent CLI commands.
  - Check `discord-cli status --json` before attempting a start; if running, reuse it.
  - **Never** stop and restart the daemon repeatedly in loops (`daemon stop` -> `daemon start` triggers a fresh Gateway bootstrap + `Op 2 IDENTIFY` handshake).
- **Strict Desktop Isolation:** Never inspect, read, copy, or query Discord Desktop profile directories (`%APPDATA%\Discord` / `AppData\Roaming\Discord`, `~/.config/discord`), `settings.json`, `userDataCache.json`, Electron `safeStorage`, LevelDB, cookies, or desktop RPC named pipes. Pass auth strictly via `DISCORD_TOKEN` (or `DISCORD_BOT_TOKEN`) at daemon startup only.

---

## 2. Cache-First & Anti-Polling Discipline

- **Read Warm Cache First:** Prefer cache-backed discovery commands before making REST requests:
  - `status --json` (health, authMode, gateway state, cache counts, rate-limit gate)
  - `guilds --json` (`source: "cache"` after `READY` hydration)
  - `channels <guild_id> --json` (`source: "cache"` after `READY` / `GUILD_CREATE` hydration)
  - `dms --json` (`source: "cache"` after `READY.private_channels` hydration)
  - `unread --json` / `unread --mentions-only --json` (pure in-memory unread watermark state; zero Discord REST calls)
- **Stream with `watch`, Never Poll `read`:** For live message or reaction monitoring, open `discord-cli watch <channel_id> --events message_create,reaction_add,gateway_state --json` (JSONL over persistent local IPC) instead of calling `read` on a timer or sleep loop.
- **Keep `--limit` Modest:** Request only what the task needs (e.g., `--limit 10` to `--limit 50` on `read`; default/small `--limit` on `members`). Use `--before` / `--after` sparingly for targeted lookups rather than deep backfill sweeps.
- **No Channel-Scraping Loops:** Never iterate across every guild, channel, or member list in loops to archive, index, or scrape history. Inspect only channels surfaced by `unread --json` or specifically requested by the user.

---

## 3. Human-Paced Writes

- **Always Trigger Typing Before Sends:**
  - Start the daemon with `DISCORD_AUTO_TYPING=1`, **and/or** always pass `--typing` explicitly on `send` and `dm`.
  - When active, the daemon sends `POST /channels/{id}/typing` and waits `clamp(40 * content.length, 800, 3500)` ms before submitting the message.
  - Never pass `"typing": false` over direct HTTP IPC when automating a user account.
- **Natural Pacing:** Space out consecutive `send`, `dm`, and `react` calls naturally across turns. Do not fire rapid-fire burst writes or concurrent write loops.
- **No Bulk, Unsolicited, or Repetitive Messages:** Never send mass messages, unsolicited DMs, duplicate/template copy-paste blasts, or automated `@everyone`/`@here` pings.

---

## 4. High-Risk Operations (User Confirmation Required)

Treat the following commands as **rare, high-risk actions that require explicit user confirmation immediately before execution**:

- **`join <invite_code_or_url>`:** Joining guilds via invite links is heavily scrutinized on user accounts. Never autonomously join servers from discovered links.
- **Cold `dm <user_id> <message...>`:** Initiating a new DM channel (`POST /users/@me/channels`) with someone not already in `dms --json` or unrequested by the user carries elevated spam/CAPTCHA risk. Confirm the target `<user_id>` and exact message with the user first.

---

## 5. Hard-Stop Circuit Breakers & Secret Hygiene

### Pre-Write Health Gate (Mandatory Before Every Write)
Before executing `send`, `dm`, `react`, or `join`, inspect `discord-cli status --json` and verify **both**:
1. `data.gateway.state === "ready"`
2. `data.rateLimits.globalBlockedUntil === null`

If either condition fails, abort the write and report the daemon state to the user.

### Immediate Halt Triggers (Stop Immediately — Do NOT Retry)
Halt all Discord activity at once and notify the user if **any** of the following occur:
1. **Authentication Failure (`401` / `4004`):**
   - `data.gateway.state === "fatal"` (e.g., `lastError` citing `HTTP 401` or `Gateway close 4004`), or
   - Any CLI error with `error.code === "DISCORD_API_ERROR"` and `error.details.httpStatus === 401`.
2. **Rate-Limit Saturation (`429`):**
   - Any error with `error.code === "RATE_LIMITED"` (`error.status === 429`), or repeated `globalBlockedUntil !== null` blocks.
3. **CAPTCHA or Verification Challenge (`403` / `captcha_key`):**
   - Any `error.code === "DISCORD_API_ERROR"` where `error.details.httpStatus === 403` or `error.details.body` includes `captcha_key`, `captcha_sitekey`, `captcha_service`, or account verification requirements.
   - Never retry or attempt to automate/bypass a CAPTCHA or verification gate.

### Token & Credential Protection
- **Never** print, echo, inspect, log, or embed `DISCORD_TOKEN` or `DISCORD_BOT_TOKEN` in command arguments, stdout/stderr outputs, summaries, or files.
- Provide `DISCORD_TOKEN` solely in the environment of `daemon start` / `daemon run`. Client commands (`status`, `unread`, `read`, `send`, `dm`, `react`, `watch`, `guilds`, `channels`, `members`, `dms`, `join`, `daemon stop`) do not read `DISCORD_TOKEN` and communicate locally with `$DISCORD_CLI_HOME/daemon.json` over `127.0.0.1` without storing the token in `daemon.json`.

---

## 6. Concise `--json` Agent Workflow Reference

All commands below emit strict single-line JSON (`{ "ok": true, "data": ... }` on `stdout`, `{ "ok": false, "error": { "code", "message", "status", ... } }` on `stderr`), except `watch`, which streams JSONL event objects on `stdout`.

```bash
# 1. Start persistent daemon once (authMode=user, auto-typing enabled; safe to re-run if already running)
DISCORD_AUTH_MODE=user DISCORD_AUTO_TYPING=1 discord-cli daemon start --json
# Inspect: data.alreadyRunning, data.authMode === "user", data.gateway.state

# 2. Pre-write & pre-task health gate
discord-cli status --json
# Require before writes: data.gateway.state === "ready" && data.rateLimits.globalBlockedUntil === null

# 3. Cache-first discovery (no polling)
discord-cli unread --json
discord-cli unread --mentions-only --json
discord-cli guilds --json
discord-cli channels <guild_id> --json
discord-cli dms --json

# 4. Live monitoring via NDJSON stream (replaces read-polling)
discord-cli watch <channel_id> --events message_create,reaction_add,gateway_state --json

# 5. Modest targeted read + watermark update
discord-cli read <channel_id> --limit 20 --mark-read --json

# 6. Human-paced writes (always --typing; put flags BEFORE "--" when text starts with "-")
discord-cli send <channel_id> "Reply text" --reply <message_id> --typing --json
discord-cli --json send <channel_id> --typing -- "- bullet text"
discord-cli react <channel_id> <message_id> "👍" --json

# 7. High-risk actions (ONLY after explicit user confirmation)
discord-cli dm <user_id> "Direct message text" --typing --json
discord-cli join <invite_code_or_url> --json

# 8. Graceful shutdown only when ending an entire session
discord-cli daemon stop --json
```

### Key `--json` Error & Exit Codes to Handle
| Exit Code | Meaning | Key `error.code` Values & Agent Action |
|---|---|---|
| `0` | Success | Proceed using `data`. |
| `1` | Runtime / API Error | Check `error.code`: **HALT** on `RATE_LIMITED` (`429`) or `DISCORD_API_ERROR` with `details.httpStatus` `401`/`403` or `details.body.captcha_key`. Check `error.code === "FORBIDDEN"` (`403` DNS-rebinding Host guard), `DAEMON_NOT_READY` (`503`). |
| `2` | Invalid Args / Config | `BAD_REQUEST` (`400`/`413`): fix snowflake/flags/message length (`1..2000` non-whitespace) before re-running; on `daemon start`, missing token or invalid `DISCORD_AUTH_MODE`. |
| `3` | Daemon Unreachable | `DAEMON_UNREACHABLE`: verify `$DISCORD_CLI_HOME` / `--port`; start daemon once if stopped. |
