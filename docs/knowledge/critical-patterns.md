# Critical Patterns

## Orphaned debugger pauses

- Any Chrome pause that waits on a debugger reply must be released when no
  connected client will send it. Driving a tab leaves
  `waitForDebuggerOnStart` live after the agent disconnects.
- Awareness is per client. A client that has sent any command on a paused
  child owns its resume, with no deadline. Never resume ahead of it.
- Events the extension cannot forward (relay down, missing tab entry) are
  resolved in the extension, via the pure `orphan-pause-policy.js`.
- Never "fix" this by disabling auto-attach on disconnect. Shared Chrome
  state belongs to every connected client.

## Ghost cursor

- The `ghostCursorEnabled` setting is local, defaults to `false`, and is read by
  the service worker as a live predicate so a setting change takes effect without
  reloading the extension.
- Renderer injection and action updates are serialized per attached tab.
  Consecutive pending movement actions may coalesce; press and wheel actions must
  retain ordering.
- Cursor updates are cosmetic only. The input adapter runs after a successful
  top-level `Input.dispatchMouseEvent` and ignores child sessions, malformed
  coordinates, and unsupported event types.
- Normal detach awaits renderer disable and registered-script removal. Unexpected
  detach cleanup invalidates state without issuing another debugger command.

### Tab groups: shared label, separate owners

**Source**: `knowledge1.md`, 2026-10-28
**Wrong**: Derive visible group labels from ephemeral owner IDs, or change ownership to merge groups.
**Correct**: Use `browserforce` for every managed group; reuse assigned groups across owners only while a live member still matches its persisted assignment. Rename old groups without moving old tabs.
**Why**: MCP restarts change owner IDs. Browser organization must remain consistent while close checks, cleanup and user grouping choices keep their existing semantics.

### Input ordering survives cursor synchronization

**Source**: `knowledge1.md`, 2026-10-29
**Wrong**: Await cursor arrival only for mousePressed while independently forwarding mouseReleased.
**Correct**: Queue native mouse commands per tab before asynchronous checks or synchronization, continue after failures, and clear only the settled tail.
**Why**: An up-before-down sequence silently prevents real clicks even when locator actions return successfully.
