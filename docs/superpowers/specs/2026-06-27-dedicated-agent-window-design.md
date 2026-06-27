# Dedicated Agent Window (opt-in) — Design

**Date:** 2026-06-27
**Author:** Valsaraj
**Status:** Approved (design); spec under review

## Problem

When BrowserForce needs a tab for the agent, it borrows one of the user's
**existing** Chrome windows. Today's "Agent Window Affinity" pins agent-created
tabs to the window the agent *first happened to work in* — which is whatever
window the user had focused — and explicitly creates them as tabs there
(`extension/background.js:443`, "do not spawn separate windows"). The agent's
tabs therefore mix into the user's working window.

The user wants to keep working freely in their own Chrome while the agent runs
isolated: the agent should claim its **own dedicated Chrome window** and keep all
its created tabs organized there, instead of opening tabs in the user's current
window.

## Goal

Add an **opt-in** setting so that, when enabled, the agent's created tabs live in
a dedicated Chrome window separate from the user's windows — without disrupting
the user's current focus or their manually attached tabs.

## Scope (decided)

- **Which tabs:** Agent-**created** tabs only. The first created tab with no
  established window affinity spawns the dedicated window; all later
  agent-created tabs join it. Tabs the user **manually attaches** stay where they
  are in the user's windows.
- **Focus:** The dedicated window opens in the **background**
  (`chrome.windows.create({ focused: false })`). It never steals the user's
  focus.
- **Default:** Setting is **OFF**. Current behavior is preserved exactly when off.
- **Per session:** Each new agent session / CDP client gets its **own fresh**
  dedicated window (no cross-session window reuse — simpler, isolates concurrent
  agents).
- **Closed-window recovery:** If the dedicated window is closed mid-session, the
  next create spawns a **new** dedicated window. It does **not** fall back into
  the user's current window (that fallback is exactly what this feature avoids).

### Out of scope (YAGNI)

- No focus-behavior toggle (background-open is fixed for v1).
- No per-tab separate windows.
- No moving/relocating existing attached tabs into the dedicated window.
- No cross-session dedicated-window reuse.
- No relay-side configuration key (the setting lives in the extension).

## Approach

**Extension-owned decision.** The setting lives in `chrome.storage.local` and the
window-creation API (`chrome.windows.create`) lives in the extension, so the
extension owns the "new window vs. tab in current window" decision. The relay
already (a) sends **no** `windowId` to `createTab` when a client has no window
affinity yet, and (b) **re-pins** affinity from whatever `windowId` the extension
returns (`relay/src/index.js` `_createTarget`). So the relay needs **no logic
change** on the happy path.

Alternatives considered and rejected:

- **Relay-driven:** relay reads the setting and sends an explicit "new window"
  flag. Splits window logic across two components and adds relay code for
  something the extension already half-owns. Against the "minimal relay"
  principle.
- **Hybrid per-client window-state tracking in relay:** redundant with the
  existing `agentWindowByClientId` affinity map. Overengineered.

## Components & Changes

### `extension/window-affinity.js` (pure, synchronous)

Replace `resolveCreateWindowId` with `resolveCreateWindowPlan`, returning a
**plan object** instead of a bare window id (the return type fundamentally
changes, so the rename keeps call sites honest). The decision stays pure and
unit-testable while the async IO stays in `background.js`. New `dedicatedWindowEnabled`
input:

- valid requested window → `{ action: 'use-window', windowId }`
- no/invalid requested window **and** `dedicatedWindowEnabled` →
  `{ action: 'new-window' }`
- no/invalid requested window **and** not `dedicatedWindowEnabled` →
  `{ action: 'current-window', windowId: currentWindowId }`

This is the single source of truth for window resolution. Callers to update:
`extension/background.js` (import + call site), `test/agent/window-affinity.test.js`
(import + assertions), and the `AGENTS.md` "Agent Window Affinity" reference.

### `extension/background.js`

`createTab` / `resolveCreateTabWindowId`:

- Read `dedicatedWindow` from `chrome.storage.local` (alongside the existing
  `mode`, `noNewTabs`, etc. read in `createTab`).
- Build the plan via the pure resolver.
- `use-window` → create tab in `windowId` (today's behavior).
- `current-window` → create tab in the current window (today's behavior).
- `new-window` → `chrome.windows.create({ url, focused: false, type: 'normal' })`,
  attach to its initial tab, and return that `windowId` so the relay re-pins
  affinity to it.

### `extension/popup.html` + `extension/popup.js`

The popup is the only settings surface (`extension/options.*` is the
logs/diagnostics page, not settings). Add a toggle near the existing
"Parallel Tab Visibility" / "Restrictions" controls:

- Storage key: `dedicatedWindow` (boolean), added to `SETTINGS_KEYS`.
- Checkbox id: `bf-dedicated-window`.
- Label: **"Open agent tabs in a dedicated window"**
- Persisted directly on change (it is a window-placement preference, not an
  instruction restriction, so it is NOT wired into the restriction auto-fill).
- Covered by an assertion in `test/agent/popup-contract.test.js`.

### `relay/src/index.js`

**No logic change.** The existing "send no `windowId` when no affinity / re-pin
from the returned `windowId`" path already drives this. During implementation,
re-confirm `_createTarget`'s re-pin branch covers the closed-window overwrite
(when a stale pinned `windowId` is sent, the extension returns a different
`windowId`, and `sentPinned` overwrite re-pins to it).

## Data Flow

```
Target.createTarget (no affinity for clientId)
  → relay sends createTab WITHOUT windowId
    → extension: dedicatedWindow ON + no requested window → plan 'new-window'
      → chrome.windows.create({ focused: false })  (background window)
      → attach debugger to its initial tab
      → return new windowId
    → relay pins agentWindowByClientId[clientId] = newWindowId
Target.createTarget (subsequent)
  → relay sends createTab WITH pinned windowId
    → extension: plan 'use-window' → tab opens in dedicated window
```

Closed-window mid-session: relay sends the stale pinned `windowId`; extension
finds it invalid; with `dedicatedWindow` ON the plan is `new-window` again →
fresh dedicated window → extension returns the new `windowId` → relay overwrites
affinity (existing `sentPinned` re-pin path).

## Interactions

- **Manual mode / `noNewTabs`:** tab creation is already blocked, so the feature
  is a clean no-op there. No conflict.
- **`browserforce` tab-group sync (`syncTabGroup`):** still runs; inside the
  dedicated window it simply groups the agent's tabs. Harmless, no change needed.

## Testing

- **Unit — `test/agent/window-affinity.test.js` (extend the existing plan table):**
  - valid requested window → `use-window`
  - invalid/absent requested window + dedicated ON → `new-window`
  - invalid/absent requested window + dedicated OFF → `current-window`
- **Relay integration:** with a fake CDP session + fake extension, assert that
  with no affinity the relay pins to whatever `windowId` the extension reports,
  and re-pins on overwrite (guard against regression of the existing mechanism).
- **Extension `chrome.windows.create`:** cannot be unit-tested directly (no
  Chrome APIs outside Chrome) — covered indirectly per the project's existing
  constraint.

## Docs

- Update `AGENTS.md` "Agent Window Affinity" section to document the
  `dedicatedWindow` setting, the `new-window` plan, and the closed-window
  re-spawn branch.
- Append a `docs/knowledge/timeline` entry per project rules.

## Success Criteria

1. With `dedicatedWindow` OFF, behavior is byte-for-byte unchanged (regression
   guard).
2. With `dedicatedWindow` ON, the first agent-created tab opens in a new
   **background** Chrome window; subsequent agent-created tabs join that window.
3. Manually attached tabs are never moved.
4. Closing the dedicated window mid-session causes the next create to spawn a new
   dedicated window, not a tab in the user's window.
5. The pure resolver plan table is fully unit-tested.
