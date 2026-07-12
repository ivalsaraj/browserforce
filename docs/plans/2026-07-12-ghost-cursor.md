# BrowserForce Ghost Cursor Implementation Plan

> **For implementers:** REQUIRED SUB-SKILL: Use `@superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add an opt-in, natural-looking cursor overlay for agent pointer actions in every controlled Chrome tab.

**Architecture:** Keep the relay protocol unchanged. The extension service worker maps top-level `Input.dispatchMouseEvent` commands into cursor actions, injects a page-side two-layer renderer through the existing debugger connection, and queues cosmetic updates per tab without awaiting them in the real CDP command path. A single `chrome.storage.local` checkbox controls current-tab updates and future navigation injection.

**Tech Stack:** MV3 extension service worker, Chrome debugger CDP, browser DOM/CSS, vanilla JavaScript, Node built-in test runner.

---

### Task 1: Add failing cursor mapping and contract tests

**Files:**
- Create: `/Users/valsaraj/Documents/projects/chrome-connect-relay/test/agent/ghost-cursor.test.js`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/package.json:59-63`

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

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
```

Expected: FAIL because `extension/ghost-cursor.js` does not exist and the
settings/injection contracts are not present yet.

### Task 2: Implement the page-side cursor renderer

**Files:**
- Create: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/ghost-cursor.js`
- Test: `/Users/valsaraj/Documents/projects/chrome-connect-relay/test/agent/ghost-cursor.test.js`

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

Also export a page-source string and an expression builder that passes an
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

**Step 3: Run the focused tests**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
```

Expected: pure event mapping tests pass; extension contract tests remain red
until the service-worker and popup integration tasks are complete.

### Task 3: Integrate renderer lifecycle into the service worker

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js:1-115,285-320,642-805,828-845`
- Test: `/Users/valsaraj/Documents/projects/chrome-connect-relay/test/agent/ghost-cursor.test.js`

**Step 1: Add setting and per-tab state**

Import the renderer source, mapping helper, and expression helper. Add:

- `isGhostCursorEnabled`, initialized to `false` and hydrated from the
  `ghostCursorEnabled` storage key with the initial
  `chrome.storage.local.get` call before starting the maintain loop.
- `ghostCursorStateByTab`, keyed by tab id, storing the new-document script id,
  an in-flight setup promise, and a per-tab update queue.
- A single disable expression that calls the injected API when present.

**Step 2: Add enable/disable helpers**

Implement `enableGhostCursorForTab(tabId)`:

- Return immediately when the setting is off or the tab is not attached.
- Reuse the existing script id when available.
- Otherwise send `Page.addScriptToEvaluateOnNewDocument` with the page source
  and store its returned `identifier`.
- Send `Runtime.evaluate` with the page source for the current document.
- Serialize concurrent setup calls through the stored promise and clear it in
  `finally`.

Implement `disableGhostCursorForTab(tabId)`:

- Evaluate the disable expression while the debugger is still available.
- Remove the registered new-document script when a script id exists.
- Clear the script id and queued state safely even if the tab is closing.

Implement a best-effort `cleanupGhostCursorTab(tabId)` for detach/close paths
that drops the per-tab state without throwing.

**Step 3: Wire attach, detach, and close paths**

- Start `enableGhostCursorForTab(tabId)` after `attachTab` registers the tab;
  do not make attach wait for cosmetic injection.
- Call `disableGhostCursorForTab(tabId)` before normal `detachTab` and
  `closeTab` debugger detaches.
- Call cleanup from `cleanupTab` and clear all cursor state in the
  `canceled_by_user` detach cascade.
- Keep tab-removal and debugger-detach handlers safe when the debugger is
  already unavailable.

**Step 4: Wire input event updates without blocking CDP**

In `cdpCommand`, after the real `chrome.debugger.sendCommand` resolves:

- Only handle top-level `Input.dispatchMouseEvent` calls (no child session).
- Build an action with `buildGhostCursorAction`.
- If an action exists and the setting is enabled, append a queued
  `Runtime.evaluate` update for that tab.
- Start the queue with `void` and catch/log failures at debug level. Never
  await it and never replace the real command result or error.
- Check the setting again inside the queued continuation so a quick disable
  prevents stale updates.

**Step 5: Apply setting changes live**

Extend the existing `chrome.storage.onChanged` listener:

- Update `isGhostCursorEnabled` from the `ghostCursorEnabled` storage change.
- When enabled, start best-effort setup for every attached tab.
- When disabled, await or schedule disable operations for every attached tab
  and clear their state.

**Step 6: Run focused tests**

Run:

```bash
node --test test/agent/ghost-cursor.test.js
```

Expected: all cursor mapping and extension contract tests pass.

### Task 4: Add the extension Settings toggle

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/popup.html:95-112`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/popup.js:20-150`
- Test: `/Users/valsaraj/Documents/projects/chrome-connect-relay/test/agent/ghost-cursor.test.js`

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
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/docs/DEVELOPMENT.md`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/docs/knowledge/timeline1.md`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/AGENTS.md`

**Step 1: Document user-facing behavior**

Add a short Development Guide section explaining the opt-in popup setting,
default-off behavior, per-controlled-tab scope, animation/idle behavior, and
the fact that cursor errors are cosmetic.

**Step 2: Add the append-only timeline entry**

Prepend a dated 2026-07-12 entry to `docs/knowledge/timeline1.md` describing
the renderer, setting, CDP input mapping, lifecycle cleanup, tests, and the
no-relay-change decision.

**Step 3: Record the critical implementation contract**

Add an `AGENTS.md` critical pattern stating that cursor updates must remain
asynchronous and isolated from the real CDP input command, and that the
new-document script must be removed when the setting is disabled.

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
git add extension/ghost-cursor.js extension/background.js extension/popup.html extension/popup.js test/agent/ghost-cursor.test.js test/agent/popup-contract.test.js package.json docs/DEVELOPMENT.md docs/knowledge/timeline1.md AGENTS.md
git commit -m "feat(extension): add optional animated ghost cursor" -m "- Render natural per-tab cursor movement for agent mouse events.\n- Add a default-off popup setting with live enable and disable behavior.\n- Keep cursor updates cosmetic and document the lifecycle contract."
```

**Step 5: Report verification**

Include the focused and full test commands, the commit, the setting name, and
the manual Chrome checks that remain useful after reloading the unpacked
extension.
