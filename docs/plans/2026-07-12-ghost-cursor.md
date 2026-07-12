# BrowserForce Ghost Cursor Implementation Plan

> **For implementers:** REQUIRED SUB-SKILL: Use `@superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add an opt-in, natural-looking cursor overlay for agent pointer actions in every controlled Chrome tab.

**Architecture:** Keep the relay protocol unchanged. The extension service worker maps top-level `Input.dispatchMouseEvent` commands into cursor actions, injects a page-side two-layer renderer through the existing debugger connection, and queues cosmetic updates per tab without awaiting them in the real CDP command path. A single `chrome.storage.local` checkbox controls current-tab updates and future navigation injection.

**Tech Stack:** MV3 extension service worker, Chrome debugger CDP, browser DOM/CSS, vanilla JavaScript, Node built-in test runner.

---

### Task 1: Add failing cursor mapping and contract tests

**Files:**
- Create: `test/agent/ghost-cursor.test.js`
- Modify: `test/agent/popup-contract.test.js`
- Modify: `package.json:59-63`

**Step 1: Write the failing tests**

Create tests that import `buildGhostCursorAction` from
`extension/ghost-cursor.js` and read the extension files as text.

Pure mapping cases:

```js
assert.deepEqual(
  buildGhostCursorAction({
    type: 'mouseMoved',
    params: { x: 40, y: 90 },
  }),
  { type: 'move', x: 40, y: 90, button: 'none' },
)

assert.deepEqual(
  buildGhostCursorAction({
    type: 'mousePressed',
    params: { x: 40, y: 90, button: 'left' },
  }),
  { type: 'down', x: 40, y: 90, button: 'left' },
)

assert.deepEqual(
  buildGhostCursorAction({
    type: 'mouseReleased',
    params: { x: 40, y: 90, button: 'left' },
  }),
  { type: 'up', x: 40, y: 90, button: 'left' },
)

assert.deepEqual(
  buildGhostCursorAction({
    type: 'mouseWheel',
    params: { x: 40, y: 90 },
  }),
  { type: 'wheel', x: 40, y: 90, button: 'none' },
)

assert.equal(buildGhostCursorAction({ type: 'touchStart', params: { x: 1, y: 2 } }), null)
assert.equal(buildGhostCursorAction({ type: 'mouseMoved', params: { x: '40', y: 90 } }), null)
```

Contract cases should assert that:

- `popup.html` contains `bf-ghost-cursor` and the user-facing toggle label.
- `popup.js` loads `ghostCursorEnabled`, hydrates the checkbox, and persists
  changes through `chrome.storage.local.set`.
- `background.js` imports the renderer helpers, handles the setting change,
  injects through `Page.addScriptToEvaluateOnNewDocument`, observes
  `Input.dispatchMouseEvent`, and removes the per-tab renderer state.
- `package.json` runs the new test in both `test` and `test:agent`.

Add controller behavior tests against the same exported dependency-free
controller that the service worker will use. Cover setup ordering, coalescing
consecutive movement updates, preserving press/release order, quick disable
invalidating pending actions, cleanup while a command rejects, and independent
state for two attached tabs. Add adapter tests for child-session and malformed
event rejection, a throwing controller/log path that must not throw, and an
assertion that the real input result remains available to `cdpCommand` when the
cosmetic adapter fails.

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
```

Expected: FAIL because `extension/ghost-cursor.js` does not exist and the
settings/injection contracts are not present yet.

### Task 2: Implement the page-side cursor renderer

**Files:**
- Create: `extension/ghost-cursor.js`
- Test: `test/agent/ghost-cursor.test.js`

**Step 1: Implement pure event mapping**

Export `buildGhostCursorAction({ type, params })` with this exact contract:

- `mouseMoved` → `move`.
- `mousePressed` → `down`.
- `mouseReleased` → `up`.
- `mouseWheel` → `wheel`.
- Accept only finite numeric `params.x` and `params.y`.
- Normalize missing buttons to `none`.
- Preserve only `left`, `right`, and `middle`; normalize all other values to
  `none`.
- Return `null` for unsupported or malformed events.

Also export a page-source string, a dependency-free per-tab lifecycle
controller, and an expression builder that passes an
already-serialized action to the injected API. JSON serialization must happen
before building the expression so coordinates and button values cannot alter
the expression structure.

**Step 2: Implement the injected renderer**

The exported source must be self-contained and install
`globalThis.__browserforceGhostCursor` with `enable`, `disable`, and
`applyMouseAction` methods. Use a BrowserForce-specific DOM id and make repeat
installation idempotent.

Renderer requirements:

- Use an outer fixed element for `translate3d` position and an inner element
  for scale/opacity feedback.
- Render a crisp arrow using an inline SVG data URL with a light fill, dark
  outline, and subtle drop shadow.
- Set `pointer-events: none`, `aria-hidden: true`, `z-index: 2147483647`, and
  `will-change: transform`.
- On the first action, place the cursor directly at the target without a move
  transition. Subsequent moves use `cubic-bezier(0.65, 0, 0.35, 1)` with a
  distance-derived duration clamped between 220ms and 1500ms at 1.2px/ms.
- For press/release, scale the inner element to `0.95` and restore it with a
  140ms `cubic-bezier(0.23, 1, 0.32, 1)` transition.
- Hide after 5 seconds without an action with a 600ms opacity transition.
- Wake from idle at the next action without replaying the full travel path.
- Schedule mounting from the document element/body so scripts registered for
  new documents work at document start.
- `disable` clears the idle timer and removes the DOM node.

**Step 3: Implement the shared per-tab operation controller**

Export `createGhostCursorController({ isEnabled, isTabAttached, sendCommand,
log })`, where `isEnabled` and `isTabAttached` are functions evaluated both
when an operation is enqueued and when it executes. The service worker must use this controller rather than maintaining a
second queue implementation. The controller owns one operation queue per tab
and exposes `enable(tabId)`, `queueAction(tabId, action)`, `disable(tabId)`,
and `cleanup(tabId)`.

The queue must:

- serialize `Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`, and
  `Page.removeScriptToEvaluateOnNewDocument` operations per tab;
- coalesce consecutive pending `move` actions while preserving every
  `down`, `up`, and `wheel` action in order;
- capture a generation number for queued actions and invalidate it immediately
  when disabling or cleaning up, so stale actions cannot re-enable or update a
  tab;
- re-read `isEnabled()` and `isTabAttached(tabId)` at execution time, so a
  storage change or detach that occurs while work is queued takes effect;
- settle all rejected cosmetic operations through `log` without rejecting
  callers or affecting real CDP input results;
- remove per-tab state only after invalidated operations settle.

`disable(tabId)` is the ordered barrier used while the debugger is still
available: it invalidates stale actions, performs the page-side disable and
script removal, and resolves after both settle. `cleanup(tabId)` is the
post-detach invalidation path: it must not start new debugger commands, must not
cancel an already-enqueued disable barrier, and removes state after the queue
settles.

Export `handleGhostCursorInput({ method, childSessionId, tabId, params,
controller, log })` as the single input-path adapter. It must ignore child
sessions, non-`Input.dispatchMouseEvent` methods, and malformed events;
otherwise it must map the event and call the supplied controller inside a
non-throwing boundary that reports synchronous mapping/controller failures to
`log`. `background.js#cdpCommand()` must call this adapter after the real
debugger command resolves inside an explicit detached `try/catch`, so tests can
exercise the same method predicate and queue entry used in production without
changing the original input result.

The registered page source must call `enable()` at document start so a
new-document execution both installs and mounts the visible cursor. The
current-document evaluation uses the same source and therefore has identical
mount behavior.

**Step 4: Add the same-source renderer harness**

Use Node’s built-in `node:vm` with a small fake DOM and deterministic timer
queue to execute the exported page source itself. Do not duplicate renderer
logic in the test. Assert that the real source:

- installs and enables the API at document start;
- places the first action without a move transition;
- uses the declared ease-in-out curve and distance-derived duration on later
  movement;
- applies press/release scale and opacity transitions;
- schedules idle fade, wakes on the next action, and preserves the new target;
- can execute again against a fresh document to model navigation; and
- removes the DOM node and clears the API state on disable.

**Step 5: Run the focused tests**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
```

Expected: mapping, controller, and renderer-source tests pass; extension contracts remain
red until the service-worker and popup integration tasks are complete.

### Task 3: Integrate renderer lifecycle into the service worker

**Files:**
- Modify: `extension/background.js:1-115,285-320,642-805,828-845`
- Test: `test/agent/ghost-cursor.test.js`

**Step 1: Add setting and per-tab state**

Import the renderer source, shared controller, and input-path adapter. Add:

- `isGhostCursorEnabled`, initialized to `false` and hydrated from the
  `ghostCursorEnabled` storage key with the initial `chrome.storage.local.get`
  call before starting the maintain loop.
- One `ghostCursorController` created from the shared controller in
  `extension/ghost-cursor.js`, configured with the service worker’s attached-tab
  predicate `isTabAttached: (tabId) => attachedTabs.has(tabId)`, live setting
  predicate `isEnabled: () => isGhostCursorEnabled`, debugger command function,
  and debug logger.
- A single disable expression that calls the injected API when present.

**Step 2: Add enable/disable helpers**

Delegate enable, action, disable, and cleanup operations to
`ghostCursorController`. Do not duplicate queue, generation, script-id, or
error-handling state inside `background.js`.

The controller’s `sendCommand` adapter must call
`chrome.debugger.sendCommand({ tabId }, method, params)` for top-level page
commands. Every controller entry point must remain best-effort and attach a
`.catch()` boundary at detached call sites.

**Step 3: Wire attach, detach, and close paths**

- Start `ghostCursorController.enable(tabId)` after `attachTab` registers the tab;
  do not make attach wait for cosmetic injection.
- Define `ghostCursorController.disable(tabId)` as a settled, best-effort
  barrier: it invalidates pending actions, queues page-side disable and
  new-document script removal, and resolves only after those operations settle.
- Await that disable barrier, with a catch/log boundary, before normal
  `detachTab` and `closeTab` debugger detaches. Then call
  `ghostCursorController.cleanup(tabId)` after the debugger detach.
- Call `ghostCursorController.cleanup(tabId)` from `cleanupTab` and clear all
  cursor state in the `canceled_by_user` detach cascade.
- Keep tab-removal and unexpected debugger-detach handlers safe when the
  debugger is already unavailable: cleanup only invalidates state and never
  attempts a new debugger command. Cleanup must not cancel an already-enqueued
  disable barrier; it waits for that operation to settle before removing state.

**Step 4: Wire input event updates without blocking CDP**

In `cdpCommand`, after the real `chrome.debugger.sendCommand` resolves:

- Only handle top-level `Input.dispatchMouseEvent` calls (no child session).
- Call `handleGhostCursorInput({ method, childSessionId, tabId, params,
  controller: ghostCursorController, log })` inside a detached `try/catch`
  after the real debugger command succeeds.
- The adapter and controller catch/log all cosmetic failures. Never await them
  and never replace the real command result or error.
- The controller re-checks its live predicates and generation inside the
  queued continuation so a quick disable prevents stale updates.

**Step 5: Apply setting changes live**

Extend the existing `chrome.storage.onChanged` listener and require
`areaName === 'local'` before handling the setting:

- Update `isGhostCursorEnabled` from the `ghostCursorEnabled` storage change.
- When enabled, start best-effort setup for every attached tab and attach a
  catch boundary to the bulk operation.
- When disabled, use `Promise.allSettled` for disable operations across every
  attached tab so one debugger failure cannot prevent other tabs from hiding.

**Step 6: Run focused tests**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
```

Expected: all cursor mapping and extension contract tests pass.

### Task 4: Add the extension Settings toggle

**Files:**
- Modify: `extension/popup.html:85-112`
- Modify: `extension/popup.js:20-150`
- Test: `test/agent/ghost-cursor.test.js`

**Step 1: Add the checkbox markup**

Add a `Ghost cursor` settings field using the existing `settings-group` and
`checkbox-row` styles:

```html
<section class="field">
  <label>Visual feedback</label>
  <div class="settings-group">
    <label class="checkbox-row">
      <input type="checkbox" id="bf-ghost-cursor">
      <span>Show ghost cursor for agent actions</span>
    </label>
  </div>
</section>
```

Place it with the other behavior settings, before restrictions. Do not add a
new permission or a second control.

**Step 2: Wire storage hydration and persistence**

Add `ghostCursorEnabled` to `SETTINGS_KEYS`, add a DOM reference, hydrate it
with `!!s.ghostCursorEnabled`, and persist changes with:

```js
ghostCursorCb.addEventListener('change', () => {
  chrome.storage.local.set({ ghostCursorEnabled: ghostCursorCb.checked });
});
```

**Step 3: Run focused tests**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
node --test test/agent/popup-contract.test.js
```

Expected: both suites pass.

### Task 5: Update project documentation and run propagation checks

**Files:**
- Modify: `docs/DEVELOPMENT.md`
- Create: `docs/knowledge/timeline2.md`
- Modify: `docs/knowledge/INDEX.md`
- Modify: `docs/knowledge/knowledge1.md`
- Modify: `docs/knowledge/critical-patterns.md`
- Modify: `AGENTS.md`

**Step 1: Document user-facing behavior**

Add a short Development Guide section explaining the opt-in popup setting,
default-off behavior, per-controlled-tab scope, animation/idle behavior, and
the fact that cursor errors are cosmetic.

**Step 2: Create the next append-only timeline file**

Because the active `timeline1.md` is already over 500 lines, create
`docs/knowledge/timeline2.md`, add it to `docs/knowledge/INDEX.md` as the only
active timeline, mark `timeline1.md` `ARCHIVED` in the index, and start the new
file with a short bullet summary. Append a dated
2026-07-12 entry describing the renderer, setting, CDP input mapping, lifecycle
cleanup, tests, and the no-relay-change decision. Do not edit existing entries
in `timeline1.md`.

Update the index prose so it names `timeline2.md` as the active changelog and
describes `timeline1.md` as the archived historical changelog.

Append a structured decision entry to the active `docs/knowledge/knowledge1.md`
covering the live-setting predicate, generation invalidation, and the rule that
cosmetic cursor failures cannot alter real CDP input behavior.

**Step 3: Record the critical implementation contracts**

Add an `AGENTS.md` critical pattern and a promoted
`docs/knowledge/critical-patterns.md` entry stating that cursor updates must
remain asynchronous and isolated from the real CDP input command, the
per-tab generation must invalidate stale queued actions, and the new-document
script must be removed when the setting is disabled.

**Step 4: Search propagation**

Run:

```bash
rg -n --glob '!node_modules/**' 'ghostCursorEnabled|bf-ghost-cursor|__browserforceGhostCursor|Input\.dispatchMouseEvent|Page\.addScriptToEvaluateOnNewDocument' extension test docs package.json
```

Expected: every production reference has a corresponding test or document
reference, with no stale setting names or orphaned helper names.

### Task 6: Verify the complete change and commit the implementation

**Files:**
- Test: all extension/agent tests and the full project suite.

**Step 1: Run the focused agent suite**

Run:

```bash
pnpm test:agent
```

Expected: PASS.

**Step 2: Run the complete project suite**

Run:

```bash
pnpm test
```

Expected: PASS. If an unrelated pre-existing failure appears, capture its
exact test and error in the handoff instead of changing unrelated code.

**Step 3: Check the diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only the cursor implementation, tests, package test registration,
and the documented feature changes are present.

**Step 4: Commit the implementation**

Stage only the implementation files, tests, package metadata, and updated
documentation:

```bash
git add extension/ghost-cursor.js extension/background.js extension/popup.html extension/popup.js test/agent/ghost-cursor.test.js test/agent/popup-contract.test.js package.json docs/DEVELOPMENT.md docs/knowledge/INDEX.md docs/knowledge/knowledge1.md docs/knowledge/timeline2.md docs/knowledge/critical-patterns.md AGENTS.md
git commit -m "feat(extension): add optional animated ghost cursor" -m "- Render natural per-tab cursor movement for agent mouse events.\n- Add a default-off popup setting with live enable and disable behavior.\n- Keep cursor updates cosmetic and document the lifecycle contract."
```

**Step 5: Report verification**

Include the focused and full test commands, the commit, the setting name, and
the manual Chrome checks that remain useful after reloading the unpacked
extension.
