# Knowledge 1

## 2026-07-12 — Ghost cursor async-safety decision

The setting predicate is read live by the per-tab controller so enabling and
disabling the feature takes effect without reconstructing the service worker.
Each tab queue carries a generation; disabling or cleanup increments it so stale
queued actions cannot inject or evaluate cursor work after the feature is off or
the debugger has detached. The disable operation deliberately bypasses the live
enabled predicate so a setting change can tear down an already-rendered cursor,
while post-detach cleanup only clears state and never sends a new debugger
command. Cursor failures are logged and contained after the real input command,
so cosmetic feedback cannot alter CDP input behavior or its result.

The service-worker module keeps only the identifiers and action-validation values
it needs; renderer motion constants live in the injected source so there is one
authoritative page-side definition rather than two unused copies that could drift.

## 2026-09-06 — [BUG] Bound the CDP traffic log (@Valsaraj)

**Scope**: relay
**Problem**: A long-lived relay allowed `~/.browserforce/cdp.jsonl` to grow to
many gigabytes and consume local disk space.
**Root Cause**: The logger serialized append operations but enforced retention
only by truncating the file at process startup.
**Fix**: Added a 10 MiB default byte cap with in-queue rollover and oversized
entry rejection in `relay/src/cdp-log.js`, plus regression coverage in
`relay/test/relay-server.test.js`.
**Rule**: Bound persistent diagnostic logs during writes; process-restart cleanup
is not a retention policy.
**Files**: `relay/src/cdp-log.js`, `relay/test/relay-server.test.js`

## 2026-10-28 — [CORRECTION] Keep browser group labels independent of agent identity (@Valsaraj)

**Scope**: extension
**Problem**: One logical agent could produce multiple `Agent ####` groups after MCP process replacement; the user requested a common `browserforce` label, even when multiple groups exist.
**Root Cause**: Group selection, titles and colors depended on the connection owner's identity.
**Fix**: `extension/tab-group-sync-plan.js` selects a shared group per window from persisted assignments with live members. `extension/background.js` names both grouping paths `browserforce` with the existing orange color and handles rename-only plans without grouping empty tab lists.
**Rule**: Keep visual group labels independent of agent ownership; never repair grouping by collapsing internal owner identities or regrouping user-moved tabs.
**Files**: `extension/tab-group-sync-plan.js`, `extension/background.js`, `test/agent/tab-group-sync-plan.test.js`

## 2026-10-29 — [BUG] Mouse release overtook click-synchronized press (@Valsaraj)

**Scope**: extension
**Problem**: Locator clicks returned without activating controls; trusted DOM events showed mouseup before mousedown on the correct element.
**Root Cause**: Relay messages execute concurrently. Asynchronous restriction checks and click-sync delay could hold mousePressed while mouseReleased reached Chrome first.
**Fix**: Added a per-tab FIFO before all mouse-command async work; failures propagate while later commands continue, and only the current tail deletes its queue entry.
**Rule**: Serialize native mouse commands, not just cosmetic cursor updates, when an adapter delays dispatch.
**Files**: `extension/background.js`, `test/agent/mouse-command-order.test.js`, `docs/qa/2026-10-29-mouse-command-order.md`

## 2026-10-29 — [CORRECTION] Separate window type from display state and native focus (@Valsaraj)

**Scope**: extension
**Problem**: Turning separate-window mode off puts agent tabs in the user's working window, defeating the requested isolation. The existing separate-window request also reproduced a native Space switch.
**Root Cause**: `type: 'normal'` chooses a tabbed window, not its display state. A `focused: false` request alone did not establish native no-interruption behavior. The older timeline's universal bounds/state claim is not supported by its retained mocked-test logs.
**Outcome**: Explicit normal state plus 1,000 × 700 bounds passed unit checks but failed after confirmed reload: the native window initially matched the request, then converted to fullscreen and switched Space35 → 242 → 35. Reverted the failed request change. Minimized creation and explicit user-adopted windows remain untested alternatives requiring a UX choice and native verification.
**Rule**: Verify native focus and active Space independently of request parameters and page focus emulation; do not replace isolation with shared-window placement to hide a focus problem.
**Files**: `extension/background.js`, `test/agent/background-window-plan.test.js`, `docs/qa/2026-10-29-normal-agent-window.md`
**Supersedes**: docs/knowledge/timeline2.md, 2026-10-28 — Agent tabs stop stealing the user's screen (only the unsupported universal live-test claim).
