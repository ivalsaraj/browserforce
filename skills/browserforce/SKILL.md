---
name: browserforce
description: Browse the web using the user's real Chrome browser — already logged in, with real cookies and extensions. No headless browser. Uses BrowserForce relay + Playwright API via CLI.
read_when:
  - Browsing as the user with logged-in sessions
  - Accessing sites that require authentication
  - Interacting with the user's real Chrome tabs
  - Web automation with existing cookies and extensions
  - Taking screenshots of authenticated pages
metadata: {"clawdbot":{"emoji":"🔌","requires":{"bins":["node","browserforce"]},"install":[{"kind":"node","package":"browserforce","bins":["browserforce"],"label":"Install BrowserForce CLI"}]}}
allowed-tools: Bash(browserforce:*)
---

# BrowserForce — Your Real Chrome Browser

BrowserForce gives you the user's actual Chrome browser — all their logins,
cookies, and extensions already active. No headless browser, no fresh profiles.

## Load the full runtime skill first

This file is a quick-start stub. For the complete, up-to-date guide — the
session commands (`open`/`tabs`/`use`/`snapshot`/`click`/`fill`/`wait`/`get`/`eval`),
the snapshot-and-ref workflow, multi-tab handling, and troubleshooting — load
the runtime skill:

```bash
browserforce skills get core          # the full core guide
browserforce skills get core --full   # plus the complete command reference
```

## Prerequisites

The user must have:
1. BrowserForce Chrome extension installed and connected (green icon)
2. The relay auto-starts on first command — no manual step needed

Check with: `browserforce status`

## Use commands first

Session commands share one persistent browser session (and snapshot refs)
across CLI calls — the same command language as the MCP `browserforce` tool:

```bash
browserforce tabs                # List tabs: stable t<N> handles + names
browserforce use t2              # Switch the active tab
browserforce open <url> --as docs  # Open a new tab, optionally named
browserforce snapshot            # Accessibility tree + @eN refs
browserforce click @e2           # Act on a ref from the last snapshot
browserforce screenshot [n]      # Screenshot tab n (PNG to stdout)
browserforce -e "<code>"         # Raw Playwright JavaScript (one-shot escape hatch)
```

Use `-e` only when the command layer cannot express the task.

## Core Workflow: Observe → Act → Observe

```bash
browserforce open https://example.com/login
browserforce snapshot                      # find the email/password/submit refs
browserforce fill @e3 "user@example.com"
browserforce fill @e4 "hunter2"
browserforce click @e5
browserforce wait url "**/dashboard"
browserforce snapshot                      # verify the result
```

Refs go stale the moment the page changes — always re-snapshot before the next
ref interaction.

### Multi-tab work

```bash
browserforce open https://docs.example.com --as docs
browserforce open https://app.example.com --as app
browserforce snapshot --tab app            # read app without switching tabs
browserforce click @e2 --tab app
browserforce use docs                      # or switch the active tab
```

Target tabs by stable handle (`t2`) or name — never by list position. Tab
names are unique; pass `--replace` only when you intentionally want to move a
name to another tab.

### Extract data

```bash
browserforce get url                       # current URL
browserforce get text @e5                  # text content of a ref
browserforce get html @e5                  # innerHTML of a ref
echo "return await page.title();" | browserforce eval --stdin
```

### One-shot `-e` (escape hatch)

Each `browserforce -e` call is independent (state does NOT persist between
`-e` calls). Do everything in a single snippet:

```bash
browserforce -e "
  state.page = await context.newPage();
  await state.page.goto('https://example.com');
  await waitForPageLoad();
  return await snapshot();
"
```

## Rules

1. **snapshot over screenshot** — snapshot returns text (fast, cheap).
   Use screenshot only for visual layout verification.
2. **Re-snapshot after every page change** — refs go stale immediately.
3. **Don't navigate existing tabs** — open your own via `browserforce open`.
4. **Commands over `-e`** — reach for raw Playwright only when the command
   layer cannot express the task.
5. **Command errors teach the next step** — stale ref → re-snapshot; unknown
   tab → `browserforce tabs`. Fix and retry.

## Error Recovery

- "Unknown ref": the page changed — `browserforce snapshot`, use the new refs
- "No tab named …": `browserforce tabs`, target a listed handle or name
- Connection lost: user must check `browserforce status`
- No tabs: `browserforce open https://example.com`
- Element not found: `browserforce snapshot --search "button"`

## Important

This is the user's REAL browser. Be respectful:
- Don't close tabs you didn't open
- Don't navigate tabs you didn't create
- Don't modify browser settings or stored data
