# Timeline 2

## 2026-10-02 — Release orphaned debugger pauses

- Fixed agent-driven tabs hanging on reload until the debugging infobar was
  cancelled. Playwright's `waitForDebuggerOnStart` auto-attach stays live in
  Chrome after the agent disconnects, and new child targets (service workers,
  OOPIFs, workers) waited forever for a resume.
- The relay now resumes a paused child:
  - at once when no client is connected;
  - at once when the client that engaged the child leaves;
  - after a 2s grace when connected clients never touch it.
  Retries are bounded, and resumes are passive.
- The extension resolves pauses itself when the relay socket is down or the
  tab entry is missing, and resumes all child sessions when the live relay
  socket closes.
- Deferred: request interception (`Fetch`) left behind by `page.route` owners.
  Plan review showed it needs per-debuggee ownership and serialization; it is
  tracked separately.

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

## 2026-10-28 — Agent tabs stop stealing the user's screen

- Agent-created tabs now open as background tabs in the pinned or last-focused
  normal window, in a named tab group per agent (title from `agentName`, else
  `Agent <id>`). A window is created only when no normal window exists. Live
  test: Chrome on macOS opens every new window as a full-screen Space while the
  user is in full screen, whatever bounds/state/focused flags are passed, so a
  new window cannot avoid the jump; a new tab in an existing window can.
- The dedicated agent window is now opt-in (`dedicatedWindow === true`).
  `parallelVisibilityMode` no longer changes behaviour.
- Top-level `Page.bringToFront` activates the tab inside its window and never
  focuses the window.
- Grouping happens once, on create; user drag/ungroup is never undone.

## 2026-10-28 — Emulation overrides die with their agent; tab ownership shown

- The relay records which client forwarded each `Emulation.*` override to an
  attached tab and sends a passive reset when the last connected holder leaves
  (viewport, media, touch, focus, geolocation, locale, timezone, background
  color, script execution, automation). `setUserAgentOverride` is excluded: CDP
  documents no reset.
- MCP saves exactly-identified pages' viewports before its 15s idle disconnect
  and re-applies them on reconnect (best-effort; never fails the reconnect).
- `tabs` marks agent-created tabs `[yours]` or `[owned by <agent>]`; help text
  tells agents to open their own tab instead of reusing another agent's.

## 2026-10-28 — Physics ghost cursor, click sync, driven-tab badge

- Ghost cursor motion rebuilt on fixed-step springs: curved Bézier arcs for
  long moves (> 196px, chosen to stay 20px inside the viewport), tangent
  rotation, speed narrowing, arrival detection, idle wiggle, fade/scale/blur
  appear, blue glow, `prefers-reduced-motion` support.
- `ghostCursorClickSync` (popup, default off): waits up to 600ms for the cursor
  to arrive before forwarding a top-level `mousePressed`.
- Driven-tab favicon badge (`extension/tab-badge.js`): a real top-level command
  marks the tab driven; icon re-asserted against page rewrites; exact original
  restored after 15s idle or detach.
- `Denying load of chrome-extension://…/assets/ghost-cursor.png`: Chrome refuses
  web-accessible resources to `about:blank`/`about:srcdoc`/opaque-origin
  documents, where the new-document script also runs. The cursor now skips
  subframes and uses an inline SVG on those origins.

## 2026-10-28 — Agent popups stay in the background; JS dialogs reported

- Popups (`window.open`, `target=_blank`) whose opener is an agent-created tab,
  or an attached tab with a real command in the last 5s, are adopted via
  `tabs.onCreated` + `openerTabId`: moved into the opener's window, the user's
  previous tab re-selected, grouped with the opener, owner/name inherited, made
  auto-closable. Relay keeps the opener mapping so Playwright still fires
  `popup`. Chrome creates the tab first, so a brief flash or Space switch can
  still happen. No new permission.
- Dialogs: one shared per-page handler records `{type,message,defaultValue,url,at}`,
  accepts alert/beforeunload, dismisses confirm/prompt by default, and appends a
  notice to the next result. `armDialog({accept, promptText})` pre-arms one
  response for the current run; `getDialogs()` returns bounded history. With no
  `/cdp` client connected the relay leaves dialogs open for the user.

## 2026-10-28 — Approved ghost cursor redesign

- Owner-approved inline SVG arrow (rounded, shallow notch, white outline, two-layer
  #339cff glow), resting at -44°, tip is the hotspot and rotation pivot.
- Motion retuned to measured reference values: response/damping springs at a
  1/240s step, 20 scored path candidates leaving and landing tip-first, scoot
  tilt/squash for short moves, one 1.41s wiggle burst on arrival, spring-driven
  appear/disappear, click-sync bound 1500ms. Favicon badge shares the arrow path.
- PNG asset and its `web_accessible_resources` entry removed (no reader left).

## 2026-10-28 — The CLI agent name is its tab-ownership identity

- Symptom: a CLI agent's own tabs showed `owned by <short id>` on its next call;
  each one-shot `-e` connected unlabeled, so every call was a new owner.
- `cliClientLabel()` maps `BROWSERFORCE_AGENT_NAME` to the label
  `browserforce-cli-<name>` for one-shot calls and sessiond (owner check uses the
  same label). Unnamed one-shot calls stay unlabeled; MCP keeps its random label.
- Skill now opens with "Name yourself first": one name, ≤24 chars, every call.

## 2026-10-28 — JavaScript dialogs belong to the run driving the page

- Symptom: `No dialog is showing` / an agent's confirm vanished. The relay
  broadcasts every dialog to every CDP client, and any client's handler (or
  Playwright's no-listener auto-dismiss) answered dialogs on other agents' pages.
- `dialogs.js` now handles and records a dialog only while a run drives that
  page (active/pinned page, page it created, armed, or sent commands to). Other
  pages keep a no-op listener so Playwright does not auto-dismiss; previously
  driven pages hold up to 100 pending dialogs for the next run on them.
  `armDialog` accepts an explicit `page`.
- Live: two sessiond clients on real Chrome; B's 6s run left A's confirm open,
  A's next run dismissed it with one notice. Known limit: older/foreign
  Playwright clients without the listener still auto-dismiss.

## 2026-10-28 — Popup click-sync toggle was never wired

- Symptom: "Sync clicks with cursor arrival" always disabled; popup console
  `ReferenceError: syncGhostCursorClickSyncState is not defined`. The throw also
  skipped loading saved instructions and the auto-mode note.
- Cause: the helper and the save handler were never written; the contract test
  only regex-matched the name. `.checkbox-row { display: flex }` also beat the
  `hidden` attribute, so the row never hid.
- Fix: helper + handlers in `extension/popup.js`, `.checkbox-row[hidden]` rule,
  and a vm test that runs popup.js and toggles the controls.
