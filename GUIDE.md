# BrowserForce — User Guide

## What is this?

BrowserForce gives AI agents — like [OpenClaw](https://github.com/openclaw/openclaw), Claude, or any MCP-compatible tool — access to **your real Chrome browser**. The one you're already logged into. No headless browser, no fake profiles. The AI sees your actual tabs and can interact with any website using your existing sessions.

**Example:** You tell your agent "go to my Gmail and summarize my latest emails" — and it actually opens your Gmail (already logged in), reads the page, and gives you a summary. No passwords, no login flows.

## What can it do?

### Browse the web as you

| Capability | What it means |
|------------|---------------|
| **See your tabs** | AI sees all your open Chrome tabs instantly |
| **Navigate** | Open any URL in your real browser (with your cookies) |
| **Open new tabs** | Create tabs that inherit all your sessions |
| **Close tabs** | Clean up when done |

### Interact with pages

| Capability | What it means |
|------------|---------------|
| **Click** | Click buttons, links, menus — anything |
| **Type** | Type text into any input, search box, or contenteditable field |
| **Fill forms** | Fill input fields (clears existing value first) |
| **Press keys** | Enter, Tab, Escape, Ctrl+C, any key combo |
| **Scroll** | Scroll pages or specific elements |
| **Hover** | Trigger hover menus and tooltips |
| **Select dropdowns** | Pick options from `<select>` elements |

### Observe and extract

| Capability | What it means |
|------------|---------------|
| **Accessibility snapshots** | Read structured page content as text (fast, cheap — preferred over screenshots) |
| **Screenshots** | Take a screenshot of any tab (viewport or full page) |
| **Run JavaScript** | Execute any JS in the page context and get the result |
| **Wait for elements** | Wait until a specific element appears, URL changes, or page loads |

## How does it work?

Three pieces work together:

```
  YOU tell AI:                AI sends commands:          Extension executes:
  "check my Gmail"  →  [MCP/Playwright]  →  [Relay Server]  →  [Chrome Extension]  →  YOUR BROWSER
                         (AI agent)         (localhost proxy)   (debugger bridge)      (real Chrome)
```

### Step by step

1. **Chrome Extension** — Lives in your browser. Connects to the relay server. When asked, it attaches Chrome's built-in debugger to your tabs. This is how it can click, type, and screenshot — exactly like Chrome DevTools does.

2. **Relay Server** — Runs on your computer (localhost only, never exposed to the internet). It's the middleman. It speaks CDP (Chrome DevTools Protocol) to the AI agent on one side, and WebSocket to the extension on the other. Think of it as a translator.

3. **AI Agent** — Connects to the relay using standard tools (Playwright or MCP). It sees your browser tabs as controllable pages and can interact with them programmatically.

### Why not just use a headless browser?

| | Headless browser | BrowserForce |
|---|---|---|
| **Logged-in sessions** | No — starts fresh every time | Yes — uses YOUR cookies |
| **2FA/captchas** | Blocked — can't pass them | Already passed (you did it) |
| **Browser profile** | Empty/sandboxed | Your real profile |
| **Extensions** | None | Your installed extensions |
| **Bot detection** | Easily flagged | Runs in your real profile |

## Quick Start

### 1. Install

```bash
npm install -g browserforce
```

Or from source:

```bash
git clone https://github.com/ivalsaraj/browserforce.git
cd browserforce
pnpm install
```

### 2. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project
5. You'll see the extension icon in your toolbar (gray = disconnected)

### 3. Start the relay

```bash
browserforce serve
```

You'll see:

```
  BrowserForce
  ────────────────────────────────────────
  Status:   http://127.0.0.1:19222/
  CDP:      ws://127.0.0.1:19222/cdp?token=<YOUR_TOKEN>
  ────────────────────────────────────────
```

The extension icon turns green — you're connected.

### 4. Connect an AI agent

**Option A: OpenClaw**

Install the BrowserForce skill:

```bash
npx -y skills add ivalsaraj/browserforce
```

The skill teaches your agent to use BrowserForce CLI commands via Bash. Your agent can now browse the web as you — no login flows, no captchas.

Or add BrowserForce as an MCP server in `~/.openclaw/openclaw.json`:

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
              "command": "npx",
              "args": ["-y", "browserforce", "mcp"]
            }
          ]
        }
      }
    }
  }
}
```

**Option B: Claude Desktop / Claude Code (via MCP)**

Add to your Claude config:

```json
{
  "mcpServers": {
    "browserforce": {
      "command": "npx",
      "args": ["-y", "browserforce", "mcp"]
    }
  }
}
```

Then just talk to Claude: *"Open twitter.com and take a screenshot"*

**Option C: Custom Playwright script**

```javascript
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP(
  'ws://127.0.0.1:19222/cdp?token=<YOUR_TOKEN>'
);

const pages = browser.contexts()[0].pages();
console.log('Your open tabs:');
for (const page of pages) {
  console.log(' -', page.url());
}
```

## CLI

Once installed globally (`npm install -g browserforce`), the CLI is available:

```bash
browserforce serve              # Start the relay server
browserforce status             # Check relay and extension status
browserforce tabs               # List open browser tabs
browserforce snapshot [n]       # Accessibility tree of tab n (default: 0)
browserforce screenshot [n]     # Screenshot tab n (default: 0, PNG to stdout)
browserforce navigate <url>     # Open URL in a new tab
browserforce -e "<code>"        # Run Playwright JavaScript (one-shot)
```

Each `-e` command is one-shot — state does not persist between calls. For persistent state, use the MCP server.

**Examples:**

```bash
browserforce tabs
browserforce -e "return await snapshot()"
browserforce -e "await page.goto('https://github.com'); return await snapshot()"
browserforce screenshot 0 > page.png
browserforce navigate https://gmail.com
```

## MCP Tools Reference

When connected via MCP (OpenClaw, Claude Desktop, Claude Code), the AI has two tools:

| Tool | What it does |
|------|-------------|
| `execute` | Run Playwright JavaScript in your real Chrome. Access `page`, `context`, `state`, `snapshot()`, `waitForPageLoad()`, `getLogs()`, and Node.js globals. |
| `reset` | Reconnect to the relay and clear state. Use when the connection drops. |

The `execute` tool gives the agent full Playwright access — it can navigate, click, type, screenshot, read accessibility trees, and run JavaScript in the page context. All within your real browser session.

## Security

- **Local only** — The relay server binds to `127.0.0.1`. Nothing is exposed to the network.
- **Auth token** — Every connection requires a random token (auto-generated, stored locally).
- **Your machine only** — The extension, relay, and agent all run on your computer.
- **Visible** — Chrome shows a "controlled by automated test software" bar so you always know when automation is active.

## Common Questions

**Q: Can the AI see my passwords?**
A: The AI can see whatever is visible on the page, just like a screenshot. It cannot access saved passwords in Chrome's password manager.

**Q: Can someone else control my browser?**
A: No. The relay only accepts connections from `127.0.0.1` (your own machine) with a secret token.

**Q: Does it work with any AI?**
A: Any AI that supports MCP (OpenClaw, Claude Desktop, Claude Code) or any tool that speaks CDP (Playwright, Puppeteer scripts).

**Q: What happens if Chrome kills the extension?**
A: Chrome aggressively kills MV3 extensions after 30 seconds of inactivity. The relay sends keepalive pings every 5 seconds to prevent this. If the extension does restart, it auto-reconnects.

**Q: Can I control which tabs the AI accesses?**
A: Yes. Click the extension icon to switch between Auto mode (agent sees all tabs) and Manual mode (you select which tabs). You can also lock URLs, block new tabs, or enable read-only mode.

**Q: Does it work with multiple windows?**
A: Yes. All tabs across all Chrome windows are visible.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension icon stays gray | Is the relay running? Run `browserforce serve` |
| "Another debugger is attached" | Close DevTools for that tab |
| AI sees 0 pages | Open at least one regular webpage (not `chrome://`) |
| Extension keeps disconnecting | Normal MV3 behavior — it auto-reconnects |
| Port already in use | Run `lsof -ti:19222 \| xargs kill -9` to kill stale process |
