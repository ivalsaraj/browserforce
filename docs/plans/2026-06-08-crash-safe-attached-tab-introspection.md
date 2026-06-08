# Crash-Safe Attached Tab + Introspection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make BrowserForce safe for "work on the attached tab" flows by preventing accidental tab creation during inspection and by exposing low-risk relay/extension status APIs that agents can query before opening a Playwright CDP session.

**Architecture:** Add relay-owned status/introspection endpoints that read existing relay state and, when the extension is connected, optionally ask the extension for its attached-tab snapshot. Then update MCP startup and execute behavior so attached/manual flows fail clearly when no attached page is available instead of calling `context.newPage()` or triggering `Target.createTarget`. Keep the first pass narrow: no new dependencies, no multi-extension refactor, no direct-CDP mode.

**Tech Stack:** Node.js CommonJS relay with `ws`, MV3 Chrome extension service worker, MCP ESM server using `@modelcontextprotocol/sdk` and `playwright-core`, Node test runner.

---

## Context And Findings

Latest Playwriter checked out locally:

- Path: `/Users/valsaraj/Documents/projects/playwriter`
- Commit: `9d837c0`
- Relevant newer patterns:
  - `/extension/status` and `/extensions/status` expose `connected`, `activeTargets`, version/profile metadata.
  - Host header validation protects local HTTP routes from DNS rebinding.
  - Extension replacement reconnect waits until the slot is truly disconnected, not merely idle.
  - Empty extension-mode contexts do not auto-create a page unless `PLAYWRITER_AUTO_ENABLE` is set.

BrowserForce outdated/risky areas found during scan:

- `mcp/src/index.js` still auto-creates a page in empty auto mode:
  - `const pages = ctx.pages(); let page = pages[0] || null;`
  - `page = await ctx.newPage();`
- `relay/src/index.js` exposes only `/`, `/client-slot`, `/json/version`, `/json/list`; no `/extension/status` or attached-tab details.
- `mcp/src/exec-engine.js` checks `/` for `extension: true`, so it cannot tell "extension connected but zero attached tabs" from "ready to inspect".
- `relay/src/index.js` accepts HTTP requests based on the inbound `Host` without Playwriter-style validation.
- `extension/background.js` re-announces manual tabs after reconnect, but has no command for a status snapshot of attached tabs.
- Tests currently assert auto-create behavior, so tests must change before implementation.
- `pnpm outdated --recursive --format json` shows dependency freshness gaps:
  - `@modelcontextprotocol/sdk` `1.26.0` -> `1.29.0`
  - `playwright-core` `1.58.2` -> `1.60.0`
  - `ws` `8.19.0` -> `8.21.0`
  - `diff` `8.0.3` -> `9.0.0`
  - `zod` `3.25.76` -> `4.4.3`

Commands used for the scan:

```bash
rg -n "extension/status|extensions/status|activeTargets|Host header|validateHost|DNS rebinding|context\\.newPage\\(|Target\\.createTarget|createTab\\(|/json/list|assertExtensionConnected|manualTabAttached|notifyRelayAttachedTabs|BF_CDP_URL|BF_CLIENT_MODE|Network\\.enable|Runtime\\.runIfWaitingForDebugger" relay mcp extension test docs README.md package.json
pnpm outdated --recursive --format json
```

## Success Criteria

- Agents can query attached-tab state without opening a Playwright CDP connection.
- Manual/attached-tab mode never creates a new tab as a fallback.
- When no attached page is available, MCP returns a clear structured error instead of invoking `context.newPage()`.
- Existing auto/new-tab behavior remains available only for explicit open/navigate flows and when restrictions allow it.
- Relay status APIs are localhost-safe and tested.
- Extension reconnect preserves and reports attached tabs.
- Docs explain how to diagnose "MCP shows zero / no attached page".

## Task 1: Relay Status Model And HTTP Endpoints

**Files:**

- Modify: `relay/src/index.js`
- Test: `relay/test/relay-server.test.js`
- Docs: `README.md`, `docs/DEVELOPMENT.md`

**Step 1: Write failing tests for status endpoints**

Add tests near the existing HTTP and manual attach tests:

```js
it('GET /extension/status reports extension connection and active targets', async () => {
  const statusBefore = await httpGet(`http://127.0.0.1:${port}/extension/status`);
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.body.connected, false);
  assert.equal(statusBefore.body.activeTargets, 0);
  assert.deepEqual(statusBefore.body.attachedTabs, []);
});

it('GET /extension/status includes manually attached tab metadata', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });
  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
  });

  ext.send(JSON.stringify({
    method: 'manualTabAttached',
    params: {
      tabId: 44,
      sessionId: 'manual-44-1',
      targetId: 'bf-target-44',
      targetInfo: { url: 'https://example.com', title: 'Example' },
    },
  }));
  await sleep(100);

  const status = await httpGet(`http://127.0.0.1:${port}/extension/status`);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.activeTargets, 1);
  assert.equal(status.body.attachedTabs[0].tabId, 44);
  assert.equal(status.body.attachedTabs[0].url, 'https://example.com');
  assert.equal(status.body.attachedTabs[0].title, 'Example');
  assert.equal(status.body.attachedTabs[0].targetId, 'bf-target-44');

  ext.close();
});
```

**Step 2: Run tests and verify failure**

```bash
node --test relay/test/relay-server.test.js
```

Expected: fails because `/extension/status` is not implemented.

**Step 3: Implement local relay status helpers**

Add small helper methods to `RelayServer`:

```js
_getAttachedTabInfos() {
  return [...this.targets.values()].map((target) => ({
    tabId: target.tabId,
    sessionId: this.tabToSession.get(target.tabId) || null,
    targetId: target.targetId,
    title: target.targetInfo?.title || '',
    url: target.targetInfo?.url || '',
    debuggerAttached: !!target.debuggerAttached,
  }));
}

_getExtensionStatusBody() {
  const attachedTabs = this._getAttachedTabInfos();
  return {
    connected: !!this.ext,
    activeTargets: attachedTabs.length,
    attachedTabs,
    clients: this.clients.size,
    startedAt: new Date(this.startedAt).toISOString(),
  };
}
```

Add routes in `_handleHttp()` before `/json/version`:

```js
if (url.pathname === '/extension/status') {
  res.end(JSON.stringify(this._getExtensionStatusBody()));
  return;
}

if (url.pathname === '/attached-tabs') {
  res.end(JSON.stringify({ tabs: this._getAttachedTabInfos() }));
  return;
}
```

**Step 4: Verify tests pass**

```bash
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 5: Update docs**

Document:

- `GET /extension/status`
- `GET /attached-tabs`
- Expected shape
- How these differ from `/json/list`

**Step 6: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js README.md docs/DEVELOPMENT.md
git commit -m "feat(relay): expose attached tab status"
```

## Task 2: Host Header Validation For Low-Risk HTTP APIs

**Files:**

- Modify: `relay/src/index.js`
- Test: `relay/test/relay-server.test.js`
- Docs: `docs/DEVELOPMENT.md`

**Step 1: Write failing tests**

Add tests near HTTP route tests:

```js
it('rejects HTTP requests with non-local Host header', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/extension/status`, {
    headers: { Host: 'evil.example' },
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Invalid Host header/);
});

it('allows localhost Host header', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/extension/status`, {
    headers: { Host: `127.0.0.1:${port}` },
  });
  assert.equal(res.status, 200);
});
```

**Step 2: Run test and verify failure**

```bash
node --test relay/test/relay-server.test.js
```

Expected: non-local Host is currently accepted.

**Step 3: Implement validation**

Port the minimal Playwriter pattern into CommonJS:

```js
const ALLOWED_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parseHostHeader(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest && !/^:\d+$/.test(rest)) return null;
    return host;
  }
  if (value === '::1') return '::1';
  const colon = value.indexOf(':');
  if (colon === -1) return value;
  const host = value.slice(0, colon);
  const port = value.slice(colon + 1);
  if (!/^\d+$/.test(port)) return null;
  return host || null;
}
```

At the start of `_handleHttp()`:

```js
if (!this._isAllowedHttpHost(req.headers.host)) {
  res.statusCode = 403;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Forbidden - Invalid Host header');
  return;
}
```

Keep CDP WebSocket auth unchanged.

**Step 4: Verify**

```bash
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js docs/DEVELOPMENT.md
git commit -m "fix(relay): reject non-local HTTP hosts"
```

## Task 3: Extension Attached-Tab Snapshot Command

**Files:**

- Modify: `extension/background.js`
- Test: `test/agent/relay-url-reconnect-contract.test.js`
- Optional Test: `relay/test/relay-server.test.js`

**Step 1: Write contract test**

Extend the existing agent contract test:

```js
test('background exposes attached tab status snapshot command', () => {
  assert.match(backgroundJs, /case 'getAttachedTabs':/);
  assert.match(backgroundJs, /function getAttachedTabsSnapshot\(\)/);
  assert.match(backgroundJs, /attachedTabs\.entries\(\)/);
});
```

**Step 2: Run contract test**

```bash
node --test test/agent/relay-url-reconnect-contract.test.js
```

Expected: FAIL.

**Step 3: Implement extension command**

Add:

```js
function getAttachedTabsSnapshot() {
  return {
    tabs: [...attachedTabs.entries()].map(([tabId, entry]) => ({
      tabId,
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      title: entry.targetInfo?.title || '',
      url: entry.targetInfo?.url || '',
    })),
  };
}
```

Add to `executeCommand()`:

```js
case 'getAttachedTabs':
  return getAttachedTabsSnapshot();
```

**Step 4: Use command as optional enrichment**

In relay `/extension/status`, when `this.ext` is connected, optionally call `_sendToExt('getAttachedTabs')` with a short timeout helper in a later task. For this task, keep relay state authoritative to avoid adding timeout complexity.

**Step 5: Verify**

```bash
node --test test/agent/relay-url-reconnect-contract.test.js
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add extension/background.js test/agent/relay-url-reconnect-contract.test.js
git commit -m "feat(extension): report attached tab snapshot"
```

## Task 4: MCP Status Helpers

**Files:**

- Modify: `mcp/src/exec-engine.js`
- Test: `mcp/test/exec-engine-plugins.test.js`

**Step 1: Write failing unit tests**

Add tests:

```js
test('getExtensionStatus reads relay /extension/status', async () => {
  const restore = mockFetch({
    'http://127.0.0.1:19222/extension/status': {
      connected: true,
      activeTargets: 1,
      attachedTabs: [{ tabId: 1, url: 'https://example.com', title: 'Example' }],
    },
  });
  try {
    const status = await getExtensionStatus({ baseUrl: 'http://127.0.0.1:19222' });
    assert.equal(status.connected, true);
    assert.equal(status.activeTargets, 1);
  } finally {
    restore();
  }
});

test('assertAttachedPageAvailable throws when manual mode has no tabs', async () => {
  await assert.rejects(
    () => assertAttachedPageAvailable({
      extensionStatus: { connected: true, activeTargets: 0, attachedTabs: [] },
      restrictions: { mode: 'manual', noNewTabs: true },
    }),
    /No attached BrowserForce page available/
  );
});
```

**Step 2: Run tests**

```bash
pnpm test:mcp
```

Expected: FAIL because helpers do not exist.

**Step 3: Implement helpers**

Export:

```js
export async function getExtensionStatus({ baseUrl = getRelayHttpUrl(), timeoutMs = 2000 } = {}) {
  const resolvedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  const response = await fetch(`${resolvedBaseUrl}/extension/status`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Cannot read BrowserForce extension status (HTTP ${response.status}).`);
  }
  return await response.json();
}

export function assertAttachedPageAvailable({ extensionStatus, restrictions }) {
  const isAttachedOnly =
    restrictions?.mode === 'manual' ||
    restrictions?.noNewTabs === true ||
    process.env.BF_REQUIRE_ATTACHED_PAGE === '1';
  if (!isAttachedOnly) return;
  if (extensionStatus?.activeTargets > 0) return;
  throw new Error(
    'No attached BrowserForce page available. Attach a tab with the BrowserForce extension, then retry.'
  );
}
```

Update `assertExtensionConnected()` to prefer `/extension/status` but keep `/` fallback during rollout.

**Step 4: Verify**

```bash
pnpm test:mcp
```

Expected: PASS.

**Step 5: Commit**

```bash
git add mcp/src/exec-engine.js mcp/test/exec-engine-plugins.test.js
git commit -m "feat(mcp): read BrowserForce attached tab status"
```

## Task 5: Crash-Safe Execute Startup

**Files:**

- Modify: `mcp/src/index.js`
- Modify: `mcp/src/exec-engine.js`
- Test: `mcp/test/mcp-tools.test.js`
- Test: `mcp/test/exec-engine-plugins.test.js`

**Step 1: Replace source contract that expects auto page creation**

Update the test currently named `execute auto-creates a working page when auto mode starts empty`.

New expectation:

```js
it('execute does not create a page for attached/manual inspection mode when context is empty', () => {
  const source = readFileSync(
    join(import.meta.url.replace('file://', ''), '../../src/index.js'),
    'utf8'
  );

  assert.ok(source.includes('assertAttachedPageAvailable'), 'execute should preflight attached-page availability');
  assert.ok(source.includes('if (!page && canCreateStartupPage'), 'new page creation should be gated behind an explicit predicate');
});
```

**Step 2: Add behavior test for predicate**

In `exec-engine` tests:

```js
test('canCreateStartupPage is false in manual/noNewTabs/require-attached modes', () => {
  assert.equal(canCreateStartupPage({ mode: 'manual', noNewTabs: false }, 'inspect'), false);
  assert.equal(canCreateStartupPage({ mode: 'auto', noNewTabs: true }, 'inspect'), false);
});

test('canCreateStartupPage is true for explicit open task when allowed', () => {
  assert.equal(canCreateStartupPage({ mode: 'auto', noNewTabs: false }, 'open'), true);
});
```

**Step 3: Implement minimal predicate**

Add in `exec-engine.js`:

```js
export function canCreateStartupPage(restrictions, startupIntent = process.env.BF_MCP_STARTUP_INTENT || 'inspect') {
  if (restrictions?.mode === 'manual') return false;
  if (restrictions?.noNewTabs) return false;
  return startupIntent === 'open' || process.env.BF_ALLOW_STARTUP_PAGE === '1';
}
```

In `mcp/src/index.js`, change:

```js
if (!page && canCreateStartupPage(browserforceRestrictions)) {
  page = await ctx.newPage();
  userState.page = page;
}
```

Preflight before `ensureBrowser()` or immediately after status/restrictions are available:

```js
const extensionStatus = await getExtensionStatus({ baseUrl: getRelayHttpUrl() });
assertAttachedPageAvailable({ extensionStatus, restrictions: browserforceRestrictions });
```

Keep this scoped: do not remove explicit `context.newPage()` from user-provided code. The first fix only stops BrowserForce from doing it automatically.

**Step 4: Update MCP prompt**

Change "Empty tabs/targets handling" from "create/reuse dedicated tab" to:

- For inspect/current/attached-tab tasks: report no attached page.
- For explicit open/navigate tasks: create only when restrictions allow and user intent is explicit.

**Step 5: Verify**

```bash
pnpm test:mcp
```

Expected: PASS.

**Step 6: Commit**

```bash
git add mcp/src/index.js mcp/src/exec-engine.js mcp/test/mcp-tools.test.js mcp/test/exec-engine-plugins.test.js
git commit -m "fix(mcp): avoid implicit tab creation for attached-page flows"
```

## Task 6: Relay Guard For Target.createTarget During Attached-Only Sessions

**Files:**

- Modify: `relay/src/index.js`
- Test: `relay/test/relay-server.test.js`

**Step 1: Write failing CDP test**

Add:

```js
it('rejects Target.createTarget when no-new-tabs restriction is active', async () => {
  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });
  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
    if (msg.id && msg.method === 'getRestrictions') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: { mode: 'manual', noNewTabs: true, lockUrl: false, readOnly: false, instructions: '' },
      }));
    }
  });

  const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
  const messages = [];
  cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));
  cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
  await sleep(200);

  const response = messages.find((m) => m.id === 1);
  assert.match(response.error.message || response.error, /New tabs are disabled|manual attached-tab mode/);

  cdp.close();
  ext.close();
});
```

**Step 2: Run relay tests and verify failure**

```bash
node --test relay/test/relay-server.test.js
```

Expected: FAIL because relay always forwards createTab.

**Step 3: Implement restriction check**

In `_createTarget()`:

```js
const restrictions = await this._getRestrictionsSafe();
if (restrictions.mode === 'manual' || restrictions.noNewTabs) {
  throw new Error('New tabs are disabled in BrowserForce attached-tab mode.');
}
```

Add `_getRestrictionsSafe()` with fallback auto mode if extension is unavailable. Do not cache inside relay in this task; settings can change from popup.

**Step 4: Verify**

```bash
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js
git commit -m "fix(relay): block target creation in attached-only mode"
```

## Task 7: Extension Reconnect Handoff Hardening

**Files:**

- Modify: `extension/background.js`
- Test: `test/agent/relay-url-reconnect-contract.test.js`
- Optional Test: `relay/test/relay-server.test.js`

**Step 1: Write contract tests**

Add tests checking for:

```js
assert.match(backgroundJs, /extension\/status/);
assert.match(backgroundJs, /connected/);
assert.match(backgroundJs, /activeTargets/);
assert.match(backgroundJs, /slotAvailable/);
```

**Step 2: Implement conservative reconnect polling**

Borrow the latest Playwriter semantics:

- If WebSocket closes because this worker was replaced or another extension slot owns the relay, do not immediately reclaim based only on `activeTargets: 0`.
- Poll `/extension/status`.
- Reconnect only when `connected === false`.
- Keep current background reconnect for ordinary relay restart.

BrowserForce currently has a single extension slot, so keep this as a small state flag:

```js
let shouldWaitForExtensionSlot = false;
```

Set it when relay rejects the connection or closes with replacement-like reason. In maintain loop:

```js
if (shouldWaitForExtensionSlot) {
  const status = await getRelayExtensionStatus();
  if (status && status.connected === false) {
    shouldWaitForExtensionSlot = false;
  } else {
    await sleep(RECONNECT_DELAY_MS);
    continue;
  }
}
```

**Step 3: Verify**

```bash
node --test test/agent/relay-url-reconnect-contract.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add extension/background.js test/agent/relay-url-reconnect-contract.test.js
git commit -m "fix(extension): avoid reconnect slot handoff races"
```

## Task 8: User-Facing Diagnostics And Docs

**Files:**

- Modify: `README.md`
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/BROWSERFORCE_AGENT.md`
- Modify: `docs/knowledge/timeline/2026-06-08-crash-safe-attached-tabs.md` if the knowledge timeline exists in this repo.

**Step 1: Document diagnosis commands**

Add:

```bash
curl -s http://127.0.0.1:19222/extension/status | jq
curl -s http://127.0.0.1:19222/attached-tabs | jq
curl -s http://127.0.0.1:19222/client-slot | jq
```

Explain expected outputs:

- `connected: false`: extension not connected to relay.
- `connected: true, activeTargets: 0`: extension connected but no tab attached.
- `activeTargets > 0`: attached-tab mode is ready.
- `clients > 0`: a CDP client is active.

**Step 2: Update "Target.createTarget" troubleshooting**

Change the recommendation from "restart relay / check stale URL" only to:

- Check `/extension/status`.
- If attached flow, attach a tab first.
- If explicit new-tab flow, verify `mode !== manual` and `noNewTabs === false`.

**Step 3: Verify docs references**

Search:

```bash
rg -n "Target.createTarget|attached tab|extension/status|attached-tabs|context\\.newPage|No attached" README.md docs mcp/src relay/src extension
```

Expected: no stale instruction saying empty attached flows should create a tab.

**Step 4: Commit**

```bash
git add README.md docs/DEVELOPMENT.md docs/BROWSERFORCE_AGENT.md docs/knowledge/timeline/2026-06-08-crash-safe-attached-tabs.md
git commit -m "docs: add attached-tab diagnostics"
```

## Task 9: Dependency Freshness Follow-Up

**Files:**

- Modify only if doing dependency updates: `package.json`, `mcp/package.json`, `pnpm-lock.yaml`
- Test: full relay + MCP suite

**Decision:** Do this after crash-safe behavior lands. The crash path is behavioral/protocol-level, not obviously caused by stale npm packages.

**Step 1: Update low-risk patch/minor deps separately**

Candidate first batch:

```bash
pnpm up ws@8.21.0 playwright-core@1.60.0 @modelcontextprotocol/sdk@1.29.0
```

Hold `zod@4` and `diff@9` for a separate breaking-change pass.

**Step 2: Verify**

```bash
pnpm test
```

Expected: PASS.

**Step 3: Commit**

```bash
git add package.json mcp/package.json pnpm-lock.yaml
git commit -m "chore(deps): refresh browser protocol dependencies"
```

## Full Verification

Run after all behavior tasks:

```bash
node --test relay/test/relay-server.test.js
pnpm test:mcp
node --test test/agent/relay-url-reconnect-contract.test.js
pnpm test
```

Manual smoke:

1. Start relay/MCP.
2. Open Chrome with BrowserForce extension connected.
3. Attach one existing page.
4. Query:

```bash
curl -s http://127.0.0.1:19222/extension/status | jq
curl -s http://127.0.0.1:19222/attached-tabs | jq
```

5. Ask MCP to inspect the attached page.
6. Confirm no new `about:blank` tab is created.
7. Detach all tabs and ask MCP to inspect.
8. Confirm MCP returns "No attached BrowserForce page available" and Chrome remains stable.

## Rollout Notes

- Keep `Target.createTarget` support for explicit new-tab flows; do not remove it.
- Prefer additive APIs first so extension and relay stay compatible during reloads.
- Avoid adding direct-CDP mode in this patch; it is useful but not necessary for crash-safe attached-tab mode.
- Keep all status APIs local-only and Host-validated.

