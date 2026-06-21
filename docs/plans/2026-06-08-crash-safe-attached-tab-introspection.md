# Crash-Safe Attached Tab + Introspection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make BrowserForce safe for "work on the attached tab" flows by preventing accidental tab creation during inspection and by exposing low-risk relay/extension status APIs that agents can query before opening a Playwright CDP session.

**Architecture:** Add relay-owned status/introspection endpoints that read existing relay state only. The extension may replay attached-tab provenance over the existing reconnect event path, but the relay remains the authoritative source for status. Then update MCP startup and execute behavior so attached/manual flows fail clearly when no attached page is available instead of calling `context.newPage()` or triggering `Target.createTarget`. Keep the first pass narrow: no new dependencies, no multi-extension refactor, no direct-CDP mode.

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

Current upstream browser MCP references checked:

- `chrome-devtools-mcp@1.1.1` is the current npm `latest`; the official README recommends `npx -y chrome-devtools-mcp@latest` and exposes explicit page/navigation/debugging tools such as `list_pages`, `select_page`, `take_snapshot`, console/network tools, and performance tools.
- Chrome DevTools MCP issue `#1921` reports Chrome becoming unresponsive/crashing when MCP connects to a profile with a very large tab count and eagerly initializes per-tab work. The relevant lesson for BrowserForce is to avoid broad eager attachment and to keep "list/inspect attached tabs" metadata-only until a page is explicitly selected.
- `@playwright/mcp@0.0.75` is the current npm `latest`; keep package freshness as a follow-up because the crash-safe attached-tab fix is a BrowserForce relay/MCP behavior change, not mainly a dependency issue.

BrowserForce outdated/risky areas found during scan:

- `mcp/src/index.js` still auto-creates a page in empty auto mode:
  - `const pages = ctx.pages(); let page = pages[0] || null;`
  - `page = await ctx.newPage();`
- `relay/src/index.js` exposes only `/`, `/client-slot`, `/json/version`, `/json/list`; no `/extension/status` or attached-tab details.
- `relay/src/index.js` currently sets `Access-Control-Allow-Origin: *` globally in `_handleHttp()`. New introspection endpoints must not inherit that header because attached tab URLs/titles are local browsing metadata.
- `mcp/src/exec-engine.js` checks `/` for `extension: true`, so it cannot tell "extension connected but zero attached tabs" from "ready to inspect".
- `relay/src/index.js` accepts HTTP requests based on the inbound `Host` without Playwriter-style validation.
- `extension/background.js` re-announces manual tabs after reconnect, but attached tab state currently lacks explicit provenance. Manual user-attached tabs and agent-created tabs must be distinguishable before MCP can trust "attached page available".
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
- Relay status APIs are localhost-safe, not cross-origin readable by arbitrary websites, and tested.
- MCP attached-page preflight uses manual attached-tab provenance, not generic target count.
- Extension reconnect preserves and reports attached tabs.
- Docs explain how to diagnose "MCP shows zero / no attached page".

## Task 1: Relay Status Model And HTTP Endpoints

**Commit boundary:** This task must include Host header validation and status endpoints in the same deployable commit. Do not ship `/extension/status` or `/attached-tabs` before the Host validation lands.

**Files:**

- Modify: `relay/src/index.js`
- Test: `relay/test/relay-server.test.js`
- Docs: `README.md`, `docs/DEVELOPMENT.md`

**Step 1: Write failing tests for status endpoints and Host validation**

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
      origin: 'manual',
      targetInfo: { url: 'https://example.com', title: 'Example' },
    },
  }));
  await sleep(100);

  const status = await httpGet(`http://127.0.0.1:${port}/extension/status`);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.activeTargets, 1);
  assert.equal(status.body.activeManualTargets, 1);
  assert.equal(status.body.manualAttachedTabs[0].tabId, 44);
  assert.equal(status.body.manualAttachedTabs[0].url, 'https://example.com');
  assert.equal(status.body.manualAttachedTabs[0].title, 'Example');
  assert.equal(status.body.manualAttachedTabs[0].targetId, 'bf-target-44');
  assert.equal(status.body.manualAttachedTabs[0].origin, 'manual');

  ext.close();
});

it('rejects HTTP requests with non-local Host header before URL parsing', async () => {
  const res = await rawHttpGet({
    port,
    path: '/extension/status',
    headers: { Host: 'evil.example' },
  });
  assert.equal(res.status, 403);
  assert.match(res.text, /Invalid Host header/);
});

it('allows localhost Host headers for status endpoints', async () => {
  const res = await rawHttpGet({
    port,
    path: '/extension/status',
    headers: { Host: `127.0.0.1:${port}` },
  });
  assert.equal(res.status, 200);
});

it('does not expose attached-tab status to arbitrary browser origins with CORS', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/extension/status`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
});
```

**Step 2: Run tests and verify failure**

```bash
node --test relay/test/relay-server.test.js
```

Expected: fails because `/extension/status` and Host validation are not implemented.

Use a raw `http.request()` test helper for Host-header cases instead of Undici `fetch`, so the test controls the exact inbound `Host` header.

**Step 3: Implement Host validation before URL parsing**

Add a small CommonJS helper near the existing relay helpers:

```js
const ALLOWED_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parseHttpHostHeader(hostHeader) {
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

At the very start of `_handleHttp(req, res)`, before `new URL(req.url, ...)`:

```js
const host = parseHttpHostHeader(req.headers.host);
if ((req.headers.host && !host) || (host && !ALLOWED_HTTP_HOSTS.has(host))) {
  res.statusCode = 403;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Forbidden - Invalid Host header');
  return;
}
```

Missing Host headers from non-browser local clients may remain allowed for local-only compatibility, but malformed/non-local Host values must be rejected before URL parsing. Document missing `Host` as a deliberate compatibility exception for local non-browser clients, not as a relaxation of the local-only security model.

**Step 4: Stop global wildcard CORS from applying to introspection endpoints**

Current `_handleHttp()` sets `Access-Control-Allow-Origin: *` before route dispatch. Move CORS assignment into an explicit helper so new introspection routes can opt out:

```js
function shouldAllowWildcardCors(pathname) {
  return !new Set(['/extension/status', '/attached-tabs']).has(pathname);
}
```

After Host validation and URL parsing:

```js
if (shouldAllowWildcardCors(url.pathname)) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}
```

Do not set wildcard CORS on `/extension/status` or `/attached-tabs`. Local CLI/Node callers still work. Browser extension callers can either use extension WebSocket state or a future origin-restricted route; arbitrary websites must not read attached tab URLs/titles.

**Step 5: Implement target provenance and local relay status helpers**

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
    origin: target.origin || 'unknown',
  }));
}

_getExtensionStatusBody() {
  const attachedTabs = this._getAttachedTabInfos();
  const manualAttachedTabs = attachedTabs.filter((tab) => tab.origin === 'manual');
  return {
    connected: !!this.ext,
    activeTargets: attachedTabs.length,
    activeManualTargets: manualAttachedTabs.length,
    attachedTabs,
    manualAttachedTabs,
    clients: this.clients.size,
    startedAt: new Date(this.startedAt).toISOString(),
  };
}
```

In the `manualTabAttached` handler, store `origin: 'manual'` only when the extension explicitly sends allowed provenance `origin: 'manual'`. Preserve allowed `agent-created` and `relay-attached` values. If `origin` is omitted or unrecognized, store `origin: 'unknown'` and exclude that tab from `manualAttachedTabs`. In `_createTarget()`, store `origin: 'agent-created'`. Do not let untrusted client-supplied CDP params choose origin.

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

**Step 6: Verify tests pass**

```bash
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 7: Update docs**

Document:

- `GET /extension/status`
- `GET /attached-tabs`
- Expected shape
- How these differ from `/json/list`
- Host header protection for local HTTP APIs
- CORS behavior: `/extension/status` and `/attached-tabs` intentionally omit wildcard CORS.
- Provenance fields: `manualAttachedTabs` are user-attached tabs; `attachedTabs` can include agent-created tabs.

**Step 8: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js README.md docs/DEVELOPMENT.md
git commit -m "feat(relay): secure and expose attached tab status"
```

## Task 2: Relay Status API Security Regression Audit

**Files:**

- Test: `relay/test/relay-server.test.js`
- Docs: `docs/DEVELOPMENT.md`

**Step 1: Confirm Task 1 already landed the Host guard**

Run:

```bash
rg -n "parseHttpHostHeader|ALLOWED_HTTP_HOSTS|Invalid Host header|shouldAllowWildcardCors|manualAttachedTabs|activeManualTargets|/extension/status|/attached-tabs" relay/src/index.js relay/test/relay-server.test.js docs/DEVELOPMENT.md
```

Expected:

- `_handleHttp()` validates `req.headers.host` before calling `new URL(req.url, ...)`.
- `/extension/status` and `/attached-tabs` tests include both accepted localhost and rejected non-local Host cases.
- `/extension/status` and `/attached-tabs` do not inherit `Access-Control-Allow-Origin: *`.
- Status JSON includes `manualAttachedTabs` and `activeManualTargets`; MCP does not rely on generic `activeTargets`.
- Docs mention Host validation for local HTTP status APIs.

**Step 2: Add any missing negative cases**

If Task 1 did not include malformed Host cases, add:

```js
it('rejects malformed bracketed Host header', async () => {
  const res = await rawHttpGet({
    port,
    path: '/extension/status',
    headers: { Host: '[::1' },
  });
  assert.equal(res.status, 403);
  assert.match(res.text, /Invalid Host header/);
});

it('rejects Host header with non-numeric port', async () => {
  const res = await rawHttpGet({
    port,
    path: '/extension/status',
    headers: { Host: `127.0.0.1:bad` },
  });
  assert.equal(res.status, 403);
  assert.match(res.text, /Invalid Host header/);
});
```

**Step 3: Run test**

```bash
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 4: Commit only if Step 2 added missing tests/docs**

```bash
git add relay/src/index.js relay/test/relay-server.test.js docs/DEVELOPMENT.md
git commit -m "test(relay): cover status endpoint host validation"
```

## Task 3: Extension Attached-Tab Provenance And Reconnect Replay

**Files:**

- Modify: `extension/background.js`
- Modify: `relay/src/index.js` (relay-side `manualTabAttached` origin allowlist + `_ensureDebuggerAttached()` non-manual provenance pass-through)
- Test: `test/agent/relay-url-reconnect-contract.test.js`
- Test: `relay/test/relay-server.test.js` (relay regression test for replayed non-manual provenance — mandatory, not optional)

**Step 1: Write contract test**

Extend the existing agent contract test:

```js
test('background tracks attached tab provenance without adding a new relay command', () => {
  assert.match(backgroundJs, /origin:\s*'manual'/);
  assert.match(backgroundJs, /origin:\s*'agent-created'/);
  assert.match(backgroundJs, /origin:\s*entry\.origin/);
  assert.doesNotMatch(backgroundJs, /case 'getAttachedTabs':/);
});

test('background reconnect replay preserves attached tab provenance', () => {
  assert.match(backgroundJs, /function notifyRelayManualTabAttached\(tabId,\s*entry\)/);
  assert.match(backgroundJs, /origin:\s*entry\.origin/);
  assert.match(backgroundJs, /function notifyRelayAttachedTabs\(\)/);
  assert.match(backgroundJs, /for \(const \[tabId,\s*entry\] of attachedTabs\)/);
});
```

**Step 2: Run contract test**

```bash
node --test test/agent/relay-url-reconnect-contract.test.js
```

Expected: FAIL.

**Step 3: Add provenance at attachment sources**

In `attachTab(tabId, sessionId, options = {})`, store:

```js
const ALLOWED_TAB_ORIGINS = new Set(['manual', 'agent-created', 'relay-attached']);
const origin = ALLOWED_TAB_ORIGINS.has(options.origin) ? options.origin : 'unknown';
const entry = { sessionId, targetId, targetInfo, tabId, origin };
```

Call sites:

- Popup `attachCurrentTab`: `attachTab(tab.id, sessionId, { origin: 'manual' })`
- Relay `attachTab` command for existing tabs: pass through `msg.params.origin` only after it is allowlisted by `attachTab()`. Never default relay-driven attachment to manual.
- `createTab(params)`: after creating the tab, call `attachTab(tab.id, params.sessionId, { origin: 'agent-created' })`

Send `origin` in `notifyRelayManualTabAttached()` for manual tabs. For agent-created tabs, relay already learns provenance from `_createTarget()` and must store `origin: 'agent-created'`.

Despite the legacy message name `manualTabAttached`, reconnect replay must preserve the original provenance for every attached tab:

```js
function notifyRelayManualTabAttached(tabId, entry) {
  send({
    method: 'manualTabAttached',
    params: {
      tabId,
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      targetInfo: entry.targetInfo,
      origin: entry.origin || 'unknown',
    },
  });
}
```

Add a relay regression test proving replayed non-manual provenance stays non-manual after status rebuild:

```js
it('preserves non-manual origin when attached tabs are replayed after reconnect', async () => {
  ext.send(JSON.stringify({
    method: 'manualTabAttached',
    params: {
      tabId: 55,
      sessionId: 'agent-55-1',
      targetId: 'bf-target-55',
      targetInfo: { url: 'https://agent.example', title: 'Agent' },
      origin: 'agent-created',
    },
  }));
  await sleep(100);

  const status = await httpGet(`http://127.0.0.1:${port}/extension/status`);
  assert.equal(status.body.activeTargets, 1);
  assert.equal(status.body.activeManualTargets, 0);
  assert.equal(status.body.attachedTabs[0].origin, 'agent-created');
  assert.deepEqual(status.body.manualAttachedTabs, []);
});
```

In relay `_ensureDebuggerAttached()`, pass non-manual provenance when asking the extension to attach an already-known tab:

```js
const result = await this._sendToExt('attachTab', {
  tabId: target.tabId,
  sessionId,
  origin: target.origin === 'manual' ? 'manual' : 'relay-attached',
});
```

This prevents lazy relay attachment from being counted as a user-attached page.

In relay `manualTabAttached` handling, allowlist incoming `origin` to `manual`, `agent-created`, or `relay-attached`; otherwise store `unknown`. The handler name is legacy protocol wording, not proof that the tab is manual.

Backward compatibility rule: when older extensions omit `origin`, treat reconnect replay as `unknown` rather than `manual`. This may require the user to reload/update the extension before attached-tab readiness is recognized, but it is safer than accidentally treating agent-created tabs as manual.

Do not add a new extension command for this feature area. Relay state is authoritative for `/extension/status` and `/attached-tabs` in this patch; the extension only needs to preserve and replay provenance on the existing `manualTabAttached` message.

**Step 4: Verify**

```bash
node --test test/agent/relay-url-reconnect-contract.test.js
node --test relay/test/relay-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add extension/background.js relay/src/index.js test/agent/relay-url-reconnect-contract.test.js relay/test/relay-server.test.js
git commit -m "fix(extension): preserve attached tab provenance"
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
      extensionStatus: { connected: true, activeTargets: 1, activeManualTargets: 0, attachedTabs: [{ origin: 'agent-created' }], manualAttachedTabs: [] },
      restrictions: { mode: 'manual', noNewTabs: true },
    }),
    (err) => {
      assert.equal(err.code, 'BF_NO_ATTACHED_PAGE');
      assert.equal(err.details.connected, true);
      assert.equal(err.details.activeTargets, 1);
      assert.equal(err.details.activeManualTargets, 0);
      assert.equal(err.details.restrictions.mode, 'manual');
      return true;
    }
  );
});

test('isAttachedPageIntent defaults to inspect-safe behavior', () => {
  assert.equal(isAttachedPageIntent(undefined), true);
  assert.equal(isAttachedPageIntent('inspect'), true);
  assert.equal(isAttachedPageIntent('auto'), true);
  assert.equal(isAttachedPageIntent('open'), false);
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
export function isAttachedPageIntent(intent) {
  return intent !== 'open';
}

export class BrowserForceMcpError extends Error {
  constructor(message, { code, details = {} }) {
    super(message);
    this.name = 'BrowserForceMcpError';
    this.code = code;
    this.details = details;
  }
}

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

export function assertAttachedPageAvailable({ extensionStatus, restrictions, intent = 'inspect' }) {
  const isAttachedOnly =
    isAttachedPageIntent(intent) ||
    restrictions?.mode === 'manual' ||
    restrictions?.noNewTabs === true ||
    process.env.BF_REQUIRE_ATTACHED_PAGE === '1';
  if (!isAttachedOnly) return;
  if (extensionStatus?.activeManualTargets > 0 || extensionStatus?.manualAttachedTabs?.length > 0) return;
  throw new BrowserForceMcpError(
    'No attached BrowserForce page available. Attach a tab with the BrowserForce extension, then retry.',
    {
      code: 'BF_NO_ATTACHED_PAGE',
      details: {
        connected: !!extensionStatus?.connected,
        activeTargets: Number(extensionStatus?.activeTargets || 0),
        activeManualTargets: Number(extensionStatus?.activeManualTargets || 0),
        attachedTabs: extensionStatus?.attachedTabs || [],
        manualAttachedTabs: extensionStatus?.manualAttachedTabs || [],
        restrictions: restrictions || {},
        intent,
      },
    },
  );
}
```

Update `assertExtensionConnected()` to use `/extension/status` for BrowserForce attached-page/status readiness. Do not fall back to `/` inside attached-page preflight or any path that can continue to `ensureBrowser()` / `chromium.connectOverCDP()`. The root endpoint may remain as a generic relay health check elsewhere, but it is not proof that an attached page exists.

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

**Step 1: Replace source contract that expects automatic page creation during inspection startup**

> **Test-strategy note (mandatory):** The source-contract tests in this step are SECONDARY guards only — they catch regressions cheaply but cannot prove runtime ordering. The PRIMARY proof that preflight runs before `ensureBrowser()`/`chromium.connectOverCDP()` is the behavior-level tests in Step 4.5, which must be implemented (not skipped) using an exported/injectable startup helper. Do not ship Task 5 with source contracts as the only coverage for the preflight-before-CDP guarantee.

Update the test currently named `execute auto-creates a working page when auto mode starts empty`.

New expectation:

```js
it('execute does not create a page for attached/manual inspection mode when context is empty', () => {
  const source = readFileSync(
    join(import.meta.url.replace('file://', ''), '../../src/index.js'),
    'utf8'
  );

  assert.ok(source.includes('assertAttachedPageAvailable'), 'execute should preflight attached-page availability');
  assert.ok(source.includes('preflightAttachedPageBeforeCdp'), 'execute should use the shared no-CDP preflight');
  assert.ok(source.includes('if (!page && shouldCreateImplicitStartupPage'), 'implicit page creation should be gated behind an explicit predicate');
});

it('reset also runs attached-page preflight before reconnecting over CDP', () => {
  const source = readFileSync(
    join(import.meta.url.replace('file://', ''), '../../src/index.js'),
    'utf8'
  );

  const resetIdx = source.indexOf("'reset'");
  const resetBlock = source.slice(resetIdx, resetIdx + 3000);
  assert.ok(resetBlock.includes('preflightAttachedPageBeforeCdp'), 'reset should preflight before ensureBrowser');
  assert.ok(resetBlock.indexOf('preflightAttachedPageBeforeCdp') < resetBlock.indexOf('ensureBrowser()'));
});

it('execute and reset are the only MCP tool handlers allowed to reach CDP startup', () => {
  const source = readFileSync(
    join(import.meta.url.replace('file://', ''), '../../src/index.js'),
    'utf8'
  );
  const directEnsureBrowserCalls = [...source.matchAll(/await ensureBrowser\(/g)].map((match) => match.index);
  assert.equal(directEnsureBrowserCalls.length, 2, 'all CDP startup should remain auditable through execute/reset');
  for (const idx of directEnsureBrowserCalls) {
    const surroundingBlock = source.slice(Math.max(0, idx - 1000), idx + 500);
    assert.match(surroundingBlock, /preflightAttachedPageBeforeCdp/, 'CDP startup must be preflighted in the same branch');
  }
  assert.equal((source.match(/chromium\.connectOverCDP/g) || []).length, 1, 'CDP connect should stay centralized inside ensureBrowser');
});

it('ensureBrowser does not use root relay readiness as attached-page proof', () => {
  const source = readFileSync(
    join(import.meta.url.replace('file://', ''), '../../src/index.js'),
    'utf8'
  );
  const ensureBrowserIdx = source.indexOf('async function ensureBrowser');
  const ensureBrowserBlock = source.slice(ensureBrowserIdx, source.indexOf('function getContext', ensureBrowserIdx));
  assert.doesNotMatch(ensureBrowserBlock, /assertExtensionConnected/);
  assert.doesNotMatch(ensureBrowserBlock, /fetch\(`?\$\{?baseUrl\}?\/`?/);
});
```

**Step 2: Add behavior test for predicate**

In `exec-engine` tests:

```js
test('shouldCreateImplicitStartupPage is false in manual/noNewTabs modes', () => {
  assert.equal(shouldCreateImplicitStartupPage({ mode: 'manual', noNewTabs: false }), false);
  assert.equal(shouldCreateImplicitStartupPage({ mode: 'auto', noNewTabs: true }), false);
});

test('shouldCreateImplicitStartupPage preserves legacy auto bootstrap only when explicitly enabled', () => {
  const original = process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE;
  try {
    delete process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE;
    assert.equal(shouldCreateImplicitStartupPage({ mode: 'auto', noNewTabs: false }), false);
    process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE = '1';
    assert.equal(shouldCreateImplicitStartupPage({ mode: 'auto', noNewTabs: false }), true);
  } finally {
    if (original === undefined) delete process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE;
    else process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE = original;
  }
});
```

**Step 2.5: Add canonical execute intent tests**

Add `intent` to the `execute` tool schema:

```js
intent: z.enum(['inspect', 'open', 'auto']).optional()
  .describe('Use inspect for current/attached-tab work; use open only when the user explicitly asked to open/navigate. Defaults to inspect.'),
```

Add source/behavior tests:

```js
it('execute schema includes an explicit attached-page intent', () => {
  const source = readFileSync(
    join(import.meta.url.replace('file://', ''), '../../src/index.js'),
    'utf8'
  );
  const execBlock = source.split("'execute'")[1]?.split('async ({ code')[0] || '';
  assert.match(execBlock, /intent:\s*z\.enum\(\['inspect', 'open', 'auto'\]\)\.optional\(\)/);
});

test('assertOpenIntentAllowed blocks open intent when restrictions disable new tabs', () => {
  assert.throws(
    () => assertOpenIntentAllowed({ mode: 'manual', noNewTabs: false }),
    /New tabs are disabled/,
  );
  assert.throws(
    () => assertOpenIntentAllowed({ mode: 'auto', noNewTabs: true }),
    /New tabs are disabled/,
  );
  assert.doesNotThrow(() => assertOpenIntentAllowed({ mode: 'auto', noNewTabs: false }));
});
```

**Step 3: Implement minimal predicate**

Add in `exec-engine.js` (`isAttachedPageIntent` was already added in Task 4; reuse it — do not re-declare or diverge):

```js
export function assertOpenIntentAllowed(restrictions) {
  if (restrictions?.mode === 'manual' || restrictions?.noNewTabs) {
    throw new BrowserForceMcpError(
      'New tabs are disabled in this BrowserForce session.',
      {
        code: 'BF_NEW_TABS_DISABLED',
        details: { restrictions: restrictions || {}, intent: 'open' },
      },
    );
  }
}

export function shouldCreateImplicitStartupPage(restrictions) {
  if (restrictions?.mode === 'manual') return false;
  if (restrictions?.noNewTabs) return false;
  return process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE === '1';
}
```

In `mcp/src/index.js`, change:

```js
if (!page && shouldCreateImplicitStartupPage(browserforceRestrictions)) {
  page = await ctx.newPage();
  userState.page = page;
}
```

Preflight ordering is mandatory for crash-safety. Add a shared `preflightAttachedPageBeforeCdp()` helper in `mcp/src/index.js` or `mcp/src/exec-engine.js` and call it before every path that can trigger `ensureBrowser()` / `chromium.connectOverCDP()`, including both `execute` and `reset`.

Centralization requirement: keep `chromium.connectOverCDP()` reachable only from `ensureBrowser()`, and keep `ensureBrowser()` reachable from MCP tool handlers only after the same branch has successfully called `preflightAttachedPageBeforeCdp()`. Do not add another helper that calls `ensureBrowser()` indirectly unless it accepts and verifies a preflight result.

For attached/current/inspect/manual/no-new-tabs flows, the shared helper must do all of this before `ensureBrowser()` and before any `chromium.connectOverCDP()` call:

1. `await ensureRelay()` so the HTTP relay exists.
2. Fetch fresh restrictions via relay HTTP (`/restrictions`) through ONE canonical helper — `fetchBrowserforceRestrictionsForSession({ forceRefresh: true })` — which bypasses the cached value, fetches from the relay, normalizes, updates the cache, and returns the normalized object. Do not read `cachedBrowserforceRestrictions` directly inside the preflight safety gate, and do not hand-roll a second fetcher. `execute`/`reset` must reuse the exact object this helper returns for the rest of the turn (no second fetch, no fallback to the cached value).
3. Fetch attached status via relay HTTP (`/extension/status`).
4. Run `assertAttachedPageAvailable(...)`.
5. Return the fresh restrictions to the caller so `execute` can use the same value for the rest of the turn.
6. Only then call `ensureBrowser()`.

```js
async function preflightAttachedPageBeforeCdp({ intent = 'inspect' } = {}) {
  await ensureRelay();
  const baseUrl = getRelayHttpUrl();
  const restrictions = await fetchBrowserforceRestrictionsForSession({ forceRefresh: true });
  const extensionStatus = await getExtensionStatus({ baseUrl });
  if (isAttachedPageIntent(intent)) {
    assertAttachedPageAvailable({ extensionStatus, restrictions, intent });
  } else {
    assertOpenIntentAllowed(restrictions);
  }
  return restrictions;
}
```

In `execute`, default `intent` to `'inspect'`, call `preflightAttachedPageBeforeCdp({ intent })` before `ensureBrowser()`, then reuse the returned fresh restrictions instead of immediately refetching/cached restrictions. Only `intent: 'open'` may bypass attached-page availability, and only after the same preflight has confirmed `restrictions.mode !== 'manual'` and `restrictions.noNewTabs !== true`.

In `reset`, call `preflightAttachedPageBeforeCdp({ intent: 'inspect' })` before reconnecting with `ensureBrowser()`. If it returns `BF_NO_ATTACHED_PAGE`, reset should fail with the same structured error rather than opening or connecting to CDP.

Remove `assertExtensionConnected()` from `ensureBrowser()` or make it a generic non-startup health helper only. `ensureBrowser()` must not prove readiness by calling `/`; every startup path must rely on the fresh `/extension/status` preflight above before CDP connection.

Add an explicit call-site audit in the implementation commit. Search `mcp/src/index.js` and `mcp/src/exec-engine.js` for every `ensureBrowser(`, `assertExtensionConnected`, `chromium.connectOverCDP`, `connectOverCDP`, `ctx.newPage(`, and helper that can indirectly call them. For each execute/reset branch, route through `preflightAttachedPageBeforeCdp()` first. The audit result should be reflected in tests, preferably with one behavior-level test for the manual/no-attached path and one source contract that catches any new direct `ensureBrowser()` before preflight or root-health check inside `ensureBrowser()`.

Minimum behavior coverage:

- `execute` with `{ mode: 'manual', noNewTabs: true }` and no manual attached tabs returns `BF_NO_ATTACHED_PAGE`; injected/observable `ensureBrowser` is not called.
- `execute` with default/omitted `intent` and `{ mode: 'auto', noNewTabs: false }` still returns `BF_NO_ATTACHED_PAGE` when no manual tab exists; this protects inspect/current/attached asks even outside manual mode.
- `execute` with `intent: 'open'` and `{ mode: 'manual' }` or `{ noNewTabs: true }` returns `BF_NEW_TABS_DISABLED`; injected/observable `ensureBrowser` is not called.
- `execute` with `intent: 'open'` may continue past preflight only when restrictions allow new tabs.
- `reset` with `{ mode: 'manual', noNewTabs: true }` and no manual attached tabs returns `BF_NO_ATTACHED_PAGE`; injected/observable `ensureBrowser` is not called.
- `execute` in legacy auto mode creates no implicit page unless `BF_ALLOW_IMPLICIT_STARTUP_PAGE=1`.

Keep this scoped: do not remove explicit `context.newPage()` from user-provided code. The first fix only stops BrowserForce from doing it automatically. For explicit open/navigate tasks, the agent can still call `context.newPage()` in its execute snippet when `mode !== 'manual'` and `noNewTabs !== true`; the relay guard in Task 6 remains the runtime backstop.

Do not add a vague env var named `BF_MCP_STARTUP_INTENT`; the explicit `intent` tool field is the startup-intent contract for this patch.

**Step 4: Update MCP prompt**

Change "Empty tabs/targets handling" from "create/reuse dedicated tab" to:

- For inspect/current/attached-tab tasks: report no attached page unless `manualAttachedTabs` is non-empty.
- For explicit open/navigate tasks: user code may create a tab only when restrictions allow it; BrowserForce itself should not create an implicit startup page unless `BF_ALLOW_IMPLICIT_STARTUP_PAGE=1` is set for backward compatibility.

Also update existing MCP prompt/source-contract tests that assert empty-tab handling or reset behavior, not only the renamed auto-create startup test.

Document this as a compatibility change: legacy auto-mode bootstrap can be restored with `BF_ALLOW_IMPLICIT_STARTUP_PAGE=1`, but the new default favors crash-safe attached-tab inspection.

**Step 4.5: Format structured MCP errors**

Import `BrowserForceMcpError` (and the `BF_*` error codes it carries) from `mcp/src/exec-engine.js` into `mcp/src/index.js` so the catch site can branch on `err.code` without re-declaring the class. In `mcp/src/index.js`, when catching `BrowserForceMcpError`, return stable machine-readable text:

```js
if (err?.code === 'BF_NO_ATTACHED_PAGE') {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      }, null, 2),
    }],
    isError: true,
  };
}
```

Add a behavior test that asserts the returned text includes `"code": "BF_NO_ATTACHED_PAGE"`.

Add a connection-order test that exercises the REAL execute/reset preflight path via dependency injection. This is mandatory, not optional — source-string contracts alone cannot prove `ensureBrowser()`/`chromium.connectOverCDP()` is not reached when preflight fails. Export (or inject) a `runExecuteStartupForTest({ restrictions, extensionStatus, ensureBrowser, ... })` helper from `mcp/src/index.js` (or a testable startup module) that runs the same `preflightAttachedPageBeforeCdp()` → `ensureBrowser()` sequence the live handler uses, with `ensureBrowser`/`fetchBrowserforceRestrictionsForSession`/`getExtensionStatus` injectable so the test can assert ordering and assert `ensureBrowser` is never called when preflight throws.

```js
test('manual attached-page preflight fails before connecting over CDP', async () => {
  const calls = [];
  const result = await runExecuteStartupForTest({
    restrictions: { mode: 'manual', noNewTabs: true },
    extensionStatus: { connected: true, activeTargets: 1, activeManualTargets: 0, manualAttachedTabs: [] },
    ensureBrowser: async () => {
      calls.push('ensureBrowser');
      throw new Error('ensureBrowser should not be called');
    },
  });
  assert.equal(result.error.code, 'BF_NO_ATTACHED_PAGE');
  assert.deepEqual(calls, []);
});

test('reset preflight fails before connecting over CDP when no manual tab is attached', async () => {
  const calls = [];
  const result = await runResetStartupForTest({
    restrictions: { mode: 'manual', noNewTabs: true },
    extensionStatus: { connected: true, activeTargets: 1, activeManualTargets: 0, manualAttachedTabs: [] },
    ensureBrowser: async () => {
      calls.push('ensureBrowser');
      throw new Error('ensureBrowser should not be called');
    },
  });
  assert.equal(result.error.code, 'BF_NO_ATTACHED_PAGE');
  assert.deepEqual(calls, []);
});

test('open intent with no-new-tabs returns BF_NEW_TABS_DISABLED before ensureBrowser', async () => {
  const calls = [];
  const result = await runExecuteStartupForTest({
    intent: 'open',
    restrictions: { mode: 'auto', noNewTabs: true },
    extensionStatus: { connected: true, activeTargets: 0, activeManualTargets: 0, manualAttachedTabs: [] },
    ensureBrowser: async () => {
      calls.push('ensureBrowser');
      throw new Error('ensureBrowser should not be called');
    },
  });
  assert.equal(result.error.code, 'BF_NEW_TABS_DISABLED');
  assert.deepEqual(calls, []);
});
```

If the handler cannot be isolated without significant refactor, extract the preflight+startup sequence into a small `mcp/src/startup.js` that both the live handler and the test import — this is the preferred approach (avoid exporting test helpers from `mcp/src/index.js`, which auto-runs `main()` at module load). Source contracts from Step 1 remain as secondary regression guards only.

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

it('rejects Target.createTarget without createTab when restrictions cannot be read', async () => {
  for (const failureMode of ['extension-missing', 'timeout', 'malformed-response', 'extension-error', 'transport-failure']) {
    const seenExtensionCommands = [];
    const cleanup = await installRestrictionsFailureFixture(failureMode, { seenExtensionCommands });
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    await sleep(300);

    const response = messages.find((m) => m.id === 1);
    assert.ok(response?.error, `expected createTarget to fail closed for ${failureMode}`);
    assert.match(response.error.message || response.error, /New tabs are disabled|Cannot read BrowserForce restrictions|attached-tab mode/);
    assert.equal(
      seenExtensionCommands.filter((msg) => msg.method === 'createTab').length,
      0,
      `createTab must not be sent when restrictions fail via ${failureMode}`,
    );

    cdp.close();
    await cleanup?.();
  }
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

Add `_getRestrictionsSafe()` without an allow-open fallback. Every inability-to-read path must block `Target.createTarget` deterministically: extension missing, timeout, parse error, malformed response, network/WS failure, and explicit extension error. Return a fail-closed restriction object such as `{ mode: 'manual', noNewTabs: true }` or throw a structured error that causes `_createTarget()` to reject. Do not silently fall back to auto mode in this guard. Do not cache inside relay in this task; settings can change from popup.

Implement the failure fixture or equivalent focused tests for all listed failure modes in the same commit as `_getRestrictionsSafe()`. The pass condition is mandatory per mode: each mode returns a CDP error and records zero extension `createTab` commands.

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
assert.match(backgroundJs, /connected === false/);
```

**Step 2: Implement conservative reconnect polling**

Borrow the latest Playwriter semantics:

- If WebSocket closes because this worker was replaced or another extension slot owns the relay, do not immediately reclaim based only on `activeTargets: 0`.
- Poll `/extension/status`.
- Reconnect only when `connected === false`.
- Do not introduce a second `slotAvailable` field; the status schema's `connected` field is the single reconnect slot signal for this patch.
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
- `activeManualTargets > 0` or `manualAttachedTabs.length > 0`: attached-tab mode is ready.
- `activeTargets > 0` alone is not enough; it can include agent-created or relay-attached tabs.
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
