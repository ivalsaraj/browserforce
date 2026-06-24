# Agent Window Affinity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep BrowserForce agent-created tabs in the Chrome window where the agent began working, even if the user later switches focus to another Chrome window.

**Architecture:** Add a lightweight "agent window affinity" to the relay/extension create-tab path. The extension will expose tab `windowId` metadata, the relay will remember the first suitable window for a CDP client/session, and `Target.createTarget` will pass that pinned `windowId` back to the extension for later tab creation. The extension will validate the requested window still exists, fall back safely when it does not, and avoid changing the existing manual/no-new-tabs restrictions.

**Tech Stack:** Node.js CommonJS relay (`relay/src/index.js`), Chrome MV3 extension service worker (`extension/background.js`), Node test runner (`node --test`), `ws` test clients.

---

## Context

Current behavior:

- `Target.createTarget` in `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js` sends `{ url, sessionId }` to the extension.
- `createTab()` in `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js` calls `getCurrentWindowId()`, which queries `chrome.tabs.query({ active: true, currentWindow: true })`, then creates an active tab in that current focused window.
- If the agent started in Window 2 and the user switches to Window 1 before the next `context.newPage()`/`Target.createTarget`, the extension resolves Window 1 as current and steals the user's foreground workspace.

Recommended approach:

- Pin the agent to a window at the relay level when it first actually uses a tab, before it creates any later tab.
- Use explicit `windowId` for later agent-created tabs.
- Include `windowId` in tab metadata so the relay can choose and expose the right window without guessing.

Rejected approaches:

- Do not create a separate Chrome profile. BrowserForce's value is real logged-in Chrome state.
- Do not force a new Chrome window for every run. That changes visible behavior and creates window clutter.
- Do not make all created tabs background-only as the primary fix. Background tabs reduce focus stealing, but they do not guarantee the agent stays in its original window.

## Behavioral Contract

After implementation:

- If the agent first works on an existing/discovered tab, later agent-created tabs from that same relay client should be created in that tab's window, even if the user switches to another Chrome window before the first new tab is created.
- If the agent starts by creating a new tab without first using an existing tab, that first tab may use the current focused Chrome window and becomes the pinned window for later agent-created tabs.
- If the pinned window was closed, BrowserForce may fall back to the current focused window and repin there.
- Existing manual mode and no-new-tabs restrictions must still block tab creation before any extension `createTab` command is sent.
- Lazy discovery and lazy debugger attachment should not eagerly attach debuggers to unrelated tabs.
- `listTabs`, `/extension/status`, and `/attached-tabs` should include `windowId` where tab metadata is known.

## Task 1: Expose `windowId` In Extension Tab Metadata

**Files:**

- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js:304-324`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js:1284-1335`
- Test: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js`

**Step 1: Write the failing relay metadata test**

Add a test near the `Target.setAutoAttach with Mock Extension` tests proving `windowId` survives from extension `listTabs` through relay target metadata.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js
it('Target.setAutoAttach preserves discovered tab windowId metadata', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });

  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
    if (msg.id && msg.method === 'listTabs') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabs: [{
            tabId: 71,
            windowId: 901,
            url: 'https://window.example',
            title: 'Window',
            active: true,
          }],
        },
      }));
    }
  });

  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
  const messages = [];
  cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

  cdp.send(JSON.stringify({
    id: 1,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, flatten: true },
  }));
  await sleep(300);

  const attached = messages.find((m) => m.method === 'Target.attachedToTarget');
  assert.equal(attached.params.targetInfo.windowId, 901);

  cdp.close();
  ext.close();
  await sleep(100);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "preserves discovered tab windowId"
```

Expected: FAIL because `windowId` is not included in `targetInfo`.

**Step 3: Add extension `windowId` to `listTabs()`**

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js
.map((t) => ({
  tabId: t.id,
  windowId: t.windowId,
  url: t.url,
  title: t.title,
  active: t.active,
})),
```

**Step 4: Preserve `windowId` in relay target info**

When synthesizing target info in `_autoAttachAllTabs()`, copy `tab.windowId` into `targetInfo` if it is an integer. Do the same in `_sendTargetCreatedEvent()`, `Target.getTargets`, `Target.getTargetInfo`, and `Target.attachedToTarget` event payloads where target metadata is shaped.

**Step 5: Run focused test**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "preserves discovered tab windowId"
```

Expected: PASS.

**Step 6: Commit**

```bash
git add /Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js
git commit -m "feat(relay): expose tab window metadata"
```

## Task 2: Seed Window Affinity From First Real Agent Tab Use

**Files:**

- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js:205-215`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js:1502-1534`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js:1419-1457`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js:388-428`
- Test: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js`

**Step 1: Write failing relay protocol test for the reported sequence**

Add a test near the `Target.createTarget eagerly attaches a new tab` tests. It must prove the agent can first use an existing tab in Window 2, then create the first new tab in Window 2 even after Chrome focus would have moved elsewhere.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js
it('Target.createTarget uses the windowId from the first real tab command', async () => {
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
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabs: [
            { tabId: 301, windowId: 111, url: 'https://user.example', title: 'User', active: true },
            { tabId: 302, windowId: 222, url: 'https://agent.example', title: 'Agent', active: true },
          ],
        },
      }));
      return;
    }
    if (msg.id && msg.method === 'attachTab') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId: msg.params.tabId,
          windowId: msg.params.tabId === 302 ? 222 : 111,
          targetId: `real-target-${msg.params.tabId}`,
          targetInfo: {
            targetId: `real-target-${msg.params.tabId}`,
            type: 'page',
            title: '',
            url: msg.params.tabId === 302 ? 'https://agent.example' : 'https://user.example',
            windowId: msg.params.tabId === 302 ? 222 : 111,
          },
        },
      }));
      return;
    }
    if (msg.id && msg.method === 'cdpCommand') {
      ext.send(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value: 'ok' } } }));
      return;
    }
    if (msg.id && msg.method === 'createTab') {
      createCommands.push(msg.params);
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId: 303,
          windowId: 222,
          targetId: 'real-target-303',
          targetInfo: { targetId: 'real-target-303', type: 'page', title: '', url: msg.params.url || 'about:blank', windowId: 222 },
          sessionId: msg.params.sessionId,
        },
      }));
    }
  });

  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
  const messages = [];
  cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

  cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
  await sleep(300);

  const agentAttached = messages.find((m) => (
    m.method === 'Target.attachedToTarget' && m.params.targetInfo.url === 'https://agent.example'
  ));
  assert.ok(agentAttached, 'agent tab should be exposed as a target');

  cdp.send(JSON.stringify({
    id: 2,
    sessionId: agentAttached.params.sessionId,
    method: 'Runtime.evaluate',
    params: { expression: 'location.href' },
  }));
  await sleep(200);

  cdp.send(JSON.stringify({ id: 3, method: 'Target.createTarget', params: { url: 'https://new-agent.example' } }));
  await sleep(200);

  assert.equal(createCommands.length, 1);
  assert.equal(createCommands[0].windowId, 222);

  cdp.close();
  ext.close();
  await sleep(100);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "uses the windowId from the first real tab command"
```

Expected: FAIL because relay does not seed affinity from first real tab use.

**Step 3: Write failing relay protocol test for repeated created tabs**

Add a test near `Target.createTarget eagerly attaches a new tab`. It should simulate two `Target.createTarget` calls where the first extension response reports `windowId: 500`, then assert the second `createTab` command includes `windowId: 500`.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js
it('Target.createTarget reuses the first agent-created windowId for later tabs', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });

  const createCommands = [];
  let nextTabId = 200;

  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
    if (msg.id && msg.method === 'getRestrictions') {
      ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
      return;
    }
    if (msg.id && msg.method === 'createTab') {
      createCommands.push(msg.params);
      const tabId = nextTabId++;
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId,
          windowId: 500,
          targetId: `real-target-${tabId}`,
          targetInfo: { targetId: `real-target-${tabId}`, type: 'page', title: '', url: msg.params.url || 'about:blank', windowId: 500 },
          sessionId: msg.params.sessionId,
        },
      }));
    }
  });

  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);

  cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://first.example' } }));
  await sleep(200);
  cdp.send(JSON.stringify({ id: 2, method: 'Target.createTarget', params: { url: 'https://second.example' } }));
  await sleep(200);

  assert.equal(createCommands.length, 2);
  assert.equal(createCommands[0].windowId, undefined);
  assert.equal(createCommands[1].windowId, 500);

  cdp.close();
  ext.close();
  await sleep(100);
});
```

**Step 4: Run test to verify it fails**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "reuses the first agent-created windowId"
```

Expected: FAIL because relay never sends `windowId` to `createTab`.

**Step 5: Add relay client/window affinity state**

Add a relay field to track affinity by CDP client id. Keep it in relay memory only.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
this.agentWindowByClientId = new Map(); // clientId -> windowId
```

Clear the entry when the CDP client disconnects in `_onCdpConnect()` close cleanup.

**Step 6: Add a relay helper for seeding affinity**

Create a small helper on `RelayServer` so all pinning uses one predicate.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
_seedAgentWindowAffinity(clientId, target) {
  if (!clientId || this.agentWindowByClientId.has(clientId)) return;
  const windowId = target?.windowId ?? target?.targetInfo?.windowId;
  if (Number.isInteger(windowId)) {
    this.agentWindowByClientId.set(clientId, windowId);
  }
}
```

Store `windowId` on the target object as well as `target.targetInfo.windowId` whenever tab metadata enters the relay.

**Step 7: Seed affinity in `_forwardToTab()` only for real commands**

In `_forwardToTab(sessionId, method, params, id, clientId)`, call `_seedAgentWindowAffinity(clientId, target)` after the `INIT_ONLY_METHODS` early return and before `_ensureDebuggerAttached()`.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
if (!target.debuggerAttached) {
  if (INIT_ONLY_METHODS.has(method)) {
    return syntheticInitResponse(method, target);
  }
  this._seedAgentWindowAffinity(clientId, target);
  target._triggerMethod = method;
  await this._ensureDebuggerAttached(target, sessionId);
} else if (!INIT_ONLY_METHODS.has(method)) {
  this._seedAgentWindowAffinity(clientId, target);
}
```

This prevents Playwright's eager init traffic from pinning to an arbitrary discovered tab while still pinning on the first real agent action.

**Step 8: Pass `clientId` into `_createTarget()`**

Change the command handling call from:

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
return this._createTarget(ws, params);
```

to:

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
return this._createTarget(ws, params, clientId);
```

**Step 9: Send pinned `windowId` with `createTab`**

In `_createTarget()`, read `this.agentWindowByClientId.get(clientId)`. If it is an integer, include it in the extension `createTab` params. After the extension responds, repin from `result.windowId` or `result.targetInfo.windowId` when valid.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
const pinnedWindowId = this.agentWindowByClientId.get(clientId);
const createParams = {
  url: params.url || 'about:blank',
  sessionId,
};
if (Number.isInteger(pinnedWindowId)) {
  createParams.windowId = pinnedWindowId;
}

const result = await this._sendToExt('createTab', createParams);
const resultWindowId = Number.isInteger(result.windowId)
  ? result.windowId
  : result.targetInfo?.windowId;
if (Number.isInteger(resultWindowId)) {
  this.agentWindowByClientId.set(clientId, resultWindowId);
}
```

**Step 10: Make extension honor requested `windowId`**

In `createTab(params)`, use `params.windowId` first if it is an integer. Validate the window still exists with `chrome.windows.get(params.windowId)`. If the call fails, fall back to `getCurrentWindowId()`.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js
async function resolveCreateWindowId(params) {
  if (Number.isInteger(params?.windowId)) {
    try {
      const win = await chrome.windows.get(params.windowId);
      if (win && typeof win.id === 'number') return win.id;
    } catch {
      // The pinned window may have been closed; fall back to the current window.
    }
  }
  return getCurrentWindowId();
}
```

Use `resolveCreateWindowId(params)` instead of directly calling `getCurrentWindowId()`.

**Step 11: Include `windowId` in all extension attach/create results**

When `attachTab()` builds the entry, fetch tab metadata with `chrome.tabs.get(tabId)` and ensure both the top-level entry and `targetInfo` include `windowId` when available. This avoids relying on Chrome CDP `Target.getTargetInfo` to expose extension tab window metadata.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js
const tab = await chrome.tabs.get(tabId);
const windowId = Number.isInteger(tab.windowId) ? tab.windowId : undefined;
targetInfo = { ...targetInfo, windowId };
const entry = { sessionId, targetId, targetInfo, tabId, windowId, origin };
```

`createTab()` should return the `windowId` from the created `tab`, and `notifyRelayManualTabAttached()` should include top-level `windowId` in the `manualTabAttached` payload.

**Step 12: Run focused tests**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "uses the windowId from the first real tab command"
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "reuses the first agent-created windowId"
```

Expected: PASS.

**Step 13: Commit**

```bash
git add /Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js
git commit -m "fix(extension): keep agent tabs in pinned window"
```

## Task 3: Surface Window Affinity In Status And Docs

**Files:**

- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js:684-702`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/popup.html:66-72`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/docs/DEVELOPMENT.md`
- Modify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/AGENTS.md`
- Create: `/Users/valsaraj/Documents/projects/chrome-connect-relay/docs/knowledge/timeline/2026-06.md` if no current timeline file exists.
- Test: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js`

**Step 1: Write failing status test**

Extend the existing `/extension/status includes manually attached tab metadata` or add a new status test to assert `windowId` is included in `attachedTabs` and `manualAttachedTabs`.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js
assert.equal(status.body.manualAttachedTabs[0].windowId, 902);
```

**Step 2: Run status test to verify it fails**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "manually attached tab metadata"
```

Expected: FAIL until status metadata includes `windowId`.

**Step 3: Update `_getAttachedTabInfos()`**

Add `windowId` to the status object only when it is an integer, preserving existing response shape for older extension messages.

```js
// /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js
const info = {
  tabId: target.tabId,
  targetId: target.targetId,
  title: target.targetInfo?.title || '',
  url: target.targetInfo?.url || '',
  origin: target.origin || 'relay-discovered',
};
if (Number.isInteger(target.windowId ?? target.targetInfo?.windowId)) {
  info.windowId = target.windowId ?? target.targetInfo.windowId;
}
return info;
```

**Step 4: Update docs**

Document the behavior in:

- `/Users/valsaraj/Documents/projects/chrome-connect-relay/docs/DEVELOPMENT.md`: add an operational note that agent-created tabs are pinned to the first agent window and only fall back when that window closes.
- `/Users/valsaraj/Documents/projects/chrome-connect-relay/AGENTS.md`: add a gotcha under Critical Patterns or Gotchas for AI Agents: do not use current Chrome focus as stable agent ownership; use stored `windowId`. Also update the extension protocol table so `createTab` documents optional `{ url, sessionId, windowId }`.
- `/Users/valsaraj/Documents/projects/chrome-connect-relay/docs/knowledge/timeline/2026-06.md`: add a timeline note for the behavior change.
- `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/popup.html`: update the "Visible new tabs (current window)" copy so it no longer promises dynamic current-window behavior after affinity is pinned.

**Step 5: Run focused status test**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js --test-name-pattern "manually attached tab metadata"
```

Expected: PASS.

**Step 6: Commit**

```bash
git add /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js /Users/valsaraj/Documents/projects/chrome-connect-relay/relay/test/relay-server.test.js /Users/valsaraj/Documents/projects/chrome-connect-relay/extension/popup.html /Users/valsaraj/Documents/projects/chrome-connect-relay/docs/DEVELOPMENT.md /Users/valsaraj/Documents/projects/chrome-connect-relay/AGENTS.md /Users/valsaraj/Documents/projects/chrome-connect-relay/docs/knowledge/timeline/2026-06.md
git commit -m "docs: document BrowserForce window affinity"
```

## Task 4: Full Regression Pass

**Files:**

- Verify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/relay/src/index.js`
- Verify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/extension/background.js`
- Verify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/mcp/src/index.js`
- Verify: `/Users/valsaraj/Documents/projects/chrome-connect-relay/mcp/src/exec-engine.js`

**Step 1: Search propagation**

Run:

```bash
rg -n "windowId|currentWindow|getCurrentWindowId|createTab|Target.createTarget|targetInfo|attachedTabs|manualAttachedTabs" /Users/valsaraj/Documents/projects/chrome-connect-relay/extension /Users/valsaraj/Documents/projects/chrome-connect-relay/relay /Users/valsaraj/Documents/projects/chrome-connect-relay/mcp
```

Expected: all `createTab` call sites either pass or intentionally omit `windowId`; all target metadata shapers preserve `windowId` consistently.

**Step 2: Run relay tests**

Run:

```bash
pnpm test:relay
```

Expected: PASS.

**Step 3: Run MCP tests**

Run:

```bash
pnpm test:mcp
```

Expected: PASS.

**Step 4: Manual smoke test**

1. Start relay with `pnpm relay:dev`.
2. Reload the unpacked BrowserForce extension at `chrome://extensions/`.
3. In Chrome Window 2, attach or select an existing test page and ask the agent to inspect it.
4. Switch to Chrome Window 1 and keep working.
5. Ask the agent to open a new page or run a page-creating task.
6. Verify the first newly created agent tab appears in Window 2, not Window 1.
7. Ask the agent to open a second new page and verify it also appears in Window 2.
8. Close Window 2 and ask the agent to open another page.
9. Verify BrowserForce falls back to the current focused window without crashing.

**Step 5: Final commit if verification-only fixes were needed**

If the regression pass required any changes:

```bash
git add <specific changed files>
git commit -m "test: cover BrowserForce window affinity"
```

## Risks And Mitigations

- **Closed pinned window:** validate with `chrome.windows.get()` and fall back to current focused window.
- **Multi-client ambiguity:** pin by CDP client id, not globally, so simultaneous clients do not overwrite each other.
- **Extension protocol compatibility:** `windowId` is optional. Existing mock extensions and old extension responses still work.
- **Playwright target metadata:** keep `browserContextId` unchanged and only add optional `windowId`; do not alter CDP-required fields.
- **Manual mode:** restrictions are checked before `createTab`, so pinned-window logic never bypasses attached-only/no-new-tabs behavior.

## Definition Of Done

- Agent-created tabs remain in the window of the first real agent-used tab after user focus changes.
- If there was no prior real tab use, the first created tab pins the client for subsequent created tabs.
- Pinned-window fallback works when the original window is closed.
- Relay and extension tests cover `windowId` metadata and repeated `Target.createTarget`.
- `pnpm test:relay` and `pnpm test:mcp` pass.
- Docs mention that agent tab ownership is based on pinned `windowId`, not current user focus.
