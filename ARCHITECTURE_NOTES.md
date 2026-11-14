# Discord Desktop Architecture Notes & Bot v10 Design Baseline

**Target Inspected:** `%LOCALAPPDATA%\Discord\app-1.0.9268` (`version: "1.0.9268"`, `releaseChannel: "stable"`, `sentryDist: "stable-win-x64"`, `sentryRelease: "discord-desktop-2fa3c2c144e226290d03680c3bf7fdd78ec3d7d8"`)  
**Safety Scope:** Application binaries, ASAR archives, JS/JSON assets, and `modules\` inside `app-1.0.9268` only. No user profile, Local Storage, LevelDB, cookies, or `AppData\Roaming\Discord` auth/token files were read or accessed.

---

## 1. Executive Summary

Discord Desktop (`1.0.9268`, `devDependencies.electron: "44.9.3"` in `app.asar\package.json`) is a **native desktop host shell plus remote web application loader**, not a self-contained Discord protocol client:

- **Bootstrapper (`resources\app.asar`)** initializes paths, `settings.json`, the native updater (`updater.node`), splash UI, and DNS/TCP pre-warming (including `gateway.discord.gg`), then loads `discord_desktop_core`.
- **Electron Core (`modules\discord_desktop_core-1\discord_desktop_core\core.asar`)** creates the sandboxed `BrowserWindow` (`nodeIntegration: false`, `contextIsolation: true`), wires Electron `ipcMain` services, injects `window.DiscordNative` via `mainScreenPreload.js`, and loads the **remote web client** via `mainWindow?.loadURL(URL_TO_LOAD)` (`https://discord.com/app?_=<timestamp>` or `https://discordapp.com/app?...`).
- **Gateway WebSocket lifecycle, REST resource clients (`channels`, `guilds`, `messages`, `reactions`), Discord `X-RateLimit-*` bucket queues, and Discord entity caches (guilds/channels/users) are NOT bundled locally** in `app.asar`, `core.asar`, or `modules\`. Instead, they execute inside the remotely loaded web bundle, calling down into local desktop/native helpers only across `window.DiscordNative` (e.g., `nativeModules.requireModule('erlpack')`, `nativeModules.requireModule('discord_zstd')`, `http.getAPIEndpoint()`, `userDataCache`, `safeStorage`).

Therefore, our **Phase 2–3 TypeScript Discord Bot API v10 daemon + CLI** cannot reuse any shipped Discord Gateway/REST protocol engine from the desktop binary—it must implement the complete Bot API v10 Gateway state machine, REST client, `X-RateLimit-*` bucket queue, and normalized entity cache standalone.

---

## 2. Tooling Verification, REA Commands & Limitations

### Host Environment & Node `v25.6.1` Compatibility
- Host OS / runtime: `win32 x64`, Node `v25.6.1`, npm `11.9.0`.
- `rea-agents@latest` (`6.9.0`) is **incompatible with Node `v25.6.1`**:
  - `package.json` declares `"engines": { "node": "^22.23.4 || ^24.22.1 || >=26.12.1" }`.
  - `npx -y rea-agents@latest --version` emitted `npm warn EBADENGINE Unsupported engine` for `rea-agents@6.9.0` on `v25.6.1`.
  - Direct execution of `rea-agents@6.9.0` (`scripts/rea.mjs --version`) exited with code `1`:
    ```text
    REA requires Node.js 22.x (>=22.23.4), 24.x (>=24.22.1), 26.12.1+; this process runs Node.js 25.6.1. Install a supported release, then retry.
    ```
  - Desktop workflow commands (`inspectDesktopApplicationInputSchema` / `application__desktop__*`) present in `6.9.0` are unavailable on `v25.6.1`.
- Per coordinator direction, Node was kept unchanged and inspection proceeded with `npm install -g rea-agents` fallback **`rea-agents@4.0.1`** (`"engines": { "node": "^22.19.0 || >=24.11.0" }`).

### Observed `rea@4.0.1` Commands & Tool Limitations

| Command / Target | Outcome | Observed Result / Limitation |
|---|---|---|
| `rea --help` | Exit `0` | 69 commands available; `inspect-desktop-application` does not exist in `4.0.1`. |
| `rea doctor --json` | Exit `1` | `node: ok (25.6.1)`, `host: ok (win32 x64)`; `hopper`/`ghidra` reported `missing_analysis_engine`; `skill:identity` & MCP `registrations` reported `missing`/`config_drift` (left untouched per config constraint). |
| `rea providers --json` | Exit `0` | Active: `rea-artifact-graph` (`v1`), `rea-dotnet-static` (`v1`). Unavailable (`null`): `ghidra`, `hopper`, `native-macos`. |
| `rea inspect-artifact resources\app.asar` | Exit `0` | ASAR verified (`sha256: b8e7db370eb8ec34844ef19bee0ac3c25ad82c631a1a10f1ee6893d7611135d9`, 14 nodes, 14 occurrences, 13 edges). |
| `rea inspect-artifact ...\core.asar` | Exit `0` | ASAR verified (`sha256: 375eb0cf6692433a0678a4fad27e19a6ad4bcf551dd68f7a24ed6ef3918c3c50`, 7 nodes, 7 occurrences, 6 edges). |
| `rea inspect-artifact discord_erlpack.node` | Exit `0` | PE `native-addon`, `566,712` B (`sha256: 9cff41976019c82a5f1ffc1afd7f54b71e9226359cd3049ca8340126a4e8e7e5`). |
| `rea inspect-managed-artifact discord_erlpack.node` | Exit `0` | `pe32-plus`, `x86_64` (`0x8664`), `classification.status: "not-managed"` (`cli-directory-absent` -> pure native binary). |
| `rea inspect-artifact discord_zstd.node` | Exit `0` | PE `native-addon`, `740,280` B (`sha256: dd2c6cad1eb555bdd3503ca99a2b5321b8d029c0cfeb11ddc91ceb15fd8f838c`). |
| `rea inspect-artifact updater.node` | Exit `0` | PE `native-addon`, `4,542,904` B (`sha256: 7412ad5c4bc4ade941916714d5f54e49c651f289d6d5f6017e0ce23f10f37fcb`). |
| `rea extract-artifact <app.asar \| core.asar>` | Failed (`io`) | Returned `artifact_operation_failed` (`reason: "io"`). Root cause in `rea-agents\dist\artifacts\SafeOutputTree.js` (lines 37, 97, 100): opens directories with POSIX `constants.O_RDONLY \| constants.O_DIRECTORY`, unsupported on Windows. Worked around using `rea-agents`'s bundled `@electron/asar` (`extractAll`) into `%TEMP%\discord-rea-extract\{app,core}`. |
| `rea analyze-javascript-application resources\app.asar` | Cancelled | Stalled with 0 bytes output while hitting Windows paging-file exhaustion (`0x800705AF` / `Thread failed to start.`) parsing the 3,015,240 B minified `bundle.js`. |
| `rea analyze-javascript-application modules\discord_rpc-1\discord_rpc` | Cancelled after write | Unfiltered JSON emitted >550,000 lines of AST expression nodes due to bundled `node_modules\ws`. |
| `rea analyze-javascript-application ... --filter-output ...` on `discord_zstd` & `discord_erlpack` | Exit `0` | Completed cleanly on compact modules; REA explicitly warns AST analysis covers inert syntax only and does not prove native exports or runtime execution. |

---

## 3. Inspected Package & Module Inventory

### Root & `resources\` (`app-1.0.9268`)
- Host executable & updater: `Discord.exe` (`235,633,592` B), `updater.node` (`4,542,904` B), `updater_launcher.exe` (`641,976` B).
- `resources\build_info.json`: `releaseChannel: "stable"`, `version: "1.0.9268"`.
- `resources\bootstrap\manifest.json`: lists bootstrap modules `{ discord_desktop_core, discord_erlpack, discord_notifications, discord_premap, discord_spellcheck, discord_utils, discord_voice, discord_zstd }`.
- `resources\app.asar` (`3,400,359` B, extracted to `%TEMP%\discord-rea-extract\app`):
  - `package.json` (`827` B): `"name": "discord"`, `"description": "Discord Client for Desktop - Bootstrapper"`, `"main": "bundle.js"`, `"devDependencies": { "electron": "44.9.3" }`.
  - `bundle.js` (`3,015,240` B): main-process bootstrapper, `Settings` (`settings.json`), `paths`, Electron updater (`NEW_UPDATE_ENDPOINT`), splash lifecycle, DNS/TCP warmup, and `requireNative("discord_desktop_core")`.
  - `splashScreenPreload.js` (`8,732` B), `splash/index.html`, `splash/index.css`, fonts, `connecting.webp`, `data/quotes_copy.json`.

### `modules\discord_desktop_core-1\discord_desktop_core`
- `index.js`: `module.exports = require('./core.asar');`
- `core.asar` (`1,595,175` B, extracted to `%TEMP%\discord-rea-extract\core`):
  - `package.json` (`1,510` B): `"name": "discord_desktop_core"`, `"description": "Discord Client for Desktop - Core App"`, `"main": "bundle.js"`.
  - `bundle.js` (`446,299` B): core main-process entry (`exports.startup`), Electron `BrowserWindow` (`mainScreen`), popout/overlay windows (`popoutWindow`), `frameView`, `safeStorage`/`userDataCache`/`settings` IPC handlers, `CONSTANTS_GET` (`APP_NAME`, `APP_ID`, `API_ENDPOINT`).
  - `mainScreenPreload.js` (`1,121,758` B): exposes `window.DiscordNative` via `contextBridge.exposeInMainWorld("DiscordNative", DiscordNative)`.
  - `frameViewPreload.js` (`22,783` B): subframe shell & complete `IPCEvents` enum (`DISCORD_*`).
  - `data/riotgames.pem` (`1,493` B): local Riot LiveClientData TLS CA (`127.0.0.1:2999`).

### Other Modules in `modules\`
- **Protocol / transport-related native & JS wrappers:**
  - `discord_erlpack-1`: `index.js` directly exports `./discord_erlpack.node` (`566,712` B PE32+ x86_64). Static strings in the PE reference `../../discord_desktop/native_modules/discord_erlpack/src\decoder.h`, `../../discord_common/native/uv/executor.cpp`, `unpack`, and `napi_register_module_v1`.
  - `discord_zstd-1`: `discord_zstd.node` (`740,280` B, native PE with static strings referencing `discord_desktop\native_modules\discord_zstd\src\bindings.rs` and `zstd-safe-7.1.0`, plus `DecompressStream` & `initializeLogging`) + `index.js` (`createContext()` -> enforces single active context `id`, calls `buffer.decompress(data)`, `buffer.reset()`, `buffer.getLastError()`).
  - `discord_rpc-1`: `index.js`, `RPCIPC.js`, `RPCWebSocket.js`, `safeEmitter.js`, `node_modules\ws`. Local RPC server adapter over Windows named pipe `\\?\pipe\discord-ipc-{0..9}` (POSIX `discord-ipc-{0..9}`) and local `http`/`ws.Server`.
  - `discord_dispatch-1`: `discord_dispatch.node` (`10,427,320` B) + `index.js` (`Dispatch(jsonConfigString, ...)` with `command`/`destroy` and `getLastState()`). Game/patch distribution engine (used by `discord_cloudsync`), **not** Gateway Op 0 `DISPATCH`.
- **Media, OS, & game modules:** `discord_cloudsync-1`, `discord_voice-1` (`22.6 MB` WebRTC/MLS/clips), `discord_krisp-1` (noise suppression `.kef` models), `discord_media-1`, `discord_utils-1` (`DiscordSystemHelper.exe`, `input_capture.js`), `discord_notifications-1` (`notifications_win.js`), `discord_desktop_overlay-1`, `discord_overlay2-1` (`Backoff.js`, `FeatureFlags.js`, `overlayHost.js`, `overlayPreload.js`), `discord_game_utils-1`, `discord_modules-1` (`discord_aegis_*.dll`, `discord_game_sdk_*.dll`), `discord_spellcheck-1`.

### Electron Process & IPC Boundary (`mainScreenPreload.js` <-> `core\bundle.js`)
- `mainWindow` (`core\bundle.js` module `527`) launches with `nodeIntegration: false`, `sandbox: false`, `contextIsolation: true`, `preload: mainScreenPreload.js`.
- `contextBridge.exposeInMainWorld("DiscordNative", DiscordNative)` exports subsystems: `nativeModules`, `process`, `os`, `app`, `clipboard`, `ipc`, `gpuSettings`, `window`, `powerMonitor`, `ntpClock`, `spellCheck`, `crashReporter`, `desktopCapture`, `activityCapture`, `fileManager`, `clips`, `processUtils`, `powerSaveBlocker`, `frameDebugger`, `frameView`, `http`, `accessibility`, `features`, `settings`, `userDataCache`, `thumbar`, `safeStorage`, `hardware`, `tracing`, `riotGames`, `cs2Gsi`, `dotaGsi`, `rocketLeagueStatsApi`, `webAuthn`, `gcEvents`, `sysimg`.
- IPC channels are prefix-normalized (`DISCORD_<event>`) and gated in preload:
  - `DiscordNative.ipc.send` / `invoke`: restricted by `RENDERER_IPC_SEND_WHITELIST` and `RENDERER_IPC_INVOKE_WHITELIST`.
  - `DiscordNative.settings.set`: restricted by `RENDERER_SET_ALLOWLIST` (enforced both in preload and `ipcMain` module `1839`).
  - `DiscordNative.nativeModules.requireModule(name)`: enforces regex `/^discord_[a-z0-9_-]+$/ || "erlpack"`, blocks `PRELOAD_ONLY_MODULES = Set(["discord_premap", "discord_sysimg"])`, and verifies resolved path lies under `nativeModule.paths` (`browserModulePaths` excluding `electron.asar`, plus module dirs) while triggering `discord_premap.dequeuePremap(...)`.

---

## 4. Deep-Dive: 4 Architecture Areas (Local vs. Native vs. Remote)

An exhaustive case-insensitive literal scan across **all 73 non-`node_modules` text/JS/HTML/JSON files** in `%TEMP%\discord-rea-extract` and `app-1.0.9268\modules` establishes exact boundaries between shipped desktop code and the remote webapp:

### 4.1 WebSocket Gateway Lifecycle
- **Present locally / natively:**
  - `app.asar\bundle.js` (`@39236`) warms DNS/TCP on boot for `DESKTOP_TTI_WARMUP_DOMAINS = ["discord.com", "cdn.discordapp.com", "gateway.discord.gg", "updates.discord.com"]` via `session.defaultSession.resolveHost(...)` and preconnects `discord.com` and `cdn.discordapp.com`.
  - `discord_erlpack.node` and `discord_zstd-1` (`createContext()` -> `DecompressStream`) provide native binary ETF deserialization and streaming Zstandard decompression to the renderer via `DiscordNative.nativeModules.requireModule('erlpack' | 'discord_zstd')`. On Windows, `discord_zstd` is listed in `PREMAP_MODULES`.
  - `core.asar` forwards `powerMonitor` OS events (`resume`, `suspend`, `lock-screen`, `unlock-screen`) to `DiscordNative.powerMonitor`, and uses `connectionBackoff = new Backoff(1000, 20000)` only for `mainWindow.loadURL(...)` page-load failures.
  - `discord_rpc-1\RPCWebSocket.js` bundles `ws` solely to host a local `ws.Server` + `http` server for local RPC clients (not an outbound Gateway client).
- **Remote / Absent locally (0 matches in scan):**
  - 0 hits for `"zlib-stream"`, `"encoding=etf"`, `"HEARTBEAT_ACK"`, `"IDENTIFY"`, `"PRESENCE_UPDATE"`, `"VOICE_STATE_UPDATE"`, `"resume_gateway_url"`, or `wss://gateway...`.
  - Gateway WebSocket creation, `Op 10 Hello`, `Op 1` heartbeat timers / `Op 11` ACK watchdog, `Op 2 Identify` / `Op 6 Resume`, `Op 7 Reconnect`, `Op 9 Invalid Session`, and `Op 0 Dispatch` frame pumping live exclusively in the **remote web bundle** loaded from `https://discord.com/app`.

### 4.2 REST Client Pipeline
- **Present locally:**
  - `app.asar\bundle.js` sets `API_ENDPOINT = settings?.get("API_ENDPOINT") || "https://discord.com/api"` and passes it to `core.asar`, which serves it via `ipcMain.handle("DISCORD_CONSTANTS_GET", ...)` (`APP_NAME`, `APP_ID`, `API_ENDPOINT`).
  - `mainScreenPreload.js` (`module 2447`) exposes `DiscordNative.http`:
    - `getAPIEndpoint()` invokes `DISCORD_CONSTANTS_GET("API_ENDPOINT")`.
    - `makeChunkedRequest(route, chunks, options, callback)` resolves `route` against `apiEndpoint`, opens Node `http.request`/`https.request` with `headers: { authorization: token, "Content-Type": contentType, "Content-Length": Buffer.byteLength(chunks.join("")) }`, streams `chunks` delayed by `chunkInterval`, and resolves `{ status, body }`.
  - Desktop-internal HTTP uses: `electron.net.request` (auto-updater, DNS connectivity checks), `https.request` with `Authorization` (internal `staffDevTools` fetcher `/__development/staff_dev_tools/...`), `https.request` with `data/riotgames.pem` (`127.0.0.1:2999/liveclientdata/...`), and `fetch()` (Sentry minidump upload). Note `core.asar` also explicitly strips `authorization` and `cookie` headers from crash report telemetry payloads.
- **Remote / Absent locally (0 matches in scan):**
  - 0 hits for `/api/v9`, `/api/v10`, `discordapp.com/api`, or Discord REST serializers for channels, guilds, messages, or reactions.
  - All standard REST API calls (CRUD on channels, guilds, messages, reactions, auth injection on web API calls) run inside the **remote web bundle** via Chromium renderer networking (`fetch`/`XMLHttpRequest` inside `session.defaultSession`) targeting `API_ENDPOINT`.

### 4.3 Standard Rate-Limit Compliance
- **Present locally:**
  - `Backoff` class (`core.asar\bundle.js` module `5072` & `discord_overlay2\Backoff.js`): generic jittered exponential backoff (`min = 500`, `max = min * 10`, `jitter = true`, `_current = Math.min(_current + delay, max)`) used for main window reload backoff (`1000..20000ms`) and `NtpClock` sync (`30000..900000ms`).
  - Bundled `@sentry/browser` / `@sentry/electron` includes Sentry's own `X-Sentry-Rate-Limits` and `Retry-After` parser strictly for Sentry error/envelope transport.
- **Remote / Absent locally (0 matches in scan):**
  - 0 hits for `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`, `X-RateLimit-Bucket`, `X-RateLimit-Global`, `X-RateLimit-Scope`, or `x-ratelimit-`.
  - Discord API route-bucket hash tracking, `X-RateLimit-*` header parsing, preemptive bucket queuing, global rate-limit locking, and HTTP `429` `Retry-After` backoff live completely in the **remote web bundle**.

### 4.4 State & Caching
- **Present locally:**
  - `settings.json` (`appSettings` class `41995` in `app.asar\bundle.js`): mtime-checked JSON file in `userData`, accessed by renderer via `SETTINGS_GET` / `SETTINGS_GET_SYNC` / `SETTINGS_SET` (allowlist-gated). Stores desktop preferences (`WEBAPP_ENDPOINT`, `API_ENDPOINT`, `WINDOW_BOUNDS`, hardware accel, debug flags).
  - `userDataCache.json` & `domainMigrated` (`core.asar\bundle.js` `@147486`): opaque JSON blob persisted via `DISCORD_USER_DATA_CACHE_{GET,SAVE,DELETE}`; also governs `discordapp.com` -> `https://discord.com` domain selection when `WEBAPP_ENDPOINT` loads.
  - `safeStorage` IPC (`core.asar` `@140709`): synchronous bridge to Electron `safeStorage.isEncryptionAvailable()`, `encryptString()` (base64), and `decryptString()`.
  - Host directories (`app.asar\bundle.js` module `17424` / `paths`): `userData`, versioned dir, `module_data`, `discord_asset_cache`, `logs`, `quotes.json`.
  - Chromium session cache (`core.asar` `@185727`): collects HTTP cache (`session.getCacheSize()`) and shared dictionary stats (`session.getSharedDictionaryUsageInfo()`), and clears `shadercache` + `clearCodeCaches({})` on main window launch unless disabled via `DESKTOP_TTI_REMOVE_*` flags.
- **Remote / Absent locally:**
  - Zero local domain models or Flux/store definitions for `guilds`, `channels`, `users`, `members`, `messages`, or `presences` exist in `app.asar`, `core.asar`, or `modules\`. Entity state and IndexedDB/memory caching are managed wholly by the **remote web bundle**.

---

## 5. Explicit Gaps & Unknowns

1. **Remote Web Bundle Opaque Locally:** The actual production client implementation (Gateway WS driver, REST client, Discord `X-RateLimit-*` bucket scheduler, Flux/Redux caches) is served dynamically at runtime from `https://discord.com/app` (not stored in `app.asar` or `core.asar`) and was not fetched/executed.
2. **Native `.node` Code Bodies:** `discord_erlpack.node`, `discord_zstd.node`, `updater.node`, etc. are compiled PE `native-addon` binaries (`discord_erlpack.node` verified `pe32-plus` / `not-managed`; PE ASCII strings indicate C++ for `erlpack` and Rust `bindings.rs` for `discord_zstd`). Without `ghidra` or `hopper`, internal native control flow beyond JS wrappers, PE metadata, and static ASCII strings remains uninspected.
3. **Modified Electron Binary:** `Discord.exe` exposes non-standard switches/hooks visible from JS (`--enable-node-leakage-in-renderers`, `--enable-native-premap`, `electron.discordMemoryProfiler`); internal Chromium/Electron C++ patches were not disassembled.

---

## 6. Design Implications for Phase 2–3 (Standalone TypeScript Bot API v10 Daemon + CLI)

Because Discord Desktop delegates all messaging protocol logic to a remote browser bundle and uses user-session mechanisms unsuitable for CLI automation, our Phase 2–3 architecture will build an independent, self-contained **TypeScript Bot API v10 Daemon + CLI** running cleanly on Node without Electron:

1. **Authentication & Security Isolation:**
   - Authenticate exclusively with a Discord **Bot Token** (`Authorization: Bot <token>`) sourced from `DISCORD_BOT_TOKEN` (or dedicated CLI config), never touching `AppData\Roaming\Discord` or `userDataCache.json`.
2. **WebSocket Gateway Manager (`wss://gateway.discord.gg/?v=10&encoding=json`):**
   - Bootstrap URL via `GET /api/v10/gateway/bot` (falls back gracefully / honors `session_start_limit`).
   - Optionally negotiate `compress=zlib-stream` (Node built-in `node:zlib` inflate context — matching Discord Desktop's stateful stream-per-connection pattern without needing native `.node` bindings) or clean JSON framing.
   - Implement exact v10 lifecycle state machine: `Op 10 Hello` -> jittered initial heartbeat (`heartbeat_interval * Math.random()`) + interval -> strict `Op 11 Heartbeat ACK` tracking (treat missed ACK as zombie connection and reconnect/resume), `Op 2 Identify` with explicit Bot Gateway Intents bitmask & `os`/`browser`/`device` properties, `Op 6 Resume` targeting stored `resume_gateway_url` + `session_id` + last sequence `s`, `Op 7 Reconnect` immediate reconnect, and `Op 9 Invalid Session` (`d: true` -> resume, `d: false` -> clear session + backoff before fresh Identify).
   - Emit typed `Op 0 Dispatch` events (`READY`, `GUILD_CREATE/UPDATE/DELETE`, `CHANNEL_CREATE/UPDATE/DELETE`, `MESSAGE_CREATE/UPDATE/DELETE`, `MESSAGE_REACTION_*`) into the local state store.
3. **REST Client Pipeline (`https://discord.com/api/v10`):**
   - Native Node `fetch` / `undici` HTTP client targeting `https://discord.com/api/v10`, injecting `Authorization: Bot <token>`, compliant `User-Agent: DiscordBot (...)`, `Content-Type: application/json` (or `multipart/form-data` for attachments when needed), and structured error mapping (`code`, `message`, `errors`).
   - Support core v10 resources cleanly: guilds, channels, messages (send/list/edit/delete), and reactions (put/delete/list URL-encoded emoji).
4. **Standard Rate-Limit Compliance Engine:**
   - Maintain an in-memory **per-major-route -> `X-RateLimit-Bucket` hash** map (keyed by HTTP method + canonical route + major params `guild_id`/`channel_id`/`webhook_id`) plus per-bucket FIFO async queues and a shared global-limit gate.
   - Track `X-RateLimit-Remaining`, `X-RateLimit-Reset-After` (prefer server relative delta to avoid local clock skew), `X-RateLimit-Bucket`, `X-RateLimit-Global`, and `X-RateLimit-Scope` (`user` / `global` / `shared`).
   - Preemptively pause queued requests when `remaining === 0` until `reset_after` elapses; on `HTTP 429`, serialize retries honoring `Retry-After` / body `retry_after` (pausing *all* non-exempt queues if `global === true`).
5. **Local State Cache & Daemon/CLI IPC Boundary:**
   - Mirror Discord Desktop's separation between host process and UI/client via a persistent **local daemon** holding authoritative in-memory caches (`guilds`, `channels`, `dmChannels`, `users`, `botUser`, bounded recent `messages` LRU per channel) kept live by Gateway `Op 0` dispatches (`READY`, `GUILD_CREATE` hydration, incremental `*_UPDATE`/`*_DELETE`).
   - Expose a fast local control boundary between the CLI and daemon (e.g., loopback HTTP JSON API or Windows named pipe `\\?\pipe\discord-cli-*` / Unix socket — conceptually analogous to `discord_rpc`'s `RPCIPC` / `RPCWebSocket` transport isolation) so repeated CLI commands (`guilds`, `channels`, `messages`, `send`, `react`, `status`) read warm cached state and enqueue rate-limited REST writes without spawning a new Gateway session per invocation.
