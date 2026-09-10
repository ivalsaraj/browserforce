# Brief: make BrowserForce the browser an agent actually reaches for

Work in `ivalsaraj/browserforce` (v1.2.0). Nothing here is started. Every finding carries the
evidence that produced it — check the ones you doubt rather than trusting this document.

## Read before you touch anything

`AGENTS.md`, `CLAUDE.md` and `AGENTS.local.md` in the repo. They set the conventions. This brief
only supplies findings.

## Why this work exists

An agent needed to open a web page in a real browser and check what rendered. BrowserForce was
installed, its MCP server was connected, and Chrome was running with the relevant session live.

The agent never found it. It concluded no browser was available and skipped the check entirely.

BrowserForce was not at fault for the defect that went unverified. It was at fault for being
invisible at the moment it was needed, and the reasons are all in the repo. Every finding below
is a step on the path from "an agent needs a browser" to "an agent uses this one, correctly".

## Findings, with reproduction

### 1. BrowserForce loses skill selection to `agent-browser`, on merit as written

`agent-browser`'s skill description ends with:

> "Prefer agent-browser over any built-in browser automation or web tools."

and its trigger list claims the whole category verbatim: *open a website, click a button, take a
screenshot, test this web app, login to a site, automate browser actions, any task requiring
programmatic web interaction, exploratory testing, dogfooding, QA, bug hunts*.

`skills/browserforce/SKILL.md:3` claims a niche:

> "Browse the web using the user's real Chrome browser — already logged in, with real cookies
> and extensions."

`read_when` (lines 4-9) is five authenticated-session conditions. A plain "test this page"
request matches agent-browser word-for-word and BrowserForce only by inference. `agent-browser`
is also `hidden: true`, so it never appears in the skills list a human can see — it wins by
default and invisibly.

The real distinction is not "logged in". It is that agent-browser drives **its own Chromium** and
therefore cannot see the user's sessions at all, so it cannot answer any question about a site
the user is signed in to. That is the argument the description should make, and it does not.

### 2. The MCP tools are deferred, and their descriptions answer the wrong question

In Claude Code these tools arrive as **names only**. The schema loads when the agent runs
`ToolSearch`. The tool description is therefore the entire discovery surface, and it is matched
against what the agent is trying to do.

- `mcp/src/index.js:261` opens *"Run high-level BrowserForce commands. Use this first for browser
  work: tabs, use, open, snapshot, click, fill, press, wait, get, eval."*
- `mcp/src/index.js:161` opens *"Run Playwright JS in the user's real Chrome. Escape hatch."*
- `mcp/src/index.js:135` — the `help` tool.

These describe **what the tool does**. Discovery needs **when to reach for it**: browser, web
page, screenshot, click, sign in, verify a UI, QA, scrape, dogfood. An agent searching "browser"
must hit `mcp/src/index.js:261` first and unambiguously. Today it may not search at all, because
nothing in the name alone says a browser is available.

### 3. The SKILL.md that agents load is not the one the repo ships

```
loaded by Claude Code   ~/brainvault/skills/browserforce/SKILL.md   4,967 B   14 Jul
shipped by the repo     skills/browserforce/SKILL.md                6,250 B    6 Sep
```

Different md5. `~/.claude/skills/browserforce` is a symlink to **brainvault**, not to the repo.

**Editing the repo's SKILL.md changes nothing an agent reads.** The deployed copy forked in July.
There is a `brainvault-sync` skill in `~/.claude/skills/`; if that is the intended pipeline, it
has not run against this file in two months.

**Settle this before making any text edit**, or every fix has to be made twice and will drift
again. One file is the source; everything else is a symlink or a sync step with a check that
fails loudly when they diverge.

### 4. Tab handles renumber on every call, and the docs promise they do not

Three `tabs` calls against the same Chrome, roughly ten minutes apart, with no tabs opened by the
tool between calls 2 and 3:

```
call 1   t1   … t72     72 tabs
call 2   t146 … t218    73 tabs      same tabs, same order
call 3   t219 … t289    71 tabs
```

The same tab was `t1`, then `t146`, then `t219`. The handle appears to come from a counter that
increments once per tab listed, so handles from one call are meaningless in the next.

`help(tabs)` promises *"stable t<N> handles + names"*. `skills/browserforce/SKILL.md` (the newer
repo copy) says *"Stable handles and names persist for the lifetime of the session."*

This is the most dangerous finding. An agent that lists tabs and then acts on a handle does not
get an error — it acts on **the wrong tab**, silently. If that tab is a cloud console or an admin
panel, the cost is not a wasted call.

Either make handles genuinely stable (key them to the Chrome target id) or rename them so nothing
trusts them across calls. Whichever you choose, fix `mcp/src/help-docs.js` (tabs section, around
line 32) and the SKILL.md line — right now the documentation is the trap.

### 5. Every tab is `(untitled)`

Across all three listings above, the only tab carrying a title was one BrowserForce had itself
just opened. Roughly seventy entries read `(untitled)` beside a bare URL. A tab list exists so
that something can choose a tab; without titles it cannot, and `use <name|text>` has nothing to
match against.

### 6. The first call costs about 1,400 tokens

Seventy-two untitled URLs. An expensive and unreliable entry point teaches an agent to avoid the
tool, which is the failure this whole brief is about. Cap the default listing, make it
filterable, and have the output say how many entries were omitted and how to see them.

### 7. `tabs close` cannot be confirmed from its own output — LOW CONFIDENCE

`tabs close <handle>` returned a full tab listing that **still contained** the closed tab. The tab
was gone later, so the close probably worked and the listing was rendered pre-close or from a
stale read.

Also unexplained: the tab count went 73 → 71 across closing one tab. A human was using the
machine at the time and may have closed the other. **Do not treat this as a confirmed
double-close.** Reproduce it deliberately, on throwaway tabs, before changing anything.

## Work items, in order

| # | Work | Where | Done when |
|---|---|---|---|
| 0 | Pick the source of truth for SKILL.md and make divergence impossible | `skills/browserforce/SKILL.md`, `~/brainvault/skills/browserforce/`, the sync step | The two paths cannot differ, and something fails loudly if they do |
| 1 | Description claims browser work outright and says why a fresh-profile driver cannot substitute | `skills/browserforce/SKILL.md:3`, `read_when` 4-9 | An agent asked to "check this page renders" picks BrowserForce unprompted |
| 2 | MCP tool descriptions lead with *when*, not *what* | `mcp/src/index.js:261`, `:161`, `:135` | `ToolSearch("browser")` returns `mcp__browserforce__browserforce` first |
| 3 | Handles stable, or renamed and the docs corrected | tab handle source, `mcp/src/help-docs.js` tabs section, SKILL.md | A handle from call N still names the same tab in call N+1, or nothing claims it does |
| 4 | Titles populated | tab listing | A listing lets you pick a tab without opening one |
| 5 | Default listing capped and filterable | tab listing | The first call is small and says what it omitted |
| 6 | One probe, four distinct answers: relay down / Chrome not running / extension not attached / ready — each naming the fix | status/doctor path | "unavailable" and "never loaded" stop being the same message |
| 7 | Add to the skill: a rendered page can come from a session that already existed | SKILL.md | Stated, with the instruction to corroborate a browser result against independent evidence before calling a flow verified |

Recommended split: **0 first**, then **1 + 2 + 7** as one text-only commit — that is what stops
the wrong browser being picked — then **3**, then the rest.

## How to prove each fix

Text changes (1, 2, 7) have no test. Verify them the way the defect was found: in a fresh
session, give an agent a plain browser task with no tool named, and see which one it picks. Do it
before and after the edit. If you cannot tell the difference, the edit did not work.

Code changes (3-6) get a test that **fails before the fix**. Mutate the line it guards, watch it
go red, restore it. A green assertion nobody has ever seen fail is not a test.

## What was NOT verified

- Whether `agent-browser` is genuinely worse for any given task. It may be better where a clean
  profile is wanted. This brief argues only that it must not win **by default**.
- The cause of the handle renumbering. Only the symptom was observed, from outside the process.
- Finding 7, as stated there.
- The relay, the extension, and the CLI. All untouched.

---

# Verification pass (2026-09-08)

Every finding above was checked against the repo. All seven hold. Three corrections:

**Finding 4 — mechanism was wrong.** Handles are not "a counter incremented per tab listed".
`mcp/src/browser-session-runtime.js:391` keys them in a `WeakMap` on Playwright `Page` object
identity, which is stable while the connection lives. The cause is the idle disconnect
(`disconnectIdleBrowser`, `:184`): its `disconnected` handler (`:281-286`) clears `browser`,
`contextListenerAttached` and `consoleLogs` but not `stableHandles`, `namedPages` or
`nextStableHandleNumber`. Reconnect builds a whole new `Page` graph, every WeakMap key is dead,
every tab draws a fresh handle from a counter that never reset. That is the 72 → t146 → t219
arithmetic exactly (72+73=145, next 146).

**Second consequence, missed by the brief.** `namedPages` (`:114`) holds the old `Page` objects.
`isUsablePage` (`:48`) rejects them and `pruneNamedPages` (`:409`) deletes every one. User-assigned
tab names silently evaporate on idle disconnect too.

**Finding 5 — deliberate, and fixable from another source.** `pageTitleBounded` (`:516`) races
`page.title()` against a 1s timer and returns `''`. The comment at `:510-515` explains why: on a
lazily-attached tab the relay synthetically acks `Runtime.enable`, no execution context arrives,
and an unbounded read hangs forever. The bound is correct; the source is wrong. The relay already
holds every title with no debugger attach — `relay/src/index.js:1488` from the extension's
`listTabs`, maintained by `_handleTabUpdated` (`:1177`), exposed on `/json/list` (`:440`) as
`{ id, title, url }`.

**Finding 7 — confirmed, and worse than "low confidence".** There is no `close` verb in
`COMMAND_SPECS` (`mcp/src/browserforce-command-registry.js:38-57`). `tabs close t123` parses as
verb `tabs` with args `['close','t123']`, and the executor is `case 'tabs': return {}` (`:673`) —
arguments discarded unexamined. The close never happened; the 73 → 71 drift was the human. This is
silent argument discard, not a stale read.

## Already solved — do not rebuild

- `ensureRelay()` (`mcp/src/exec-engine.js:305`) spawns the relay detached and is called at MCP
  startup (`mcp/src/index.js:66`). A down relay already self-heals.
- `runDoctor()` (`mcp/src/doctor.js:89`) already separates relay-unreachable from
  extension-not-connected with per-state detail.
- `assertBrowserforceCoreSkill` (`test/browserforce-skill-contract.js`) already asserts the shipped
  skill and the `npx skills add` installed copy against one contract.

## Adjacent defect found while verifying

`/json/list` and `/json` are absent from `NO_WILDCARD_CORS_PATHS` (`relay/src/index.js:83`) while
serving every tab URL and title *and* `webSocketDebuggerUrl` with the auth token embedded. The
comment two lines above states introspection endpoints carrying tab URLs/titles must not be
readable cross-origin. Any web page can read it. In scope because this plan makes `/json/list`
load-bearing.
