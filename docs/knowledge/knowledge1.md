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
