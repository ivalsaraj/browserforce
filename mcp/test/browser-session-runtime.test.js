import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';

// ─── Fakes (no real browser / no real clock) ─────────────────────────────────

function makeFakePage() {
  const handlers = {};
  return {
    handlers,
    on(event, cb) { handlers[event] = cb; },
    mainFrame() { return 'main-frame'; },
  };
}

function makeFakeBrowser({ pages = [makeFakePage()] } = {}) {
  let connected = true;
  let disconnectedCb = null;
  const context = { on() {}, pages: () => pages };
  return {
    pages,
    get connected() { return connected; },
    isConnected: () => connected,
    contexts: () => [context],
    on(event, cb) { if (event === 'disconnected') disconnectedCb = cb; },
    async close() { connected = false; disconnectedCb?.(); },
    fireDisconnected() { connected = false; disconnectedCb?.(); },
  };
}

function makeFakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (cb, ms) => { const id = nextId++; timers.set(id, { cb, ms }); return { id, unref() {} }; },
    clearTimeout: (handle) => { if (handle && timers.has(handle.id)) timers.delete(handle.id); },
    pending: () => timers.size,
    fireAll: () => { const fns = [...timers.values()].map((t) => t.cb); timers.clear(); for (const fn of fns) fn(); },
  };
}

test('runtime keeps persistent userState until reset', async () => {
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => ({ isConnected: () => true, close: async () => {} }),
    getContext: () => ({ pages: () => [] }),
  });

  runtime.userState.answer = 42;
  assert.equal(runtime.userState.answer, 42);
  await runtime.reset();
  assert.equal(runtime.userState.answer, undefined);
});

test('concurrent ensureBrowser calls coalesce into a single connect', async () => {
  let connectCount = 0;
  const browser = makeFakeBrowser();
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => {
      connectCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return browser;
    },
  });

  await Promise.all([runtime.ensureBrowser(), runtime.ensureBrowser(), runtime.ensureBrowser()]);

  assert.equal(connectCount, 1, 'browserConnectPromise should coalesce concurrent connects');
  assert.equal(runtime.isConnected(), true);
});

test('idle-disconnect timer is scheduled when idle and cleared on active operation', async () => {
  const clock = makeFakeClock();
  const browser = makeFakeBrowser();
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => browser,
    idleDisconnectMs: 15000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  await runtime.ensureBrowser();
  assert.equal(runtime.isConnected(), true);

  runtime.beginOperation();
  assert.equal(runtime.hasPendingIdleDisconnect(), false, 'no idle timer while an operation is active');

  runtime.endOperation();
  assert.equal(runtime.hasPendingIdleDisconnect(), true, 'idle timer scheduled once idle');

  runtime.beginOperation();
  assert.equal(runtime.hasPendingIdleDisconnect(), false, 'active operation clears the pending idle timer');
});

test('idle-disconnect timer firing closes the browser when no operations are active', async () => {
  const clock = makeFakeClock();
  const browser = makeFakeBrowser();
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => browser,
    idleDisconnectMs: 15000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  await runtime.ensureBrowser();
  runtime.beginOperation();
  runtime.endOperation();
  assert.equal(clock.pending(), 1, 'one idle timer is pending');

  clock.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.connected, false, 'firing the idle timer closes the idle browser');
});

test('console capture attaches per page and clears on disconnect', async () => {
  const page = makeFakePage();
  const browser = makeFakeBrowser({ pages: [page] });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser });

  await runtime.ensureBrowser();
  page.handlers.console?.({ type: () => 'log', text: () => 'hello world' });
  assert.deepEqual(runtime.consoleLogs.get(page), ['[log] hello world']);

  // framenavigated on the main frame resets the buffer
  page.handlers.framenavigated?.('main-frame');
  assert.deepEqual(runtime.consoleLogs.get(page), []);

  browser.fireDisconnected();
  assert.equal(runtime.consoleLogs.size, 0, 'disconnect clears all console capture state');
});

test('agent preferences and restrictions are fetched once and cached, forceRefresh bypasses', async () => {
  let prefCalls = 0;
  let restrictCalls = 0;
  const fakeFetch = async (url) => {
    if (url.endsWith('/agent-preferences')) {
      prefCalls += 1;
      return { ok: true, json: async () => ({ executionMode: 'sequential' }) };
    }
    if (url.endsWith('/restrictions')) {
      restrictCalls += 1;
      return { ok: true, json: async () => ({ mode: 'manual', readOnly: true }) };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const runtime = createBrowserSessionRuntime({
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: fakeFetch,
  });

  const p1 = await runtime.getAgentPreferencesForSession();
  const p2 = await runtime.getAgentPreferencesForSession();
  assert.equal(p1.executionMode, 'sequential');
  assert.equal(p2, p1, 'cached preferences are the same object');
  assert.equal(prefCalls, 1, 'preferences fetched once and cached');

  const r1 = await runtime.getBrowserforceRestrictionsForSession();
  await runtime.getBrowserforceRestrictionsForSession();
  assert.equal(r1.mode, 'manual');
  assert.equal(r1.readOnly, true);
  assert.equal(restrictCalls, 1, 'restrictions cached after first fetch');

  await runtime.getBrowserforceRestrictionsForSession({ forceRefresh: true });
  assert.equal(restrictCalls, 2, 'forceRefresh bypasses the cache');
});

test('runtime falls back to default preferences/restrictions when the relay fetch fails', async () => {
  const runtime = createBrowserSessionRuntime({
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async () => { throw new Error('relay unreachable'); },
  });

  const prefs = await runtime.getAgentPreferencesForSession();
  assert.equal(prefs.executionMode, 'parallel');
  assert.equal(prefs.parallelVisibilityMode, 'foreground-tab');

  const restrictions = await runtime.getBrowserforceRestrictionsForSession();
  assert.equal(restrictions.mode, 'auto');
  assert.equal(restrictions.readOnly, false);
});

test('reset clears cached preferences/restrictions so the next read refetches', async () => {
  let calls = 0;
  const runtime = createBrowserSessionRuntime({
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async () => { calls += 1; return { ok: true, json: async () => ({}) }; },
  });

  await runtime.getAgentPreferencesForSession();
  assert.equal(calls, 1);
  await runtime.reset();
  await runtime.getAgentPreferencesForSession();
  assert.equal(calls, 2, 'reset clears the preference cache');
});
