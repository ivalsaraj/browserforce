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
