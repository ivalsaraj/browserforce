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
