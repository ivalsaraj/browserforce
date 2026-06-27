# Dedicated Agent Window (opt-in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in setting so the agent's *created* tabs open in a dedicated background Chrome window instead of borrowing the user's current window.

**Architecture:** The decision of "new dedicated window vs. tab in an existing window" is a pure function in `extension/window-affinity.js`; all async Chrome IO (validating a window, reading the current window, creating a window) stays in `extension/background.js`. The relay needs **no logic change** — it already sends no `windowId` when a client has no window affinity and re-pins affinity from whatever `windowId` the extension returns. The setting lives in `chrome.storage.local`, surfaced as a popup toggle.

**Tech Stack:** Vanilla JS ES modules, MV3 extension (`chrome.windows`, `chrome.tabs`, `chrome.storage`, `chrome.debugger`), `node:test` for unit tests.

**GitHub Issue:** #14 — https://github.com/ivalsaraj/browserforce/issues/14

**Spec:** `docs/superpowers/specs/2026-06-27-dedicated-agent-window-design.md`

## Global Constraints

- **No new dependencies.** Relay stays `ws`-only; extension stays dependency-free.
- **Default OFF.** With `dedicatedWindow` unset/false, behavior is byte-for-byte unchanged.
- **Storage key:** `dedicatedWindow` (boolean). **Checkbox id:** `bf-dedicated-window`.
- **New window is opened in the background:** `chrome.windows.create({ focused: false, type: 'normal' })`.
- **Scope:** agent-**created** tabs only. Never move manually attached tabs.
- **Window resolution stays centralized** in the pure `extension/window-affinity.js` resolver — `background.js` must not re-implement the decision.
- Run tests with `node --test <file>` (matches `package.json` scripts).

---

### Task 1: Pure resolver returns a window *plan*

Replace the bare-id resolver with one that returns a plan object and accepts a `dedicatedWindowEnabled` flag. This is the only behavior change that is unit-testable without Chrome APIs, so it is fully TDD'd against the existing test file.

**Files:**
- Modify: `extension/window-affinity.js` (whole file)
- Test: `test/agent/window-affinity.test.js` (whole file — contract changes from id to plan)

**Interfaces:**
- Produces: `resolveCreateWindowPlan({ requestedWindowId, isRequestedWindowValid, currentWindowId, dedicatedWindowEnabled = false })` →
  - `{ action: 'use-window', windowId }` when `requestedWindowId` is an integer **and** `isRequestedWindowValid === true`
  - `{ action: 'new-window' }` when no valid requested window **and** `dedicatedWindowEnabled === true`
  - `{ action: 'current-window', windowId: currentWindowId }` otherwise (`windowId` may be `undefined`)

- [ ] **Step 1: Rewrite the test file to assert on plans**

Replace the entire contents of `test/agent/window-affinity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCreateWindowPlan } from '../../extension/window-affinity.js';

test('uses the requested window when it is a valid integer window', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    currentWindowId: 111,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});

test('falls back to the current window when the requested window is closed/invalid', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 500,
    isRequestedWindowValid: false,
    currentWindowId: 700,
  });
  assert.deepEqual(plan, { action: 'current-window', windowId: 700 });
});

test('falls back to the current window when no window is requested', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: 700,
  });
  assert.deepEqual(plan, { action: 'current-window', windowId: 700 });
});

test('falls back when the requested window is a non-integer', () => {
  for (const requestedWindowId of ['222', 3.5, null]) {
    assert.deepEqual(
      resolveCreateWindowPlan({ requestedWindowId, isRequestedWindowValid: true, currentWindowId: 700 }),
      { action: 'current-window', windowId: 700 },
    );
  }
});

test('carries an undefined current window when Chrome reports none and no valid request', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: undefined,
  });
  assert.deepEqual(plan, { action: 'current-window', windowId: undefined });
});

test('spawns a new dedicated window when enabled and no valid window is requested', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: 700,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'new-window' });
});

test('spawns a new dedicated window when enabled and the requested window is closed', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 500,
    isRequestedWindowValid: false,
    currentWindowId: 700,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'new-window' });
});

test('still honors a valid requested window even when dedicated mode is enabled', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    currentWindowId: 111,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/agent/window-affinity.test.js`
Expected: FAIL — `resolveCreateWindowPlan` is not exported (import resolves to `undefined`, `TypeError: resolveCreateWindowPlan is not a function`).

- [ ] **Step 3: Rewrite the resolver to return a plan**

Replace the entire contents of `extension/window-affinity.js`:

```js
// Pure, synchronous resolver for where a new agent tab should be created.
//
// All async Chrome IO (validating the requested window still exists, reading the
// current focused window, creating a new window) happens in background.js; this
// module only encodes the decision so it is unit-testable without Chrome APIs.
// Centralizes the single windowId validity predicate (Number.isInteger).
//
// Returns a plan describing what background.js should do:
//   { action: 'use-window', windowId }     → open a tab in this existing window
//   { action: 'new-window' }               → create a fresh dedicated window
//   { action: 'current-window', windowId } → open a tab in the current window
//                                            (windowId may be undefined when
//                                             Chrome reports no current window)
//
// When the requested (relay-pinned) window is gone and dedicated mode is on, we
// deliberately return 'new-window' rather than dropping the agent's tab into the
// user's current window — keeping the agent's work isolated is the whole point.
export function resolveCreateWindowPlan({
  requestedWindowId,
  isRequestedWindowValid,
  currentWindowId,
  dedicatedWindowEnabled = false,
} = {}) {
  if (Number.isInteger(requestedWindowId) && isRequestedWindowValid === true) {
    return { action: 'use-window', windowId: requestedWindowId };
  }
  if (dedicatedWindowEnabled === true) {
    return { action: 'new-window' };
  }
  return { action: 'current-window', windowId: currentWindowId };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/agent/window-affinity.test.js`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/window-affinity.js test/agent/window-affinity.test.js
git commit -m "feat(extension): window resolver returns a plan with new-window action"
```

---

### Task 2: Extension spawns the dedicated background window

Wire the plan into `createTab`. The async wrapper reads the `dedicatedWindow` setting and Chrome window state, asks the pure resolver for a plan, and executes it. A `new-window` plan creates a background window and attaches to its initial tab; `attachTab` already surfaces the new `windowId` back through `result.windowId`, so the relay re-pins affinity with no relay change. This task touches `chrome.*` IO and so is verified by reading + the existing relay integration suite, not a new unit test (Chrome APIs are unavailable under `node:test`, per the project's standing constraint).

**Files:**
- Modify: `extension/background.js:2` (import), `extension/background.js:305-322` (`resolveCreateTabWindowId` → `resolveCreateTabWindowPlan`), `extension/background.js:422-463` (`createTab`)
- Test: `test/agent/background-window-plan.test.js` (new — static source-contract test, matching the `extension-manifest.test.js` / `popup-contract.test.js` text-assertion pattern, since Chrome APIs can't run under `node:test`)
- Modify: `package.json` (register the new test in the explicitly-enumerated `scripts.test` and `scripts.test:agent` chains, otherwise CI never runs it)

**Interfaces:**
- Consumes: `resolveCreateWindowPlan(...)` from Task 1.
- Produces: `createTab(params)` unchanged return shape (`attachTab` result carrying `windowId`); new internal `resolveCreateTabWindowPlan(params, dedicatedWindowEnabled)`.

- [ ] **Step 1: Update the import**

Change `extension/background.js:2` from:

```js
import { resolveCreateWindowId } from './window-affinity.js';
```

to:

```js
import { resolveCreateWindowPlan } from './window-affinity.js';
```

- [ ] **Step 2: Replace `resolveCreateTabWindowId` with a plan-returning wrapper**

Replace the function at `extension/background.js:305-322`:

```js
// Resolve the window a new agent tab should open in. Honors the relay-pinned
// `params.windowId` when that window still exists, otherwise falls back to the
// current focused window (which becomes the new pinned window upstream).
async function resolveCreateTabWindowId(params) {
  const requestedWindowId = params?.windowId;
  let isRequestedWindowValid = false;
  if (Number.isInteger(requestedWindowId)) {
    try {
      const win = await chrome.windows.get(requestedWindowId);
      isRequestedWindowValid = !!win && typeof win.id === 'number';
    } catch {
      // The pinned window may have been closed; fall back to the current window.
      isRequestedWindowValid = false;
    }
  }
  const currentWindowId = await getCurrentWindowId();
  return resolveCreateWindowId({ requestedWindowId, isRequestedWindowValid, currentWindowId });
}
```

with:

```js
// Resolve where a new agent tab should open. Honors the relay-pinned
// `params.windowId` when that window still exists; otherwise, when dedicated
// mode is on, plans a fresh background window, else falls back to the current
// focused window (which becomes the new pinned window upstream).
async function resolveCreateTabWindowPlan(params, dedicatedWindowEnabled) {
  const requestedWindowId = params?.windowId;
  let isRequestedWindowValid = false;
  if (Number.isInteger(requestedWindowId)) {
    try {
      const win = await chrome.windows.get(requestedWindowId);
      isRequestedWindowValid = !!win && typeof win.id === 'number';
    } catch {
      // The pinned window may have been closed; fall back per the plan.
      isRequestedWindowValid = false;
    }
  }
  const currentWindowId = await getCurrentWindowId();
  return resolveCreateWindowPlan({
    requestedWindowId,
    isRequestedWindowValid,
    currentWindowId,
    dedicatedWindowEnabled,
  });
}
```

- [ ] **Step 3: Branch `createTab` on the plan**

Replace the body of `createTab` at `extension/background.js:422-463`. Read `dedicatedWindow` from storage (add it to the existing `get` keys), build the plan, and create either a fresh background window or a tab in the resolved window:

```js
async function createTab(params) {
  // Check restrictions
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(
      ['mode', 'noNewTabs', 'lockUrl', 'readOnly', 'userInstructions', 'dedicatedWindow'],
      resolve,
    );
  });

  if (settings.mode === 'manual' || settings.noNewTabs) {
    const msg = settings.mode === 'manual'
      ? 'Tab creation blocked: manual mode is active. Work only with tabs attached by the user.'
      : 'Tab creation blocked: "No new tabs" restriction is active.';

    if (!restrictionExplained) {
      throw new Error(buildRestrictionError(msg, 'no new tabs', settings));
    }
    throw new Error(`BLOCKED: ${msg}`);
  }

  const agentSettings = await getAgentExecutionSettings();
  const plan = await resolveCreateTabWindowPlan(params, !!settings.dedicatedWindow);

  let tab;
  if (plan.action === 'new-window') {
    // Dedicated agent window: open in the background so the user keeps focus.
    const win = await chrome.windows.create({
      url: params.url || 'about:blank',
      focused: false,
      type: 'normal',
    });
    tab = win?.tabs?.[0];
    if (!tab) throw new Error('Failed to create dedicated agent window');
  } else {
    const createOptions = {
      url: params.url || 'about:blank',
      // Keep agent-created tabs visible; do not spawn separate windows.
      active: true,
    };
    if (typeof plan.windowId === 'number') {
      createOptions.windowId = plan.windowId;
    }

    // rotate-visible remains normalized to visible tab creation in current window.
    if (agentSettings.parallelVisibilityMode === 'rotate-visible') {
      createOptions.active = true;
    }

    tab = await chrome.tabs.create(createOptions);
  }

  // Brief delay for Chrome to finalize tab creation
  await sleep(200);

  const result = await attachTab(tab.id, params.sessionId, { origin: 'agent-created' });
  agentCreatedTabs.add(tab.id);
  return result;
}
```

- [ ] **Step 4: Add a static source-contract test for the new-window branch**

Chrome APIs can't run under `node:test`, but the repo already guards extension
source with text-assertion tests (`test/agent/extension-manifest.test.js`,
`test/agent/popup-contract.test.js`). Add `test/agent/background-window-plan.test.js`
to lock the `createTab` contract so a typo/regression in the new-window branch
is caught in CI:

```js
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const bg = fs.readFileSync('extension/background.js', 'utf8');

test('createTab imports and uses the plan resolver', () => {
  assert.match(bg, /import \{ resolveCreateWindowPlan \} from '\.\/window-affinity\.js'/);
  assert.match(bg, /resolveCreateTabWindowPlan\(params, !!settings\.dedicatedWindow\)/);
});

test('createTab reads the dedicatedWindow setting from storage', () => {
  assert.match(bg, /'dedicatedWindow'/);
});

test('new-window plan opens a background window via chrome.windows.create', () => {
  assert.match(bg, /plan\.action === 'new-window'/);
  assert.match(bg, /chrome\.windows\.create\(/);
  assert.match(bg, /focused:\s*false/);
});
```

Then **register it in `package.json`** — both `scripts.test` and `scripts.test:agent`
enumerate every test file explicitly, so a new file is never run by CI unless added.
Insert `&& node --test test/agent/background-window-plan.test.js` immediately after the
existing `node --test test/agent/window-affinity.test.js` segment in **both** scripts.

- [ ] **Step 5: Run the full agent + relay suites to confirm no regression**

Run: `node --test test/agent/window-affinity.test.js && node --test test/agent/background-window-plan.test.js && node --test relay/test/relay-server.test.js`
Then confirm the script wiring is valid: `pnpm test:agent` (repo uses `pnpm` — `pnpm-lock.yaml`).
Expected: PASS — resolver + background-contract tests pass, the new test runs under `test:agent`, and relay integration (affinity pinning / re-pin from returned `windowId`) is unaffected.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js test/agent/background-window-plan.test.js package.json
git commit -m "feat(extension): open agent-created tabs in a dedicated background window"
```

---

### Task 3: Popup toggle for the dedicated-window setting

Add the user-facing toggle to the popup (the only settings surface; `extension/options.*` is the logs page). TDD via the existing static `popup-contract.test.js`.

**Files:**
- Modify: `extension/popup.html:73` (new section after "Parallel Tab Visibility")
- Modify: `extension/popup.js:34` (DOM ref), `:51-55` (`SETTINGS_KEYS`), `:57-69` (load), and a new change handler near `:120-122`
- Test: `test/agent/popup-contract.test.js` (add one block)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent UI wiring; reads/writes `chrome.storage.local` key `dedicatedWindow`).

- [ ] **Step 1: Add the failing contract test**

Append to `test/agent/popup-contract.test.js`:

```js
test('popup exposes a dedicated-window toggle wired to storage', () => {
  assert.match(html, /id="bf-dedicated-window"/);
  assert.match(html, /Open agent tabs in a dedicated window/);
  assert.match(popupJs, /'dedicatedWindow'/);
  assert.match(popupJs, /dedicatedWindowCb/);
  assert.match(popupJs, /chrome\.storage\.local\.set\(\{\s*dedicatedWindow:/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/agent/popup-contract.test.js`
Expected: FAIL — `bf-dedicated-window` / `dedicatedWindow` not present in the HTML/JS yet.

- [ ] **Step 3: Add the toggle markup**

In `extension/popup.html`, insert a new `<section>` immediately after the "Parallel Tab Visibility" section (after the `</section>` at line 73, before the "Restrictions" section):

```html
      <section class="field">
        <label>Window</label>
        <div class="settings-group">
          <label class="checkbox-row">
            <input type="checkbox" id="bf-dedicated-window">
            <span>Open agent tabs in a dedicated window</span>
          </label>
        </div>
      </section>
```

- [ ] **Step 4: Wire the toggle in popup.js**

(a) Add a DOM ref after `extension/popup.js:33` (`const readOnlyCb = ...`):

```js
const dedicatedWindowCb = document.getElementById('bf-dedicated-window');
```

(b) Add `'dedicatedWindow'` to `SETTINGS_KEYS` (`extension/popup.js:51-55`):

```js
const SETTINGS_KEYS = [
  'relayUrl', 'autoDetachMinutes', 'autoCloseMinutes',
  'mode', 'lockUrl', 'noNewTabs', 'readOnly', 'userInstructions',
  'executionMode', 'parallelVisibilityMode', 'dedicatedWindow',
];
```

(c) Hydrate the checkbox in the `chrome.storage.local.get` callback (after `readOnlyCb.checked = !!s.readOnly;` at `extension/popup.js:66`):

```js
  dedicatedWindowCb.checked = !!s.dedicatedWindow;
```

(d) Persist on change. Add after the `parallelVisibilitySelect` change handler (`extension/popup.js:120-122`). It is a window-placement preference, **not** an instruction restriction, so it does NOT go through `onRestrictionToggle`/`updateInstructions`:

```js
dedicatedWindowCb.addEventListener('change', () => {
  chrome.storage.local.set({ dedicatedWindow: dedicatedWindowCb.checked });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/agent/popup-contract.test.js`
Expected: PASS — all popup-contract tests pass, including the new toggle assertion.

- [ ] **Step 6: Commit**

```bash
git add extension/popup.html extension/popup.js test/agent/popup-contract.test.js
git commit -m "feat(extension): add dedicated-window popup toggle"
```

---

### Task 4: Documentation

Update the evergreen project guide and append the timeline entry (project rules require both).

**Files:**
- Modify: `AGENTS.md` ("Agent Window Affinity" section)
- Modify: `docs/DEVELOPMENT.md` ("Agent Window Affinity" section — keep the evergreen dev doc in sync; it currently only describes the closed-window→current-window fallback)
- Modify: `docs/knowledge/timeline1.md` (append entry) — **local-only**: `docs/knowledge/` is gitignored (`.gitignore:11 knowledge/`), so this file is updated for the compounding protocol but is **NOT** committed/pushed.

- [ ] **Step 1: Update the "Agent Window Affinity" section in `AGENTS.md`**

In the `### Agent Window Affinity` section, (a) replace the reference to `resolveCreateWindowId()` with `resolveCreateWindowPlan()`, and (b) append this paragraph at the end of the section:

```markdown
**Dedicated window (opt-in):** When the `dedicatedWindow` setting (popup toggle) is
on and a create has no valid pinned window, `resolveCreateWindowPlan()` returns
`{ action: 'new-window' }` and the extension opens a fresh **background**
(`focused: false`) Chrome window for the agent's created tabs, instead of a tab in
the user's current window. Affinity then pins to that window so later created tabs
join it. If the dedicated window is closed mid-session, the next create spawns a
**new** dedicated window rather than falling back to the user's window. Scope is
agent-**created** tabs only — manually attached tabs are never moved. Default is OFF.
```

- [ ] **Step 2: Update the "Agent Window Affinity" section in `docs/DEVELOPMENT.md`**

Append a paragraph to the `## Agent Window Affinity` section so the evergreen dev
doc reflects dedicated mode (it currently only documents the closed-window →
current-window fallback):

```markdown
**Dedicated window (opt-in):** With the **Open agent tabs in a dedicated window**
popup setting ON, a create with no valid pinned window opens a fresh **background**
(`focused: false`) Chrome window for the agent's tabs instead of using the user's
current window; affinity then pins to it. If that window is closed mid-session, the
next create spawns a **new** dedicated window rather than falling back to the user's
window. Scope is agent-**created** tabs only; manually attached tabs are never moved.
Default is OFF.
```

- [ ] **Step 3: Append the timeline entry (local-only — `docs/knowledge/` is gitignored)**

Append to `docs/knowledge/timeline1.md` (use today's date `2026-06-27` and `@Valsaraj`):

```markdown
## 2026-06-27 — [PATTERN] Opt-in dedicated agent window (@Valsaraj)

**Change**: Added a `dedicatedWindow` popup setting. When on, the first agent-created
tab with no pinned window spawns a background (`focused: false`) Chrome window;
subsequent created tabs join it; a closed dedicated window re-spawns a new one
rather than falling back to the user's window. Scope: created tabs only.
**Why**: Let the user keep working in their own Chrome while the agent's tabs stay
organized in their own window.
**How**: Pure decision in `extension/window-affinity.js` (`resolveCreateWindowId` →
`resolveCreateWindowPlan`, returns `{ action }` plan); `extension/background.js`
`createTab` executes the plan via `chrome.windows.create`. Relay unchanged — it
already re-pins affinity from the returned `windowId`.
**Files**: extension/window-affinity.js, extension/background.js, extension/popup.html,
extension/popup.js, test/agent/window-affinity.test.js, test/agent/popup-contract.test.js,
test/agent/background-window-plan.test.js, AGENTS.md, docs/DEVELOPMENT.md
```

- [ ] **Step 4: Commit**

`docs/knowledge/` is gitignored, so the timeline file is updated locally for the
compounding protocol but is **NOT** staged. Commit only the tracked docs:

```bash
git add AGENTS.md docs/DEVELOPMENT.md
git commit -m "docs: document opt-in dedicated agent window"
```

---

## Verification (after all tasks)

Run the agent suite to confirm everything is green:

```bash
node --test test/agent/window-affinity.test.js \
  && node --test test/agent/background-window-plan.test.js \
  && node --test test/agent/popup-contract.test.js \
  && node --test relay/test/relay-server.test.js
```

Also confirm the new test is wired into the enumerated scripts: `pnpm test:agent`.

Manual smoke (in Chrome, with the extension reloaded):
1. Toggle **Open agent tabs in a dedicated window** ON in the popup.
2. Have the agent create a tab → a new Chrome window appears **in the background**, holding the agent's tab; your focused window is undisturbed.
3. Agent creates a second tab → it joins the same dedicated window as a tab.
4. Close the dedicated window, have the agent create another tab → a new dedicated window appears (the tab does NOT land in your window).
5. Toggle OFF → agent-created tabs again open in the current window (original behavior).

## Self-Review notes

- **Spec coverage:** new-window on first create (Task 1+2), join-on-subsequent (relay affinity, unchanged), closed-window re-spawn (Task 1 `new-window` branch + Task 2 invalid-window path), background focus (Task 2 `focused:false`), created-only scope (only `createTab` touched; attach untouched), default OFF (`!!settings.dedicatedWindow`), popup toggle (Task 3), docs (Task 4). All covered.
- **Relay:** intentionally no change — `_createTarget` already sends no `windowId` without affinity and re-pins from `result.windowId`, which `attachTab` populates from the new window. Verified against `relay/src/index.js:1457-1481` and `extension/background.js:386-399`.
- **Type consistency:** `resolveCreateWindowPlan` returns `{ action, windowId? }` consistently; `createTab` reads `plan.action` / `plan.windowId`; rename applied at import, call site, test, and `AGENTS.md`.
