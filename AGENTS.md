# BrowserForce — Agent Guidelines

## Project Overview

BrowserForce bridges AI agents to a user's real Chrome browser via a transparent CDP proxy. Three components: **relay server** (Node.js CDP proxy), **Chrome extension** (MV3 service worker using `chrome.debugger`), and **MCP server** (exposes Playwright-based tools via Model Context Protocol).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         AI Agent Layer                               │
│                                                                      │
│  ┌─────────────────────────────┐  ┌───────────────────────────────┐ │
│  │  MCP Client (Claude, etc.)  │  │  Direct Playwright Client     │ │
│  │  Uses bf_* tools            │  │  chromium.connectOverCDP()    │ │
│  └──────────┬──────────────────┘  └──────────┬────────────────────┘ │
│             │ MCP/stdio                      │ CDP/WebSocket        │
└─────────────┼────────────────────────────────┼──────────────────────┘
              │                                │
              ▼                                │
┌──────────────────────────────────┐           │
│  MCP Server (mcp/src/index.js)   │           │
│  - 15 browser control tools      │           │
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

## Development Workflow

### Making Changes

1. **Relay changes**: Edit `relay/src/index.js`, restart with `pnpm relay:dev` (auto-reload)
2. **Extension changes**: Edit `extension/background.js`, reload at `chrome://extensions/` (click refresh icon)
3. **MCP changes**: Edit `mcp/src/index.js`, restart the MCP client (Claude Desktop, etc.)

### Testing

```bash
pnpm test               # All tests
pnpm test:relay          # Relay server unit + integration tests
pnpm test:mcp            # MCP server tests
```

Tests use `node:test` (built-in, no dependencies).

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
| `relay/src/index.js` | ~690 | `RelayServer` class — CDP proxy, session management, HTTP endpoints |
| `extension/background.js` | ~425 | Service worker — WS connection, `chrome.debugger` bridge, reconnection |
| `extension/manifest.json` | 20 | MV3 manifest — permissions: debugger, tabs, storage, alarms |
| `extension/popup.html/js/css` | ~100 | Status UI — connection state, relay URL config, attached tabs list |
| `mcp/src/index.js` | ~420 | MCP server — 15 tools via Playwright-core `connectOverCDP` |

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

4. **Tab indices are unstable**: Closing tab 0 shifts all subsequent indices down. Always call `bf_list_tabs` before using `bf_click`/`bf_navigate` with a `tabIndex`.

5. **Relay port collision**: Default port 19222. If tests fail with EADDRINUSE, kill stale processes: `lsof -ti:19222 | xargs kill -9`.
