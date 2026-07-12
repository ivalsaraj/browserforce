# BrowserForce Ghost Cursor Design

**Date**: 2026-07-12  
**Status**: Approved

## Goal

Add an optional visual cursor that makes agent-driven pointer movement visible
in real Chrome tabs. The cursor should feel natural, remain cosmetic, and be
controlled by one extension setting.

## Scope decisions

- Show the cursor in every tab currently controlled by the agent.
- Add one popup setting: `Show ghost cursor for agent actions`.
- Default the setting to off.
- Do not add style, color, size, or speed controls in this version.
- Use a crisp arrow with subtle shadow, smooth movement easing, and press
  feedback.
- Do not change the relay protocol.
- Do not allow cursor failures to affect browser actions.

## User experience

When enabled, the extension injects a fixed, pointer-events-free cursor into
each controlled tab. Agent mouse actions update that cursor independently from
the real Chrome input command:

- `mouseMoved` animates movement.
- `mousePressed` animates movement and a subtle press pulse.
- `mouseReleased` animates movement and restores the cursor scale.
- `mouseWheel` updates the cursor position.

The first action places the cursor at its target without an artificial flight
from the viewport center. Later movements use distance-based durations with
smooth ease-in-out acceleration and deceleration. Press feedback uses a short
ease-out transition. After five seconds without agent activity, the cursor
fades out and wakes on the next action.

Changing the setting applies immediately to already controlled tabs. Disabling
it removes visible cursors and prevents future injection. Navigation restores
the cursor when the setting remains enabled.

## Architecture

### Extension settings

`extension/popup.html` adds the checkbox. `extension/popup.js` loads and stores
`ghostCursorEnabled` through `chrome.storage.local`. The service worker keeps a
small cached setting and reacts to `chrome.storage.onChanged` so existing tabs
update without reconnecting the relay.

### Cursor renderer

`extension/ghost-cursor.js` contains the page-side renderer source and the
pure CDP mouse-event mapping helper. The renderer uses two DOM layers:

- an outer element for translated position;
- an inner element for scale and opacity feedback.

The overlay is `aria-hidden`, has `pointer-events: none`, and uses the highest
available stacking order. It is keyed by a BrowserForce-specific DOM id so
repeated injection is idempotent.

### Debugger lifecycle

On a real debugger attach, the service worker registers the renderer with
`Page.addScriptToEvaluateOnNewDocument` and enables it in the current document.
The registration id is tracked per tab so disabling the setting can remove the
future-navigation script as well as the current overlay. Navigation and
re-attach paths are best-effort and safe if a tab closes during the operation.

### CDP input path

`extension/background.js` observes top-level `Input.dispatchMouseEvent`
commands. It forwards the real command normally, then asynchronously queues a
corresponding cursor update for the same tab. Cursor updates use the injected
page API and never delay or reject the actual input command.

## Reliability and security

- No new extension permissions are required; the existing debugger permission
  is used for page injection.
- Cursor code is only sent to the tab that received the agent command.
- JSON serialization is used when passing mouse coordinates and button values
  into the page expression.
- Injection, navigation, and debugger errors are handled as cosmetic failures
  and logged without changing CDP command results.
- Per-tab queues preserve visual event order when multiple input events arrive
  quickly.
- Tab close and debugger detach remove per-tab cursor bookkeeping.

## Testing strategy

- Add pure unit tests for mouse-event mapping, unsupported event handling, and
  first-action behavior.
- Add extension contract tests for the settings markup, storage key, default,
  storage listener, renderer injection, and cleanup hooks.
- Run focused agent tests, then the complete project test suite.
- Manually verify enable, disable, navigation, click, drag, wheel, tab close,
  and simultaneous controlled tabs in Chrome.

## Acceptance criteria

- The popup exposes a single cursor toggle and persists it.
- The default installation shows no cursor.
- Enabling the toggle makes agent pointer movement visibly animated in every
  controlled tab.
- Click and wheel actions produce natural cursor feedback.
- Disabling the toggle removes cursors immediately and survives navigation.
- Cursor failures never break or noticeably block agent input commands.
- Existing relay, restrictions, tab attachment, and auto-cleanup behavior stay
  unchanged.
