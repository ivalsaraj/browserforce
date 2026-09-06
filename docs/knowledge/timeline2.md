# Timeline 2

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
