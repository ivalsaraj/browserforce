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
│  │  Uses browserforce/exec     │  │  chromium.connectOverCDP()    │ │
│  └──────────┬──────────────────┘  └──────────┬────────────────────┘ │
│             │ MCP/stdio                      │ CDP/WebSocket        │
└─────────────┼────────────────────────────────┼──────────────────────┘
              │                                │
              ▼                                │
┌──────────────────────────────────┐           │
│  MCP Server (mcp/src/index.js)   │           │
│  - 4 tools: browserforce + exec  │           │
│    + reset + help                │           │
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
| `createTab` | `{ url, sessionId, windowId?, ownerKey? }` | Create and attach new tab (`windowId` pins the agent's window; `ownerKey` records the owning agent) |
| `closeTab` | `{ tabId, ownerKey? }` | Close tab (refused when `ownerKey` names a different agent than the tab's owner) |
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

When the agent sends `Target.setAutoAttach`, the relay responds with `{}` immediately, lists all tabs from the extension, and sends `Target.attachedToTarget` events — but does NOT call `chrome.debugger.attach()` on any tab. The debugger is attached lazily on the first CDP command targeting that tab via `_ensureDebuggerAttached()`. This avoids attaching debuggers to 50+ tabs at once (each consuming Chrome memory and showing the automation infobar). Race-safe via `attachPromise` per target. `attachPromise` is cleared in a `finally` — a failed `attachTab` (e.g. frozen tab, extension timeout) must NOT leave a rejected promise on the target, or every later command would instantly re-throw the stale error until relay restart (rediscovery preserves `attachPromise`); clearing lets the next real command retry the attach.

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

Agent-created tabs are pinned to the Chrome **window** the agent created them in, not the user's current focus. The relay seeds `agentWindowByAffinityKey` from the `windowId` of the first real (non-init) command in `_forwardToTab()` as a **weak** pin, which is never passed to `createTab`; only a pin a create actually established is sent. The extension validates the window still exists (`chrome.windows.get`) and, if it was closed, falls back to the current focused window; the relay re-pins to whatever window the extension actually used. Window resolution is centralized in the pure, synchronous `extension/window-affinity.js` `resolveCreateWindowPlan()`, which returns a `{ action }` plan (`use-window` / `new-window` / `current-window`) that `createTab` executes.

**Affinity keying (label-durable):** the map key is `label:<explicit label>` when the client connected with an explicit `?label=` query param (MCP sends `label=browserforce-mcp-<8 hex>`), else the ephemeral connection id. Label-keyed pins **survive disconnects** — this is what stops MCP's 15s idle-disconnect/reset cycle from spawning a new dedicated window per reconnect. Connection-keyed pins are deleted on client close. Only *explicit* labels are durable: `_deriveClientLabel()` always returns a display label (UA fallbacks like `cdp-client`), which must never key durable affinity — durability is decided by `meta.affinityLabel` from `_explicitClientLabel(req)`. Consequence (deliberate): two clients sharing a label share an agent window. Leak guard: `MAX_AFFINITY_ENTRIES = 50`, FIFO eviction via `_pinAgentWindow()`.

**Pin provenance:** affinity entries are `{ windowId, strength }`. `strength: 'created'` means a window a `createTab` actually used; `strength: 'discovered'` means a window merely seeded from the first real command on some tab — which may be the USER's. **Only `created` pins are sent to the extension as a create target.** A create always re-pins (`_pinAgentWindow(key, id, 'created')`) with no guard: the previous `sentPinned || !has(key)` guard skipped the re-pin whenever a real command seeded affinity DURING the `createTab` round-trip, so the dedicated window was never recorded and every later create fell into the seeded user window. A weak pin never overwrites a strong one.

**Dedicated-window provenance:** a `created` pin is NOT automatically an agent window — a pin established while `dedicatedWindow` was OFF names the user's own window and stays valid when the setting is later switched ON. The relay cannot tell the two apart, so the extension tracks the windows it opened as dedicated (`dedicatedWindowIds`, persisted under `AUTO_MANAGE_STATE_KEY`, pruned on `chrome.windows.onRemoved` and at hydrate) and `resolveCreateWindowPlan()` takes `isRequestedWindowDedicated`: while dedicated mode is on, a valid pinned window is reused ONLY when the extension opened it as dedicated. Do not "simplify" this away — without it, agent tabs keep landing in the user's window with the setting ON.

**Per-agent windows:** MCP sends a per-process label (`browserforce-mcp-<8 hex>`, `mcp/src/client-label.js`), unique across concurrent agents and stable within a process so the 15s idle-reconnect reuses the same window. `BROWSERFORCE_CDP_CLIENT_LABEL` overrides it — that is how two agents deliberately share one window. The helper lives outside `index.js` because `index.js` calls `main()` at import time.

**Do not** treat the current Chrome focus as stable agent ownership — use the stored `windowId`. Residual limitation: with truly concurrent first creates tabs can land in different windows; a create now re-pins unconditionally, so the last completing create's window wins. Playwright awaits `newPage()` sequentially, so no per-client serialization queue is added.

**Dedicated window (default ON):** When the `dedicatedWindow` setting (popup toggle) is on and a create has no valid pinned window, `resolveCreateWindowPlan()` returns `{ action: 'new-window' }` and the extension opens a fresh **background** (`focused: false`) Chrome window for the agent's created tabs, instead of a tab in the user's current window. Affinity then pins to that window so later created tabs join it. If the dedicated window is closed mid-session, the next create spawns a **new** dedicated window rather than falling back to the user's window. Scope is agent-**created** tabs only — manually attached tabs are never moved. Default is **ON**; an unset setting reads as enabled.

### Tab Identity Survives Reconnect

Handles (`t<N>`) and names are keyed by **relay target id**, not by Playwright
`Page` identity. Playwright rebuilds every `Page` object when the idle
disconnect drops the CDP connection, so a `Page`-keyed map renumbers every
handle and deletes every name on each reconnect — and an agent acting on a
stale handle hits the WRONG TAB silently. `mcp/src/tab-identity.js`
(`matchPagesToTargets`) pairs a page to a relay target **only when the URL is
unique on both sides**. There is no positional tie-breaking: that would assume
`ctx.pages()` and the relay target list share an insertion order, which is
unproven, and if it were ever false two tabs showing the same page would swap
handles silently. Tabs the matcher leaves unpaired are then resolved EXACTLY by
`Target.getTargetInfo` over a per-page CDP session, bounded by
`AMBIGUOUS_RESOLUTION_LIMIT = 8` — a full listing cannot be done that way (the
relay mints an alias session per `Target.attachToTarget`, so 72 tabs would mint
72), but the ambiguous subset is typically zero. Past the cap it degrades to
per-connection handles, which renumber: visible degradation, never a silent
mis-bind. Relay identity is additionally gated on the negotiated backend; a
managed/headless session has no relay.

A Page from a dead connection is **orphaned, not closed** — `isClosed()` returns
`false`. Every identity lookup therefore checks `connectionGeneration` BEFORE
usability; trusting `isUsablePage` alone hands back a handle onto a dead CDP
session.

Titles come from the relay for the same reason `page.title()` is bounded: on a
lazily-attached tab the relay acks `Runtime.enable` synthetically, no execution
context ever arrives, and the read never settles. Never issue an **unbounded**
`page.title()` against a relay-backed tab. `pageTitleBounded()` stays as the
fallback for pages with no relay identity — a managed/headless backend has no
target list, and removing it would leave those sessions untitled. A **stale**
relay snapshot may only confirm identity for a page already known: rematching a
fresh Page against cached targets lets a replacement tab at the same URL inherit
a closed tab's id, handle and title.

The relay's metadata cache is only as fresh as what the extension reports.
`extension/tab-update-policy.js` decides that: url/title changes are reported
for EVERY tab (attachment is lazy, so gating on it froze the cache), by property
PRESENCE not truthiness (a cleared title is `''`), and every close is reported
because the relay drops ids it does not know.

### Per-Client Active Tab

`clientId` (from `BROWSERFORCE_CLIENT_ID`, wire header `X-BrowserForce-Client`,
sanitized `/^[A-Za-z0-9._-]{1,64}$/` at both ends) gives each identified client
its own active tab inside the one shared session. Unidentified clients keep the
shared slot byte-identically — that is what preserves sequential CLI behaviour.
Slots store `{ targetId, page, gen }`; a Page-keyed slot would look dead after a
reconnect and fall back to the SHARED page, i.e. onto another agent's tab. A
slot that cannot rebind stays **blocked** (`page = null`) rather than being
deleted — deleting it puts the cross-agent stomp back one call later.
`state.page` is scoped by `stateViewFor(clientId)`, a proxy over the shared
`userState` that intercepts only `page`; it also scopes `buildExecContext`'s
`activePage()`, which reads `userState.page`. Every other key stays shared.

This is **not** an isolation boundary: `_autoAttachAllTabs` loops the global
target map and every CDP client can still see and drive every tab. Never
document it as a sandbox.

### Durable Auto-Close (agent tab bookkeeping)

Auto-close of agent-created tabs is **ON by default** (10 minutes idle,
`DEFAULT_AUTO_CLOSE_MINUTES` in `extension/agent-defaults.js`); auto-detach stays
off by default. Both are changeable in the popup's Auto-Cleanup section.
`resolveAutoCloseMinutes()` uses an explicit integer check rather than `|| 0`,
which could not distinguish "never chosen" from an explicit **Off** — both read
as `0` and the default would silently override the user's choice.

Auto-close/auto-detach state must survive MV3 service worker restarts and Playwright's reconnect init storm:

- **Persistence shape**: in memory `agentCreatedTabs` is a `Map<tabId, ownerKey|null>`. `AUTO_MANAGE_STATE_KEY` holds four fields: `agentCreatedTabs` (a bare tab-id array — kept in this shape so an older extension build can still hydrate membership after a rollback), `agentTabOwners` (`[tabId, ownerKey]` pairs), `tabLastActivity`, and `dedicatedWindowIds`. Hydration runs through the pure `extension/auto-manage-state.js` helpers, which validate every entry before destructuring: a malformed member previously threw and aborted the whole hydrate, silently disabling auto-close for every restored tab. `agentCreatedTabs` + `tabLastActivity` are checkpointed to `chrome.storage.session` under `AUTO_MANAGE_STATE_KEY` (`persistAutoManageState()` / `hydrateAutoManageState()` in `extension/background.js`). Session storage survives SW restarts and dies with the browser — the correct lifetime. Membership changes persist immediately; the activity clock checkpoints once per `checkInactiveTabs()` sweep, never per CDP command.
- **Passive flag contract**: the relay tags forwarded `INIT_ONLY_METHODS` `cdpCommand` payloads with `passive: true`; the extension skips the `tabLastActivity` bump for them. Only real commands count as activity. The flag is optional — old relay/extension pairings degrade to the previous behavior.
- **Provenance no-demote**: `agent-created` origin must never be demoted to `relay-attached` (that would exempt the tab from auto-close). The extension surfaces `origin: 'agent-created'` in `listTabs` for hydrated agent tabs; the relay accepts it in `_autoAttachAllTabs()` discovery (never `manual` from discovery) and `_ensureDebuggerAttached()` preserves `manual`/`agent-created` on lazy attach. `attachTab` re-registers agent-created tabs into `agentCreatedTabs`.
- **Alarm-driven sweep**: the `bf-reconnect` alarm also runs `checkInactiveTabs()` — `setInterval` dies with the SW; alarms don't.
- **Observability**: `GET /attached-tabs` exposes `lastCommandAt`/`idleMs` per tab (real, non-init activity as seen by the relay).

### Ghost Cursor

The optional ghost cursor is controlled by the local-storage key
`ghostCursorEnabled` and defaults to disabled. `extension/ghost-cursor.js` owns the
renderer, action mapping, and per-tab serialized queue; `extension/background.js`
owns live setting state and debugger lifecycle. Only successful top-level
`Input.dispatchMouseEvent` commands enqueue cosmetic updates, so child sessions,
unsupported input, and failed browser commands cannot affect the cursor. Disable
must complete the renderer teardown and registered-script removal before normal
debugger detach; post-detach cleanup only invalidates queued work and must not send
new debugger commands.

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

### MCP Tool Surface & Shared Command Registry

The MCP server exposes exactly four tools: **`browserforce`** (high-level
command strings), **`exec`** (raw JS escape hatch — the tool formerly named
`execute`), **`reset`**, and **`help`**. Command-first is the taught default;
`exec` is for work the command surface cannot express.

- **Rule**: ALL browser command parsing/execution lives in the shared registry
  `mcp/src/browserforce-command-registry.js` (`parseBrowserforceCommand` /
  `executeBrowserforceCommand` / `executeBrowserforceVerb`). CLI direct verbs
  (`bin.js`), sessiond HTTP verbs (`cli/sessiond.js`), and the MCP
  `browserforce` tool are thin transports over it — never fork command
  semantics per surface. Every command executes through
  `runtime.runCommand()` → `runCode()` (the guarded vm boundary); never call
  raw Playwright APIs from a transport handler.
- **Rule**: Tab identity — stable `t<N>` handles are permanent per page
  (`getStablePageHandle`); names are user labels validated by
  `assertValidTabName` (identifier-like, `t<N>` shape reserved for handles,
  uniqueness enforced, `--replace` moves a name explicitly).
- **Rule**: `--tab <target>` pins the page for THAT run only (per-run
  `pinnedPage` on `buildExecContext`); it must never mutate the persistent
  active tab (`state.page`), which only `use`/`open` (or snippets assigning
  `state.page`) change. The raw `exec` top-level `page` follows the runtime
  active page — never rebind it to `pages()[0]` when an active page exists.
- **Rule**: Command errors are `BrowserforceCommandError` with `code`,
  actionable `suggestion`, and `resetHintAllowed` — reset hints are reserved
  for connection/internal failures, never selector/stale-ref/tab/parse errors.
  Sessiond appends the suggestion to the wire `error` string; keep that.
- **Real-Chrome discipline (100+ tabs)**: never issue an unbounded
  `page.title()` against a lazily-attached tab — the relay synthesizes
  `Runtime.enable`, the JS execution context never arrives, and the promise
  never settles (`.catch()` does not fire). Use the bounded readers
  (`pageTitleBounded` in the runtime, `boundedPageTitle` in exec-engine
  snapshots, the raced `get title` snippet). Initial Playwright page discovery
  streams for seconds at that scale: `waitForInitialPageDiscovery` waits for
  the relay-reported tab count (`/extension/status`) or a stable-count settle,
  bounded by a 5s timeout.

### Process Crash Guard (MCP server + sessiond)

Both long-lived servers that run user snippet code install
`installProcessCrashGuard()` (`mcp/src/process-crash-guard.js`): a detached
promise rejection or a stray sync throw from user exec/eval code must log and
survive, never kill the process (Node 22 default kills it — the a0eab22b
outage: every MCP client got "Not connected" and `reset` could not recover
because reset runs inside the dead process).

- **Rule**: The guard writes to **stderr only** — stdout is the MCP stdio
  transport. Never remove the guard "for cleanliness", never add a
  swallow-everything variant to short-lived CLIs.
- **Rule**: sessiond installs it in the **direct-run block only** so
  programmatic `startSessiond()` in tests keeps Node's default crash
  semantics (test processes must still fail loudly).
- **Testing gotcha**: `node:test` intercepts `unhandledRejection`/
  `uncaughtException` and fails the running test even when listeners exist —
  guard behavior must be tested in spawned subprocesses with REAL events,
  never via `process.emit()`.

### CDP Traffic Log Retention

`relay/src/cdp-log.js` keeps `~/.browserforce/cdp.jsonl` within a hard byte cap
(10 MiB by default, configurable with `BROWSERFORCE_CDP_LOG_MAX_BYTES`). Rollover
must remain inside the logger's serialized write queue so concurrent traffic
cannot race truncation against appends. A single encoded entry larger than the
cap is skipped; the file itself must never exceed the configured limit.

### Execute Timeout Cancellation

`runCode()` is the single execution boundary for the MCP `exec` tool (formerly `execute`), the `browserforce` command tool's canned snippets, and `-e` (CLI). User code runs inside `node:vm` via `vm.runInContext(..., { timeout })` so a synchronous runaway is interrupted; remaining async work is raced against an outer timeout that calls `run.abort()`. `createRunController()` owns a per-run `AbortController` plus tracked timers; on timeout it aborts the signal (reason: `CodeExecutionTimeoutError`) and clears every pending run-scoped timer, so a continuation suspended on a run `setTimeout` never resumes and cannot mutate `state` afterward.

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
exact same vm boundary as MCP `exec` and one-shot `-e`. Never `eval()` /
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
- **The installed BrowserForce guide (`skills/browserforce/SKILL.md`) is the
  complete canonical guide.** Install it with
  `npx -y skills add ivalsaraj/browserforce`; it must remain visible to
  OpenCode and must not use `hidden: true`. There is no second documentation
  command or runtime skill loader.

### Eval Command-String Parsing (raw remainder)

In a command STRING (MCP `browserforce` tool, `run "eval ..."`), the `eval`
verb's code is the RAW remainder after the verb — never tokenized. The
shell-style tokenizer strips quotes and collapses whitespace, which silently
rewrites JS (`getByRole('button')` became `getByRole(button)` →
`ReferenceError` → the a0eab22b server crash).

- **Rule**: `parseEvalRemainder()` (`mcp/src/browserforce-command-registry.js`)
  takes the remainder verbatim (quotes/newlines preserved). `--tab` is
  recognized at the START of the remainder only — trailing extraction on raw
  code is unsupported by design (code may legitimately contain `--tab`).
- **Rule**: Legacy fully-quoted forms keep tokenized semantics ONLY when the
  remainder is one quoted group + optional trailing `--tab` — exactly what the
  CLI direct-verb builder (`bin.js` `quoteCommandToken()`) emits. A closing
  quote followed by anything else (`'text'.length`) means raw code.
- **Rule**: Never re-tokenize an argument that is source code — carry it
  verbatim from the surface that received it.

## Security Rules

- Relay binds to `127.0.0.1` ONLY. Never `0.0.0.0`.
- Extension WS validates `Origin: chrome-extension://`. Reject all others.
- CDP clients require auth token in query param. Token is random 32 bytes (base64url).
- Token file permissions: `0o600` (owner read/write only).
- Single extension slot. Second extension connection gets HTTP 409.
- Wildcard CORS is an ALLOWLIST (`WILDCARD_CORS_PATHS`), not a denylist. Only
  `/` (counts-only health) is readable cross-origin. Everything else is denied
  by default — the previous denylist silently exempted `/json/version`,
  `/json/list` (both embed the CDP auth token in `webSocketDebuggerUrl`),
  `/restrictions` and `/agent-preferences` (user settings, including free-text
  instructions). Never add a route to the allowlist without establishing that
  its body is safe for any page the user visits to read.

## Operational Non-Goals

- No new dependencies for client arbitration or standby behavior.
- Tab ownership is metadata-only: agent-created tabs record an owning agent key, and an explicit `closeTab` from a different agent is refused. It is NOT a capability fence — every CDP client can still navigate any target, and auto-close remains per-tab idle time rather than per owner.
- No extension protocol changes beyond the `ownerKey` field on `createTab`/`closeTab`.

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
| `mcp/src/index.js` | ~400 | MCP server — browserforce + exec + reset + help tools via Playwright-core `connectOverCDP` |
| `mcp/src/browserforce-command-registry.js` | ~700 | Shared command registry — parser + executor for CLI/sessiond/MCP command surfaces |
| `mcp/src/browser-session-runtime.js` | ~800 | Shared browser session runtime — connection lifecycle, active tab, handles/names, runCommand |
| `mcp/src/tab-identity.js` | ~75 | Pure page↔relay-target pairing — the rule handles and names are keyed by |
| `mcp/src/readiness.js` | ~45 | Pure four-state readiness classifier shared by the CLI assertion and the MCP preflight |
| `extension/tab-update-policy.js` | ~30 | Pure predicates for what the extension reports to the relay about tab lifecycle |

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
