# Critical Patterns

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
