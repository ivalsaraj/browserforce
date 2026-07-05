---
name: core
description: Core BrowserForce usage guide. Read this before running any browserforce commands. Covers the snapshot-and-ref workflow against the user's real Chrome browser, the persistent session commands (open, tabs, use, snapshot, click, hover, fill, type, press, wait, get, eval, rename, forget, run), the one-shot -e Playwright path, taking screenshots, and troubleshooting connection problems. Use when the user asks to browse, fill a form, click something, extract data, take a screenshot, log into a site, or automate a browser task with their logged-in Chrome sessions.
allowed-tools: Bash(browserforce:*), Bash(npx browserforce:*)
---

# BrowserForce core

BrowserForce gives an AI agent the user's **real** Chrome browser — their
logins, cookies, and extensions already active — through a transparent CDP
proxy. No headless browser, no fresh profile. Snapshots return a compact
accessibility tree with `@eN` refs so you interact with pages in a few hundred
tokens instead of parsing raw HTML.

## Prerequisites

1. The BrowserForce Chrome extension is installed and connected (green icon).
2. The relay auto-starts on the first command — no manual step.

Check anytime with:

```bash
browserforce status
```

## Two ways to drive the browser

BrowserForce has two execution paths. Prefer the **session commands** for
step-by-step agent work; use **one-shot `-e`** for a self-contained script.

### 1. Session commands — persistent, atomic verbs (preferred)

A small localhost daemon holds one browser session so state (the active tab,
snapshot refs, `state`) **persists across commands**. This is the natural fit
for the observe → act → observe loop. The same command language powers the MCP
`browserforce` tool, so examples transfer 1:1 between surfaces.

```bash
browserforce snapshot          # 1. accessibility tree + @eN refs
browserforce click @e3         # 2. act on a ref from the snapshot
browserforce snapshot          # 3. re-snapshot after the page changes
```

Refs (`@e1`, `@e2`, …) are assigned fresh on every snapshot and become **stale
the moment the page changes** (navigation, form submit, re-render). Always
re-snapshot before the next ref interaction. Refs accept `@e1`, `e1`, or
`ref=e1` — all normalize to the same element.

Session commands:

```bash
browserforce open https://example.com --as docs   # open a new tab (optionally named)
browserforce tabs                             # list tabs: stable t<N> handles + names
browserforce use t2                           # switch the active tab (handle, name, or title/url text)
browserforce snapshot [--tab docs] [--selector "#main"] [--search "login"] [--interactive]
browserforce click  @e3                       # click the element behind a ref
browserforce hover  @e3                       # hover a ref
browserforce fill   @e2 "user@example.com"    # clear then type into a field
browserforce type   @e2 " more text"          # type without clearing
browserforce press  Enter                     # press a key (Enter, Control+a, …)
browserforce wait   text "Saved"              # wait for text (flag form --text also works)
browserforce wait   url  "**/dashboard"       # wait for a URL glob
browserforce wait   load domcontentloaded     # wait for a load state
browserforce wait   fn   "window.ready === true"  # wait for a JS predicate
browserforce get    url                       # current URL
browserforce get    title                     # page title
browserforce get    text @e5                  # text content of a ref
browserforce get    html @e5                  # innerHTML of a ref
browserforce eval   --stdin                   # run piped Playwright JS in the session
browserforce rename docs api-docs             # rename a tab name
browserforce forget api-docs                  # remove a tab name
browserforce run "click @e2 --tab docs"       # run any command string verbatim
```

Ref/read commands accept `--tab <handle|name|text>` to target a specific tab
without switching the active one. Tab names are unique; pass `--replace` only
when you intentionally want to move a name to another tab.

`eval` runs through the **same guarded execution boundary** as the MCP `exec`
tool — the snippet has `page`, `context`, `state`, `snapshot()`,
`locatorForRef()`, etc., and `state` persists between calls:

```bash
cat <<'EOF' | browserforce eval --stdin
const rows = await page.locator('table tbody tr').all();
return rows.length;
EOF
```

Add `--json` to any verb for a machine-readable `{ success, data, error, warning }`
envelope (`tabs --json` prints the rows array directly).

### 2. One-shot `-e` — independent Playwright snippet

Each `browserforce -e` call is **independent**; state does NOT persist between
calls. Do everything (navigate, act, observe) in a single snippet:

```bash
browserforce -e "
  state.page = await context.newPage();
  await state.page.goto('https://example.com');
  await waitForPageLoad();
  return await snapshot();
"
```

## Reading a page

```bash
browserforce snapshot                     # full accessibility tree
browserforce snapshot --interactive      # interactive elements only
browserforce snapshot --selector "#main" # scope to a CSS selector
browserforce snapshot --search "checkout" # only nodes matching text
browserforce snapshot --tab docs          # snapshot a specific tab
```

## Screenshots and tabs

```bash
browserforce screenshot 0 > page.png   # PNG of tab 0 to stdout
browserforce tabs                      # list tabs (stable handles, active marker)
browserforce open https://gmail.com    # open a URL in a new session tab
```

Prefer `snapshot` (text, fast, cheap) over `screenshot`; reach for a screenshot
only when you need visual layout verification.

## Common workflow: log in

```bash
browserforce open https://app.example.com/login
browserforce snapshot                       # find the email/password/submit refs
browserforce fill @e3 "user@example.com"
browserforce fill @e4 "hunter2"
browserforce click @e5
browserforce wait url "**/dashboard"
browserforce snapshot
```

## Rules

1. **snapshot over screenshot** — snapshot returns compact text.
2. **Re-snapshot after every page change** — refs go stale immediately.
3. **It's the user's real browser** — don't close tabs you didn't open, don't
   navigate tabs you didn't create, don't change settings or stored data.
4. **Session commands share persistent state** — one-shot `-e` does not.
5. **Target tabs by stable handle (`t2`) or name** — never by list position.

## Troubleshooting

- **"Unknown ref" / element not found** — the page changed; re-run
  `browserforce snapshot` and use the new refs.
- **"No tab named …"** — run `browserforce tabs` and target a listed handle or
  name.
- **Connection lost** — run `browserforce status`; the user may need to
  reconnect the extension.
- **No tabs** — `browserforce open https://example.com`.
- **Element exists in the DOM but not the snapshot** — it's likely off-screen
  or not rendered; scroll or `wait text "..."`, then re-snapshot.

## Full reference

Pull in every command, flag, and the security model:

```bash
browserforce skills get core --full
```

That adds `references/commands.md` — the complete command/flag listing.
