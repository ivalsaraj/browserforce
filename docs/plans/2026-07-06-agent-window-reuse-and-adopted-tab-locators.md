# Agent Window Reuse + Adopted-Tab Locators + Durable Auto-Close — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the three live-verified root causes behind "BrowserForce opens a new Chrome window every session, never closes them, and locator actions hang on adopted tabs": (1) relay swallows `Page.createIsolatedWorld` so Playwright's utility world never exists on adopted tabs, (2) window affinity is keyed to the ephemeral CDP connection id and dies on every 15s idle-disconnect/reset, (3) auto-close bookkeeping (`agentCreatedTabs`/`tabLastActivity`) is in-memory in the MV3 service worker and its idle clock is reset by Playwright's init storm on every reconnect.

**Architecture:** All changes live in the relay (`relay/src/index.js`) and extension (`extension/background.js`); no MCP-layer or CDP-protocol-shape changes. The relay stops special-casing `Page.createIsolatedWorld` for attached tabs (it stays synthetic for unattached tabs), keys window affinity by the stable client `label` (already sent by MCP as `label=browserforce-mcp`), tags forwarded init-only commands as `passive` so the extension does not bump idle timers for them, and preserves `agent-created` provenance across lazy re-attach. The extension persists auto-close state to `chrome.storage.session` (survives SW restart, dies with the browser — the correct lifetime) and re-arms its sweep from the existing `bf-reconnect` alarm.

**Tech Stack:** Node.js (ESM relay, `ws`), Chrome MV3 service worker, `node:test`. No new dependencies.

**Branch:** `fix/agent-window-reuse-and-utility-world`, based on `main`.
**Working copy decision:** implement directly in the main checkout (NOT a worktree) — the user's Chrome loads the unpacked extension from `/Users/valsaraj/Documents/projects/browserforce/extension`, so live browser verification requires the branch to be checked out here. The only pre-existing dirty file is `package.json` (user's own version bump `1.1.1 → 1.1.2`); never stage or commit it.

**Diagnosis evidence (live-verified 2026-07-06):**
- `fill` on an adopted DuckDuckGo tab timed out; after `page.reload()` it worked in 278ms — utility world is created for new documents by the (forwarded) `Page.addScriptToEvaluateOnNewDocument` but never for the *current* document because `Page.createIsolatedWorld` is answered synthetically even when the debugger is attached (`ALWAYS_SYNTHETIC_INIT_METHODS`, added in d8d3401).
- 7 MCP sessions produced 7 separate Chrome windows: relay deletes `agentWindowByClientId` on client disconnect (`relay/src/index.js:1222`), MCP idle-disconnects after 15s (`mcp/src/index.js:42`), extension `dedicatedWindow=true` then spawns a fresh window per re-connect.
- Extension storage forensics: `autoCloseMinutes` currently `0` (user must re-enable via popup — out of code scope), and even when enabled the state is wiped on SW restart plus every reconnect init storm bumps `tabLastActivity` for all attached tabs.

**Playwright 1.61 facts this plan relies on (read from `node_modules/playwright-core/lib/coreBundle.js`):**
- On FrameSession init Playwright calls `_sendMayFail("Page.createIsolatedWorld", { frameId, grantUniveralAccess: true, worldName: this._crPage.utilityWorldName })` — the *response is discarded*; the utility context is registered only via the `Runtime.executionContextCreated` event whose `name` matches `utilityWorldName`.
- `utilityWorldName` is `__playwright_utility_world_${page.guid}` — unique per Page object/connection.
- For tabs already debugger-attached at client connect, `Page.getFrameTree` / `Runtime.enable` / `Page.addScriptToEvaluateOnNewDocument` are forwarded (INIT_ONLY methods forward when attached), so frame ids are real and main-world contexts flow. Only the current document's utility world is missing → exactly what Task 1 fixes.
- **Known limitation (documented, not fixed here):** tabs that were *never* attached when the client connected hold a synthetic frame id (`bf-target-<tabId>`) from the synthetic `Page.getFrameTree`; context events for them can't bind until a navigation re-keys the frame. Locator actions there still require a navigation first. Out of scope: full frame-id translation.

---

## Task 1: Relay — forward `Page.createIsolatedWorld` to attached tabs

**Files:**
- Modify: `relay/src/index.js` (delete `ALWAYS_SYNTHETIC_INIT_METHODS` at ~181-183; remove its two guards at ~1680-1682 and ~1731-1733)
- Test: `relay/test/relay-server.test.js` (flip test at ~2634; add one new test)

**Step 1: Flip the existing test (write the failing test)**

Replace the test `answers Page.createIsolatedWorld synthetically for already-attached manual tabs` (relay/test/relay-server.test.js:2634) with:

```js
it('forwards Page.createIsolatedWorld to already-attached manual tabs (utility world must exist)', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });
  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
  try {
    const isolatedWorldCommands = [];
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'cdpCommand') {
        if (msg.params.method === 'Page.createIsolatedWorld') {
          isolatedWorldCommands.push(msg.params);
          ext.send(JSON.stringify({ id: msg.id, result: { executionContextId: 7 } }));
          return;
        }
        ext.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });

    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    await sleep(50);

    ext.send(JSON.stringify({
      method: 'manualTabAttached',
      params: {
        tabId: 777,
        sessionId: 'manual-777-456',
        targetId: 'bf-target-777',
        targetInfo: { url: 'https://sheet.example', title: 'Sheet' },
        origin: 'manual',
      },
    }));

    await sleep(200);

    const attached = events.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should receive Target.attachedToTarget event');

    cdp.send(JSON.stringify({
      id: 20,
      method: 'Page.createIsolatedWorld',
      params: {
        frameId: 'bf-target-777',
        worldName: '__playwright_utility_world_page@test',
        grantUniveralAccess: true,
      },
      sessionId: attached.params.sessionId,
    }));

    await sleep(100);

    const response = events.find((m) => m.id === 20);
    assert.equal(response?.result?.executionContextId, 7,
      'forwarded response must round-trip from the extension');
    assert.equal(isolatedWorldCommands.length, 1,
      'Page.createIsolatedWorld must be forwarded to the extension exactly once');
    assert.equal(isolatedWorldCommands[0].tabId, 777);
  } finally {
    cdp.close();
    ext.close();
    await sleep(100);
  }
});
```

**Step 2: Add the unattached-tab guard test (must pass before AND after)**

Append after the flipped test:

```js
it('keeps Page.createIsolatedWorld synthetic on unattached tabs (no eager attach)', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });
  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
  try {
    const extCommands = [];
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'listTabs') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabs: [{ tabId: 901, windowId: 11, url: 'https://idle.example', title: 'Idle', active: false }] },
        }));
        return;
      }
      if (msg.id) extCommands.push(msg.method);
    });

    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(300);

    const attached = events.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'discovered tab should be exposed');

    cdp.send(JSON.stringify({
      id: 2,
      method: 'Page.createIsolatedWorld',
      params: { frameId: 'bf-target-901', worldName: '__pw_utility', grantUniveralAccess: true },
      sessionId: attached.params.sessionId,
    }));
    await sleep(150);

    const response = events.find((m) => m.id === 2);
    assert.deepEqual(response?.result, {}, 'unattached tab still gets a synthetic response');
    assert.ok(!extCommands.includes('attachTab'), 'must not trigger eager debugger attach');
    assert.ok(!extCommands.includes('cdpCommand'), 'must not forward to the extension');
  } finally {
    cdp.close();
    ext.close();
    await sleep(100);
  }
});
```

**Step 3: Run to verify the flipped test fails**

Run: `node --test relay/test/relay-server.test.js --test-name-pattern "createIsolatedWorld"`
Expected: flipped test FAILS (`isolatedWorldCommands.length` is 0 — relay answered synthetically); guard test PASSES.

**Step 4: Implement**

In `relay/src/index.js`:
1. Delete the `ALWAYS_SYNTHETIC_INIT_METHODS` declaration (~lines 181-183).
2. In `_forwardToTab` main-session path, delete:
```js
if (ALWAYS_SYNTHETIC_INIT_METHODS.has(method)) {
  return syntheticInitResponse(method, target);
}
```
3. In the alias-session path, delete the identical guard.
4. Update the comment on `'Page.createIsolatedWorld'` inside `INIT_ONLY_METHODS` to:
```js
'Page.createIsolatedWorld',                  // synthetic ONLY while unattached; forwarded when attached so Playwright's utility world (locator actions) exists — see docs/knowledge/knowledge1.md 2026-07-06
```

`Page.createIsolatedWorld` stays in `INIT_ONLY_METHODS`, so unattached tabs keep synthetic `{}` and lazy attach is never triggered by it.

**Why this is safe vs. commit d8d3401 ("keep createIsolatedWorld synthetic for attached manual tabs"):** Playwright fires it via `_sendMayFail` and discards the response — forwarding cannot "pull Playwright into eager init"; the eager-init problem d8d3401 actually fixed was the missing `targetCreated` ordering (which stays). The synthetic answer, however, provably breaks every locator action on adopted tabs (live repro above). The google-sheets plugin path uses `page.evaluate` (main world) and is unaffected; run its tests in Step 5 to confirm.

**Step 5: Run tests**

Run: `node --test relay/test/relay-server.test.js`
Expected: PASS (100%).
Run: `node --test mcp/test/exec-engine-plugins.test.js --test-name-pattern "getBrowserforcePageForTab|gsSummarizeSheet"`
Expected: PASS (sheets flow unaffected).

**Step 6: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js
git commit -m "fix(relay): forward Page.createIsolatedWorld to attached tabs

Playwright registers its utility world only via Runtime.executionContextCreated
after a real createIsolatedWorld; answering synthetically starved adopted tabs
of the utility world, hanging every locator action (fill/click/waitFor) until
a navigation. Keep it synthetic for unattached tabs (no eager attach)."
```

---

## Task 2: Relay — window affinity keyed by client label, survives reconnects

**Files:**
- Modify: `relay/src/index.js` (constructor map, `_seedAgentWindowAffinity`, `_createTarget`, client `close` handler)
- Test: `relay/test/relay-server.test.js` (two new tests next to the existing affinity tests at ~1482-1672)

**Step 1: Write the failing tests**

Add after the test `Target.createTarget reuses the first agent-created windowId for later tabs` (~line 1576). Reuse the fake-extension pattern from the test at line 1576 (same `listTabs`/`attachTab`/`cdpCommand`/`createTab` handlers; `createTab` responds `windowId: 500` for the first create and echoes `msg.params.windowId` afterwards):

```js
it('window affinity survives reconnect for labeled clients', async () => {
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
    if (msg.id && msg.method === 'listTabs') {
      ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
      return;
    }
    if (msg.id && msg.method === 'createTab') {
      createCommands.push(msg.params);
      const tabId = 400 + createCommands.length;
      const windowId = Number.isInteger(msg.params.windowId) ? msg.params.windowId : 500;
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId,
          windowId,
          targetId: `real-target-${tabId}`,
          targetInfo: { targetId: `real-target-${tabId}`, type: 'page', title: '', url: msg.params.url || 'about:blank', windowId },
          sessionId: msg.params.sessionId,
        },
      }));
    }
  });

  // Session A: labeled client creates a tab -> establishes window 500
  const cdpA = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}&label=mcp-live`);
  cdpA.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://a.example' } }));
  await sleep(200);
  cdpA.close();
  await sleep(100);

  // Session B: NEW connection, same label -> must reuse window 500
  const cdpB = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}&label=mcp-live`);
  cdpB.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://b.example' } }));
  await sleep(200);

  assert.equal(createCommands.length, 2);
  assert.equal(createCommands[0].windowId, undefined, 'first create has no pin yet');
  assert.equal(createCommands[1].windowId, 500, 'reconnected labeled client reuses the pinned window');

  cdpB.close();
  ext.close();
  await sleep(100);
});

it('unlabeled clients keep per-connection affinity (cleared on disconnect)', async () => {
  // identical fake extension as above
  // Session A: unlabeled client creates a tab (window 500 established)
  // close A, connect unlabeled B, create again:
  // assert createCommands[1].windowId === undefined (fresh affinity)
});
```

Write the second test in full using the same skeleton — only the `/cdp?token=...` URLs drop `&label=` and the final assertion is `assert.equal(createCommands[1].windowId, undefined)`.

**Step 2: Run to verify failure**

Run: `node --test relay/test/relay-server.test.js --test-name-pattern "affinity survives|unlabeled clients"`
Expected: labeled test FAILS (`createCommands[1].windowId` is `undefined`); unlabeled test PASSES.

**Step 3: Implement**

**⚠️ Explicit vs derived labels:** `_deriveClientLabel()` (relay/src/index.js:666-693) ALWAYS returns a label — it falls back to UA-derived values (`playwright-client`, `node-client`) and finally `'cdp-client'`. Durable affinity must key on the *explicit* query-param label only, otherwise every unlabeled client would share `label:cdp-client` affinity forever. Keep `meta.label` (display/logs) unchanged; add a separate `meta.affinityLabel`.

In `relay/src/index.js`:

1. Rename the map (constructor ~line 281) and document keying:
```js
// affinityKey ('label:<explicit label>' when the client passed ?label=,
// else the connection id) -> windowId. Explicit-label entries survive
// disconnects so the 15s MCP idle-disconnect/reset cycle reuses the same
// agent window instead of spawning a new dedicated window per reconnect.
this.agentWindowByAffinityKey = new Map();
```
2. Extract the explicit-label read so `_deriveClientLabel` and the connect handler share it (behavior of `_deriveClientLabel` unchanged):
```js
_explicitClientLabel(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    return sanitizeClientLabel(
      url.searchParams.get('label')
        || url.searchParams.get('clientLabel')
        || url.searchParams.get('client')
        || '',
    );
  } catch {
    return null;
  }
}

_deriveClientLabel(req) {
  const fromQuery = this._explicitClientLabel(req);
  if (fromQuery) return fromQuery;
  // ...existing origin/UA fallbacks unchanged...
}
```
3. Store it in client meta at connect (~1192-1199): add `affinityLabel: this._explicitClientLabel(req),` next to `label`.
4. Add the key helper + bound constant:
```js
const MAX_AFFINITY_ENTRIES = 50; // leak guard for label-keyed entries (module scope, near other consts)
```
```js
_affinityKey(clientId) {
  if (!clientId) return null;
  const affinityLabel = this.clientById.get(clientId)?.affinityLabel;
  return affinityLabel ? `label:${affinityLabel}` : clientId;
}

_pinAgentWindow(affinityKey, windowId) {
  if (!affinityKey || !Number.isInteger(windowId)) return;
  this.agentWindowByAffinityKey.set(affinityKey, windowId);
  if (this.agentWindowByAffinityKey.size > MAX_AFFINITY_ENTRIES) {
    const oldest = this.agentWindowByAffinityKey.keys().next().value;
    this.agentWindowByAffinityKey.delete(oldest);
  }
}
```
5. `_seedAgentWindowAffinity(clientId, target)` (~1558): derive `const key = this._affinityKey(clientId); if (!key || this.agentWindowByAffinityKey.has(key)) return;` then `this._pinAgentWindow(key, windowId)`.
6. `_createTarget` (~1580, ~1600): `const affinityKey = this._affinityKey(clientId);`, read pin via `this.agentWindowByAffinityKey.get(affinityKey)`, re-pin via `this._pinAgentWindow(affinityKey, resultWindowId)` under the same `sentPinned || !has(key)` condition as today.
7. Client `close` handler (~1220-1222): delete only connection-scoped entries:
```js
if (meta?.id) {
  this.clientById.delete(meta.id);
  if (!meta.affinityLabel) this.agentWindowByAffinityKey.delete(meta.id);
  this._dropAliasSessions((_id, entry) => entry.clientId === meta.id);
}
```
8. 8-fold: `rg -n "agentWindowByClientId"` — update every reference (AGENTS.md prose updated in Task 6).

The "unlabeled" test in Step 1 exercises the derived-label path implicitly (the `ws` client sends no `?label=` but still gets a derived `meta.label`); its assertion that affinity does NOT survive is exactly what proves derived labels are excluded from durable keying.

Stale-window safety needs no new code: the extension already validates the pinned window via `chrome.windows.get` and falls back per `resolveCreateWindowPlan`, and `_createTarget` re-pins to the window actually used.

**Step 4: Run tests**

Run: `node --test relay/test/relay-server.test.js`
Expected: PASS, including the pre-existing affinity tests at ~1482-1672 (they connect unlabeled, so behavior is unchanged for them).

**Step 5: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js
git commit -m "fix(relay): key window affinity by client label so reconnects reuse the agent window

MCP idle-disconnects after 15s and resets create fresh CDP connections; keying
affinity by the ephemeral connection id spawned a new dedicated window per
session. Label-keyed pins (MCP sends label=browserforce-mcp) survive
disconnects; unlabeled clients keep the old per-connection lifetime."
```

---

## Task 3: Extension — durable auto-close state + provenance preservation

**⚠️ Why provenance must flow through `listTabs` discovery:** when the extension service worker restarts, its relay WebSocket drops and the relay's `_cleanupExtension()` (relay/src/index.js:932-956) **clears all targets** — relay memory of `agent-created` origins is gone. On reconnect, tabs are re-discovered via `_autoAttachAllTabs()` → `listTabs()`, which today carries no origin, so everything becomes `relay-discovered` and later lazy attach demotes to `relay-attached`. The persisted `agentCreatedTabs` set (this task) is the only surviving source of truth, so `listTabs()` must surface it and the relay must accept it during discovery.

**Files:**
- Modify: `extension/background.js`
- Modify: `relay/src/index.js` (`_autoAttachAllTabs` origin acceptance + `_ensureDebuggerAttached` origin preservation)
- Test: `test/agent/background-window-plan.test.js` (contract assertions; file already wired into `pnpm test` / `test:agent`)
- Test: `relay/test/relay-server.test.js` (origin preservation through discovery + lazy attach)

**Step 1: Write failing contract tests**

Append to `test/agent/background-window-plan.test.js`:

```js
test('auto-manage state is persisted to chrome.storage.session and hydrated on start', () => {
  assert.match(bg, /chrome\.storage\.session\.set\(/);
  assert.match(bg, /chrome\.storage\.session\.get\(/);
  assert.match(bg, /hydrateAutoManageState\(\)/);
  assert.match(bg, /persistAutoManageState\(\)/);
});

test('attachTab re-registers agent-created tabs for auto-close', () => {
  assert.match(bg, /origin === 'agent-created'\) \{\s*agentCreatedTabs\.add\(tabId\)/);
});

test('attachTab never demotes agent-created provenance to relay-attached', () => {
  assert.match(bg, /existing\.origin === 'agent-created' && origin === 'relay-attached'/);
});

test('the bf-reconnect alarm also sweeps inactive tabs', () => {
  assert.match(bg, /alarm\.name === 'bf-reconnect'[\s\S]{0,200}checkInactiveTabs\(\)/);
});

test('listTabs surfaces agent-created provenance for hydrated tabs', () => {
  assert.match(bg, /origin: agentCreatedTabs\.has\(t\.id\) \? 'agent-created' : undefined/);
});
```

**Step 2: Run to verify failure**

Run: `node --test test/agent/background-window-plan.test.js`
Expected: 5 new tests FAIL.

**Step 3: Implement in `extension/background.js`**

1. Persistence helpers (place after the `agentCreatedTabs` declaration, ~line 47):
```js
/** storage.session key for auto-manage state (survives SW restarts, dies with the browser) */
const AUTO_MANAGE_STATE_KEY = 'bfAutoManageState';

async function persistAutoManageState() {
  try {
    await chrome.storage.session.set({
      [AUTO_MANAGE_STATE_KEY]: {
        agentCreatedTabs: [...agentCreatedTabs],
        tabLastActivity: [...tabLastActivity],
      },
    });
  } catch (e) {
    console.warn('[bf] Failed to persist auto-manage state:', e?.message || e);
  }
}

async function hydrateAutoManageState() {
  try {
    const stored = await chrome.storage.session.get(AUTO_MANAGE_STATE_KEY);
    const saved = stored?.[AUTO_MANAGE_STATE_KEY];
    if (!saved) return;
    const openTabIds = new Set((await chrome.tabs.query({})).map((t) => t.id));
    for (const tabId of saved.agentCreatedTabs || []) {
      if (openTabIds.has(tabId)) agentCreatedTabs.add(tabId);
    }
    for (const [tabId, lastActivity] of saved.tabLastActivity || []) {
      if (openTabIds.has(tabId)) tabLastActivity.set(tabId, lastActivity);
    }
  } catch (e) {
    console.warn('[bf] Failed to hydrate auto-manage state:', e?.message || e);
  }
}
```
2. Call `await hydrateAutoManageState();` at the top of the `init()` IIFE (~line 57), before listener registration and `startMaintainLoop()`.
3. Persist on every membership change — after `agentCreatedTabs.add(tab.id)` in `createTab` (~493), inside `cleanupTab` (~724, after the deletes), and in the detach-cascade loop that clears all tabs (~648): call `persistAutoManageState()` (fire-and-forget, no await needed in `cleanupTab`).
4. Persist the activity clock cheaply: at the END of `checkInactiveTabs()` (~767) add `persistAutoManageState();` — one write per minute, not per command.
5. attachTab provenance (~355-364): re-register agent tabs and never demote:
```js
async function attachTab(tabId, sessionId, options = {}) {
  const origin = ALLOWED_TAB_ORIGINS.has(options.origin) ? options.origin : 'unknown';
  if (origin === 'agent-created') {
    agentCreatedTabs.add(tabId);
    persistAutoManageState();
  }
  if (attachedTabs.has(tabId)) {
    const existing = attachedTabs.get(tabId);
    existing.sessionId = sessionId;
    const isDemotion = existing.origin === 'agent-created' && origin === 'relay-attached';
    if (ALLOWED_TAB_ORIGINS.has(options.origin) && !isDemotion) existing.origin = origin;
    ...unchanged...
```
6. Alarm sweep (~72-76): make the alarm also run the auto-manage check so idle tabs are closed even when the relay is down and the interval died with the SW:
```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bf-reconnect') {
    if (!ws) startMaintainLoop();
    checkInactiveTabs();
  }
});
```

**Step 3b: Extension — surface provenance in `listTabs`**

In `listTabs()` (~330-352), include origin for hydrated/known agent tabs (map step):
```js
.map((t) => ({
  tabId: t.id,
  windowId: t.windowId,
  url: t.url,
  title: t.title,
  active: t.active,
  origin: agentCreatedTabs.has(t.id) ? 'agent-created' : undefined,
})),
```
(`JSON.stringify` drops `undefined`, so the payload shape for non-agent tabs is unchanged — old relay + new extension stays compatible, and new relay + old extension simply sees no `origin`.)

**Step 4: Relay — accept discovered provenance + preserve on lazy attach, with test**

1. In `_autoAttachAllTabs` (~1470-1478), accept an allowlisted origin from `listTabs` (existing target origin wins; never accept `manual` from discovery):
```js
const discoveredOrigin = tab.origin === 'agent-created' ? 'agent-created' : undefined;
this.targets.set(sessionId, {
  ...
  origin: existing?.origin || discoveredOrigin || 'relay-discovered',
});
```
2. In `_ensureDebuggerAttached` (~1502-1517), preserve agent-created provenance:
```js
const preservedOrigin = (target.origin === 'manual' || target.origin === 'agent-created')
  ? target.origin
  : 'relay-attached';
const result = await this._sendToExt('attachTab', {
  tabId: target.tabId,
  sessionId,
  origin: preservedOrigin,
});
...
target.debuggerAttached = true;
target.origin = preservedOrigin;
```

Relay test — full SW-restart round trip (append near the affinity tests): fake extension whose `listTabs` returns `{ tabId: 950, windowId: 11, url: 'https://agent.example', title: 'A', origin: 'agent-created' }` and answers `attachTab`/`cdpCommand`; CDP client connects, `Target.setAutoAttach` discovers the tab, send one real command (`Runtime.evaluate`) to trigger lazy attach; assert (a) the extension's received `attachTab` message carries `origin: 'agent-created'`, (b) `GET /attached-tabs` shows `origin: 'agent-created'` afterwards. A second test asserts a tab WITHOUT `origin` in `listTabs` still becomes `relay-discovered` → `relay-attached` (old-extension compatibility).

**Step 5: Run tests**

Run: `node --test test/agent/background-window-plan.test.js` → PASS
Run: `node --test relay/test/relay-server.test.js` → PASS
Run: `node --test test/agent/extension-manifest.test.js` → PASS (no manifest change needed — `storage` permission already covers `chrome.storage.session`)

**Step 6: Commit**

```bash
git add extension/background.js relay/src/index.js test/agent/background-window-plan.test.js relay/test/relay-server.test.js
git commit -m "fix(extension): persist auto-close state across SW restarts, preserve agent-created provenance

agentCreatedTabs/tabLastActivity lived only in SW memory, so any service-worker
restart orphaned agent tabs forever (auto-close checks agentCreatedTabs), and
the relay's _cleanupExtension() wipes its own origin memory on extension
disconnect. Persist to chrome.storage.session (browser-lifetime), hydrate on
start, prune closed tabs, surface provenance through listTabs discovery,
re-register on attach, never demote agent-created provenance, and sweep from
the existing bf-reconnect alarm so the timer survives SW death."
```

---

## Task 4: Relay + Extension — init-storm commands must not reset idle timers

**Files:**
- Modify: `relay/src/index.js` (`_forwardToTab` — tag `passive` on init-only forwards, all three paths: main, alias, child)
- Modify: `extension/background.js` (`case 'cdpCommand'` — skip activity bump when `passive`)
- Test: `relay/test/relay-server.test.js` (payload flag), `test/agent/background-window-plan.test.js` (contract)

**Step 1: Write failing tests**

Relay test:

```js
it('tags init-only cdpCommands as passive so the extension does not bump idle timers', async () => {
  // fake ext: listTabs -> one tab; attachTab + cdpCommand respond ok; record cdpCommand payloads
  // 1. connect CDP client, Target.setAutoAttach, get session for the discovered tab
  // 2. send Runtime.evaluate (real command -> lazy attach) -> recorded payload has passive undefined
  // 3. send Runtime.enable (init-only, tab now attached) -> recorded payload has passive === true
  const runtimeEnable = cdpCommands.find((c) => c.method === 'Runtime.enable');
  assert.equal(runtimeEnable.passive, true);
  const evaluate = cdpCommands.find((c) => c.method === 'Runtime.evaluate');
  assert.equal(evaluate.passive, undefined);
});
```

Write it in full with the fake-extension skeleton used by the affinity tests.

Extension contract test (append to `test/agent/background-window-plan.test.js`):

```js
test('passive cdpCommands do not bump tabLastActivity', () => {
  assert.match(bg, /if \(!msg\.params\.passive\) tabLastActivity\.set\(msg\.params\.tabId, Date\.now\(\)\)/);
});
```

**Step 2: Run to verify failure**

Run: `node --test relay/test/relay-server.test.js --test-name-pattern "passive"` → FAIL
Run: `node --test test/agent/background-window-plan.test.js` → new contract test FAILS

**Step 3: Implement**

Relay — in `_forwardToTab`, build the extension payload once per path and tag init-only methods (main path shown; alias and child paths get the same tagging):

```js
const payload = {
  tabId: target.tabId,
  method,
  params: params || {},
};
if (INIT_ONLY_METHODS.has(method)) payload.passive = true;
return this._sendToExt('cdpCommand', payload);
```

(child path additionally keeps `childSessionId`.)

Extension — `executeCommand` (~256-258):

```js
case 'cdpCommand':
  if (!msg.params.passive) tabLastActivity.set(msg.params.tabId, Date.now());
  return cdpCommand(msg.params);
```

Old extension + new relay (or vice versa) stay compatible: the flag is optional and ignored by old code.

**Step 4: Run tests**

Run: `node --test relay/test/relay-server.test.js && node --test test/agent/background-window-plan.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add relay/src/index.js extension/background.js relay/test/relay-server.test.js test/agent/background-window-plan.test.js
git commit -m "fix(relay,extension): init-storm commands no longer reset tab idle timers

Playwright re-sends ~40 init commands to every attached tab on each (re)connect;
each bump reset tabLastActivity, so with 15s idle-disconnect cycling, attached
tabs never reached the auto-close threshold. The relay tags INIT_ONLY forwards
as passive; the extension skips the activity bump for them."
```

---

## Task 5: Relay — expose per-tab idle metadata in `/attached-tabs`

Makes auto-close behavior observable (live verification + user debugging: "why didn't my tab close?").

**Files:**
- Modify: `relay/src/index.js` (`_forwardToTab` sets `target.lastCommandAt`; `_getAttachedTabInfos` surfaces it)
- Test: `relay/test/relay-server.test.js`

**Step 1: Write the failing test**

```js
it('exposes lastCommandAt/idleMs for tabs with real activity in /attached-tabs', async () => {
  // fake ext with one discovered tab; attachTab/cdpCommand respond ok
  // send Runtime.evaluate on the tab, then GET /attached-tabs (http.get, same pattern as existing /attached-tabs tests — find with rg -n "attached-tabs" relay/test/relay-server.test.js)
  const tab = body.tabs.find((t) => t.tabId === 901);
  assert.ok(Number.isInteger(tab.lastCommandAt));
  assert.ok(tab.idleMs >= 0);
});
```

**Step 2: Run to verify failure** → FAIL (fields undefined)

**Step 3: Implement**

In `_forwardToTab` main path — set alongside the existing affinity seeding (both the pre-attach branch and the attached branch already distinguish real commands):

```js
if (!INIT_ONLY_METHODS.has(method)) {
  this._seedAgentWindowAffinity(clientId, target);
  target.lastCommandAt = Date.now();
}
```

(replacing the two existing `_seedAgentWindowAffinity` call sites in that function — keep the lazy-attach ordering unchanged; in the `!debuggerAttached` branch the method is already known to be non-init at that point, so set `lastCommandAt` there unconditionally next to the seed call.)

In `_getAttachedTabInfos()` (~735-750):

```js
if (Number.isInteger(target.lastCommandAt)) {
  info.lastCommandAt = target.lastCommandAt;
  info.idleMs = Date.now() - target.lastCommandAt;
}
```

**Step 4: Run** `node --test relay/test/relay-server.test.js` → PASS

**Step 5: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js
git commit -m "feat(relay): expose per-tab lastCommandAt/idleMs in /attached-tabs for auto-close observability"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `AGENTS.md` (three sections)
- Modify: `docs/knowledge/knowledge1.md` (entries), `docs/knowledge/timeline1.md` (changelog), `docs/knowledge/critical-patterns.md` (one promotion)
- Check: `README.md` `/attached-tabs` mention (update only if the endpoint's fields are documented there — `rg -n "attached-tabs" README.md`)

**Step 1: AGENTS.md**

1. **INIT_ONLY_METHODS section**: rewrite the `Page.createIsolatedWorld (critical — this was the actual trigger)` sentence to state it is synthetic only while unattached and forwarded when attached (utility world requirement), and delete any claim that it is always-synthetic.
2. **Agent Window Affinity section**: replace `agentWindowByClientId` with `agentWindowByAffinityKey`, document label keying (`label:<label>` keys survive disconnect; unlabeled = per-connection), the 50-entry leak guard, and the consequence: two clients sharing a label share an agent window (deliberate).
3. **Auto-Close / MV3 keepalive area**: add a rule block documenting `chrome.storage.session` persistence (`AUTO_MANAGE_STATE_KEY`), the `passive` cdpCommand flag contract, provenance no-demote, and the alarm-driven sweep.

**Step 2: knowledge1.md entries** (append, follow the repo's `## YYYY-MM-DD — [TAG] Title (@Valsaraj)` format):
- `[CORRECTION]` — supersedes the 2026-07-03 always-synthetic `createIsolatedWorld` decision (d8d3401): forwarding is required for locator actions on adopted tabs; response is `_sendMayFail`-discarded; real fix for the sheets timeout was the targetCreated ordering.
- `[BUG]` — window-per-reconnect: affinity keyed to ephemeral client id + 15s idle disconnect + dedicatedWindow ⇒ one window per session; fixed by label keying.
- `[BUG]` — auto-close never fired: in-memory SW state + init-storm activity bumps; fixed by storage.session persistence + passive flag.

**Step 3: critical-patterns.md** — promote one entry: "CDP relay: never synthesize responses for commands whose *side effects* Playwright depends on (`Page.createIsolatedWorld` ⇒ `Runtime.executionContextCreated`)" with the ❌/✅ example.

**Step 4: timeline1.md** — one changelog entry listing all files + verification commands.

**Step 5: Full verification**

```bash
pnpm test
```
Expected: all suites PASS. If unrelated suites fail, verify they fail identically on `main` before proceeding (document in PR).

**Step 6: Commit docs**

```bash
# The plan document already exists on disk (authored before implementation,
# currently untracked) — this commit brings it into the repo alongside the
# doc updates it drove.
git add AGENTS.md docs/knowledge/knowledge1.md docs/knowledge/timeline1.md docs/knowledge/critical-patterns.md docs/plans/2026-07-06-agent-window-reuse-and-adopted-tab-locators.md
git commit -m "docs: createIsolatedWorld forwarding, label-keyed affinity, durable auto-close"
```

Also update `README.md:1024` — the `/attached-tabs` field table gains `lastCommandAt`/`idleMs` (from Task 5); include `README.md` in the `git add` when changed.

---

## Task 7: PR

```bash
git push -u origin fix/agent-window-reuse-and-utility-world
gh pr create --title "fix: reuse agent window across reconnects, unblock locators on adopted tabs, durable auto-close" --body "<summary per repo conventions: problem/root causes with file:line, fixes, test plan, live-verification checklist>"
```

---

## Live browser verification matrix (post-PR, real Chrome)

Restart the relay from this branch (`pnpm relay`), then reload the extension via `POST /extension/reload` (Bearer token from `~/.browserforce/`). The MCP test harness at `/tmp/bf-pr20-livetest/mcp-client.mjs` drives sessions.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | Relay restart → extension auto-reconnect | `/extension/status` connected within ~5s |
| 2 | Adopted-tab locator: attach to an existing user tab, `fill` WITHOUT reload | fill completes < 2s (was: 30s timeout) |
| 3 | Window reuse: session A `open` → note windowId; kill client; session B `open` | same windowId (was: new window) |
| 4 | `reset` tool mid-session → `open` | same windowId |
| 5 | Extension SW reload (`POST /extension/reload`) → session C `open` | same windowId; `/attached-tabs` keeps `origin=agent-created` on re-adoption |
| 6 | Init-storm idle check: connect fresh client, touch nothing | `/attached-tabs` `idleMs` of previously-touched tabs keeps GROWING (was: reset to 0 by init storm) |
| 7 | Auto-close mechanism: with autoClose enabled in popup* | agent tab closes ≤ (threshold + 60s); window closes with last tab |
| 8 | Two labels (`BROWSERFORCE_CDP_CLIENT_LABEL=other`) | independent windows per label |
| 9 | Full command-tool sweep on the new stack (open/snapshot/fill/click/eval/reset) | all green |
| 10 | Sheets-plugin smoke (manual tab attach → `page.evaluate` path) | no regression vs d8d3401 concern |

*Scenario 7 requires the popup toggle (user-owned setting, currently Off per storage forensics). If not toggled during the session, verify via unit tests + scenario 6 arithmetic and report it as the single manual step.

**Known unknowns to watch live:** (a) any consumer that relied on `createIsolatedWorld` being swallowed (watch sheets/manual flows), (b) `storage.session` quota/latency under many tabs, (c) multi-window Chrome focus races when the pinned window is minimized (extension falls back per `resolveCreateWindowPlan` — confirm no focus steal), (d) unlabeled third-party CDP clients must keep today's semantics.

## Post-Implementation Amendments

- **Plan gap (Codex code review round 1, IMPORTANT):** Task 5 specified `lastCommandAt` + affinity seeding only for `_forwardToTab`'s **main-session** path. Real work also flows through explicit `newCDPSession` **alias sessions** (snapshot engine AX fetches) and **OOPIF child sessions** — without seeding there, the agent window could stay unpinned and `/attached-tabs` idle metadata went stale while the tab was actively used. Fix: mirrored the main-path non-init branch in both paths (`_seedAgentWindowAffinity` + `lastCommandAt`), gated on `!INIT_ONLY_METHODS.has(method)` so passive tagging semantics are unchanged. Root cause: the plan treated alias/child paths as pass-through routing and only listed them for `passive` tagging (Task 4), missing that Task 5's "real activity" definition must apply to every forward path. Test: `real commands on an alias session seed affinity and bump lastCommandAt` (failing-first).
