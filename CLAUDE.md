# BrowserForce — Project Instructions

## What This Is

A three-component system that bridges AI agents to a user's **real Chrome browser** via transparent CDP (Chrome DevTools Protocol) proxy. The agent controls logged-in tabs, opens new ones, takes screenshots — all through the user's actual browser profile.

```
Agent (Playwright/MCP) <--CDP--> Relay Server <--WS--> Chrome Extension <--debugger--> Real Chrome
```

## Architecture

### Components

| Component | Path | Runtime | Language |
|-----------|------|---------|----------|
| **Relay server** | `relay/src/index.js` | Node.js | JavaScript (CJS) |
| **Chrome extension** | `extension/` | Chrome MV3 Service Worker | JavaScript |
| **MCP server** | `mcp/src/index.js` | Node.js | JavaScript (ESM) |

### Data Flow

1. Extension connects to relay via WebSocket (`ws://127.0.0.1:19222/extension`)
2. Agent connects to relay via CDP WebSocket (`ws://127.0.0.1:19222/cdp?token=...`)
3. Relay intercepts `Target.*` commands, forwards everything else to extension
4. Extension executes via `chrome.debugger.sendCommand()` on real browser tabs
5. CDP events flow back: Extension → Relay → Agent

### State Management

- **Relay**: `targets` Map (sessionId → tab info), `tabToSession` Map (reverse), `childSessions` Map (iframe routing)
- **Extension**: `attachedTabs` Map (tabId → session info), `childSessions` Map (Chrome sessionId → tabId)
- **Token**: Persisted to `~/.browserforce/auth-token` (reused across restarts)
- **CDP URL**: Written to `~/.browserforce/cdp-url` on relay startup (auto-discovered by MCP server)

## Development

### Commands

```bash
pnpm relay              # Start relay server (port 19222)
pnpm relay:dev          # Start with --watch
pnpm mcp                # Start MCP server (stdio)
pnpm test               # Run all tests
pnpm test:relay         # Run relay tests only
pnpm test:mcp           # Run MCP tests only
```

### Install

```bash
cd relay && pnpm install    # ws
cd mcp && pnpm install      # @modelcontextprotocol/sdk, playwright-core, zod
```

### Extension

Load `extension/` as unpacked at `chrome://extensions/` (Developer mode).

## Conventions

### Language & Style

- **JavaScript only.** No TypeScript unless explicitly requested.
- **pnpm** for package management.
- CJS (`require`) for relay server. ESM (`import`) for MCP server (SDK requires it).
- No build step. Raw JS runs directly.

### Naming

- MCP tools: `bf_<action>` (e.g., `bf_click`, `bf_screenshot`)
- Relay internal methods: `_prefixed` for private
- Session IDs: `s<counter>` (assigned by relay)
- Extension messages: `camelCase` method names

### File Structure

```
browserforce/
├── relay/
│   ├── src/index.js           # RelayServer class + CLI entry
│   └── test/relay-server.test.js
├── extension/
│   ├── manifest.json          # MV3, permissions: debugger, tabs, storage, alarms
│   ├── background.js          # Service worker
│   ├── popup.html / .js / .css
├── mcp/
│   ├── src/index.js           # MCP server with 15 tools
│   └── test/mcp-tools.test.js
├── CLAUDE.md                  # This file
├── AGENTS.md                  # Agent roles and architecture
└── README.md                  # User-facing docs
```

## Critical Patterns

### Runtime.enable Trick

When Playwright sends `Runtime.enable`, the extension must call `Runtime.disable` → 50ms sleep → `Runtime.enable` to force Chrome to re-emit `executionContextCreated` events. Without this, Playwright hangs waiting for contexts.

**Location**: `extension/background.js`, `cdpCommand()` function.

### MV3 Service Worker Keepalive

Chrome kills MV3 service workers after ~30s of inactivity. The relay sends `ping` every 5 seconds. The extension responds with `pong`. Backup: `chrome.alarms` at 30-second intervals wakes the worker for reconnection.

### Lazy Debugger Attachment

When the agent sends `Target.setAutoAttach`, the relay responds with `{}` immediately, lists all tabs from the extension, and sends `Target.attachedToTarget` events — but does NOT call `chrome.debugger.attach()` on any tab. The debugger is attached lazily on the first CDP command targeting that tab via `_ensureDebuggerAttached()`. This avoids attaching debuggers to 50+ tabs at once (each consuming Chrome memory and showing the automation infobar). Race-safe via `attachPromise` per target.

**Location**: `relay/src/index.js`, `_autoAttachAllTabs()`, `_ensureDebuggerAttached()`, `_forwardToTab()`.

### OOPIF / Child Session Routing

Cross-origin iframes create child CDP sessions. The extension tracks `childSessions` (Chrome sessionId → parent tabId). The relay maps child session events to the parent page's relay sessionId for correct Playwright frame tree construction.

### Debugger Detach Cascade

When a user clicks "Cancel" on Chrome's automation infobar, Chrome detaches the debugger from **ALL** tabs (reason: `canceled_by_user`). The extension must clear all attached tab state, not just one tab.

## Security Rules

- Relay binds to `127.0.0.1` ONLY. Never `0.0.0.0`.
- Extension WS validates `Origin: chrome-extension://`. Reject all others.
- CDP clients require auth token in query param. Token is random 32 bytes (base64url).
- Token file permissions: `0o600` (owner read/write only).
- Single extension slot. Second extension connection gets HTTP 409.

## Testing

Tests use Node.js built-in test runner (`node:test`). No extra test dependencies.

- **Relay tests**: Start a real server on a random port, test with actual WebSocket connections.
- **MCP tests**: Test tool registration, CDP URL discovery, and error handling. Playwright connection is mocked.

### Running Tests

```bash
node --test relay/test/relay-server.test.js
node --test mcp/test/mcp-tools.test.js
```

## Common Pitfalls

1. **Port in use**: Kill stale relay with `lsof -ti:19222 | xargs kill -9`
2. **"Another debugger attached"**: Close DevTools for that tab, or the extension skips it
3. **Extension badge stays gray**: Relay not running, or relay URL in popup doesn't match
4. **Tab indices shift**: Closing/opening tabs changes indices. Use `bf_list_tabs` before targeting.
5. **about:blank tabs**: Filtered from `listTabs` but `about:blank` created by `newPage()` is attached automatically
