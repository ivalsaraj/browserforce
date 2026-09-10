# Timeline 2

## 2026-09-09 — Agent discoverability and durable tab identity

- Rewrote the skill description and the three MCP tool descriptions to claim
  browser work outright and state why a fresh-profile driver cannot substitute:
  agents asked for plain browser work were selecting a hidden competing skill
  and reporting no browser available.
- Added a `browserforce doctor` check that FAILS when a deployed SKILL.md
  differs from the shipped guide. A local copy had forked silently for two
  months, so every text fix reached no agent. Probes per-home and per-project
  skill roots.
- Keyed tab handles and tab names by relay target id. Playwright rebuilds every
  Page object on the idle reconnect, so the previous Page-keyed maps renumbered
  every handle and deleted every user-assigned name on each reconnect — an
  agent acting on a handle from the previous call silently hit the wrong tab.
  Reproduced live: t1..t72 -> t73..t144 across one idle disconnect.
- Sourced tab titles from the relay's `/json/list`. `page.title()` cannot
  resolve on a lazily-attached tab, so every row in a real many-tab session
  listed as `(untitled)` — 72 of 72, measured.
- Widened the extension's tab reporting: `onTabRemoved` and `onTabUpdated` were
  gated on `attachedTabs.has(tabId)`, but attachment is lazy, so closes and
  navigations of unattached tabs never reached the relay's metadata cache.
- Inverted wildcard CORS to an allowlist. A denylist had exempted only
  `/extension/status` and `/attached-tabs`, leaving `/json`, `/json/list` and
  `/json/version` serving the CDP auth token, and `/restrictions` and
  `/agent-preferences` serving user settings, to any page the user visits.
  Only `/` is wildcard now.
- Capped the default `tabs` listing at 20 with `--all`/`--match`/`--limit` and
  an explicit omission notice; the first call had cost ~1,400 tokens.
- `tabs` now refuses positional arguments. `tabs close <handle>` had parsed as a
  bare listing with the arguments discarded: it reported success and closed
  nothing.
- Gave each unready state its own message and fix through a pure
  `classifyReadiness`, and raised `NO_TABS` on the inspect paths only — after
  discovery, where a zero page count is real evidence. `attachedTabs` is empty
  on a healthy browser until `Target.setAutoAttach`, so a pre-connect check
  would have rejected working sessions.
- Documented the subagent handoff. Orchestrators delegate browser work by
  pasting an instruction line, and BrowserForce had none — despite subagents
  already sharing one daemon, and one shared active tab, by default.
- Gave each identified client its own active tab inside the shared session.
  Sharing by default is the reason delegation is worth doing; one shared
  `state.page` made it unsafe the moment two subagents ran at once.

## 2026-07-12 — Optional animated ghost cursor

- Added a default-off Settings toggle, `ghostCursorEnabled`, for visible agent
  action feedback across every currently controlled tab.
- Added a page-side two-layer renderer with eased, distance-aware movement,
  press feedback, idle fading, and automatic re-injection after navigation.
- Mapped only successful top-level `Input.dispatchMouseEvent` calls into
  cosmetic cursor actions; child sessions, malformed input, unsupported events,
  and failed browser commands are ignored.
- Added one serialized, failure-contained queue per tab with pending movement
  coalescing and generation invalidation.
- Normal detach awaits renderer disable and future-navigation script removal;
  unexpected detach cleanup only invalidates state.
- No relay protocol, manifest permission, or dependency changes were needed.
- Added focused renderer/controller/wiring coverage and registered it in the
  agent and full test scripts.

## 2026-09-06 — Bounded CDP traffic log

- Capped `~/.browserforce/cdp.jsonl` at 10 MiB by default, with an environment
  override via `BROWSERFORCE_CDP_LOG_MAX_BYTES`.
- Kept rollover in the existing serialized write queue and skipped individual
  entries that cannot fit within the configured cap.
- Added regression coverage for sustained writes and oversized entries.
