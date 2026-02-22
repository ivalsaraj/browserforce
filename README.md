# BrowserForce

**Give your AI agent your real Chrome browser.** Your logins, your cookies, your extensions — already there.

Other browser tools spawn a fresh Chrome — no logins, no extensions, instantly flagged by bot detectors. BrowserForce connects to **your running browser** instead. One Chrome extension, full Playwright API, everything you're already logged into.

Works with [OpenClaw](https://github.com/openclaw/openclaw), Claude, or any MCP-compatible agent.

| | OpenClaw's built-in browser | BrowserForce |
|---|---|---|
| Browser | Spawns dedicated Chrome | **Uses your Chrome** |
| Login state | Fresh — must log in every time | Already logged in |
| Extensions | None | Your existing ones |
| 2FA / Captchas | Blocked | Already passed (you did it) |
| Bot detection | Easily detected | Runs in your real profile |
| Cookies & sessions | Empty | Yours |

## Setup

### 1. Install

```bash
npm install -g browserforce
```

Or from source:

```bash
git clone https://github.com/anthropics/browserforce.git
cd browserforce
pnpm install
```

### 2. Load the Chrome extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Extension icon appears in your toolbar (gray = disconnected)

### 3. Start the relay

```bash
browserforce serve
```

Or with pnpm (development):

```bash
pnpm relay
```

```
  BrowserForce
  ────────────────────────────────────────
  Status:   http://127.0.0.1:19222/
  CDP:      ws://127.0.0.1:19222/cdp?token=<TOKEN>
  ────────────────────────────────────────
```

Extension icon turns green — you're connected.

## Connect Your Agent

### OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mcp-adapter": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "name": "browserforce",
              "transport": "stdio",
              "command": "node",
              "args": ["/absolute/path/to/browserforce/mcp/src/index.js"]
            }
          ]
        }
      }
    }
  }
}
```

Then add `"mcp-adapter"` to your agent's allowed tools. Your OpenClaw agent can now browse the web as you — no login flows, no captchas.

### Claude Desktop

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

### Claude Code

Add to `~/.claude/mcp.json`:

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

### CLI

```bash
npm install -g browserforce   # or: pnpm add -g browserforce
```

```bash
browserforce serve              # Start the relay server
browserforce status             # Check relay and extension status
browserforce tabs               # List open browser tabs
browserforce snapshot [n]       # Accessibility tree of tab n
browserforce screenshot [n]     # Screenshot tab n (PNG to stdout)
browserforce navigate <url>     # Open URL in a new tab
browserforce -e "<code>"        # Run Playwright JavaScript (one-shot)
```

Each `-e` command is one-shot — state does not persist between calls. For persistent state, use the MCP server.

### OpenClaw Skill

Install the skill directly:

```bash
npx -y skills add anthropics/browserforce
```

Or add to your agent config manually — the skill teaches the agent to use BrowserForce CLI commands via Bash.

### Any Playwright Script

```javascript
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP(
  'ws://127.0.0.1:19222/cdp?token=<TOKEN>'
);

const pages = browser.contexts()[0].pages();
for (const page of pages) {
  console.log(page.url());  // your real tabs!
}

// Gmail is already logged in
const gmail = pages.find(p => p.url().includes('mail.google'));
await gmail.screenshot({ path: 'gmail.png' });
```

No token config needed for MCP — the server reads it automatically from `~/.browserforce/cdp-url`.

## What Your Agent Can Do

Once connected, your agent has full Playwright access to your real browser:

```javascript
// Navigate (uses your cookies — no login needed)
await page.goto('https://github.com');
await waitForPageLoad();

// Read pages with accessibility snapshots (10-100x cheaper than screenshots)
return await snapshot();

// Click, type, fill forms
await page.locator('role=button[name="Sign in"]').click();
await page.locator('role=textbox[name="Search"]').fill('query');

// Screenshots when you need them
return await page.screenshot();

// Work with multiple tabs
const pages = context.pages();
const gmail = pages.find(p => p.url().includes('mail.google'));

// Persist data across calls
state.results = await page.evaluate(() => document.title);
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `execute` | Run Playwright JavaScript in your real Chrome. Access `page`, `context`, `state`, `snapshot()`, `waitForPageLoad()`, `getLogs()`, and Node.js globals. |
| `reset` | Reconnect to the relay and clear state. Use when the connection drops. |

## How It Works

```
  Agent (OpenClaw, Claude, etc.)
         │
         ├─ MCP server (stdio)
         ├─ CLI (browserforce -e)
         │
         │ CDP over WebSocket
         ▼
  Relay Server (localhost:19222)
         │
         │ WebSocket
         ▼
  Chrome Extension (MV3)
         │
         │ chrome.debugger API
         ▼
  Your Real Chrome Browser
```

The **relay server** runs on your machine (localhost only). It translates between the agent's CDP commands and the extension's debugger bridge.

The **Chrome extension** lives in your browser. It attaches Chrome's built-in debugger to your tabs and forwards commands — exactly like DevTools does.

When the agent connects, it immediately sees all your open tabs as controllable Playwright pages. No clicking, no manual attachment.

## Extension Settings

Click the extension icon to configure:

- **Auto / Manual mode** — Let the agent create tabs freely, or manually select which tabs it can access
- **Lock URL** — Prevent the agent from navigating away from the current page
- **No new tabs** — Block tab creation
- **Read-only** — Observe only, no interactions
- **Auto-cleanup** — Automatically detach or close agent tabs after a timeout
- **Custom instructions** — Pass text instructions to the agent

## Security

| Layer | Control |
|-------|---------|
| **Network** | Relay binds to `127.0.0.1` only — never exposed to the internet |
| **Auth** | Random token required for every CDP connection |
| **Origin** | Extension only accepts connections from its own Chrome origin |
| **Visibility** | Chrome shows "controlled by automated test software" on active tabs |

Everything runs on your machine. The auth token is stored at `~/.browserforce/auth-token` with owner-only permissions.

## Configuration

**Custom relay port:**
```bash
RELAY_PORT=19333 browserforce serve
```

**Extension relay URL:** Click the extension icon → change the URL → Save. Default: `ws://127.0.0.1:19222/extension`

**Override CDP URL for MCP:**
```json
{
  "env": {
    "BF_CDP_URL": "ws://127.0.0.1:19333/cdp?token=your-token"
  }
}
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check (extension status, target count) |
| `GET /json/version` | CDP discovery |
| `GET /json/list` | List attached targets |
| `ws://.../extension` | Chrome extension WebSocket |
| `ws://.../cdp?token=...` | Agent CDP connection |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension stays gray | Is the relay running? Check `http://127.0.0.1:19222/` |
| "Another debugger attached" | Close DevTools for that tab |
| Agent sees 0 pages | Open at least one regular webpage (not `chrome://`) |
| Extension keeps reconnecting | Normal — MV3 kills idle workers; it auto-recovers |
| Port in use | `lsof -ti:19222 \| xargs kill -9` |

> **Want the full walkthrough?** Read the [User Guide](GUIDE.md) for a plain-English explanation of what this does and how to get started.
