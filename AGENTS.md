# BrowserForce — Agent Guidelines

## Playwriter Reference

**Before writing any new code, always check how [playwriter](../playwriter) solves the same problem.** Playwriter is the reference implementation for a browser extension + CDP relay + MCP server stack. It lives at `~/Documents/projects/playwriter`.

Rules:
- **Don't reinvent what playwriter already solved.** Read the relevant playwriter source file first.
- **Only add code for new requirements or problems playwriter hasn't already solved.**
- Reference files: `playwriter/src/cdp-relay.ts`, `playwriter/src/executor.ts`, `playwriter/src/mcp.ts`, `playwriter/src/relay-client.ts`

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
│  - 2 tools: execute + reset     │           │
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
| `createTab` | `{ url, sessionId }` | Create and attach new tab |
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

Playwright eagerly sends ~40 init-only CDP commands to every page it learns about via `Target.attachedToTarget`. Without interception, this would trigger eager debugger attachment on all tabs. The relay intercepts these commands (in `INIT_ONLY_METHODS` set) and returns synthetic responses without calling `chrome.debugger.attach()`.

Key methods: `Runtime.enable/disable`, `Page.enable/disable`, `Page.getFrameTree`, `Page.createIsolatedWorld` (critical — this was the actual trigger), `Page.addScriptToEvaluateOnNewDocument`, plus ~35 more Network/Fetch/Emulation/Security commands.

**Location**: `relay/src/index.js`, `INIT_ONLY_METHODS`, `syntheticInitResponse()`, `_forwardToTab()`.

### browserContextId Requirement

Playwright's `CRBrowser._onAttachedToTarget` asserts `targetInfo.browserContextId` must be truthy. All relay-synthesized `targetInfo` objects must include `browserContextId: DEFAULT_BROWSER_CONTEXT_ID`. `Target.getBrowserContexts` must return `[DEFAULT_BROWSER_CONTEXT_ID]`.

**Location**: `relay/src/index.js`, `DEFAULT_BROWSER_CONTEXT_ID = 'bf-default-context'`.

### OOPIF / Child Session Routing

Cross-origin iframes create child CDP sessions. The extension tracks `childSessions` (Chrome sessionId → parent tabId). The relay maps child session events to the parent page's relay sessionId for correct Playwright frame tree construction.

### Debugger Detach Cascade

When a user clicks "Cancel" on Chrome's automation infobar, Chrome detaches the debugger from **ALL** tabs (reason: `canceled_by_user`). The extension must clear all attached tab state, not just one tab.

### Test Isolation: writeCdpUrl Flag

`RelayServer.start()` accepts `{ writeCdpUrl: false }` to prevent test instances from clobbering `~/.browserforce/cdp-url`. **All test `relay.start()` calls must pass `{ writeCdpUrl: false }`** or the production cdp-url file gets overwritten with random test ports.

### Client Arbitration: BF_CLIENT_MODE

`BF_CLIENT_MODE` controls agent-side CDP arbitration:
- `single-active` (default): only one active `/cdp` client connection at a time.
- `multi-client`: fallback mode that allows concurrent `/cdp` clients.

In `single-active`, contention returns HTTP `409 Conflict` for additional `/cdp` connects while the slot is busy. Slot state is exposed at `GET /client-slot` (`mode`, `busy`, `activeClientId`, `connectedAt`).

### MCP Standby Polling

MCP handles `409`/busy connect errors by entering standby and polling `GET /client-slot` with short jittered intervals (~200-400ms), then reconnecting when `busy: false` (up to a 30s connect timeout).

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
| `mcp/src/index.js` | ~300 | MCP server — execute + reset tools via Playwright-core `connectOverCDP` |

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
