# BrowserForce — Agent Guidelines

## Local Private Overrides

@AGENTS.local.md

## Project Overview

BrowserForce bridges AI agents to a user's real Chrome browser via a transparent CDP proxy. Three components: **relay server** (Node.js CDP proxy), **Chrome extension** (MV3 service worker using `chrome.debugger`), and **MCP server** (exposes Playwright-based tools via Model Context Protocol).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         AI Agent Layer                               │
│                                                                      │
│  ┌─────────────────────────────┐  ┌───────────────────────────────┐ │
│  │  MCP Client (Claude, etc.)  │  │  Direct Playwright Client     │ │
│  │  Uses execute/reset tools    │  │  chromium.connectOverCDP()    │ │
│  └──────────┬──────────────────┘  └──────────┬────────────────────┘ │
│             │ MCP/stdio                      │ CDP/WebSocket        │
└─────────────┼────────────────────────────────┼──────────────────────┘
              │                                │
              ▼                                │
┌──────────────────────────────────┐           │
│  MCP Server (mcp/src/index.js)   │           │
│  - 3 tools: execute + help + reset │        │
│  - Playwright-core CDP client    ├───────────┘
│  - Auto-discovers relay token    │
└──────────────┬───────────────────┘
               │ CDP over WebSocket
               ▼
┌──────────────────────────────────┐
│  Relay Server (relay/src/index.js)│
│  - ws://127.0.0.1:19222          │
│  - /extension (single ext slot)  │
│  - /cdp?token=... (agent side)   │
│  - Intercepts Target.* commands  │
│  - Forwards all else to ext      │
│  - Tracks sessions + children    │
└──────────────┬───────────────────┘
               │ WebSocket
               ▼
┌──────────────────────────────────┐
│  Chrome Extension (MV3 SW)       │
│  - background.js service worker  │
│  - chrome.debugger.attach/send   │
│  - Auto-reconnect + keepalive    │
│  - Tab lifecycle tracking        │
└──────────────┬───────────────────┘
               │ chrome.debugger API
               ▼
┌──────────────────────────────────┐
│  Real Chrome Browser             │
│  - User's logged-in sessions     │
│  - All cookies and localStorage  │
│  - Real tabs with real content   │
└──────────────────────────────────┘
```

## Protocol Reference

### Extension ↔ Relay Messages

**Relay → Extension (commands):**

| Method | Params | Description |
|--------|--------|-------------|
| `listTabs` | — | List all eligible browser tabs |
| `attachTab` | `{ tabId, sessionId }` | Attach debugger to tab |
| `detachTab` | `{ tabId }` | Detach debugger |
| `createTab` | `{ url, sessionId, windowId? }` | Create and attach new tab (optional `windowId` pins the agent's window) |
| `closeTab` | `{ tabId }` | Close tab |
| `cdpCommand` | `{ tabId, method, params, childSessionId? }` | Forward CDP command |
| `ping` | — | Keepalive (every 5s) |

**Extension → Relay (events):**

| Method | Params | Description |
|--------|--------|-------------|
| `cdpEvent` | `{ tabId, method, params, childSessionId? }` | CDP event from debugger |
| `tabDetached` | `{ tabId, reason }` | Tab lost debugger |
| `tabUpdated` | `{ tabId, url?, title? }` | Tab URL/title changed |
| `pong` | — | Keepalive response |

**Responses** (to commands with `id`):

```json
{ "id": 1, "result": { ... } }
{ "id": 1, "error": "message" }
```

### CDP Commands Intercepted by Relay

These are NOT forwarded to the extension — handled locally:

| Command | Relay Behavior |
|---------|---------------|
| `Browser.getVersion` | Returns synthetic version |
| `Browser.setDownloadBehavior` | No-op `{}` |
| `Target.setDiscoverTargets` | Emits `targetCreated` for known targets |
| `Target.setAutoAttach` | Responds `{}`, then auto-attaches all tabs async |
| `Target.getTargets` | Returns from local cache |
| `Target.getTargetInfo` | Returns from local cache |
| `Target.attachToTarget` | Returns existing sessionId from cache |
| `Target.createTarget` | Creates tab via extension |
| `Target.closeTarget` | Closes tab via extension |

Everything else → forwarded to extension as `cdpCommand`.

## Critical Patterns

### Runtime.enable Trick

When Playwright sends `Runtime.enable`, the extension must call `Runtime.disable` → 50ms sleep → `Runtime.enable` to force Chrome to re-emit `executionContextCreated` events. Without this, Playwright hangs waiting for contexts.

**Location**: `extension/background.js`, `cdpCommand()` function.

### MV3 Service Worker Keepalive

Chrome kills MV3 service workers after ~30s of inactivity. The relay sends `ping` every 5 seconds. The extension responds with `pong`. Backup: `chrome.alarms` at 30-second intervals wakes the worker for reconnection.

### Lazy Debugger Attachment

When the agent sends `Target.setAutoAttach`, the relay responds with `{}` immediately, lists all tabs from the extension, and sends `Target.attachedToTarget` events — but does NOT call `chrome.debugger.attach()` on any tab. The debugger is attached lazily on the first CDP command targeting that tab via `_ensureDebuggerAttached()`. This avoids attaching debuggers to 50+ tabs at once (each consuming Chrome memory and showing the automation infobar). Race-safe via `attachPromise` per target.

**Location**: `relay/src/index.js`, `_autoAttachAllTabs()`, `_ensureDebuggerAttached()`, `_forwardToTab()`.

### INIT_ONLY_METHODS Interception

Playwright eagerly sends ~40 init-only CDP commands to every page it learns about via `Target.attachedToTarget`. Without interception, this would trigger eager debugger attachment on all tabs. The relay intercepts these commands (in `INIT_ONLY_METHODS` set) and returns synthetic responses without calling `chrome.debugger.attach()` — but **only while the tab is unattached**. Once the debugger is attached, every init-only command is forwarded for real.

Key methods: `Runtime.enable/disable`, `Page.enable/disable`, `Page.getFrameTree`, `Page.createIsolatedWorld` (the eager-attach trigger while unattached), `Page.addScriptToEvaluateOnNewDocument`, plus ~35 more Network/Fetch/Emulation/Security commands.

**`Page.createIsolatedWorld` must be forwarded on attached tabs.** Playwright fires it via `_sendMayFail` and discards the response; the utility world (which every locator action — `fill`/`click`/`waitFor` — runs in) is registered only via the resulting `Runtime.executionContextCreated` event. Synthesizing the response on an attached tab silently starves the page of its utility world and every locator action hangs until a navigation. Never re-add an "always synthetic" set for it.

Forwarded init-only commands are tagged `passive: true` in the `cdpCommand` payload so the extension does not count them as tab activity (see Durable Auto-Close below).

**Location**: `relay/src/index.js`, `INIT_ONLY_METHODS`, `syntheticInitResponse()`, `_forwardToTab()`.

### browserContextId Requirement

Playwright's `CRBrowser._onAttachedToTarget` asserts `targetInfo.browserContextId` must be truthy. All relay-synthesized `targetInfo` objects must include `browserContextId: DEFAULT_BROWSER_CONTEXT_ID`. `Target.getBrowserContexts` must return `[DEFAULT_BROWSER_CONTEXT_ID]`.

**Location**: `relay/src/index.js`, `DEFAULT_BROWSER_CONTEXT_ID = 'bf-default-context'`.

### OOPIF / Child Session Routing

Cross-origin iframes create child CDP sessions. The extension tracks `childSessions` (Chrome sessionId → parent tabId). The relay maps child session events to the parent page's relay sessionId for correct Playwright frame tree construction.

### Debugger Detach Cascade

When a user clicks "Cancel" on Chrome's automation infobar, Chrome detaches the debugger from **ALL** tabs (reason: `canceled_by_user`). The extension must clear all attached tab state, not just one tab.

### Agent Window Affinity

Agent-created tabs are pinned to the Chrome **window** the agent first worked in, not the user's current focus. The relay seeds `agentWindowByAffinityKey` from the `windowId` of the first real (non-init) command in `_forwardToTab()`, then passes that `windowId` to `createTab`. The extension validates the window still exists (`chrome.windows.get`) and, if it was closed, falls back to the current focused window; the relay re-pins to whatever window the extension actually used. Window resolution is centralized in the pure, synchronous `extension/window-affinity.js` `resolveCreateWindowPlan()`, which returns a `{ action }` plan (`use-window` / `new-window` / `current-window`) that `createTab` executes.

**Affinity keying (label-durable):** the map key is `label:<explicit label>` when the client connected with an explicit `?label=` query param (MCP sends `label=browserforce-mcp`), else the ephemeral connection id. Label-keyed pins **survive disconnects** — this is what stops MCP's 15s idle-disconnect/reset cycle from spawning a new dedicated window per reconnect. Connection-keyed pins are deleted on client close. Only *explicit* labels are durable: `_deriveClientLabel()` always returns a display label (UA fallbacks like `cdp-client`), which must never key durable affinity — durability is decided by `meta.affinityLabel` from `_explicitClientLabel(req)`. Consequence (deliberate): two clients sharing a label share an agent window. Leak guard: `MAX_AFFINITY_ENTRIES = 50`, FIFO eviction via `_pinAgentWindow()`.

**Do not** treat the current Chrome focus as stable agent ownership — use the stored `windowId`. Residual limitation: with truly concurrent first creates (the user changing focus between two extension-handled creates) tabs can land in different windows; affinity still resolves deterministically to the first established window. Playwright awaits `newPage()` sequentially, so no per-client serialization queue is added.

**Dedicated window (opt-in):** When the `dedicatedWindow` setting (popup toggle) is on and a create has no valid pinned window, `resolveCreateWindowPlan()` returns `{ action: 'new-window' }` and the extension opens a fresh **background** (`focused: false`) Chrome window for the agent's created tabs, instead of a tab in the user's current window. Affinity then pins to that window so later created tabs join it. If the dedicated window is closed mid-session, the next create spawns a **new** dedicated window rather than falling back to the user's window. Scope is agent-**created** tabs only — manually attached tabs are never moved. Default is OFF.

### Durable Auto-Close (agent tab bookkeeping)

Auto-close/auto-detach state must survive MV3 service worker restarts and Playwright's reconnect init storm:

- **Persistence**: `agentCreatedTabs` + `tabLastActivity` are checkpointed to `chrome.storage.session` under `AUTO_MANAGE_STATE_KEY` (`persistAutoManageState()` / `hydrateAutoManageState()` in `extension/background.js`). Session storage survives SW restarts and dies with the browser — the correct lifetime. Membership changes persist immediately; the activity clock checkpoints once per `checkInactiveTabs()` sweep, never per CDP command.
- **Passive flag contract**: the relay tags forwarded `INIT_ONLY_METHODS` `cdpCommand` payloads with `passive: true`; the extension skips the `tabLastActivity` bump for them. Only real commands count as activity. The flag is optional — old relay/extension pairings degrade to the previous behavior.
- **Provenance no-demote**: `agent-created` origin must never be demoted to `relay-attached` (that would exempt the tab from auto-close). The extension surfaces `origin: 'agent-created'` in `listTabs` for hydrated agent tabs; the relay accepts it in `_autoAttachAllTabs()` discovery (never `manual` from discovery) and `_ensureDebuggerAttached()` preserves `manual`/`agent-created` on lazy attach. `attachTab` re-registers agent-created tabs into `agentCreatedTabs`.
- **Alarm-driven sweep**: the `bf-reconnect` alarm also runs `checkInactiveTabs()` — `setInterval` dies with the SW; alarms don't.
- **Observability**: `GET /attached-tabs` exposes `lastCommandAt`/`idleMs` per tab (real, non-init activity as seen by the relay).

### Test Isolation: writeCdpUrl Flag

`RelayServer.start()` accepts `{ writeCdpUrl: false }` to prevent test instances from clobbering `~/.browserforce/cdp-url`. **All test `relay.start()` calls must pass `{ writeCdpUrl: false }`** or the production cdp-url file gets overwritten with random test ports.

### Client Arbitration: BF_CLIENT_MODE

`BF_CLIENT_MODE` controls agent-side CDP arbitration:
- `multi-client` (default): allows concurrent `/cdp` clients.
- `single-active`: opt-in mode that allows only one active `/cdp` client connection at a time.

In `single-active`, contention returns HTTP `409 Conflict` for additional `/cdp` connects while the slot is busy. Slot state is exposed at `GET /client-slot` (`mode`, `busy`, `activeClientId`, `connectedAt`).

### MCP Standby Polling

MCP handles `409`/busy connect errors by entering standby and polling `GET /client-slot` with short jittered intervals (~200-400ms), then reconnecting when `busy: false` (up to a 30s connect timeout).

### BrowserForce Agent Session Identity (No Fixed ID)

For side-panel chat UX, **never hardcode or assume a fixed `sessionId`**.

- Sessions are user-selectable conversation threads (ChatGPT/Atlas style).
- The UI must list prior sessions and let the user resume any session.
- New chats must create a new generated session ID (UUID/ULID), then persist metadata + transcript.
- Streaming channels (`/events`) must be scoped by explicit selected `sessionId`.
- Do not infer continuity from "current Codex turn/session" alone; BrowserForce Agent keeps its own session store.

### Codex Provider Session Continuity + Usage Telemetry

For side-panel chat continuity, BrowserForce session metadata stores Codex provider state:

- Persist Codex thread identity at `providerState.codex.sessionId`.
- On each new run, pass that mapping as `resumeSessionId` so runner can invoke `codex exec resume <id> --json`.
- Persist latest context/token telemetry at `providerState.codex.latestUsage`.
- Emit and consume `run.usage` and `run.provider_session` events.
- Side-panel hydrates usage from `GET /v1/sessions/:sessionId` and shows `Context: unavailable` when telemetry is missing.

### Execute Timeout Cancellation

`runCode()` is the single execution boundary for `execute` (MCP) and `-e` (CLI). User code runs inside `node:vm` via `vm.runInContext(..., { timeout })` so a synchronous runaway is interrupted; remaining async work is raced against an outer timeout that calls `run.abort()`. `createRunController()` owns a per-run `AbortController` plus tracked timers; on timeout it aborts the signal (reason: `CodeExecutionTimeoutError`) and clears every pending run-scoped timer, so a continuation suspended on a run `setTimeout` never resumes and cannot mutate `state` afterward.

Exposed BrowserForce helpers and the persistent `state` object are wrapped by `guardObject()` / `guardAsyncFunction()`: a guarded call or property access throws once the run has aborted, so a timed-out snippet cannot keep driving Chrome or mutate `state`. `shouldGuardObject()` only guards "behavioral" values (class instances, or POJOs/arrays exposing methods) so plain-data results (`pluginCatalog()`, `getBrowserforceStatus()`) and the `formatResult()` Buffer/labeled-screenshot contract stay raw. `state` is force-guarded and its writes store the **unwrapped** value, so a timed-out run never persists a run-bound proxy onto `state` and poisons the next run that reads it.

- **Rule**: Any new helper exposed inside `buildExecContext()` must either be left for `runCode()` to wrap with the run guard, or explicitly observe `executeSignal` / `throwIfExecutionAborted` while it polls or waits (use the private `abortableDelay(ms, signal)` for internal waits). Never add a raw `Promise.race()` timeout wrapper around `runCode()` at a caller — it leaves losing async work alive.
- **Rule**: Keep built-in constructors/utilities (`URL`, `URLSearchParams`, `Buffer`, `TextEncoder`, `TextDecoder`, `setTimeout`, `clearTimeout`) in `RAW_CONTEXT_BUILTINS` so they are never proxied — wrapping a constructor breaks `new URL(...)` and drops statics like `Buffer.from`.
- **Limitation (raw top-level handles)**: Top-level `page` and `context` are intentionally left **raw** (not guarded) because they are identity-sensitive Playwright handles — a proxy breaks `context.pages().includes(page)` and private-field getters. The fence therefore covers run-scoped timers, guarded BrowserForce helpers, the guarded `state`, and guarded stored/returned handles (`state.page`, helper-returned handles). A snippet that resumes after awaiting a **raw top-level `page`/`context`** operation can still issue one further Chrome command by design; the guarantee is scoped to BrowserForce-controlled continuations, not to rolling back an already-issued CDP command. Guard `page`/`context` only if a browser-level repro requires it, and add identity/regression tests first (the Task 7 repro uses a guarded stored handle, so it does not).
- **Limitation (sync CPU loop after `await`)**: `vm.runInContext(..., { timeout })` bounds only the **synchronous window up to the first `await`** (so `while (true) {}` is interrupted). A CPU-bound synchronous loop scheduled **after** an `await` (e.g. `await Promise.resolve(); while (true) {}`) runs as a microtask the vm `timeout` does not bound and can block the event loop so the outer abort timer never fires. Interrupting that requires worker/isolate execution, a deliberate Non-Goal. Do **not** "fix" it with `vm.createContext(..., { microtaskMode: 'afterEvaluate' })`: that breaks host-promise awaits (every real `await page.*()` would never resume and would time out).
- **Location**: `mcp/src/exec-engine.js` — `runCode()`, `createRunController()`, `createRunTimers()`, `guardObject()`, `shouldGuardObject()`, `abortableDelay()`.

## Accessibility Snapshot Engine

- **Rule**: The snapshot tree comes from `mcp/src/aria-snapshot-engine.js` (CDP `Accessibility.getFullAXTree` + `DOM.getFlattenedDocument`, cross-referenced by `backendNodeId`). There is **no DOM-walker fallback** — an empty AX tree throws a descriptive error after one retry. `mcp/src/snapshot.js` keeps only shared constants/helpers + `createSmartDiff`/`parseSearchPattern`.
- **Rule**: Send `Accessibility.enable` **before** `DOM.enable`. `DOM.enable` is in the relay's `INIT_ONLY_METHODS` and no-ops on a not-yet-attached tab; AX enable forces the lazy `chrome.debugger.attach()` first. Fetch DOM + AX from the **same** session (backendNodeIds are per-process).
- **Rule**: Interaction refs keep the `- role "name" [ref=eN]` line contract (`renderRefLines`). Act on a ref with `locatorForRef({ ref })` (frame-aware Playwright `Locator`, pierces `frameChain`); `refToLocator({ ref })` returns the top-frame locator string. The CDP-accurate locator is also shown in the snapshot's "Ref → Locator" table. `EXECUTE_PROMPT` is unchanged.
- **Rule**: Only **interactive** roles get refs/labels (incl. the screenshot label overlay). Context roles (`main`, `nav`, …) are structure-only lines.
- **Rule**: Subframe scoping — `context.newCDPSession(frame)` is **OOPIF-only**; same-origin frames throw, so fall back to the page session and scope via a `data-pw-scope` attribute. OOPIF AX additionally needs the relay to resolve the frame's `Target.attachToTarget` to the existing child sessionId.
- **Rule**: Full-page `snapshot()` (no explicit `frame`/`locator`) **stitches** subframe content: each `<iframe>`/`<frame>` is a leaf in the main tree, every subframe is (re)assembled once into a single shared `refCtx`, then stitched under its owner leaf by `backendNodeId` and finalized once. In-frame refs carry a `frameChain` so `locatorForRef` pierces via `frameLocator`. Explicit `frame`/`locator` keeps single-region behavior (empty `frameChain`).
- **Rule**: Full-page degradation is **visible, never silent**. A first-level OOPIF that fails to acquire/fetch (relay target-resolution error, detach, enable failure) or is empty after retry is **best-effort skipped** — one flaky/blank cross-origin subframe must not nuke the whole-page snapshot — but recorded in `getAriaSnapshot`'s `frameErrors` and surfaced via `renderFrameErrors` as a `⚠️ N subframe(s) not stitched` block. Callers can then retry, wait, or scope the frame explicitly (explicit `frame` scope still **throws** on failure). **Limitation**: owners are matched only in the page-process DOM, so one level of OOPIF is stitched; iframes nested inside an OOPIF are skipped (their owner is not in the page DOM, so they are not recorded as errors).
- **Why**: `backendNodeId` anchoring gives stable refs, subtree scoping, and cross-origin iframe reach that the old JS DOM walk could not.

### CLI Session Daemon & Backend Selection

The CLI ships a persistent session daemon (`cli/sessiond.js`, client in
`cli/session-client.js`) so atomic verbs (`snapshot --sessiond`, `click`,
`fill`, `type`, `press`, `wait`, `get`, `eval`) share one browser session and
its snapshot refs across separate CLI invocations. It mirrors the relay's
security contract: binds `127.0.0.1` only, random 32-byte bearer token in a
`0o600` lock/url sidecar, `Authorization: Bearer` on every state route, and
`/health` is the only unauthenticated route (leaks no secret). Every verb routes
through the shared `runtime.runCommand()` → `runCode()` guarded boundary — the
exact same vm boundary as MCP `execute` and one-shot `-e`. Never `eval()` /
`new Function()` user input at the caller; pass it as the snippet.

Backend policy (`mcp/src/backend-selection.js`, negotiated in
`cli/sessiond.js#negotiateBackend`) is **real-Chrome-first**:

- **Real Chrome remains primary.** `auto` (default) connects to the user's real
  Chrome via the relay + extension whenever the extension is connected.
- **The managed fallback warning is mandatory — never silent.** When `auto`
  falls back to managed/headless Chrome, the daemon records and surfaces a
  warning (`/status` `warning` field, CLI stderr).
- **`--real` / `BF_BROWSER_BACKEND=real` never falls back.** It fails loud
  (non-zero exit, no lock written) when the bridge is unavailable. Negotiation
  runs BEFORE the lock is published so a failed `real` request leaves no daemon.
- **The installed BrowserForce skill stub (`skills/browserforce/SKILL.md`) must
  NOT use `hidden: true`.** Deliberate divergence from agent-browser: OpenCode
  can filter hidden installed skills out entirely, which would hide the
  `skills get core` redirect from the model. Runtime skill content lives in
  `skill-data/` and is served by `browserforce skills get|list|path`.

## Security Rules

- Relay binds to `127.0.0.1` ONLY. Never `0.0.0.0`.
- Extension WS validates `Origin: chrome-extension://`. Reject all others.
- CDP clients require auth token in query param. Token is random 32 bytes (base64url).
- Token file permissions: `0o600` (owner read/write only).
- Single extension slot. Second extension connection gets HTTP 409.

## Operational Non-Goals

- No new dependencies for client arbitration or standby behavior.
- No per-tab ownership model; arbitration is one relay-level client slot.
- No extension protocol changes for this feature area.

## Development Workflow

### Commands

```bash
pnpm relay              # Start relay server (port 19222, kills stale process first)
pnpm relay:dev          # Start with --watch
pnpm mcp                # Start MCP server (stdio)
pnpm test               # All tests
pnpm test:relay         # Relay server unit + integration tests
pnpm test:mcp           # MCP server tests
```

### Making Changes

1. **Relay changes**: Edit `relay/src/index.js`, restart with `pnpm relay:dev` (auto-reload)
2. **Extension changes**: Edit `extension/background.js`, reload at `chrome://extensions/` (click refresh icon)
3. **MCP changes**: Edit `mcp/src/index.js`, restart the MCP client (Claude Desktop, etc.)

### Code Review Checklist

When reviewing changes to this project:

- [ ] **Security**: Relay still binds 127.0.0.1 only? Token validation intact? Origin check on extension WS?
- [ ] **CDP compliance**: Does the change break Playwright's expected CDP handshake?
- [ ] **Session tracking**: Are all Maps (targets, tabToSession, childSessions) updated consistently?
- [ ] **Error paths**: Do errors clean up state? Do pending commands get rejected?
- [ ] **MV3 safety**: Will this survive service worker termination + restart?
- [ ] **No new dependencies** without justification (relay is intentionally minimal: just `ws`)

## Key Files Quick Reference

| File | Lines | Purpose |
|------|-------|---------|
| `relay/src/index.js` | ~800 | `RelayServer` class — CDP proxy, session management, HTTP endpoints |
| `extension/background.js` | ~430 | Service worker — WS connection, `chrome.debugger` bridge, reconnection |
| `extension/manifest.json` | 20 | MV3 manifest — permissions: debugger, tabs, storage, alarms |
| `extension/popup.html/js/css` | ~100 | Status UI — connection state, relay URL config, available tabs list |
| `mcp/src/index.js` | ~300 | MCP server — execute + help + reset tools via Playwright-core `connectOverCDP` |

## Agent Roles

### Explore Agent
Use for: finding where a specific CDP command is handled, tracing session routing, understanding state flow.

### Code Review Agent
Focus on: security boundaries (token/origin validation), session state consistency, error cleanup paths, MV3 service worker compatibility.

### Test Runner Agent
Run with: `node --test relay/test/relay-server.test.js` and `node --test mcp/test/mcp-tools.test.js`. Report failures with full context.

## Gotchas for AI Agents

1. **Relay auto-starts on require**: `relay/src/index.js` auto-starts the server when run directly. For testing, use `require.main === module` guard — the module exports `RelayServer` for programmatic use.

2. **MCP server is ESM**: `mcp/` uses `"type": "module"`. Cannot `require()` it. Use `import()` or test as subprocess.

3. **Extension code can't be unit-tested directly**: It uses Chrome APIs (`chrome.debugger`, `chrome.tabs`, etc.) that don't exist outside Chrome. Test extension logic indirectly via relay integration tests.

4. **Tab indices are unstable**: Closing tab 0 shifts all subsequent indices down. Always call `context.pages()` to get the current list before targeting a tab by index.

5. **Relay port collision**: Default port 19222. If tests fail with EADDRINUSE, kill stale processes: `lsof -ti:19222 | xargs kill -9`.

6. **Test writeCdpUrl**: Never call `relay.start()` in tests without `{ writeCdpUrl: false }` — it overwrites the production cdp-url file.

7. **No fixed chat session IDs**: BrowserForce Agent chat must always use explicit user-selected/generated session IDs and persisted session history. Never bind side-panel chat to a single hardcoded ID.
