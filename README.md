# BrowserForce // 

> "a lion doesn't concern itself with token counting" — [@steipete](https://x.com/steipete), creator of [OpenClaw](https://github.com/openclaw/openclaw)
>
> "a 10x user doesn't concern itself with sandboxed browsers // sandboxes are for kids" — BrowserForce, your friendly neighborhood power source.

**You're giving an AI your real Chrome — your logins, cookies, and sessions. That takes conviction.** BrowserForce is built for people who use the best models and don't look back. Security is built in: lock URLs, block navigation, read-only mode, auto-cleanup — you stay in control.

**Fully autonomous browser control.** No manual tab clicking. Your agent browses as you, even from WhatsApp. Other tools make you click each tab, spawn a fresh Chrome, or only work with one AI client. BrowserForce connects to **your running browser** and auto-attaches to all tabs. One Chrome extension, full Playwright API, completely hands-off.

Works with [OpenClaw](https://github.com/openclaw/openclaw), Claude, or any MCP-compatible agent.

## Comparison

| | Playwright MCP | OpenClaw Browser | Playwriter | Claude Extension | BrowserForce |
|---|---|---|---|---|---|
| Browser | Spawns new Chrome | Separate profile | Your Chrome | Your Chrome | **Your Chrome** |
| Login state | Fresh | Fresh (isolated) | Yours | Yours | **Yours** |
| Tab access | N/A (new browser) | Managed by agent | Click each tab | Click each tab | **All tabs, automatic** |
| Autonomous | Yes | Yes | No (manual click) | No (manual click) | **Yes (fully autonomous)** |
| Context method | Screenshots (100KB+) | Screenshots + snapshots | A11y snapshots (5-20KB) | Screenshots (100KB+) | **A11y snapshots (5-20KB)** |
| Tools | Many dedicated | 1 `browser` tool | 1 `execute` tool | Built-in | **1 `execute` tool** |
| Agent support | Any MCP client | OpenClaw only | Any MCP client | Claude only | **Any MCP client** |
| Playwright API | Partial | No | Full | No | **Full** |

## Your Credentials Stay Yours

Every other approach asks you to hand over something: an API key, an OAuth token, stored passwords, session cookies in a config file. BrowserForce asks for none of it.

**Why?** Because you're already logged in. BrowserForce talks to your running Chrome — it doesn't extract credentials, store cookies, or replay tokens. The browser handles auth exactly as it always has. Your agent inherits your sessions the same way a new Chrome tab does.

What you never need to provide:
- No passwords
- No API keys
- No OAuth tokens
- No session cookies in env vars or config files

It's a security win *and* a setup win — there are no secrets to rotate, leak, or manage. Your logins live in Chrome. They stay in Chrome.

## Setup

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

**If you installed via npm:**

1. Run: `browserforce install-extension`
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the path printed in step 1

❗ After every BrowserForce update, re-run `browserforce install-extension`, then reload the extension in `chrome://extensions/` (click the ↺ icon next to BrowserForce).

**If you cloned the repo:**

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder

After loading, the extension icon appears in your toolbar (gray = disconnected).

### 3. Done

The relay auto-starts when you run any command or connect via MCP — no manual step needed. Extension icon turns green once connected.

To run the relay manually (optional):

```bash
browserforce serve
```

## Connect Your Agent

### OpenClaw

Most OpenClaw users chat with their agent from Telegram or WhatsApp. BrowserForce lets your agent browse the web as you — no login flows, no captchas — even from a messaging app.

**Quick setup** (copy-paste into your terminal):

```bash
npm install -g browserforce && browserforce install-extension && npx -y skills add ivalsaraj/browserforce
```

Then start the relay (keep this running):

```bash
browserforce serve
```

**Verify it works** — send this to your agent:

> Go to https://x.com and give me top tweets

If your agent browses to the page and responds with the title, you're all set.

<details>
<summary><b>Alternative: MCP server</b> (advanced)</summary>

If you prefer MCP over the skill, add to `~/.openclaw/openclaw.json`:

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

</details>

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Claude Code

Add to `~/.claude/mcp.json`:

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
browserforce plugin list        # List installed plugins
browserforce plugin install <n> # Install a plugin from the registry
browserforce plugin remove <n>  # Remove an installed plugin
browserforce update             # Update to the latest version
browserforce install-extension  # Copy extension to ~/.browserforce/extension/
```

Each `-e` command is one-shot — state does not persist between calls. For persistent state, use the MCP server.

## Plugins

Plugins add custom helpers directly into the `execute` tool scope. Install once — your agent calls them like built-in functions.

### Install a plugin

```bash
browserforce plugin install highlight
```

That's it. Restart MCP (or Claude Desktop) and `highlight()` is available in every `execute` call.

### Official plugins

| Plugin | What it adds | Install |
|--------|-------------|---------|
| `highlight` | `highlight(selector, color?)` — outlines matching elements; `clearHighlights()` — removes them | `browserforce plugin install highlight` |

### Use an installed plugin

After installing `highlight`, your agent can call it directly:

```javascript
// Outline all buttons in blue
await highlight('button', 'blue');

// Highlight the specific element you're about to click
await highlight('[data-testid="submit"]', 'red');
return await screenshotWithAccessibilityLabels();
```

The helper receives the active page, context, and state automatically — no plumbing needed.

### Manage plugins

```bash
browserforce plugin list        # See what's installed
browserforce plugin remove highlight   # Uninstall
```

Plugins are stored at `~/.browserforce/plugins/`. Each one is a folder with an `index.js`.

### Write your own

```javascript
// ~/.browserforce/plugins/my-plugin/index.js
export default {
  name: 'my-plugin',
  helpers: {
    async scrollToBottom(page, ctx, state) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    },
    async countLinks(page, ctx, state) {
      return page.evaluate(() => document.querySelectorAll('a').length);
    },
  },
};
```

Drop it in `~/.browserforce/plugins/my-plugin/`, restart MCP, and call `await scrollToBottom()` or `await countLinks()` from any `execute` call.

Add a `SKILL.md` file alongside `index.js` and its content is automatically appended to the `execute` tool's description — so your agent knows the helpers exist without you having to explain them every time.

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
| `screenshot_with_labels` | Take a screenshot with Vimium-style accessibility labels overlaid on interactive elements. |
| `reset` | Reconnect to the relay and clear state. Use when the connection drops. |

## Examples

Get started with simple prompts. The AI generates code and does the work.

<details>
<summary><b>Example 1: Read page content (X.com search)</b></summary>

**Prompt to AI:**
> Go to x.com/search and search for "browserforce". Show me the top 5 tweets you find.

**What the AI does:** Navigates to X, searches the term, extracts top tweets, returns them to you.

**Use case:** Quick research, trend tracking, social listening.

</details>

<details>
<summary><b>Example 2: Interact with a form (GitHub search)</b></summary>

**Prompt to AI:**
> Go to GitHub and search for "ai agents". Show me the top 3 repositories and their star counts.

**What the AI does:** Fills GitHub search, waits for results, extracts repo names + stars, returns them.

**Use case:** Finding libraries, competitive research, project discovery.

</details>

### Multi-Tab Workflows

<details>
<summary><b>Example 3: Search → Extract → Return</b></summary>

**Prompt to AI:**
> Search ProductHunt for "AI tools" and give me the top 5 products with their taglines and upvote counts.

**What the AI does:** Navigates ProductHunt, searches, extracts product info, returns structured data.

**Use case:** Market research, finding tools, competitive analysis.

</details>

<details>
<summary><b>Example 4: Open result in new tab, process there</b></summary>

**Prompt to AI:**
> Find the #1 product from your last ProductHunt search, click into it, and read the full description. Tell me what it does.

**What the AI does:** Opens the product page from previous results, reads the description, summarizes it.

**Use case:** Deep-dive research, understanding competitors, due diligence.

</details>

<details>
<summary><b>Example 5: Debugging workflow (inspect + verify)</b></summary>

**Prompt to AI:**
> Go to my staging site at staging.myapp.com/checkout and take a labeled screenshot. Tell me if the "Complete Purchase" button is visible and what's around it.

**What the AI does:** Navigates, takes screenshot with interactive labels, analyzes button state and layout.

**Use case:** Visual debugging, QA checks, spotting broken elements.

</details>

<details>
<summary><b>Example 6: Test form with data</b></summary>

**Prompt to AI:**
> Sign up for Substack using the email test.user@example.com. Tell me if the signup completes successfully.

**What the AI does:** Fills the form, submits, waits for confirmation, reports success/failure.

**Use case:** Testing sign-up flows, QA automation, form validation.

</details>

<details>
<summary><b>Example 7: Content pipeline (search → extract → compare)</b></summary>

**Prompt to AI:**
> Search for "AI regulation" on both X.com and LinkedIn. Give me the top 5 trending posts from each and tell me which topics overlap.

**What the AI does:** Searches both platforms, extracts posts, compares content, returns analysis.

**Use case:** Multi-source research, trend analysis, market sentiment.

</details>

<details>
<summary><b>Example 8: Data extraction → CSV pipeline</b></summary>

**Prompt to AI:**
> Go to Hacker News and extract the top 10 stories with their titles and vote counts. Format as CSV so I can import into a spreadsheet.

**What the AI does:** Navigates HN, extracts story data, formats as CSV, returns it ready to paste.

**Use case:** Data workflows, trend tracking, content curation.

</details>

<details>
<summary><b>Example 9: A/B testing across variants</b></summary>

**Prompt to AI:**
> Visit myapp.com/?variant=red and myapp.com/?variant=blue. Compare the two designs and tell me which button color is more prominent and what other differences exist.

**What the AI does:** Opens both variants, compares layouts/colors/text, reports visual differences.

**Use case:** Design QA, A/B testing, variant comparison.

</details>

<details>
<summary><b>Example 10: Monitor + alert workflow</b></summary>

**Prompt to AI:**
> Check our status page at status.myapp.com every few minutes. Tell me the current status of the API and database. Alert me if anything changes from green to red.

**What the AI does:** Monitors status page, reads indicators, alerts on degradation.

**Use case:** Uptime monitoring, incident detection, SLA tracking.

</details>

**More examples** and detailed walkthrough available in the [User Guide](GUIDE.md#examples).

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

## You Stay in Control

Click the extension icon to configure restrictions. Your browser, your rules:

| Setting | What it does |
|---------|-------------|
| **Auto / Manual mode** | Let the agent create tabs freely, or hand-pick which tabs it can access |
| **Lock URL** | Prevent the agent from navigating away from the current page |
| **No new tabs** | Block the agent from opening new tabs |
| **Read-only** | Observe only — no clicks, no typing, no interactions |
| **Auto-detach** | Automatically detach inactive tabs after 5-60 minutes |
| **Auto-close** | Automatically close agent-created tabs after 5-60 minutes |
| **Custom instructions** | Pass text instructions to the agent (e.g. "don't click any buy buttons") |

## Security

| Layer | Control |
|-------|---------|
| **Network** | Relay binds to `127.0.0.1` only — never exposed to the internet |
| **Auth** | Random token required for every CDP connection |
| **Origin** | Extension only accepts connections from its own Chrome origin |
| **Visibility** | Chrome shows "controlled by automated test software" on active tabs |
| **Restrictions** | Lock URLs, block navigation, read-only mode — enforced at the CDP level |

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

> **Want the full walkthrough?** Read the [User Guide](https://github.com/ivalsaraj/browserforce/blob/main/GUIDE.md) for a plain-English explanation of what this does and how to get started.
