# Agent Window & Tab Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent-created tabs land in the agent's own Chrome window — never the user's working window — concurrent agents do not share a window, and no agent can *close* another agent's tab.

**Explicitly NOT a goal:** preventing one agent from navigating, clicking, typing into, or evaluating JS in another agent's tab. See "Scope limit: ownership is close-only".

**Architecture:** Two independent defects put agent tabs in the user's window. (1) A race in relay affinity bookkeeping: affinity entries gain a *provenance* (`discovered` = merely seeded from a tab the agent touched; `created` = a window a `createTab` actually used), and only `created` pins are sent to the extension. (2) A `created` pin can still name the user's window when it was established while `dedicatedWindow` was OFF — turning the setting ON later does not dislodge it. So the extension additionally tracks which windows it opened *as* dedicated agent windows, and `resolveCreateWindowPlan` refuses to reuse a non-dedicated window while dedicated mode is on. Per-agent isolation then comes from a process-stable unique affinity label (one window per MCP process) plus an `ownerKey` threaded into the extension's tab bookkeeping.

**Tech Stack:** Node.js (CommonJS relay, ESM MCP/extension), `ws`, `node:test`, Chrome MV3 extension APIs. No new dependencies.

**Spec:** This document (design and evidence inlined below — see "Design & Evidence").

---

## Global Constraints

- No new dependencies. The relay stays on `ws` only (AGENTS.md "No new dependencies without justification").
- Relay binds `127.0.0.1` only; extension WS `Origin: chrome-extension://` validation and CDP token auth are untouched by this work.
- All test `relay.start()` calls MUST pass `{ writeCdpUrl: false }` (AGENTS.md "Test Isolation").
- Extension code cannot be unit-tested against real Chrome APIs. Extension logic is tested either through the pure resolver `extension/window-affinity.js` or through source-contract assertions in `test/agent/background-window-plan.test.js`, matching existing repo practice.
- `active: true` in `extension/background.js` `createTab()` is **deliberately kept**. See "Design & Evidence".
- Red-phase verification runs each affected test FILE on its own, never chained with `&&`, so one expected failure cannot mask another.
- Every relay test body that opens a `cdp`/`ext` socket wraps its assertions in `try/finally` and closes both in the `finally`. `RelayServer.stop()` only closes the HTTP server, so a socket left open by a failing assertion — which the red phase deliberately produces — can hang `pnpm test:relay`.
- Every task ends with an atomic commit staging only its own files (never `git add -A` or `.`).
- Commit message format: `type(scope): what + why`.
- Package manager: `pnpm` (`pnpm-lock.yaml`).
- Run `pnpm test:relay` and `pnpm test:agent` before each commit that touches those areas. Focused `node --test <file>` runs are for the red/green cycle only — never the last check before a commit.

---

## Design & Evidence

### The defect

`relay/src/index.js` `_createTarget()` re-pins window affinity after the extension returns:

```js
const resultWindowId = integerWindowId(result.windowId ?? result.targetInfo?.windowId);
if (affinityKey && resultWindowId !== undefined) {
  if (sentPinned || !this.agentWindowByAffinityKey.has(affinityKey)) {
    this._pinAgentWindow(affinityKey, resultWindowId);
  }
}
```

On the first create, `sentPinned` is `false` and `has(affinityKey)` is `false`, so the branch is taken. But `_sendToExt('createTab', ...)` is awaited, and during that round-trip any real (non-init) CDP command seeds affinity via `_seedAgentWindowAffinity()` — from **any** tab the agent touches, including the user's. There are five seeding sites: `relay/src/index.js:1760`, `:1765` (main session), `:1809`, `:1817` (alias/`newCDPSession`), `:1852` (OOPIF parent).

When that happens mid-create, `has(affinityKey)` flips to `true` before the re-pin runs, `sentPinned` is still `false`, and **the re-pin is skipped**. The dedicated window the extension just opened is never recorded. Affinity permanently holds the user's window, so every later create resolves `use-window` → the user's window.

### Evidence

Measured live against the user's Chrome (36 targets / 6 windows) on 2026-09-02:

- Create immediately after connect: tab A → new window `367119663`; tabs B and C → user window `367118804`.
- Falsifiable prediction: if discovery is allowed to settle *before* creating, even tab A should land in the user's window. Confirmed — A → `367118804`.
- Standing artifact: window `367122958` held 5 `agent-created` tabs mixed with 2 user tabs.

The race is load-dependent (it needs a real command to land inside the create round-trip) and did not reproduce at 15 targets / 3 windows. **The branch is wrong by inspection regardless of live reproducibility**, and is deterministically reproducible at the relay level with no Chrome involved — which is why Task 1 starts with that test.

### Why `resolveCreateWindowPlan` IS changed (revised)

An earlier draft argued that once the relay sends only `created` pins, `requestedWindowId` could only ever name a window the agent opened, so the resolver needed no change. **That reasoning is wrong**, and the counterexample is almost certainly what the user actually hit:

1. `dedicatedWindow` is OFF. A create resolves `current-window` — the user's window — and the extension returns that `windowId`.
2. The relay records it as a **`created`** pin, because a create really did use it.
3. The user turns `dedicatedWindow` ON.
4. The next create sends that pin. It is `created` and the window still exists, so `resolveCreateWindowPlan` returns `use-window` → the user's window, **with the setting ON**.

Provenance in the relay cannot distinguish these: from the relay's side both are "a window a create used". Only the extension knows whether it opened a window *as a dedicated agent window*. It therefore tracks `dedicatedWindowIds`, and the resolver refuses to reuse a non-dedicated window while dedicated mode is on. Task 2 implements this.

### Why `active: true` is kept

A spike proved `Page.captureScreenshot` does not require the tab to be selected: a tab in the same window, non-selected by construction, captured correct content in 60ms. `Page.bringToFront` is never issued — `visibilityState` was unchanged before and after every capture. Chrome keeps a `chrome.debugger`-attached renderer live, which is why attached tabs capture reliably regardless of selection.

Therefore `active: true` causes no functional problem once tabs land in the agent's own window, and it keeps the agent's work watchable. Removing it would be an unrequested behavior change. The one residual case — two agents deliberately sharing a label share a window and contend for the selected tab — is acceptable and documented.

One separate finding, **out of scope** for this plan: `page.screenshot()` hung for 15s on a lazily-attached tab that had no JS execution context, while raw `Page.captureScreenshot` on the same tab succeeded in 155ms. That is the known synthesized-`Runtime.enable` issue in AGENTS.md, not a visibility problem. Do not attempt to fix it here.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `relay/src/index.js` | Modify | Affinity provenance: `_pinAgentWindow`, `_seedAgentWindowAffinity`, `_createTarget` read/re-pin; send `ownerKey` on `createTab` |
| `relay/test/relay-server.test.js` | Modify | Deterministic mid-create race regression test; owner-key wire test |
| `extension/window-affinity.js` | Modify | `isRequestedWindowDedicated` predicate so dedicated mode ignores non-agent windows |
| `test/agent/window-affinity.test.js` | Modify | Resolver cases for the new predicate |
| `extension/popup.js` | Modify | `dedicatedWindow` defaults ON in the UI |
| `extension/background.js` | Modify | `dedicatedWindow` defaults ON; `agentCreatedTabs` Set → Map with owner; cross-owner close refusal |
| `extension/auto-manage-state.js` | Create | Pure `hydrateAgentTabs` / `hydrateActivity` / `canCloseTab` — Chrome-free, so A3/A4 are actually testable |
| `test/agent/auto-manage-state.test.js` | Create | Legacy hydration, malformed-owner tolerance, ownership fence, auto-close exemption |
| `mcp/src/client-label.js` | Create | Side-effect-free process-stable affinity label helper |
| `mcp/src/index.js` | Modify | Import the label helper (index.js runs `main()` at import, so it is untestable) |
| `mcp/test/client-label.test.js` | Create | Label uniqueness/stability/override contract |
| `package.json` | Modify | Register the new test file |
| `test/agent/background-window-plan.test.js` | Modify | Source contracts for default-ON and owner map |
| `test/agent/popup-contract.test.js` | Modify | Source contract for popup default-ON |
| `AGENTS.md`, `README.md`, `README.frontpage.md`, `GUIDE.md`, `docs/DEVELOPMENT.md` | Modify | Protocol table, affinity section, two Non-Goal reversals, setting default, MCP label |

---

### Task 1: Affinity pin provenance (the race fix)

**Files:**
- Modify: `relay/src/index.js:1611-1631` (`_pinAgentWindow`, `_seedAgentWindowAffinity`), `relay/src/index.js:1645-1672` (`_createTarget` read + re-pin)
- Test: `relay/test/relay-server.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `this.agentWindowByAffinityKey` becomes `Map<string, { windowId: number, strength: 'discovered' | 'created' }>`. `_pinAgentWindow(affinityKey, windowId, strength)` — third parameter required. `_seedAgentWindowAffinity(clientId, target)` signature unchanged.

- [ ] **Step 1: Write the failing test**

Add to `relay/test/relay-server.test.js`, next to the existing `Target.createTarget reuses the first agent-created windowId for later tabs` test (~line 1576):

```js
it('Target.createTarget re-pins to the created window even when affinity is seeded mid-create', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });

  const createCommands = [];
  let nextTabId = 400;
  let releaseCreate = null;

  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
    if (msg.id && msg.method === 'getRestrictions') {
      ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
      return;
    }
    if (msg.id && msg.method === 'listTabs') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: { tabs: [{ tabId: 301, windowId: 111, url: 'https://user.example', title: 'User', active: true }] },
      }));
      return;
    }
    if (msg.id && msg.method === 'attachTab') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId: msg.params.tabId,
          windowId: 111,
          targetId: `real-target-${msg.params.tabId}`,
          targetInfo: { targetId: `real-target-${msg.params.tabId}`, type: 'page', title: 'User', url: 'https://user.example', windowId: 111 },
          sessionId: msg.params.sessionId,
        },
      }));
      return;
    }
    if (msg.id && msg.method === 'cdpCommand') {
      ext.send(JSON.stringify({ id: msg.id, result: {} }));
      return;
    }
    if (msg.id && msg.method === 'createTab') {
      createCommands.push(msg.params);
      const tabId = nextTabId++;
      // Hold the FIRST create open so a real command can seed affinity
      // from the user's window while this create is still in flight.
      const respond = () => ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId,
          windowId: 999,
          targetId: `real-target-${tabId}`,
          targetInfo: { targetId: `real-target-${tabId}`, type: 'page', title: '', url: msg.params.url || 'about:blank', windowId: 999 },
          sessionId: msg.params.sessionId,
        },
      }));
      if (createCommands.length === 1) { releaseCreate = respond; } else { respond(); }
    }
  });

  // Unique label => a private affinity key. The relay is shared across this
  // describe block and label pins are durable, so the test must never look at
  // the collection as a whole.
  const AFFINITY_KEY = 'label:race-test';
  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}&label=race-test`);
  const userSessions = [];
  cdp.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo?.url === 'https://user.example') {
      userSessions.push(msg.params.sessionId);
    }
  });

  // The ENTIRE body after socket setup is guarded: the red phase makes the
  // FIRST affinity assertion fail, and RelayServer.stop() closes only the HTTP
  // server (relay/src/index.js:1896-1899), so a leaked socket hangs the suite.
  try {
  cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
  await waitForCondition(() => userSessions.length > 0, { description: 'user tab auto-attach' });

  // First create — the extension holds its response open.
  cdp.send(JSON.stringify({ id: 2, method: 'Target.createTarget', params: { url: 'https://agent.example/one' } }));
  await waitForCondition(() => createCommands.length === 1 && releaseCreate, { description: 'first createTab to reach the extension' });

  // Mid-create: a real command on the USER tab seeds affinity to window 111.
  cdp.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: userSessions[0] }));
  await waitForCondition(
    () => relay.agentWindowByAffinityKey.get(AFFINITY_KEY),
    { description: 'affinity to be seeded from the user tab mid-create' },
  );
  // Precondition of the race: the seed points at the USER's window.
  assert.deepEqual(relay.agentWindowByAffinityKey.get(AFFINITY_KEY),
    { windowId: 111, strength: 'discovered' });

  releaseCreate();
  await waitForCondition(
    () => relay.agentWindowByAffinityKey.get(AFFINITY_KEY)?.strength === 'created',
    { description: 'the created window to be re-pinned' },
  );
  assert.deepEqual(relay.agentWindowByAffinityKey.get(AFFINITY_KEY),
    { windowId: 999, strength: 'created' });

  // Second create must go to the window the FIRST create actually used (999),
  // not the user window (111) that got seeded during the round-trip.
  cdp.send(JSON.stringify({ id: 4, method: 'Target.createTarget', params: { url: 'https://agent.example/two' } }));
  await waitForCondition(() => createCommands.length === 2, { description: 'second createTab' });

    assert.equal(createCommands[1].windowId, 999);
  } finally {
    cdp.close();
    ext.close();
    await sleep(100);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:relay`

Expected: FAIL on the new test. Pre-fix, affinity values are bare numbers, so the FIRST guarded assertion — `assert.deepEqual(relay.agentWindowByAffinityKey.get(AFFINITY_KEY), { windowId: 111, strength: 'discovered' })` — fails with `111 !== { windowId: 111, strength: 'discovered' }`. That is why the whole body is inside `try/finally`: the failure happens well before the closing assertion, and the sockets must still close.

- [ ] **Step 3: Add provenance to the pin store**

In `relay/src/index.js`, update the comment at `:280-285` and replace `_pinAgentWindow` and `_seedAgentWindowAffinity` (`:1611-1631`) with:

```js
  // Pin an agent window. `strength` records provenance:
  //   'created'    — a window a createTab actually used; authoritative.
  //   'discovered' — merely a window the agent touched a tab in; may be the
  //                  user's own window, so it must never be sent to the
  //                  extension as a create target.
  // A weak pin never overwrites a strong one; a create always overwrites.
  _pinAgentWindow(affinityKey, windowId, strength) {
    if (!affinityKey || !Number.isInteger(windowId)) return;
    const existing = this.agentWindowByAffinityKey.get(affinityKey);
    if (existing?.strength === 'created' && strength !== 'created') return;
    this.agentWindowByAffinityKey.set(affinityKey, { windowId, strength });
    if (this.agentWindowByAffinityKey.size > MAX_AFFINITY_ENTRIES) {
      const oldest = this.agentWindowByAffinityKey.keys().next().value;
      this.agentWindowByAffinityKey.delete(oldest);
    }
  }

  // Record the window of the first real tab use as a WEAK pin. It keeps the
  // /attached-tabs picture coherent but is never used as a create target —
  // the tab may well be one of the user's, which is exactly the bug this
  // provenance split fixes.
  _seedAgentWindowAffinity(clientId, target) {
    const key = this._affinityKey(clientId);
    if (!key || this.agentWindowByAffinityKey.has(key)) return;
    const windowId = target?.windowId ?? target?.targetInfo?.windowId;
    if (Number.isInteger(windowId)) {
      this._pinAgentWindow(key, windowId, 'discovered');
    }
  }
```

- [ ] **Step 4: Send only strong pins, and always re-pin after a create**

In `relay/src/index.js` `_createTarget()`, replace the pin read (`:1645-1651`) with:

```js
    // Only a 'created' pin may steer a new tab: a 'discovered' pin can point
    // at the USER's window, and sending it would drop agent tabs there.
    const affinityKey = this._affinityKey(clientId);
    const pinned = affinityKey ? this.agentWindowByAffinityKey.get(affinityKey) : undefined;
    const pinnedWindowId = pinned?.strength === 'created' ? pinned.windowId : undefined;
    const sentPinned = Number.isInteger(pinnedWindowId);
    if (sentPinned) createParams.windowId = pinnedWindowId;
```

and replace the re-pin block (`:1665-1672`) with:

```js
    // Always record the window the extension actually used. The previous
    // `sentPinned || !has(key)` guard silently skipped this whenever a real
    // command seeded affinity DURING the createTab round-trip, so the agent's
    // own dedicated window was never remembered and every later create fell
    // into the seeded (user) window.
    const resultWindowId = integerWindowId(
      result.windowId ?? result.targetInfo?.windowId
    );
    if (affinityKey && resultWindowId !== undefined) {
      this._pinAgentWindow(affinityKey, resultWindowId, 'created');
    }
```

- [ ] **Step 5: Update the two tests this change invalidates, THEN run**

Make both edits BEFORE running the suite — the Task 1 change invalidates them by design, so running first would report a failure the plan already expects:

1. `relay/test/relay-server.test.js:2026` reads affinity values as bare numbers:

```js
    assert.ok([...relay.agentWindowByAffinityKey.values()].includes(11),
      'alias-session real command must seed window affinity');
```

   Values are now objects. Replace with:

```js
    assert.deepEqual(
      relay.agentWindowByAffinityKey.get('label:alias-affinity'),
      { windowId: 11, strength: 'discovered' },
      'alias-session real command must seed a weak (discovered) window affinity');
```

and give that test's CDP client its own durable key by appending `&label=alias-affinity` to its `connectWs` URL.

Scope it to a private key rather than scanning the collection: `before(async () => { relay = new RelayServer(port); })` creates **one relay per `describe` block** and label-keyed pins are durable across disconnects, so any collection-wide assertion can be satisfied by an unrelated test's pin.

2. `Target.createTarget uses the windowId from the first real tab command` (~:1482) asserts `createCommands[0].windowId === 222` from a *discovered* pin. A discovered pin is no longer sent, so change that assertion to `assert.equal(createCommands[0].windowId, undefined);` and rename the test to `Target.createTarget does not steer new tabs into a merely-discovered window`.

`...reuses the first agent-created windowId for later tabs` (~:1576) must keep passing unchanged — its pin comes from a real create.

Run: `pnpm test:relay`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js
git commit -m "fix(relay): re-pin agent window affinity after every create

A real CDP command landing inside the createTab round-trip seeded window
affinity from the user's tab, after which the re-pin guard
(sentPinned || !has(key)) skipped recording the dedicated window the
extension had just opened. Every later create then resolved use-window
into the user's working window. Affinity entries now carry provenance and
only 'created' pins steer new tabs."
```

---

### Task 2: Dedicated-window provenance in the extension

**Files:**
- Modify: `extension/window-affinity.js` (`resolveCreateWindowPlan`)
- Modify: `extension/background.js` (`resolveCreateTabWindowPlan`, `createTab`, persist/hydrate)
- Test: `test/agent/window-affinity.test.js`, `test/agent/background-window-plan.test.js`

**Interfaces:**
- Consumes: Task 1's `created`/`discovered` split.
- Produces: `resolveCreateWindowPlan({ requestedWindowId, isRequestedWindowValid, isRequestedWindowDedicated, currentWindowId, dedicatedWindowEnabled })`. New third predicate defaults to `false`. `dedicatedWindowIds: Set<number>` in `background.js`, persisted under `AUTO_MANAGE_STATE_KEY` as `dedicatedWindowIds`.

- [ ] **Step 1: Write the failing resolver tests**

Add to `test/agent/window-affinity.test.js`:

```js
test('dedicated mode refuses to reuse a window the agent did not open as dedicated', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    isRequestedWindowDedicated: false,
    currentWindowId: 111,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'new-window' });
});

test('dedicated mode reuses a window it opened as dedicated', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    isRequestedWindowDedicated: true,
    currentWindowId: 111,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});

test('with dedicated mode off, any valid pinned window is still reused', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    isRequestedWindowDedicated: false,
    currentWindowId: 111,
    dedicatedWindowEnabled: false,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});
```

Also update the EXISTING test at `test/agent/window-affinity.test.js:70-78`, which the new default breaks. It reads:

```js
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

`isRequestedWindowDedicated` now defaults to `false`, so under dedicated mode this correctly resolves to `new-window`. Rename it and make the dedicated provenance explicit — the behavior it asserted is exactly the bug:

```js
test('honors a valid requested window under dedicated mode only when the agent opened it', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    isRequestedWindowDedicated: true,
    currentWindowId: 111,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/agent/window-affinity.test.js`

Expected: FAIL — `dedicated mode refuses to reuse a window the agent did not open as dedicated` returns `{ action: 'use-window', windowId: 222 }`.

- [ ] **Step 3: Add the predicate to the resolver**

Replace the body of `resolveCreateWindowPlan` in `extension/window-affinity.js`:

```js
export function resolveCreateWindowPlan({
  requestedWindowId,
  isRequestedWindowValid,
  isRequestedWindowDedicated = false,
  currentWindowId,
  dedicatedWindowEnabled = false,
} = {}) {
  const canReuse = Number.isInteger(requestedWindowId) && isRequestedWindowValid === true;
  // A pinned window is not necessarily an AGENT window: a pin established while
  // dedicated mode was OFF names the user's own window, and it stays valid when
  // the setting is later turned ON. Only the extension knows which windows it
  // opened as dedicated, so that is the predicate dedicated mode must trust.
  if (canReuse && (dedicatedWindowEnabled !== true || isRequestedWindowDedicated === true)) {
    return { action: 'use-window', windowId: requestedWindowId };
  }
  if (dedicatedWindowEnabled === true) {
    return { action: 'new-window' };
  }
  return { action: 'current-window', windowId: currentWindowId };
}
```

Update the module's header comment to describe the new predicate.

- [ ] **Step 4: Track dedicated windows in `background.js`**

Add beside the other module state:

```js
/** Windows this extension opened AS dedicated agent windows (windowId set) */
const dedicatedWindowIds = new Set();
```

Persist and hydrate it with the rest of the auto-manage state — add `dedicatedWindowIds: [...dedicatedWindowIds]` to the `persistAutoManageState()` payload, and in `hydrateAutoManageState()`:

```js
    const openWindowIds = new Set((await chrome.windows.getAll()).map((w) => w.id));
    for (const windowId of Array.isArray(saved.dedicatedWindowIds) ? saved.dedicatedWindowIds : []) {
      if (openWindowIds.has(windowId)) dedicatedWindowIds.add(windowId);
    }
```

Feed the predicate in `resolveCreateTabWindowPlan`:

```js
  return resolveCreateWindowPlan({
    requestedWindowId,
    isRequestedWindowValid,
    isRequestedWindowDedicated: dedicatedWindowIds.has(requestedWindowId),
    currentWindowId,
    dedicatedWindowEnabled,
  });
```

Record the window in `createTab`'s `new-window` branch, right after `tab = win?.tabs?.[0];`:

```js
    if (Number.isInteger(win?.id)) dedicatedWindowIds.add(win.id);
```

Drop it when the window closes — add near the other lifecycle listeners:

```js
chrome.windows.onRemoved.addListener((windowId) => {
  if (dedicatedWindowIds.delete(windowId)) persistAutoManageState();
});
```

- [ ] **Step 5: Add the source contract**

Add to `test/agent/background-window-plan.test.js`:

```js
test('dedicated windows are tracked and consulted by the resolver', () => {
  assert.match(bg, /const dedicatedWindowIds = new Set\(\)/);
  assert.match(bg, /dedicatedWindowIds\.add\(win\.id\)/);
  assert.match(bg, /isRequestedWindowDedicated: dedicatedWindowIds\.has\(requestedWindowId\)/);
});

test('dedicated windows survive a service-worker restart and are pruned', () => {
  // Without persistence + hydration a restart forgets them, every valid pin
  // stops looking dedicated, and each create opens another window.
  assert.match(bg, /dedicatedWindowIds: \[\.\.\.dedicatedWindowIds\]/);
  assert.match(bg, /saved\.dedicatedWindowIds/);
  assert.match(bg, /chrome\.windows\.getAll\(\)/);
  assert.match(bg, /openWindowIds\.has\(windowId\)/);
  assert.match(bg, /chrome\.windows\.onRemoved\.addListener/);
});
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/agent/window-affinity.test.js`
Then: `node --test test/agent/background-window-plan.test.js`

Run them separately, not chained with `&&`, so one failure does not mask the other.

Expected: PASS.

Then run the whole agent suite before committing, so an unrelated regression cannot reach a committed state:

```bash
pnpm test:agent
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/window-affinity.js extension/background.js \
  test/agent/window-affinity.test.js test/agent/background-window-plan.test.js
git commit -m "fix(extension): only reuse windows opened as dedicated agent windows

A window pinned while dedicatedWindow was OFF is the user's own window, and
it stayed valid when the setting was later switched ON, so agent tabs kept
landing there with dedicated mode enabled. The extension now tracks the
windows it opened as dedicated and the resolver trusts that predicate."
```

---

### Task 3: Default `dedicatedWindow` to ON

**Files:**
- Modify: `extension/popup.js:69`
- Modify: `extension/background.js:526`
- Test: `test/agent/popup-contract.test.js`, `test/agent/background-window-plan.test.js`

**Interfaces:**
- Consumes: Task 1's provenance fix (a default-ON dedicated window is only safe once creates stop leaking into the user's window).
- Produces: absent `dedicatedWindow` in `chrome.storage.local` now means ON. Both readers use `!== false`.

- [ ] **Step 1: Write the failing tests**

Add to `test/agent/popup-contract.test.js`:

```js
test('dedicated window checkbox defaults to ON when unset', () => {
  assert.match(popupJs, /dedicatedWindowCb\.checked = s\.dedicatedWindow !== false/);
});
```

Add to `test/agent/background-window-plan.test.js`:

```js
test('createTab treats an unset dedicatedWindow setting as enabled', () => {
  assert.match(bg, /resolveCreateTabWindowPlan\(params, settings\.dedicatedWindow !== false\)/);
});
```

Note: `test/agent/popup-contract.test.js` already binds the popup source as `popupJs` (alongside `html`, `optionsJs`, `popupCss`). Use `popupJs`; do not introduce a new binding.

- [ ] **Step 2: Run the tests to verify they fail**

Run each file separately so one expected failure cannot mask the other:

```bash
node --test test/agent/popup-contract.test.js
node --test test/agent/background-window-plan.test.js
```

Expected: both FAIL — the assertions report no match.

- [ ] **Step 3: Change the two readers**

In `extension/popup.js:69`:

```js
  dedicatedWindowCb.checked = s.dedicatedWindow !== false;
```

In `extension/background.js:526`:

```js
  const plan = await resolveCreateTabWindowPlan(params, settings.dedicatedWindow !== false);
```

- [ ] **Step 4: Update the invalidated contract, THEN run**

`test/agent/background-window-plan.test.js:9` still asserts the old expression:

```js
  assert.match(bg, /resolveCreateTabWindowPlan\(params, !!settings\.dedicatedWindow\)/);
```

Replace it BEFORE running, or the suite reports a failure the plan already expects:

```js
  assert.match(bg, /resolveCreateTabWindowPlan\(params, settings\.dedicatedWindow !== false\)/);
```

Then run each file separately:

```bash
node --test test/agent/popup-contract.test.js
node --test test/agent/background-window-plan.test.js
```

Expected: PASS. Then run the whole agent suite before committing, so an unrelated regression cannot reach a committed state:

```bash
pnpm test:agent
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/popup.js extension/background.js test/agent/popup-contract.test.js test/agent/background-window-plan.test.js
git commit -m "feat(extension): default dedicatedWindow to ON

Agent tabs belong in the agent's window by default; an unset setting now
reads as enabled in both the popup and createTab."
```

---

### Task 4: One window per agent (process-stable unique label)

**Files:**
- Create: `mcp/src/client-label.js`
- Modify: `mcp/src/index.js:59-71` (delete the local `withClientLabel`, import it instead)
- Create: `mcp/test/client-label.test.js`
- Modify: `package.json` (`test` and `test:mcp` scripts — add the new test file)

**Why a new module:** `mcp/src/index.js:408` calls `main().catch(...)` at top level with **no** `require.main`/direct-run guard, so importing it from a test boots the MCP server, connects the stdio transport, and can `process.exit(1)` inside the test runner. The label helper must therefore live in a module with no side effects. This is not test-only production code — it is a pure helper given its own file.

**Interfaces:**
- Consumes: Task 1's `created` pins (durable per label across the 15s idle reconnect).
- Produces: `mcp/src/client-label.js` exporting `PROCESS_CLIENT_LABEL: string` and `withClientLabel(cdpUrl: string): string`. Default label is `browserforce-mcp-<8 hex chars>`, generated once per process. `BROWSERFORCE_CDP_CLIENT_LABEL` still overrides it verbatim.

Rationale: the relay keys durable affinity on the explicit `?label=`. Every MCP process currently sends the same literal `browserforce-mcp`, so concurrent agents share one affinity key and therefore one window. A per-process suffix gives each agent its own window while staying stable across that process's own disconnect/reconnect cycle — which is the property AGENTS.md relies on.

- [ ] **Step 1: Write the failing test**

Create `mcp/test/client-label.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { withClientLabel, PROCESS_CLIENT_LABEL } from '../src/client-label.js';

test('applies one stable label for the lifetime of the process', () => {
  const a = new URL(withClientLabel('ws://127.0.0.1:19222/cdp?token=t')).searchParams.get('label');
  const b = new URL(withClientLabel('ws://127.0.0.1:19222/cdp?token=t')).searchParams.get('label');
  assert.equal(a, b, 'label must be stable within a process (survives idle reconnect)');
  assert.equal(a, PROCESS_CLIENT_LABEL);
});

test('keeps an explicit label already present on the URL', () => {
  const out = withClientLabel('ws://127.0.0.1:19222/cdp?token=t&label=mine');
  assert.equal(new URL(out).searchParams.get('label'), 'mine');
});

test('returns the input unchanged when it is not a valid URL', () => {
  assert.equal(withClientLabel('not a url'), 'not a url');
});
```

The in-process test deliberately does NOT assert the generated `browserforce-mcp-<hex>` shape: `BROWSERFORCE_CDP_CLIENT_LABEL` is a supported override, and a developer with it exported would otherwise get a spurious failure. The override is read once at module load, so it cannot be re-tested by mutating `process.env` after import — both the default shape and the override are covered in subprocesses with an explicit environment:

```js
import { execFileSync } from 'node:child_process';

const readLabelFromSubprocess = (env) => execFileSync(process.execPath, [
  '--input-type=module', '-e',
  "import{PROCESS_CLIENT_LABEL}from'./mcp/src/client-label.js';process.stdout.write(PROCESS_CLIENT_LABEL)",
], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('honours BROWSERFORCE_CDP_CLIENT_LABEL from the environment', () => {
  assert.equal(
    readLabelFromSubprocess({ BROWSERFORCE_CDP_CLIENT_LABEL: 'shared-team-window' }),
    'shared-team-window');
});

test('default labels differ across processes so concurrent agents get separate windows', () => {
  const env = { BROWSERFORCE_CDP_CLIENT_LABEL: '' };
  const a = readLabelFromSubprocess(env);
  const b = readLabelFromSubprocess(env);
  assert.match(a, /^browserforce-mcp-[0-9a-f]{8}$/);
  assert.match(b, /^browserforce-mcp-[0-9a-f]{8}$/);
  assert.notEqual(a, b, 'a shared constant would make every agent share one window');
});
```

The empty-string env var is deliberate: `||` treats `''` as unset, so this exercises the generated default even when the developer running the suite has the override exported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test mcp/test/client-label.test.js`

Expected: FAIL — `Cannot find module .../mcp/src/client-label.js`.

- [ ] **Step 3: Implement the per-process label**

Create `mcp/src/client-label.js`:

```js
import { randomBytes } from 'node:crypto';

// One affinity label per MCP process: unique across concurrent agents (so each
// gets its own Chrome window) but constant within this process, so the 15s
// idle-disconnect/reconnect cycle reuses the same window instead of spawning a
// new one. An explicit BROWSERFORCE_CDP_CLIENT_LABEL still wins, which is how
// two agents deliberately share one window.
//
// This lives outside index.js on purpose: index.js runs main() at import time
// (no direct-run guard), so importing it from a test would boot the server.
export const PROCESS_CLIENT_LABEL =
  process.env.BROWSERFORCE_CDP_CLIENT_LABEL ||
  `browserforce-mcp-${randomBytes(4).toString('hex')}`;

export function withClientLabel(cdpUrl) {
  try {
    const url = new URL(cdpUrl);
    if (!url.searchParams.get('label')) {
      url.searchParams.set('label', PROCESS_CLIENT_LABEL);
    }
    return url.toString();
  } catch {
    return cdpUrl;
  }
}
```

In `mcp/src/index.js`, delete the local `withClientLabel` function (`:59-71`) and import it instead, alongside the existing imports:

```js
import { withClientLabel } from './client-label.js';
```

Register the new test file in `package.json`, appending to BOTH the `test` and `test:mcp` scripts:

```
&& node --test mcp/test/client-label.test.js
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:mcp`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/client-label.js mcp/src/index.js mcp/test/client-label.test.js package.json
git commit -m "feat(mcp): give each MCP process its own window affinity label

Every MCP instance sent the literal 'browserforce-mcp', so concurrent
agents shared one affinity key and one Chrome window. The label is now
unique per process and stable within it, so each agent gets its own
window while the idle-reconnect cycle still reuses it."
```

---

### Task 5: Per-agent tab ownership

**Files:**
- Modify: `relay/src/index.js` (`_createTarget` — send `ownerKey`; `_closeTarget` — send `ownerKey`)
- Modify: `extension/background.js:49` (`agentCreatedTabs`), `:66-92` (persist/hydrate), `:406` (`listTabs`), `:411-415` (`attachTab`), `:544-561` (`createTab`), `:564+` (`closeTab`), `:729-730`, `:807-808` (cleanup)
- Test: `relay/test/relay-server.test.js`, `test/agent/background-window-plan.test.js`

**Interfaces:**
- Consumes: `_affinityKey(clientId)` from Task 1.
- Produces: `createTab` and `closeTab` extension commands gain an optional `ownerKey: string`. `agentCreatedTabs` becomes `Map<tabId, ownerKey|null>`. `listTabs` entries gain optional `ownerKey`. Persisted `AUTO_MANAGE_STATE_KEY` keeps `agentCreatedTabs` as a bare tab-id array (rollback-readable) and adds `agentTabOwners` as `[tabId, ownerKey]` pairs.

### Scope limit: ownership is close-only

Read this before implementing — it bounds what Task 5 delivers against the stated goal of "no cross-agent tab damage".

Ownership governs **explicit `Target.closeTarget` only**. It does NOT prevent another agent from navigating, clicking, typing into, or running JS in a tab it does not own. The relay routes any authenticated `/cdp` client to any target by `sessionId`, and every client learns every target through `Target.setAutoAttach` discovery. Real per-target authorization would mean the relay rejecting commands whose `sessionId` belongs to another client's owned tab — a relay-wide authorization model touching every forwarding path (`_forwardToTab`, alias sessions, OOPIF child sessions), with its own failure modes for legitimately shared tabs. That is a separate design, not a step in this plan.

What actually reduces cross-agent damage here is **Tasks 2-4**: once each agent works in its own window and never adopts a window it did not open, agents stop discovering and acting on each other's tabs in practice. The close fence then covers exactly one further case — an **explicit** `Target.closeTarget` issued by one agent against another agent's tab.

The idle sweep is deliberately NOT covered: `checkInactiveTabs()` calls `closeTab({ tabId })` with no `ownerKey`, and `canCloseTab` permits an identity-less requester by design (acceptance criterion A4). Auto-close remains purely per-tab idle time and will close any agent's idle tab regardless of owner.

Auto-close is likewise unchanged and per-tab idle: an idle tab is idle regardless of who opened it, and per-owner idle timers would be a different feature.

- [ ] **Step 1: Write the failing tests**

Add to `relay/test/relay-server.test.js`:

```js
it('Target.createTarget forwards the client ownerKey to the extension', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });
  const createCommands = [];
  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
    if (msg.id && msg.method === 'getRestrictions') {
      ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
      return;
    }
    if (msg.id && msg.method === 'createTab') {
      createCommands.push(msg.params);
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId: 600, windowId: 900, targetId: 'real-target-600',
          targetInfo: { targetId: 'real-target-600', type: 'page', title: '', url: 'about:blank', windowId: 900 },
          sessionId: msg.params.sessionId,
        },
      }));
    }
  });

  // Unique label: `label=agent-one` is already claimed by the existing
  // `two different labels keep independent window affinity` test
  // (relay/test/relay-server.test.js:1742-1750), and label pins are durable,
  // so reusing it makes the suite order-dependent.
  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}&label=owner-create-test`);
  try {
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://a.example' } }));
    await waitForCondition(() => createCommands.length === 1, { description: 'createTab reaching the extension' });

    assert.equal(createCommands.length, 1);
    assert.equal(createCommands[0].ownerKey, 'label:owner-create-test');
  } finally {
    cdp.close();
    ext.close();
    await sleep(100);
  }
});
```

Add a second relay test proving the close path carries identity and still cleans up:

```js
it('Target.closeTarget forwards the caller ownerKey and still cleans up', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });
  const closeCommands = [];
  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
    if (msg.id && msg.method === 'getRestrictions') {
      ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
      return;
    }
    if (msg.id && msg.method === 'createTab') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId: 601, windowId: 901, targetId: 'real-target-601',
          targetInfo: { targetId: 'real-target-601', type: 'page', title: '', url: 'about:blank', windowId: 901 },
          sessionId: msg.params.sessionId,
        },
      }));
      return;
    }
    if (msg.id && msg.method === 'closeTab') {
      closeCommands.push(msg.params);
      ext.send(JSON.stringify({ id: msg.id, result: {} }));
    }
  });

  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}&label=owner-close-test`);
  const detached = [];
  cdp.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Target.detachedFromTarget') detached.push(msg.params);
  });

  // Guard everything after socket setup: a waitForCondition timeout before the
  // try would leak both sockets, and RelayServer.stop() closes only the HTTP
  // server (relay/src/index.js:1896-1899).
  try {
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://a.example' } }));
    await waitForCondition(() => relay.tabToSession.has(601), { description: 'created tab registered' });

    cdp.send(JSON.stringify({ id: 2, method: 'Target.closeTarget', params: { targetId: 'real-target-601' } }));
    await waitForCondition(() => closeCommands.length === 1, { description: 'closeTab reaching the extension' });

    assert.equal(closeCommands[0].ownerKey, 'label:owner-close-test');
    // Cleanup must still run — a `return` in place of `await` would skip it.
    await waitForCondition(() => detached.length > 0, { description: 'detachedFromTarget broadcast' });
  } finally {
    cdp.close();
    ext.close();
    await sleep(100);
  }
});
```

Add to `test/agent/background-window-plan.test.js`:

```js
test('agent-created tabs are tracked with their owning agent in one awaited write', () => {
  assert.match(bg, /const agentCreatedTabs = new Map\(\)/);
  assert.match(bg, /attachTab\(tab\.id, params\.sessionId, \{ origin: 'agent-created', ownerKey \}\)/);
  assert.match(bg, /await persistAutoManageState\(\)/);
  // No post-attach resurrection: onTabRemoved may have cleared the tab mid-await.
  assert.doesNotMatch(bg, /agentCreatedTabs\.set\(tab\.id, ownerKey\)/);
});

test('agent membership and its activity clock are checkpointed before the attach can throw', () => {
  const registration = bg.indexOf("origin === 'agent-created'");
  const activity = bg.indexOf('tabLastActivity.set(tabId, Date.now())', registration);
  const checkpoint = bg.indexOf('await persistAutoManageState()', registration);
  const attach = bg.indexOf('chrome.debugger.attach(', registration);
  assert.ok([registration, activity, checkpoint, attach].every((i) => i !== -1));
  assert.ok(activity < checkpoint, 'activity clock must be seeded before the checkpoint');
  assert.ok(checkpoint < attach,
    'persist must happen before chrome.debugger.attach, which can throw');
});

test('closeTab refuses to close a tab owned by a different agent', () => {
  assert.match(bg, /owned by another agent/);
});

test('persisted auto-manage state stays rollback-readable', () => {
  assert.match(bg, /agentCreatedTabs: \[\.\.\.agentCreatedTabs\.keys\(\)\]/);
  assert.match(bg, /agentTabOwners: \[\.\.\.agentCreatedTabs\]/);
});

test('the ownership rewrite does not drop dedicated-window persistence', () => {
  assert.match(bg, /dedicatedWindowIds: \[\.\.\.dedicatedWindowIds\]/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run each file separately so one expected failure cannot mask the other:

```bash
node --test relay/test/relay-server.test.js
node --test test/agent/background-window-plan.test.js
```

Expected: both FAIL — `createCommands[0].ownerKey` is `undefined`; the background source assertions find no match.

- [ ] **Step 3: Send `ownerKey` from the relay**

In `relay/src/index.js` `_createTarget()`, extend `createParams` (it already computes `affinityKey`):

```js
    const createParams = {
      url: params.url || 'about:blank',
      sessionId,
    };
    if (affinityKey) createParams.ownerKey = affinityKey;
```

Move the `const affinityKey = this._affinityKey(clientId);` line above `createParams` so it is in scope.

`_closeTarget` does not currently receive the caller's identity, so it must be threaded in. Three edits, in order:

1. `relay/src/index.js:1430-1431` — pass `clientId` at the dispatch site:

```js
      case 'Target.closeTarget':
        return this._closeTarget(params, clientId);
```

2. `relay/src/index.js:1707` — widen the signature:

```js
  async _closeTarget(params, clientId) {
```

3. `relay/src/index.js:1721` — replace `await this._sendToExt('closeTab', { tabId });` with:

```js
    const ownerKey = this._affinityKey(clientId);
    await this._sendToExt('closeTab', ownerKey ? { tabId, ownerKey } : { tabId });
```

**Keep `await`, do not `return` here.** The lines immediately after (`:1723+`) delete child sessions and broadcast `Target.detachedFromTarget`; returning early would skip all relay-side cleanup and leak session state.

- [ ] **Step 4: Track ownership in the extension**

In `extension/background.js:49`:

```js
/** Tracks tabs created by the agent via createTab() (tabId → owning agent key) */
const agentCreatedTabs = new Map();
```

`persistAutoManageState()` must keep `agentCreatedTabs` as a **bare tab-id array** and carry owners in a separate key. If it wrote `[tabId, ownerKey]` pairs there, a rollback to the previous extension would hydrate each pair as a tab id, match nothing in `openTabIds`, and silently lose every agent-tab membership (and therefore auto-close) for the rest of the browser session:

```js
      [AUTO_MANAGE_STATE_KEY]: {
        // Bare ids: an older extension build hydrates this key directly, so the
        // shape must stay rollback-readable. Owners ride alongside it.
        agentCreatedTabs: [...agentCreatedTabs.keys()],
        agentTabOwners: [...agentCreatedTabs],
        tabLastActivity: [...tabLastActivity],
        // Added in Task 2 — MUST be preserved here. Dropping it means dedicated
        // windows hydrate as unknown after an MV3 restart, so a valid pin is no
        // longer recognised as dedicated and every create opens a NEW window.
        dedicatedWindowIds: [...dedicatedWindowIds],
      },
```

In `hydrateAutoManageState()` replace the agent-tab loop (Step 6 factors this exact logic into a pure module and rewires this call site — write it inline here only to keep this step independently runnable):

```js
    // Owners are best-effort metadata: malformed data must never abort hydration,
    // or tabLastActivity is lost too and auto-close silently stops working.
    const owners = new Map(
      (Array.isArray(saved.agentTabOwners) ? saved.agentTabOwners : [])
        .filter((pair) => Array.isArray(pair) && pair.length === 2)
        .map(([tabId, ownerKey]) => [tabId, typeof ownerKey === 'string' ? ownerKey : null]),
    );
    // Bare-ID list is the source of truth for membership; last owner entry wins.
    for (const tabId of Array.isArray(saved.agentCreatedTabs) ? saved.agentCreatedTabs : []) {
      if (openTabIds.has(tabId)) agentCreatedTabs.set(tabId, owners.get(tabId) ?? null);
    }
```

Older state (written before this change) simply has no `agentTabOwners`, so every hydrated tab gets a `null` owner and is closable by anyone — the pre-ownership behavior, which is correct for tabs whose owner was never recorded.

In `createTab()`, pass the owner INTO `attachTab` instead of writing membership twice. The existing sequence sets a null owner inside `attachTab`, persists, then overwrites with the real owner and persists again — both unawaited, so an MV3 restart or a reordered write between them loses ownership (A3) and can take the activity clock with it (A4).

Replace the existing `attachTab` call:

```js
  const ownerKey = typeof params.ownerKey === 'string' ? params.ownerKey : null;
  let result;
  try {
    result = await attachTab(tab.id, params.sessionId, { origin: 'agent-created', ownerKey });
  } catch (e) {
    // The attach is awaited, so onTabRemoved may have run meanwhile and cleared
    // this tab. Roll back rather than leaving membership for a tab that never
    // attached — Chrome reuses tab ids, and a stale entry would later
    // misclassify or auto-close an unrelated tab.
    agentCreatedTabs.delete(tab.id);
    tabLastActivity.delete(tab.id);
    await persistAutoManageState();
    throw e;
  }
  return result;
```

`createTab` must NOT write `agentCreatedTabs` or persist on the success path — `attachTab` performs the one awaited write, before the debugger attach. A post-attach `set` here would resurrect membership for a tab that `onTabRemoved` deleted during the await.

In `attachTab()`, accept the owner and keep the checkpoint exactly where it is today, **before** `chrome.debugger.attach`:

```js
  if (origin === 'agent-created') {
    const ownerKey = typeof options.ownerKey === 'string' ? options.ownerKey : null;
    if (!agentCreatedTabs.has(tabId)) agentCreatedTabs.set(tabId, ownerKey);
    else if (ownerKey && !agentCreatedTabs.get(tabId)) agentCreatedTabs.set(tabId, ownerKey);
    // Seed the activity clock HERE, not only at the existing post-attach
    // `tabLastActivity.set` (extension/background.js:483). The checkpoint below
    // is the only write before the attach, and membership persisted without an
    // activity entry means checkInactiveTabs() iterates tabLastActivity and
    // never sees this tab — auto-close would silently never fire (A4).
    if (!tabLastActivity.has(tabId)) tabLastActivity.set(tabId, Date.now());
    // Checkpoint BEFORE the debugger attach, mirroring the current code
    // (extension/background.js:413-416): attach can throw on a frozen or
    // restricted tab, and losing membership there means the tab is never
    // auto-closed. Awaited so an MV3 restart cannot race the write.
    await persistAutoManageState();
  }
```

This is `attachTab`'s single persist, and it happens **before** `chrome.debugger.attach`. Do not add a second write after the attach, and do not move this one below it.

The lazy-attach path in `_ensureDebuggerAttached` passes no `ownerKey`, so a re-adopted tab keeps whatever owner it already had and never downgrades to `null`.

In `attachTab()`'s agent re-registration (`:413-415`), preserve any existing owner:

(shown above — `attachTab` records membership with the owner and does not persist)

This invalidates an existing source contract. In `test/agent/background-window-plan.test.js:29-31`, replace:

```js
  assert.match(bg, /origin === 'agent-created'\) \{\s*agentCreatedTabs\.add\(tabId\)/);
```

with:

```js
  assert.match(bg, /origin === 'agent-created'\) \{[\s\S]{0,200}agentCreatedTabs\.set\(tabId, ownerKey\)/);
```

In `listTabs()` (`:406`), surface the owner alongside the existing origin field:

```js
        origin: agentCreatedTabs.has(t.id) ? 'agent-created' : undefined,
        ownerKey: agentCreatedTabs.get(t.id) || undefined,
```

In `closeTab()`, fence cross-owner closes at the top of the function:

```js
  const owner = agentCreatedTabs.get(tabId);
  const requester = typeof params.ownerKey === 'string' ? params.ownerKey : null;
  // A tab with a known owner may only be closed by that owner. Unowned tabs
  // (manually attached, or hydrated from a pre-ownership session) stay open to
  // every client so this cannot strand them.
  if (owner && requester && owner !== requester) {
    throw new Error(`Tab ${tabId} is owned by another agent`);
  }
```

`agentCreatedTabs.delete(tabId)` at `:730` and `:808` works unchanged on a Map.

`onTabRemoved` (`extension/background.js:752-753`) currently early-returns for any tab not in `attachedTabs`, so a hydrated agent tab that closes while unattached leaves stale membership, a stale activity entry, and — after Task 2 — a stale dedicated-window association. Chrome reuses tab ids, so a later tab can inherit that identity and be misclassified as agent-owned or auto-closed. Clear bookkeeping unconditionally and gate only the relay notification on attachment:

```js
function onTabRemoved(tabId) {
  // Bookkeeping is cleared even for tabs we never attached: hydrated agent tabs
  // can close while unattached, and Chrome reuses tab ids, so a stale entry
  // would later misclassify or auto-close an unrelated tab.
  const hadAgentEntry = agentCreatedTabs.delete(tabId);
  const hadActivity = tabLastActivity.delete(tabId);
  if (hadAgentEntry || hadActivity) persistAutoManageState();

  if (!attachedTabs.has(tabId)) return;

  send({
    method: 'tabDetached',
    params: { tabId, reason: 'tab_closed' },
  });
  cleanupTab(tabId);
  updateBadge();
  queueSyncTabGroup();
}
```

Add the contract:

```js
test('closing an unattached tab still clears its agent bookkeeping', () => {
  assert.match(bg, /function onTabRemoved\(tabId\) \{[\s\S]{0,400}agentCreatedTabs\.delete\(tabId\)[\s\S]{0,200}if \(!attachedTabs\.has\(tabId\)\) return;/);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:relay && pnpm test:agent`

Expected: PASS.

- [ ] **Step 6: Cover hydration, ownership and auto-close with real tests**

Source-contract regexes cannot prove acceptance criteria A3 (legacy/rollback hydration) or A4 (auto-close unchanged). Extract the two decisions into a pure, Chrome-free module — the same pattern `extension/window-affinity.js` already establishes — and test that.

Create `extension/auto-manage-state.js`:

```js
// Pure helpers for agent-tab bookkeeping. Kept out of background.js so they are
// testable without Chrome APIs (same rationale as window-affinity.js).

/**
 * Rebuild the agent-tab map from persisted state.
 * `agentCreatedTabs` (bare ids) is the source of truth for membership;
 * `agentTabOwners` pairs are best-effort metadata. Malformed owner data must
 * never abort hydration — losing it costs a close-fence, losing membership
 * costs auto-close entirely.
 * @returns {Map<number, string|null>}
 */
export function hydrateAgentTabs(saved, openTabIds) {
  const owners = new Map(
    (Array.isArray(saved?.agentTabOwners) ? saved.agentTabOwners : [])
      .filter((pair) => Array.isArray(pair) && pair.length === 2)
      .map(([tabId, ownerKey]) => [tabId, typeof ownerKey === 'string' ? ownerKey : null]),
  );
  const out = new Map();
  for (const tabId of Array.isArray(saved?.agentCreatedTabs) ? saved.agentCreatedTabs : []) {
    if (openTabIds.has(tabId)) out.set(tabId, owners.get(tabId) ?? null);
  }
  return out;
}

/**
 * Rebuild the activity clock from persisted state.
 * Entries are validated before destructuring: `extension/background.js:88-90`
 * currently destructures raw persisted pairs, so a malformed member (`null`,
 * a bare number) throws and aborts the whole hydrate — which silently disables
 * auto-close for every restored tab, not just the bad one.
 * @returns {Map<number, number>}
 */
export function hydrateActivity(saved, openTabIds) {
  const out = new Map();
  for (const pair of Array.isArray(saved?.tabLastActivity) ? saved.tabLastActivity : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [tabId, lastActivity] = pair;
    if (!Number.isInteger(lastActivity) || !openTabIds.has(tabId)) continue;
    out.set(tabId, lastActivity);
  }
  return out;
}

/**
 * A tab with a known owner may only be closed by that owner. Unowned tabs
 * (manually attached, hydrated from a pre-ownership session) and internal
 * callers with no identity (auto-close) may always close.
 */
export function canCloseTab({ owner, requester }) {
  if (!owner || !requester) return true;
  return owner === requester;
}
```

**Rewire `background.js` to call these helpers — do not leave the inline versions from Step 4 in place**, or the pure tests would pass while production runs divergent logic.

Add the import alongside the existing `window-affinity.js` import:

```js
import { hydrateAgentTabs, hydrateActivity, canCloseTab } from './auto-manage-state.js';
```

In `hydrateAutoManageState()`, replace the whole inline owners/membership block written in Step 4 with:

```js
    for (const [tabId, ownerKey] of hydrateAgentTabs(saved, openTabIds)) {
      agentCreatedTabs.set(tabId, ownerKey);
    }
    for (const [tabId, lastActivity] of hydrateActivity(saved, openTabIds)) {
      tabLastActivity.set(tabId, lastActivity);
    }
```

This replaces the existing unguarded loop at `extension/background.js:88-90`.

In `closeTab()`, replace the inline fence written in Step 4 with:

```js
  const requester = typeof params.ownerKey === 'string' ? params.ownerKey : null;
  if (!canCloseTab({ owner: agentCreatedTabs.get(tabId), requester })) {
    throw new Error(`Tab ${tabId} is owned by another agent`);
  }
```

Assert the wiring in `test/agent/background-window-plan.test.js` so the helpers cannot silently drift back inline:

```js
test('background delegates hydration and the close fence to the pure helpers', () => {
  assert.match(bg, /import \{ hydrateAgentTabs, hydrateActivity, canCloseTab \} from '\.\/auto-manage-state\.js'/);
  assert.match(bg, /hydrateAgentTabs\(saved, openTabIds\)/);
  assert.match(bg, /hydrateActivity\(saved, openTabIds\)/);
  assert.match(bg, /canCloseTab\(\{ owner: agentCreatedTabs\.get\(tabId\), requester \}\)/);
});
```

Create `test/agent/auto-manage-state.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateAgentTabs, hydrateActivity, canCloseTab } from '../../extension/auto-manage-state.js';

test('hydrates legacy state written before ownership existed', () => {
  const out = hydrateAgentTabs({ agentCreatedTabs: [1, 2] }, new Set([1, 2]));
  assert.deepEqual([...out], [[1, null], [2, null]]);
});

test('hydrates membership plus owners from the two-field format', () => {
  const out = hydrateAgentTabs(
    { agentCreatedTabs: [1, 2], agentTabOwners: [[1, 'label:a'], [2, 'label:b']] },
    new Set([1, 2]),
  );
  assert.deepEqual([...out], [[1, 'label:a'], [2, 'label:b']]);
});

test('prunes tabs that closed while the service worker was dead', () => {
  const out = hydrateAgentTabs({ agentCreatedTabs: [1, 2], agentTabOwners: [[2, 'label:b']] }, new Set([2]));
  assert.deepEqual([...out], [[2, 'label:b']]);
});

test('malformed owner data never costs membership', () => {
  for (const agentTabOwners of ['nope', [null], [[1]], [[1, 2, 3]], undefined]) {
    const out = hydrateAgentTabs({ agentCreatedTabs: [1], agentTabOwners }, new Set([1]));
    assert.deepEqual([...out], [[1, null]], `agentTabOwners=${JSON.stringify(agentTabOwners)}`);
  }
});

test('a non-string owner key degrades to unowned rather than throwing', () => {
  const out = hydrateAgentTabs({ agentCreatedTabs: [1], agentTabOwners: [[1, 42]] }, new Set([1]));
  assert.deepEqual([...out], [[1, null]]);
});

test('a malformed activity entry never aborts hydration of the good ones', () => {
  const saved = { tabLastActivity: [[1, 1000], null, [2], [3, 'nope'], [4, 4000]] };
  const out = hydrateActivity(saved, new Set([1, 2, 3, 4]));
  assert.deepEqual([...out], [[1, 1000], [4, 4000]]);
});

test('activity hydration prunes tabs that are no longer open', () => {
  const out = hydrateActivity({ tabLastActivity: [[1, 1000], [2, 2000]] }, new Set([2]));
  assert.deepEqual([...out], [[2, 2000]]);
});

test('activity hydration tolerates a missing or non-array field', () => {
  for (const tabLastActivity of [undefined, null, 'nope', {}]) {
    assert.deepEqual([...hydrateActivity({ tabLastActivity }, new Set([1]))], []);
  }
});

test('an owner may close its own tab', () => {
  assert.equal(canCloseTab({ owner: 'label:a', requester: 'label:a' }), true);
});

test('a different agent may not close it', () => {
  assert.equal(canCloseTab({ owner: 'label:a', requester: 'label:b' }), false);
});

test('auto-close has no identity and is never fenced (A4)', () => {
  assert.equal(canCloseTab({ owner: 'label:a', requester: null }), true);
});

test('unowned tabs stay closable by anyone', () => {
  assert.equal(canCloseTab({ owner: null, requester: 'label:b' }), true);
});
```

Register it in BOTH the `test` and `test:agent` scripts in `package.json`:

```
&& node --test test/agent/auto-manage-state.test.js
```

Run: `node --test test/agent/auto-manage-state.test.js && pnpm test:agent`

Expected: PASS. The `auto-close has no identity` case is the executable form of acceptance criterion A4 — `checkInactiveTabs()` calls `closeTab({ tabId })` with no `ownerKey`, so `requester` is `null` and auto-close is never fenced.

- [ ] **Step 7: Commit**

```bash
git add relay/src/index.js extension/background.js extension/auto-manage-state.js \
  relay/test/relay-server.test.js test/agent/background-window-plan.test.js \
  test/agent/auto-manage-state.test.js package.json
git commit -m "feat(relay,extension): track per-agent tab ownership

Agent-created tabs now record the owning client's affinity key, and an
explicit closeTab from a different agent is refused. Auto-close is
unchanged (idle time is per tab, not per owner)."
```

---

### Task 6: Documentation pass

**Files:**
- Modify: `AGENTS.md` (protocol table, "Agent Window Affinity", "Durable Auto-Close", both "Operational Non-Goals" entries, the "Dedicated window (opt-in)" heading)
- Modify: `README.md` (`:926`, `:935`, `:939`, `:1079`)
- Modify: `README.frontpage.md` (`:867`)
- Modify: `GUIDE.md` (`:71`, `:73`, `:80`)
- Modify: `docs/DEVELOPMENT.md` (`:76-82`, `:87` heading, `:93`)

- [ ] **Step 1: Update the extension protocol table in `AGENTS.md`**

In "Relay → Extension (commands)", amend the two rows:

```
| `createTab` | `{ url, sessionId, windowId?, ownerKey? }` | Create and attach new tab (`windowId` pins the agent's window; `ownerKey` records the owning agent) |
| `closeTab` | `{ tabId, ownerKey? }` | Close tab (refused when `ownerKey` names a different agent than the tab's owner) |
```

- [ ] **Step 2: Rewrite the affinity paragraph in `AGENTS.md` "Agent Window Affinity"**

Replace the "Affinity keying (label-durable)" paragraph's consequence sentence and add:

```markdown
**Pin provenance:** affinity entries are `{ windowId, strength }`. `strength: 'created'` means a window a `createTab` actually used; `strength: 'discovered'` means a window merely seeded from the first real command on some tab — which may be the USER's. **Only `created` pins are ever sent to the extension as a create target.** A create always re-pins (`_pinAgentWindow(key, id, 'created')`) with no guard: the previous `sentPinned || !has(key)` guard skipped the re-pin whenever a real command seeded affinity DURING the `createTab` round-trip, so the dedicated window was never recorded and every later create fell into the seeded user window. A weak pin never overwrites a strong one.

**Dedicated-window provenance:** a `created` pin is NOT automatically an agent window — a pin established while `dedicatedWindow` was OFF names the user's own window and stays valid when the setting is later switched ON. The relay cannot tell the two apart, so the extension tracks the windows it opened as dedicated (`dedicatedWindowIds`, persisted under `AUTO_MANAGE_STATE_KEY`) and `resolveCreateWindowPlan()` takes `isRequestedWindowDedicated`: while dedicated mode is on, a valid pinned window is reused ONLY when the extension opened it as dedicated; otherwise a fresh dedicated window is created. Do not "simplify" this away — without it, agent tabs keep landing in the user's window with the setting ON.

**Per-agent windows:** MCP sends a per-process label (`browserforce-mcp-<8 hex>`), unique across concurrent agents and stable within a process so the 15s idle-reconnect reuses the same window. `BROWSERFORCE_CDP_CLIENT_LABEL` overrides it — that is how two agents deliberately share one window.
```

Also update the older sentence that names `label=browserforce-mcp` as a fixed literal.

- [ ] **Step 3: Update "Durable Auto-Close" and reverse the Non-Goal**

In "Durable Auto-Close", change the persistence bullet to describe the format exactly as implemented — an incorrect migration contract in the governing doc is worse than none:

```markdown
- **Persistence shape**: in memory `agentCreatedTabs` is a `Map<tabId, ownerKey|null>`. `AUTO_MANAGE_STATE_KEY` holds FOUR fields: `agentCreatedTabs` (a bare tab-id array — kept in this shape so an older extension build can still hydrate membership after a rollback), `agentTabOwners` (`[tabId, ownerKey]` pairs), `tabLastActivity`, and `dedicatedWindowIds` (windows the extension opened as dedicated agent windows, pruned on `chrome.windows.onRemoved` and against open windows at hydrate). Membership comes from the bare-id array; owners are best-effort and default to `null`, so state written before ownership existed hydrates as unowned (closable by any client), which is the correct pre-ownership behavior.
```

In "Operational Non-Goals", replace `- No per-tab ownership model; arbitration is one relay-level client slot.` with:

```markdown
- Tab ownership is metadata-only: agent-created tabs record an owning agent key, and an explicit `closeTab` from a different agent is refused. It is NOT a capability fence — every CDP client can still navigate any target, and auto-close remains per-tab idle time rather than per owner.
```

- [ ] **Step 4: Update every live doc that still describes the old behavior**

These are the exact live-doc contradictions. All must change:

| File:line | Current text | Required change |
|---|---|---|
| `AGENTS.md` "Dedicated window (opt-in)" | `Default is OFF.` | Default is **ON**; unset reads as enabled |
| `docs/DEVELOPMENT.md:93` | `Default is OFF.` | same |
| `GUIDE.md:71` | `Agent-created tabs stay visible in the current window` | agent-created tabs open in the agent's own window by default |
| `GUIDE.md:73` | `No new windows are created for parallel workers.` | a dedicated agent window is created by default; one per agent process |
| `README.md:935` | `foreground-tab` (visible tabs in the active window, no new windows) | note the dedicated agent window is the default placement |
| `README.md:939` | `New agent tabs open visibly in your current Chrome window and stay there.` | they open in the agent's dedicated window |
| `README.md:1079` | ``MCP defaults to `browserforce-mcp`.`` | MCP defaults to `browserforce-mcp-<8 hex>`, unique per process; set `BROWSERFORCE_CDP_CLIENT_LABEL` to share a window |
| `README.frontpage.md:867` | ``MCP defaults to `browserforce-mcp`.`` | same as `README.md:1079` |
| `README.md:926` | `foreground-tab` keeps new tabs visible in the current window | new tabs are visible in the agent's dedicated window |
| `GUIDE.md:80` | `Visible parallel in current window: ... parallelVisibilityMode=foreground-tab` | visible parallel in the agent's dedicated window |
| `docs/DEVELOPMENT.md:76-82` | affinity is "seeded from the first non-init command" and that `windowId` is sent to `createTab` | only a `created` pin is sent; a pin merely seeded from a first command is `discovered` and is never used as a create target |
| `AGENTS.md:162` | "affinity still resolves deterministically to the first established window" | a create now re-pins unconditionally, so with truly concurrent creates the LAST completing create's window wins, not the first |
| `AGENTS.md:158` | "The relay seeds `agentWindowByAffinityKey` from the `windowId` of the first real (non-init) command in `_forwardToTab()`, then passes that `windowId` to `createTab`" and "if it was closed, falls back to the current focused window" | the first-command seed is a `discovered` pin and is never passed to `createTab`; only `created` pins are sent, and with dedicated mode ON a closed or non-dedicated window yields a NEW dedicated window rather than the current focused one |

Rename the now-misleading headings: `AGENTS.md:164` and `docs/DEVELOPMENT.md:87` both read `**Dedicated window (opt-in):**`. Change both to `**Dedicated window (default ON):**`. Leave the unrelated "opt-in" wording at `README.md:1047` and `AGENTS.md:196` alone — those describe the `single-active` client slot.

Also remove `AGENTS.md:366` (`- No extension protocol changes for this feature area.`) or scope it explicitly — Task 5 adds `ownerKey` to `createTab`/`closeTab`, so leaving it stands as a direct contradiction.

- [ ] **Step 5: Verify no stale references remain**

Run:

Scope the search to LIVE documentation only. `docs/superpowers/` holds historical specs and plans (including this one), which legitimately describe the old behavior and must not be rewritten:

```bash
rg -ni \
  -e 'Default is OFF' \
  -e 'Dedicated window \(opt-in\)' \
  -e 'browserforce-mcp`' \
  -e 'No per-tab ownership' \
  -e 'No extension protocol changes' \
  -e 'Agent-created tabs stay visible in the current window' \
  -e 'No new windows are created for parallel workers' \
  -e 'keeps new tabs visible in the current window' \
  -e 'open visibly in your current Chrome window' \
  -e 'Visible parallel in current window' \
  -e 'then passes that .windowId. to .createTab' \
  -e 'falls back to the current focused window' \
  -e 'resolves deterministically to the first established window' \
  AGENTS.md README.md README.frontpage.md GUIDE.md docs/ --glob '!docs/superpowers/**'
```

Expected: no hits. Note the trailing backtick in the label pattern — it matches the OLD literal ``browserforce-mcp` `` (closing delimiter immediately after) but NOT the required new text ``browserforce-mcp-<8 hex>``, so a correct edit actually clears the check.

- [ ] **Step 6: Run the full suite and commit**

Run: `pnpm test`

```bash
git add AGENTS.md README.md README.frontpage.md GUIDE.md docs/DEVELOPMENT.md
git commit -m "docs: record affinity provenance, per-agent labels and tab ownership

Documents the createTab/closeTab ownerKey protocol fields, the created vs
discovered pin split, per-process MCP affinity labels, and the
dedicated-window default flip; reverses the per-tab-ownership Non-Goal."
```

---

## Manual Verification (after Task 6)

Automated tests cannot exercise real Chrome. After the full plan lands, verify by hand:

1. Reload the extension at `chrome://extensions/`, restart the relay (`pnpm relay`), restart the MCP client.
2. With several OOPIF-heavy tabs open (Slack, Notion, Google Docs) in your working window, have an agent create three tabs.
3. Check `curl -s http://127.0.0.1:19222/extension/status`: all three `agent-created` tabs must share one `windowId`, and that `windowId` must contain **no** `relay-discovered` tabs.
4. Run a second agent concurrently; its tabs must occupy a different `windowId`.
5. Confirm your own window's selected tab is never changed by either agent.

---

## Risks

- **Behavior change for existing users.** Anyone who never touched the setting now gets dedicated windows. Intended, and called out in the docs commit.
- **Label churn.** A restarted MCP process gets a new label and therefore a new window; tabs in the old window are orphaned (they still work, they are just no longer the affinity target). `MAX_AFFINITY_ENTRIES = 50` FIFO eviction bounds the map. Acceptable at 2-3 concurrent agents; revisit only if orphaned windows become a nuisance.
- **The race is load-dependent.** Task 1's regression test forces it deterministically at the relay level, so the fix is verifiable without reproducing the live timing.
