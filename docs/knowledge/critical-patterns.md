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
