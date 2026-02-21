# BrowserForce

Bridge AI agents to your **real Chrome browser** — with all your logged-in sessions, cookies, and tabs — via a transparent CDP (Chrome DevTools Protocol) proxy.

No headless browser. No sandboxed profiles. Your agent drives your actual browser.

> **New here?** Read the [User Guide](GUIDE.md) for a plain-English walkthrough of what this does and how to get started.

## Architecture

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────────────┐
│   AI Agent       │ CDP  │   Relay Server   │  WS  │   Chrome Extension       │
│  (Playwright)    │─────▶│  (Node.js)       │─────▶│  (MV3 Service Worker)    │
│                  │◀─────│  127.0.0.1:19222 │◀─────│  chrome.debugger API     │
└──────────────────┘      └──────────────────┘      └──────────────────────────┘
```

**Relay server** — Localhost-only Node.js process. Accepts Playwright CDP connections on one side, Chrome extension WebSocket on the other. Transparently proxies CDP commands/events. Intercepts `Target.*` commands to manage tab attachment.

**Chrome extension** — MV3 service worker. Connects to the relay via WebSocket. Uses `chrome.debugger` API to attach to real browser tabs and forward CDP commands. Auto-reconnects on service worker termination.

**Agent** — Any Playwright-compatible client. Connects via standard `chromium.connectOverCDP()`. Sees all your real browser tabs as controllable pages.

## Setup

### 1. Install the relay server

```bash
cd relay
pnpm install
```

### 2. Load the extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** → select the `extension/` directory
4. The extension icon appears in the toolbar (gray badge = disconnected)

### 3. Start the relay

```bash
pnpm relay
# or
node relay/src/index.js
```

Output:

```
  BrowserForce
  ────────────────────────────────────────
  Status:   http://127.0.0.1:19222/
  CDP:      ws://127.0.0.1:19222/cdp?token=<AUTH_TOKEN>
  ────────────────────────────────────────
```

The extension badge turns green (`ON`) when connected.

### 4. Connect your agent

```javascript
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP(
  'ws://127.0.0.1:19222/cdp?token=<AUTH_TOKEN>'
);

// Access your real, logged-in tabs
const context = browser.contexts()[0];
const pages = context.pages();

for (const page of pages) {
  console.log(page.url());
}

// Take a screenshot of Gmail (already logged in!)
const gmail = pages.find(p => p.url().includes('mail.google'));
if (gmail) {
  await gmail.screenshot({ path: 'gmail.png' });
}

// Open a new tab in the same browser
const page = await context.newPage();
await page.goto('https://x.com');
// Uses your existing X session — no login needed
```

## Configuration

### Relay port

```bash
RELAY_PORT=19333 pnpm relay
# or
node relay/src/index.js 19333
```

### Extension relay URL

Click the extension icon → change the relay URL in the popup → Save.

Default: `ws://127.0.0.1:19222/extension`

## How it works

### Zero-click control

When your agent connects and Playwright sends `Target.setAutoAttach`, the relay:

1. Asks the extension for all open tabs
2. Attaches `chrome.debugger` to each eligible tab
3. Sends `Target.attachedToTarget` events to Playwright
4. Your agent sees all tabs as `page` objects — immediately controllable

No clicking. No tab groups. No manual attachment. The agent requests access, the relay grants it.

### New tab creation

```javascript
const page = await context.newPage();
await page.goto('https://github.com');
```

Creates a real Chrome tab, attaches the debugger, returns a Playwright page. Your cookies apply.

### CDP transparency

The relay is a transparent CDP proxy. Standard Playwright operations work:

- `page.click()`, `page.type()`, `page.fill()` — native CDP `Input.*` events
- `page.screenshot()` — `Page.captureScreenshot`
- `page.evaluate()` — `Runtime.evaluate`
- `page.goto()` — `Page.navigate`
- Frame/iframe access — OOPIF child session routing

### Reconnection

The MV3 service worker handles Chrome's aggressive termination:

- Relay pings extension every 5 seconds (keeps worker alive)
- `maintainConnection` loop auto-reconnects on WS drop
- `chrome.alarms` fallback wakes the worker after full termination
- On reconnect, relay re-issues tab attachments

## Security model

| Layer | Control |
|-------|---------|
| **Network** | Relay binds to `127.0.0.1` only — no remote access |
| **Origin** | Extension WS rejects non-`chrome-extension://` origins |
| **Auth** | CDP clients require a per-instance random auth token |
| **Visibility** | Chrome shows "controlled by automated test software" infobar |

The auth token is persisted to `~/.browserforce/auth-token` and reused across restarts.

## MCP Server (AI Agent Integration)

The MCP server lets any MCP-compatible AI agent (Claude Desktop, Claude Code, etc.) control your browser through natural language.

### Install

```bash
cd mcp
pnpm install
```

### Configure for Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browserforce": {
      "command": "node",
      "args": ["/absolute/path/to/browserforce/mcp/src/index.js"]
    }
  }
}
```

No token configuration needed — the MCP server reads it automatically from `~/.browserforce/cdp-url`.

### Configure for Claude Code

Add to `~/.claude/mcp.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "browserforce": {
      "command": "node",
      "args": ["/absolute/path/to/browserforce/mcp/src/index.js"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `bf_list_tabs` | List all controlled tabs (index, URL, title) |
| `bf_navigate` | Navigate a tab to a URL |
| `bf_new_tab` | Open a new tab (with your cookies/sessions) |
| `bf_close_tab` | Close a tab |
| `bf_screenshot` | Take a screenshot (returns image to agent) |
| `bf_click` | Click an element (CSS/text/role selector) |
| `bf_type` | Type text character-by-character (works on contenteditable) |
| `bf_fill` | Fill an input field (clear + set value) |
| `bf_press_key` | Press a key or combo (Enter, Tab, Ctrl+a, etc.) |
| `bf_scroll` | Scroll page or element |
| `bf_select` | Select dropdown option |
| `bf_hover` | Hover over an element |
| `bf_get_content` | Extract text or HTML from page/element |
| `bf_evaluate` | Execute JavaScript in page context |
| `bf_wait_for` | Wait for element, URL, or load state |

### Example Agent Interaction

Once configured, you can tell Claude:

> "Open twitter.com in my browser and take a screenshot"

The agent will call `bf_new_tab` with `url: "https://twitter.com"`, then `bf_screenshot` — and since it's your real Chrome with your real X session, you'll see your actual feed.

### Override CDP URL

If you need to point the MCP server at a non-default relay:

```json
{
  "mcpServers": {
    "browserforce": {
      "command": "node",
      "args": ["/path/to/mcp/src/index.js"],
      "env": {
        "BF_CDP_URL": "ws://127.0.0.1:19333/cdp?token=your-token"
      }
    }
  }
}
```

## API

### HTTP endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check (extension status, target count) |
| `GET /json/version` | CDP discovery endpoint |
| `GET /json/list` | List attached targets |

### WebSocket endpoints

| Endpoint | Client |
|----------|--------|
| `ws://.../extension` | Chrome extension (single slot) |
| `ws://.../cdp?token=...` | Playwright / CDP clients |

## Troubleshooting

**Extension stays gray ("disconnected")**
- Is the relay running? Check `http://127.0.0.1:19222/`
- Check the relay URL in the extension popup matches

**"Another debugger is already attached"**
- Another DevTools window is open for that tab. Close it, or the extension skips that tab.

**Agent sees 0 pages**
- The extension filters `chrome://`, `edge://`, and `devtools://` tabs
- Ensure you have at least one regular webpage tab open

**Service worker dies / badge flickers**
- Normal MV3 behavior. The 5s ping keeps it alive during active sessions. The alarm fallback handles full restarts.
