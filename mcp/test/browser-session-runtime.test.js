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

function makeFakeBrowser({ pages = [makeFakePage()] , cdpSessions = null } = {}) {
  let connected = true;
  let disconnectedCb = null;
  const context = {
    on() {},
    pages: () => pages,
    // Per-page CDP session seam: exact identification of duplicate-URL tabs
    // opens one of these per unmatched page and detaches it immediately.
    async newCDPSession(page) {
      const index = pages.indexOf(page);
      cdpSessions?.push(page);
      return {
        async send(method) {
          if (method !== 'Target.getTargetInfo') return {};
          return { targetInfo: { targetId: `cdp-${index}` } };
        },
        async detach() {},
      };
    },
  };
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

// Page with a controllable isClosed() — `closed: 'throw'` simulates a
// detached/destroyed handle whose isClosed() raises (the case the defensive
// predicate must treat as unusable rather than crashing the verb).
function makeClosablePage(closed = false) {
  return { isClosed() { if (closed === 'throw') throw new Error('detached'); return closed; } };
}

// ─── Active tab + named tab primitives ───────────────────────────────────────

// Fake page with identity, closable state, and mutable url/title (to prove
// stable handles are keyed by page identity, not by page metadata).
function makeTabPage({ url = 'about:blank', title = 'Tab' } = {}) {
  let closed = false;
  return {
    meta: { url, title },
    isClosed: () => closed,
    closeNow: () => { closed = true; },
    url() { return this.meta.url; },
    async title() { return this.meta.title; },
    on() {},
    mainFrame() { return 'main-frame'; },
  };
}

function makeTabRuntime(ctxPages) {
  return createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages: ctxPages }),
  });
}

test('runtime starts with no explicit active tab', () => {
  const runtime = makeTabRuntime([makeTabPage()]);
  assert.equal(runtime.getActivePage(), null);
});

test('setActivePage pins the page and closed active pages are dropped', async () => {
  const p1 = makeTabPage();
  const runtime = makeTabRuntime([p1]);

  runtime.setActivePage(p1);
  assert.equal(runtime.getActivePage(), p1);
  assert.equal(runtime.userState.page, p1, 'active page is the persistent state.page');

  p1.closeNow();
  assert.equal(runtime.getActivePage(), null, 'closed active page is dropped');
  assert.equal(runtime.userState.page, null, 'dropped pin is cleared from state');

  assert.throws(() => runtime.setActivePage(p1), /closed/i, 'cannot activate a closed page');
});

test('unnamed commands use the active page', async () => {
  const p1 = makeTabPage({ url: 'https://one.test/' });
  const p2 = makeTabPage({ url: 'https://two.test/' });
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages: [p1, p2] }),
    buildExecContext: (page) => ({ page }),
    runCode: async (_code, execCtx) => execCtx.page,
  });

  runtime.setActivePage(p2);
  const target = await runtime.runCommand({ code: 'noop' });
  assert.equal(target, p2, 'runCommand targets the explicitly activated page, not pages()[0]');
});

test('named tabs are stored separately from the active tab', () => {
  const p1 = makeTabPage();
  const p2 = makeTabPage();
  const runtime = makeTabRuntime([p1, p2]);

  runtime.setNamedPage('docs', p1);
  runtime.setActivePage(p2);

  assert.equal(runtime.getNamedPage('docs'), p1);
  assert.equal(runtime.getActivePage(), p2);

  runtime.forgetPageName('docs');
  assert.equal(runtime.getNamedPage('docs'), null);
  assert.equal(runtime.getActivePage(), p2, 'forgetting a name never touches the active tab');
});

test('reset clears active page and tab names', async () => {
  const p1 = makeTabPage();
  const runtime = makeTabRuntime([p1]);

  runtime.setActivePage(p1);
  runtime.setNamedPage('docs', p1);
  await runtime.reset();

  assert.equal(runtime.getActivePage(), null);
  assert.equal(runtime.getNamedPage('docs'), null);
  assert.deepEqual(runtime.listPageNames(), []);
});

test('stable handles survive page title/URL changes', async () => {
  const p1 = makeTabPage({ url: 'https://a.test/', title: 'A' });
  const runtime = makeTabRuntime([p1]);
  await runtime.ensureBrowser();

  const handle = runtime.getStablePageHandle(p1);
  assert.match(handle, /^t\d+$/, 'handles use the t<N> shape');

  p1.meta.url = 'https://a.test/changed';
  p1.meta.title = 'A (changed)';
  assert.equal(runtime.getStablePageHandle(p1), handle, 'handle is keyed by page identity, not metadata');
});

test('removing a page before the active page preserves the same logical active handle', async () => {
  const pA = makeTabPage({ title: 'A' });
  const pB = makeTabPage({ title: 'B' });
  const pC = makeTabPage({ title: 'C' });
  const ctxPages = [pA, pB, pC];
  const runtime = makeTabRuntime(ctxPages);
  await runtime.ensureBrowser();

  const before = runtime.listStablePages();
  assert.deepEqual(before.map((row) => row.handle), ['t1', 't2', 't3']);
  runtime.setActivePage(pB);
  const activeHandle = runtime.getStablePageHandle(pB);

  // Close + remove the page listed BEFORE the active one.
  pA.closeNow();
  ctxPages.splice(ctxPages.indexOf(pA), 1);

  const after = runtime.listStablePages();
  assert.deepEqual(after.map((row) => row.handle), ['t2', 't3'], 'handles never renumber when earlier tabs close');
  assert.equal(runtime.getStablePageHandle(runtime.getActivePage()), activeHandle);
});

// ─── Many-tab stress (Task 12): the primitives stay fast and identity-stable ──

test('stress: listTabRows over 100 pages is prompt, unique, and stable through churn', async () => {
  const ctxPages = Array.from({ length: 100 }, (_, i) => makeTabPage({
    url: `https://site-${i}.test/path?session=${i}`,
    title: `Site ${i}`,
  }));
  const runtime = makeTabRuntime(ctxPages);
  runtime.setActivePage(ctxPages[60]);

  const started = Date.now();
  const rows = await runtime.listTabRows();
  const elapsed = Date.now() - started;

  assert.equal(rows.length, 100);
  assert.ok(elapsed < 2000, `listTabRows over 100 pages should be prompt (took ${elapsed}ms)`);
  const handles = rows.map((row) => row.handle);
  assert.ok(handles.every((h) => /^t\d+$/.test(h)));
  assert.equal(new Set(handles).size, 100, 'every page has its own stable handle');
  const activeRows = rows.filter((row) => row.active);
  assert.equal(activeRows.length, 1, 'exactly one row is marked active');
  const activeHandle = activeRows[0].handle;

  // Churn: close + remove 30 pages listed before the active one.
  for (const page of ctxPages.slice(0, 30)) page.closeNow();
  ctxPages.splice(0, 30);

  const after = await runtime.listTabRows();
  assert.equal(after.length, 70);
  const activeAfter = after.find((row) => row.active);
  assert.equal(activeAfter.handle, activeHandle, 'the active logical tab kept its handle through churn');
  assert.equal(runtime.getActivePage(), ctxPages[30], 'the active page object never changed');
});

test('stress: resolveTabTarget soft-matching stays precise across 100 pages', async () => {
  const ctxPages = Array.from({ length: 100 }, (_, i) => makeTabPage({
    url: `https://site-${i}.test/path?session=${i}`,
    title: `Site ${i}`,
  }));
  const mrr = makeTabPage({
    url: 'https://app.heymantle.com/reports/mrr?range=90d&compare=prev',
    title: 'MRR — Mantle',
  });
  const dupA = makeTabPage({ url: 'https://one.test/', title: 'Dashboard — One' });
  const dupB = makeTabPage({ url: 'https://two.test/', title: 'Dashboard — Two' });
  ctxPages.splice(57, 0, mrr, dupA, dupB);
  const runtime = makeTabRuntime(ctxPages);

  // Query-string drift: the query has no ?range=… but still matches uniquely.
  const hit = await runtime.resolveTabTarget('app.heymantle.com/reports/mrr');
  assert.equal(hit.page, mrr);
  assert.equal(hit.matchedBy, 'url-substring');

  // Ambiguity fails loudly even with 103 candidates to scan.
  await assert.rejects(
    () => runtime.resolveTabTarget('Dashboard'),
    (err) => err.code === 'TAB_AMBIGUOUS' && /matches 2 tabs/.test(err.message),
  );

  // A unique title substring still resolves.
  const byTitle = await runtime.resolveTabTarget('Site 73');
  assert.equal(byTitle.matchedBy, 'title-substring');
  assert.equal(byTitle.page.meta.title, 'Site 73');
});

test('named tab conflicts: duplicate names fail without replace, move with replace', () => {
  const p1 = makeTabPage();
  const p2 = makeTabPage();
  const runtime = makeTabRuntime([p1, p2]);

  runtime.setNamedPage('docs', p1);

  assert.throws(
    () => runtime.setNamedPage('docs', p2),
    (err) => err.code === 'TAB_NAME_IN_USE',
    'assigning an existing name without replace fails with a structured code',
  );

  const result = runtime.setNamedPage('docs', p2, { replace: true });
  assert.equal(result.replaced, true);
  assert.equal(runtime.getNamedPage('docs'), p2, 'replace moves the name to the new page');
  assert.equal(p1.isClosed(), false, 'the previously named page stays open');
});

test('tab names must be identifier-like and never take the stable-handle shape', () => {
  const p1 = makeTabPage();
  const runtime = makeTabRuntime([p1]);

  const badName = (fn) => assert.throws(fn, (err) => err.code === 'BAD_TAB_NAME');

  badName(() => runtime.setNamedPage('my tab', p1));      // spaces
  badName(() => runtime.setNamedPage('2docs', p1));       // leading digit
  badName(() => runtime.setNamedPage('docs.dev', p1));    // punctuation
  badName(() => runtime.setNamedPage('', p1));            // empty
  // t<N> would be shadowed forever: resolveTabTarget matches handles first.
  badName(() => runtime.setNamedPage('t2', p1));
  badName(() => runtime.setNamedPage('T15', p1));

  // Valid shapes still work, including the documented hyphenated style.
  runtime.setNamedPage('api-docs', p1);
  assert.equal(runtime.getNamedPage('api-docs'), p1);
  runtime.setNamedPage('_scratch', p1);
  runtime.setNamedPage('tab2', p1); // starts with t but not t<N> — allowed

  // rename goes through the same validator.
  badName(() => runtime.renamePageName('api-docs', 't3'));
  badName(() => runtime.renamePageName('api-docs', 'bad name'));
  runtime.renamePageName('api-docs', 'docs-v2');
  assert.equal(runtime.getNamedPage('docs-v2'), p1);
});

test('forgetPageName removes the mapping and reports whether it existed', () => {
  const p1 = makeTabPage();
  const runtime = makeTabRuntime([p1]);

  runtime.setNamedPage('docs', p1);
  assert.equal(runtime.forgetPageName('docs'), true);
  assert.equal(runtime.getNamedPage('docs'), null);
  assert.equal(runtime.forgetPageName('docs'), false, 'forgetting a missing name reports false');
});

test('renamePageName moves the mapping; renaming onto an existing name needs replace', () => {
  const p1 = makeTabPage();
  const p2 = makeTabPage();
  const runtime = makeTabRuntime([p1, p2]);

  runtime.setNamedPage('docs', p1);
  runtime.renamePageName('docs', 'api-docs');
  assert.equal(runtime.getNamedPage('docs'), null);
  assert.equal(runtime.getNamedPage('api-docs'), p1);

  runtime.setNamedPage('app', p2);
  assert.throws(
    () => runtime.renamePageName('app', 'api-docs'),
    (err) => err.code === 'TAB_NAME_IN_USE',
    'renaming onto a taken name fails without replace',
  );

  const moved = runtime.renamePageName('app', 'api-docs', { replace: true });
  assert.equal(moved.replaced, true);
  assert.equal(runtime.getNamedPage('api-docs'), p2);

  assert.throws(
    () => runtime.renamePageName('ghost', 'anything'),
    (err) => err.code === 'TAB_NAME_NOT_FOUND',
    'renaming an unknown name fails with a structured code',
  );
});

test('closed pages are pruned from names and stable listings', async () => {
  const p1 = makeTabPage();
  const p2 = makeTabPage();
  const ctxPages = [p1, p2];
  const runtime = makeTabRuntime(ctxPages);
  await runtime.ensureBrowser();

  runtime.setNamedPage('docs', p1);
  p1.closeNow();
  ctxPages.splice(ctxPages.indexOf(p1), 1);

  assert.equal(runtime.getNamedPage('docs'), null, 'names pointing at closed pages resolve to null');
  assert.deepEqual(runtime.listPageNames(), [], 'closed pages are pruned from the name listing');
  assert.equal(runtime.listStablePages().some((row) => row.page === p1), false);
});

test('resolveCommandPage resolves handles, names, active page, and fails structurally', async () => {
  const p1 = makeTabPage();
  const p2 = makeTabPage();
  const runtime = makeTabRuntime([p1, p2]);
  await runtime.ensureBrowser();

  const [row1, row2] = runtime.listStablePages();
  assert.equal(await runtime.resolveCommandPage({ tab: row2.handle }), p2, 'resolves by stable handle');
  assert.equal(await runtime.resolveCommandPage({ tab: row2.handle.toUpperCase() }), p2, 'handles are case-insensitive');

  runtime.setNamedPage('docs', p1);
  assert.equal(await runtime.resolveCommandPage({ tab: 'docs' }), p1, 'resolves by name');

  runtime.setActivePage(p2);
  assert.equal(await runtime.resolveCommandPage({}), p2, 'no tab means the active page');
  assert.equal(await runtime.resolveCommandPage({ tab: row1.handle }), p1, 'resolving a tab does not require it to be active');
  assert.equal(runtime.getActivePage(), p2, 'resolveCommandPage never changes the active tab');

  await assert.rejects(
    () => runtime.resolveCommandPage({ tab: 'nope' }),
    (err) => err.code === 'TAB_NOT_FOUND' && /tabs/.test(err.message),
    'unknown tabs fail with a structured code and a tabs suggestion',
  );
});

test('listTabRows returns structured rows with handles, active marker, and names', async () => {
  const p1 = makeTabPage({ url: 'https://docs.test/', title: 'Docs' });
  const p2 = makeTabPage({ url: 'https://app.test/', title: 'App' });
  const runtime = makeTabRuntime([p1, p2]);
  await runtime.ensureBrowser();

  runtime.setNamedPage('docs', p1);
  runtime.setActivePage(p2);

  const rows = await runtime.listTabRows();
  assert.deepEqual(rows, [
    { handle: 't1', index: 0, title: 'Docs', url: 'https://docs.test/', targetId: null, active: false, name: 'docs' },
    { handle: 't2', index: 1, title: 'App', url: 'https://app.test/', targetId: null, active: true, name: null },
  ]);
});

test('resolveTabTarget soft-matching tiers: exact URL beats substring, substring beats title', async () => {
  const exact = makeTabPage({ url: 'https://app.heymantle.com/reports/mrr', title: 'MRR' });
  const other = makeTabPage({ url: 'https://app.heymantle.com/reports/mrr/details', title: 'MRR details' });
  const titled = makeTabPage({ url: 'https://elsewhere.test/', title: 'quarterly reports overview' });
  const runtime = makeTabRuntime([exact, other, titled]);
  await runtime.ensureBrowser();

  const exactHit = await runtime.resolveTabTarget('https://app.heymantle.com/reports/mrr');
  assert.equal(exactHit.page, exact, 'an exact URL match wins even when it is also a substring of another URL');
  assert.equal(exactHit.matchedBy, 'url');

  const substringHit = await runtime.resolveTabTarget('reports/mrr/details');
  assert.equal(substringHit.page, other);
  assert.equal(substringHit.matchedBy, 'url-substring');

  const titleHit = await runtime.resolveTabTarget('quarterly');
  assert.equal(titleHit.page, titled);
  assert.equal(titleHit.matchedBy, 'title-substring');
});

test('resolveTabTarget: ambiguity fails with candidates, stale handles fail immediately', async () => {
  const a = makeTabPage({ url: 'https://one.test/dashboard', title: 'Dashboard' });
  const b = makeTabPage({ url: 'https://two.test/dashboard', title: 'Dashboard' });
  const runtime = makeTabRuntime([a, b]);
  await runtime.ensureBrowser();

  await assert.rejects(
    () => runtime.resolveTabTarget('Dashboard'),
    (err) => err.code === 'TAB_AMBIGUOUS' && /t1/.test(err.message) && /t2/.test(err.message),
    'multiple matches in one tier list candidates instead of silently picking one',
  );

  await assert.rejects(
    () => runtime.resolveTabTarget('t99'),
    (err) => err.code === 'TAB_NOT_FOUND',
    'a t-handle miss must not fall through to URL/title soft matching',
  );
});

test('resolveTabTarget supports 1-based list positions with a stable-handle warning', async () => {
  const a = makeTabPage({ title: 'A' });
  const b = makeTabPage({ title: 'B' });
  const runtime = makeTabRuntime([a, b]);
  await runtime.ensureBrowser();

  const hit = await runtime.resolveTabTarget('2');
  assert.equal(hit.page, b);
  assert.equal(hit.matchedBy, 'index');
  assert.match(hit.warning, /t2/, 'index selection warns with the stable handle to use next time');
});

test('openNewPage creates, navigates, activates — and closes the page on navigation failure', async () => {
  const existing = makeTabPage({ title: 'Existing' });
  const ctxPages = [existing];
  const createdPages = [];
  let failNavigation = false;
  const context = {
    on() {},
    pages: () => ctxPages,
    newPage: async () => {
      let closed = false;
      const page = {
        isClosed: () => closed,
        url: () => 'https://opened.test/',
        title: async () => 'Opened',
        on() {},
        mainFrame() { return 'main-frame'; },
        goto: async (url) => {
          if (failNavigation) throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
        },
        close: async () => { closed = true; },
      };
      ctxPages.push(page);
      createdPages.push(page);
      return page;
    },
  };
  const browser = {
    isConnected: () => true,
    contexts: () => [context],
    on() {},
    close: async () => {},
  };
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser });

  const page = await runtime.openNewPage({ url: 'https://opened.test/' });
  assert.equal(runtime.getActivePage(), page, 'a successful open activates the new page');

  failNavigation = true;
  await assert.rejects(() => runtime.openNewPage({ url: 'https://bad.test/' }), /ERR_NAME_NOT_RESOLVED/);
  assert.equal(createdPages.length, 2);
  assert.equal(createdPages[1].isClosed(), true, 'navigation failure closes the just-created page (no orphan tabs)');
  assert.equal(runtime.getActivePage(), page, 'a failed open leaves the previous active tab in place');
});

test('runCommand resolves function-valued plugin deps lazily at run time', async () => {
  const page = makeTabPage();
  let seenHelpers = null;
  let seenSkillRuntime = null;
  // Simulates the MCP server: runtime constructed BEFORE plugins load, with
  // accessors that read the plugin runtime populated later.
  let loadedPluginRuntime = { helpers: {}, skillRuntime: {} };
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages: [page] }),
    buildExecContext: (_page, _ctx, _state, _caps, pluginHelpers, _prefs, _restrictions, pluginSkillRuntime) => {
      seenHelpers = pluginHelpers;
      seenSkillRuntime = pluginSkillRuntime;
      return {};
    },
    runCode: async () => 'ok',
    pluginHelpers: () => loadedPluginRuntime.helpers,
    pluginSkillRuntime: () => loadedPluginRuntime.skillRuntime,
  });

  // Plugins finish loading AFTER runtime construction (as in mcp/src/index.js).
  const myHelper = () => {};
  loadedPluginRuntime = { helpers: { myHelper }, skillRuntime: { catalog: [{ name: 'demo' }] } };

  await runtime.runCommand({ code: 'noop' });
  assert.equal(seenHelpers.myHelper, myHelper, 'late-loaded plugin helpers are visible to command runs');
  assert.deepEqual(seenSkillRuntime.catalog, [{ name: 'demo' }], 'late-loaded skill runtime is visible too');
});

test('runCommand({ page }) pins the run to that page without touching the active tab', async () => {
  const active = makeTabPage({ title: 'Active' });
  const target = makeTabPage({ title: 'Target' });
  let builtCaps = null;
  let builtDefaultPage = null;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages: [active, target] }),
    buildExecContext: (page, _ctx, _state, caps) => {
      builtDefaultPage = page;
      builtCaps = caps;
      return { page };
    },
    runCode: async (_code, execCtx) => execCtx.page,
  });

  runtime.setActivePage(active);
  const result = await runtime.runCommand({ code: 'noop', page: target });

  assert.equal(result, target, 'the run targets the pinned page');
  assert.equal(builtDefaultPage, target, 'the pinned page is the run default page');
  assert.equal(builtCaps.pinnedPage, target, 'the pin travels to buildExecContext as caps.pinnedPage');
  assert.equal(runtime.getActivePage(), active, 'pinning never mutates the persistent active tab');

  // Unpinned runs keep the existing behavior (and pass no pin).
  const unpinned = await runtime.runCommand({ code: 'noop' });
  assert.equal(unpinned, active);
  assert.equal(builtCaps.pinnedPage, null, 'unpinned runs pass pinnedPage: null');
});

test('runCommand({ page }) fails loudly on a closed pin instead of falling back to the active tab', async () => {
  const active = makeTabPage({ title: 'Active' });
  const stale = makeTabPage({ title: 'Stale' });
  stale.closeNow();
  let ran = false;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages: [active] }),
    buildExecContext: (page) => ({ page }),
    runCode: async () => { ran = true; },
  });
  runtime.setActivePage(active);

  await assert.rejects(
    () => runtime.runCommand({ code: 'noop', page: stale }),
    (err) => err.code === 'TAB_NOT_USABLE' && /closed/.test(err.message),
    'a stale pin is a structured failure, never a silent wrong-tab run',
  );
  assert.equal(ran, false, 'no code runs against the wrong tab');
  assert.equal(runtime.getActivePage(), active);
});

test('runCommand targets a usable state.page, drops closed/throwing handles, and re-pins the fallback', async () => {
  const clock = makeFakeClock();
  const open = makeClosablePage(false);
  const firstCtxPage = makeClosablePage(false);
  const ctxPages = [firstCtxPage];
  let builtWith = null;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages: ctxPages }),
    getContext: () => ({ pages: () => ctxPages }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // Capture which page runCommand resolved and hand it straight back.
    buildExecContext: (page) => { builtWith = page; return { page }; },
    runCode: async (_code, execCtx) => execCtx.page,
  });

  // 1) A usable pinned page is targeted as-is.
  runtime.userState.page = open;
  const r1 = await runtime.runCommand({ code: 'noop' });
  assert.equal(r1, open, 'usable state.page is targeted');
  assert.equal(builtWith, open);
  assert.equal(runtime.userState.page, open, 'usable pin is preserved');

  // 2) A closed pinned page is dropped → falls back to ctx.pages()[0] and re-pins.
  runtime.userState.page = makeClosablePage(true);
  const r2 = await runtime.runCommand({ code: 'noop' });
  assert.equal(r2, firstCtxPage, 'closed state.page falls back to the first context page');
  assert.equal(runtime.userState.page, firstCtxPage, 'fallback re-pins state.page');

  // 3) A handle whose isClosed() THROWS is treated as unusable (no crash) → fallback.
  runtime.userState.page = makeClosablePage('throw');
  const r3 = await runtime.runCommand({ code: 'noop' });
  assert.equal(r3, firstCtxPage, 'throwing isClosed() is treated as unusable, not propagated');
  assert.equal(runtime.userState.page, firstCtxPage);
});

// ─── Relay-sourced identity (targets, titles, freshness) ─────────────────────

function makeRelayFetch(getTargets, { fail = () => false } = {}) {
  return async (url) => {
    if (fail()) throw new Error('relay unreachable');
    const u = String(url);
    if (u.endsWith('/json/list')) return { ok: true, json: async () => getTargets() };
    return { ok: true, json: async () => ({}) };
  };
}

/** A page whose title() never settles — the real relay behaviour on a lazily-attached tab. */
function makeUntitleablePage(url) {
  return { ...makeTabPage({ url }), title: async () => new Promise(() => {}) };
}

function makeRelayRuntime({ pages, targets, fail = () => false, relayUrl = 'http://127.0.0.1:19222', onFetch, cdpSessions = null }) {
  const fetchImpl = makeRelayFetch(() => targets(), { fail });
  return createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages, cdpSessions }),
    getRelayHttpUrl: () => relayUrl,
    fetch: async (url, ...rest) => { onFetch?.(String(url)); return fetchImpl(url, ...rest); },
    initialPageDiscoveryTimeoutMs: 50,
    initialPageDiscoveryPollMs: 5,
  });
}

test('tab titles come from the relay target list, not page.title()', async () => {
  const pages = [makeUntitleablePage('https://a.test/')];
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'Real Title' }],
  });
  const [row] = await runtime.listTabRows();
  assert.equal(row.title, 'Real Title');
});

test('falls back to the bounded page title when no relay target matches', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/', title: 'From Page' })];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getRelayHttpUrl: () => '',
    fetch: async () => { throw new Error('no relay'); },
  });
  const [row] = await runtime.listTabRows();
  assert.equal(row.title, 'From Page');
});

test('rows carry targetId so names and handles can key on it', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'A' }] });
  assert.equal((await runtime.listTabRows())[0].targetId, 'T1');
});

test('a managed backend never reads the real browser target list', async () => {
  // NOT "zero fetches": waitForInitialPageDiscovery probes /extension/status on
  // any backend whose getRelayHttpUrl is truthy, and sessiond wires that
  // unconditionally. Assert on the URLs, not a count.
  const urls = [];
  const pages = [makeTabPage({ url: 'https://a.test/', title: 'Managed' })];
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'Real Chrome' }],
    relayUrl: 'http://relay.test',
    onFetch: (u) => urls.push(u),
  });
  runtime.setBackendInfo({ backend: 'managed', requestedBackend: 'auto' });
  const [row] = await runtime.listTabRows();
  assert.equal(urls.filter((u) => u.endsWith('/json/list')).length, 0,
    'managed backend must not read the real browser target list');
  assert.equal(row.targetId, null, 'no relay identity on a managed backend');
  assert.equal(row.title, 'Managed', 'titles fall back to the bounded page read');
});

test('the discovery probe is also backend-gated', async () => {
  const urls = [];
  const pages = [makeTabPage({ url: 'https://a.test/', title: 'M' })];
  const runtime = makeRelayRuntime({
    pages, targets: () => [], relayUrl: 'http://relay.test', onFetch: (u) => urls.push(u),
  });
  runtime.setBackendInfo({ backend: 'managed', requestedBackend: 'auto' });
  await runtime.listTabRows();
  assert.deepEqual(urls, [], 'a managed session has no relay to ask about anything');
});

test('a stale snapshot never identifies a page it has not seen before', async () => {
  // The hazard: a tab closes, a new tab opens at the same URL, the relay fetch
  // fails, and the cached target list hands the newcomer the dead tab's id.
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  let fail = false;
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'A' }],
    fail: () => fail,
    relayUrl: 'http://relay.test',
  });
  await runtime.listTabRows();
  pages[0] = makeTabPage({ url: 'https://a.test/' }); // replacement tab, same URL
  fail = true;
  const [row] = await runtime.listTabRows();
  assert.notEqual(row.targetId, 'T1', 'a page never seen before must not inherit a cached id');
  assert.notEqual(row.title, 'A', 'nor the dead tab title');
});

test('a transient relay failure keeps identity instead of renumbering', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  let fail = false;
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'A' }],
    fail: () => fail,
  });
  const before = await runtime.listTabRows();
  fail = true;
  const during = await runtime.listTabRows();
  assert.deepEqual(during.map((r) => r.handle), before.map((r) => r.handle));
  assert.equal(during[0].targetId, 'T1', 'a known page keeps its target id when the fetch fails');
});

test('duplicate-URL tabs are resolved exactly through a bounded CDP probe', async () => {
  // The URL matcher fails closed on duplicates; the small unmatched set is then
  // identified precisely rather than left on renumbering handles.
  const pages = [makeTabPage({ url: 'about:blank' }), makeTabPage({ url: 'about:blank' })];
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'D1', url: 'about:blank', title: '' }, { id: 'D2', url: 'about:blank', title: '' }],
  });
  const rows = await runtime.listTabRows();
  assert.deepEqual(rows.map((r) => r.targetId), ['cdp-0', 'cdp-1']);
});

test('exact resolution is skipped when the ambiguous set is large', async () => {
  // Cost guard: a broken match degrades to renumbering rather than opening
  // dozens of alias sessions on the relay.
  const pages = Array.from({ length: 20 }, () => makeTabPage({ url: 'about:blank' }));
  const cdpSessions = [];
  const runtime = makeRelayRuntime({
    pages,
    cdpSessions,
    targets: () => pages.map((_, i) => ({ id: `D${i}`, url: 'about:blank', title: '' })),
  });
  const rows = await runtime.listTabRows();
  assert.equal(rows.filter((r) => r.targetId).length, 0);
  assert.equal(cdpSessions.length, 0, 'no alias sessions opened');
});

test('exact resolution never runs on a managed backend', async () => {
  const pages = [makeTabPage({ url: 'about:blank' }), makeTabPage({ url: 'about:blank' })];
  const cdpSessions = [];
  const runtime = makeRelayRuntime({ pages, cdpSessions, targets: () => [] });
  runtime.setBackendInfo({ backend: 'managed', requestedBackend: 'auto' });
  const rows = await runtime.listTabRows();
  assert.equal(rows.filter((r) => r.targetId).length, 0);
  assert.equal(cdpSessions.length, 0);
});

// ─── Handles keyed by relay target id ────────────────────────────────────────

test('a handle names the same tab after an idle reconnect replaces every Page object', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }, { id: 'T2', url: 'https://b.test/', title: 'B' }];
  const pages = targets.map((t) => makeTabPage({ url: t.url }));
  let browser;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => { browser = makeFakeBrowser({ pages }); return browser; },
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: makeRelayFetch(() => targets),
    initialPageDiscoveryTimeoutMs: 50,
    initialPageDiscoveryPollMs: 5,
  });

  const before = await runtime.listTabRows();
  browser.fireDisconnected();
  // Reconnect: brand-new Page objects for the same tabs. The old ones stay
  // open() — orphaned, not closed — exactly as Playwright leaves them.
  pages.splice(0, pages.length, ...targets.map((t) => makeTabPage({ url: t.url })));
  const after = await runtime.listTabRows();

  assert.deepEqual(after.map((r) => r.handle), before.map((r) => r.handle));
  assert.equal(after[0].handle, 't1');
});

test('a fallback handle is promoted, not replaced, when the relay recovers', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  let fail = true;
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'A' }],
    fail: () => fail,
    relayUrl: 'http://relay.test',
  });
  const first = (await runtime.listTabRows())[0].handle; // fallback handle
  fail = false;
  const second = (await runtime.listTabRows())[0];
  assert.equal(second.handle, first, 'the handle already handed out must not change');
  assert.equal(second.targetId, 'T1');
});

test('handles still work per-connection when no relay target is available', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/', title: 'A' })];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getRelayHttpUrl: () => '',
    fetch: async () => { throw new Error('no relay'); },
  });
  assert.equal((await runtime.listTabRows())[0].handle, 't1');
  assert.equal((await runtime.listTabRows())[0].handle, 't1');
});

test('a reopened tab reusing a Chrome tab id does not inherit the old handle', async () => {
  // The relay synthesizes bf-target-<tabId> and Chrome reuses tab ids, so
  // without eviction the new tab silently answers to the closed tab's handle.
  // A second tab stays open throughout so the browser is never empty.
  const keep = { id: 'T9', url: 'https://keep.test/', title: 'Keep' };
  let targets = [{ id: 'bf-target-7', url: 'https://a.test/', title: 'A' }, keep];
  const pages = [makeTabPage({ url: 'https://a.test/' }), makeTabPage({ url: 'https://keep.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => targets, relayUrl: 'http://relay.test' });
  const before = (await runtime.listTabRows())[0].handle;
  targets = [keep]; pages.shift(); // tab closed, relay says so
  await runtime.listTabRows();
  targets = [{ id: 'bf-target-7', url: 'https://b.test/', title: 'B' }, keep]; // id reused
  pages.unshift(makeTabPage({ url: 'https://b.test/' }));
  assert.notEqual((await runtime.listTabRows())[0].handle, before,
    'a different tab must not answer to the closed tab handle');
});

test('reset drops the cached relay snapshot, so a later failure cannot reuse it', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/', title: 'live' })];
  let fail = false;
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'A' }],
    fail: () => fail,
    relayUrl: 'http://relay.test',
  });
  await runtime.listTabRows();
  await runtime.reset();
  fail = true;
  const [row] = await runtime.listTabRows();
  // Identity may only come from a live source. 'T1' would mean the pre-reset
  // relay snapshot survived; the exact CDP probe is ground truth and may.
  assert.notEqual(row.targetId, 'T1', 'a reset session must not resurrect the pre-reset target list');
  assert.equal(row.handle, 't1', 'numbering restarts');
});

// ─── Names keyed by relay target id ──────────────────────────────────────────

function makeReconnectableRelayRuntime({ targets, pages }) {
  let browser;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => { browser = makeFakeBrowser({ pages }); return browser; },
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: makeRelayFetch(() => targets()),
    initialPageDiscoveryTimeoutMs: 50,
    initialPageDiscoveryPollMs: 5,
  });
  return {
    runtime,
    fireDisconnect() {
      browser.fireDisconnected();
      const replacements = pages.map((old) => makeTabPage({ url: old.url(), title: old.meta.title }));
      pages.splice(0, pages.length, ...replacements);
    },
  };
}

test('a tab name still resolves after an idle reconnect', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  const { runtime, fireDisconnect } = makeReconnectableRelayRuntime({ targets: () => targets, pages });

  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });
  fireDisconnect();

  const rows = await runtime.listTabRows();
  assert.equal(rows[0].name, 'docs');
  assert.equal(runtime.getNamedPage('docs'), pages[0], 'the name must re-bind to the live page');
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs']);
});

test('a name is dropped only when an authoritative listing no longer has its target', async () => {
  // A second, unrelated tab stays open: an empty browser is a different case
  // (NO_TABS), and this test is about the named tab specifically closing.
  let targets = [
    { id: 'T1', url: 'https://a.test/', title: 'A' },
    { id: 'T9', url: 'https://keep.test/', title: 'Keep' },
  ];
  const pages = [makeTabPage({ url: 'https://a.test/' }), makeTabPage({ url: 'https://keep.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => targets });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });

  targets = [targets[1]]; pages.shift(); // the named tab really closed
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), []);
});

test('a name survives when its tab is present but unmatched', async () => {
  // Two tabs share a URL, so the matcher fails closed — but both are in
  // /json/list, so neither name is gone.
  let targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => targets, relayUrl: '' });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId ?? 'T1' });

  targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }, { id: 'T2', url: 'https://a.test/', title: 'A2' }];
  pages.push(makeTabPage({ url: 'https://a.test/' }));
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs'],
    'unmatched is not the same as gone');
});

test('a failed relay fetch never deletes a name', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  let fail = false;
  const runtime = makeRelayRuntime({
    pages,
    targets: () => [{ id: 'T1', url: 'https://a.test/', title: 'A' }],
    fail: () => fail,
  });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });
  fail = true;
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs'],
    'an unreachable relay is not evidence that a tab closed');
});

test('setNamedPage still honours { replace } and rejects a conflict without it', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' }), makeTabPage({ url: 'https://b.test/' })];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getRelayHttpUrl: () => '',
    fetch: async () => { throw new Error('no relay'); },
  });
  runtime.setNamedPage('docs', pages[0]);
  assert.throws(() => runtime.setNamedPage('docs', pages[1]), /docs/);
  assert.deepEqual(runtime.setNamedPage('docs', pages[1], { replace: true }), { name: 'docs', replaced: true });
});

test('a name whose target is unresolved fails closed instead of soft-matching another tab', async () => {
  // getNamedPage must never fall through to a different page: acting on the
  // wrong tab is worse than reporting the name as momentarily unresolvable.
  // Reconnect orphans the stored Page (isClosed() is still false), and the
  // relay is unreachable so identity cannot rebind.
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  let fail = false;
  let browser;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => { browser = makeFakeBrowser({ pages }); return browser; },
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: makeRelayFetch(() => targets, { fail: () => fail }),
    initialPageDiscoveryTimeoutMs: 50,
    initialPageDiscoveryPollMs: 5,
  });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });
  const orphan = pages[0];

  browser.fireDisconnected();
  fail = true;
  pages.splice(0, pages.length, makeTabPage({ url: 'https://elsewhere.test/' }));

  assert.equal(orphan.isClosed(), false, 'fixture must model the real hazard');
  assert.equal(runtime.getNamedPage('docs'), null, 'must not return the orphaned page');
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs'],
    'an unreachable relay is not evidence the tab closed — keep the name');
});

// ─── Per-client active tab ───────────────────────────────────────────────────

test('two identified clients keep separate active tabs in one shared session', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' }), makeTabPage({ url: 'https://b.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [] });
  await runtime.ensureBrowser();
  runtime.setActivePage(pages[0], { clientId: 'agent-1' });
  runtime.setActivePage(pages[1], { clientId: 'agent-2' });
  assert.equal(runtime.getActivePage({ clientId: 'agent-1' }), pages[0],
    'agent-1 must not see agent-2 switch tabs underneath it');
  assert.equal(runtime.getActivePage({ clientId: 'agent-2' }), pages[1]);
});

test('unidentified clients still share one active tab', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' }), makeTabPage({ url: 'https://b.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [] });
  await runtime.ensureBrowser();
  runtime.setActivePage(pages[0]);
  runtime.setActivePage(pages[1]);
  assert.equal(runtime.getActivePage(), pages[1], 'sequential CLI behaviour is unchanged');
});

test('a client falls back to the shared tab before it picks one', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [] });
  await runtime.ensureBrowser();
  runtime.setActivePage(pages[0]);
  assert.equal(runtime.getActivePage({ clientId: 'fresh-agent' }), pages[0],
    'a subagent inherits the parent tab until it chooses its own — that is the point of sharing');
});

test('a client slot rebinds across a reconnect instead of falling back', async () => {
  // The regression that matters: a Page-keyed slot dies on reconnect and the
  // client silently lands on the SHARED page — another agent's tab.
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }, { id: 'T2', url: 'https://b.test/', title: 'B' }];
  const pages = targets.map((t) => makeTabPage({ url: t.url }));
  const { runtime, fireDisconnect } = makeReconnectableRelayRuntime({ targets: () => targets, pages });
  const rows = await runtime.listTabRows();
  runtime.setActivePage(pages[1], { clientId: 'agent-2', targetId: rows[1].targetId });
  runtime.setActivePage(pages[0]); // shared slot = tab A
  fireDisconnect();
  await runtime.listTabRows();
  const own = runtime.getActivePage({ clientId: 'agent-2' });
  assert.equal(own?.url(), 'https://b.test/', 'agent-2 must still be on its own tab');
  assert.notEqual(own, runtime.getActivePage(), 'and must not have fallen back to the shared tab');
});

test('an orphaned Page from the previous connection is never returned', async () => {
  // Playwright Pages from a dead connection are NOT closed, so isClosed() is
  // false and a usability-first check hands back a dead handle.
  const targets = [{ id: 'T1', url: 'https://one.test/', title: '1' }, { id: 'T2', url: 'https://two.test/', title: '2' }];
  const pages = targets.map((t) => makeTabPage({ url: t.url }));
  const { runtime, fireDisconnect } = makeReconnectableRelayRuntime({ targets: () => targets, pages });
  const rows = await runtime.listTabRows();
  const stale = pages[1];
  runtime.setActivePage(stale, { clientId: 'agent-2', targetId: rows[1].targetId });
  fireDisconnect();
  assert.equal(stale.isClosed(), false, 'fixture must model the real hazard');
  await runtime.listTabRows();
  const got = runtime.getActivePage({ clientId: 'agent-2' });
  assert.notEqual(got, stale, 'must not return the orphaned Page');
  assert.equal(got.url(), 'https://two.test/', 'must rebind to the live page for that target');
});

test('a blocked slot stays blocked instead of silently sharing', async () => {
  // Two consecutive failures. If the slot is deleted on the first, the second
  // finds none and falls back to the shared tab — the stomp, one call later.
  let targets = [{ id: 'T1', url: 'https://one.test/', title: '1' }, { id: 'T2', url: 'https://two.test/', title: '2' }];
  const pages = targets.map((t) => makeTabPage({ url: t.url }));
  const { runtime, fireDisconnect } = makeReconnectableRelayRuntime({ targets: () => targets, pages });
  const rows = await runtime.listTabRows();
  runtime.setActivePage(pages[1], { clientId: 'b', targetId: rows[1].targetId });
  runtime.setActivePage(pages[0]); // shared slot = tab one
  fireDisconnect();
  targets = [targets[0]];
  pages.length = 1; // b's tab is gone entirely
  await runtime.listTabRows();
  assert.equal(runtime.getActivePage({ clientId: 'b' }), null);
  assert.equal(runtime.getActivePage({ clientId: 'b' }), null,
    'the second call must not fall back to the shared tab');
});

test('a closed page clears only its own client slot', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' }), makeTabPage({ url: 'https://b.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [] });
  await runtime.ensureBrowser();
  runtime.setActivePage(pages[0], { clientId: 'agent-1' });
  runtime.setActivePage(pages[1], { clientId: 'agent-2' });
  pages[0].closeNow();
  assert.equal(runtime.getActivePage({ clientId: 'agent-1' }), null);
  assert.equal(runtime.getActivePage({ clientId: 'agent-2' }), pages[1]);
});

test('state.page is client-scoped for reads and writes', async () => {
  const pages = [makeTabPage({ url: 'https://one.test/' }), makeTabPage({ url: 'https://two.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [] });
  const rows = await runtime.listTabRows();
  runtime.setActivePage(pages[0], { clientId: 'a', targetId: rows[0].targetId });
  runtime.setActivePage(pages[1], { clientId: 'b', targetId: rows[1].targetId });
  const stateA = runtime.stateViewFor('a');
  const stateB = runtime.stateViewFor('b');
  assert.equal(stateA.page.url(), 'https://one.test/');
  assert.equal(stateB.page.url(), 'https://two.test/');

  // B assigns a page A does NOT hold. Assigning A's own page would pass even
  // against a shared implementation, leaving the stomp untested.
  const third = makeTabPage({ url: 'https://three.test/' });
  pages.push(third);
  await runtime.listTabRows();
  stateB.page = third;
  assert.equal(stateB.page.url(), 'https://three.test/');
  assert.equal(stateA.page.url(), 'https://one.test/', 'b assigning state.page must not move a');

  // Every other key stays shared — the session is one session.
  stateA.scratch = 42;
  assert.equal(stateB.scratch, 42);
});

test('a slot stored before its page was identified adopts the id on the next listing', async () => {
  // A `state.page = ...` inside eval names a page listIdentifiedPages has not
  // seen, so the slot stores null and could never rebind after a reconnect.
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  const { runtime, fireDisconnect } = makeReconnectableRelayRuntime({ targets: () => targets, pages });
  runtime.setActivePage(pages[0], { clientId: 'late' }); // never listed: no targetId
  await runtime.listTabRows();                           // adoption happens here
  fireDisconnect();
  await runtime.listTabRows();
  assert.equal(runtime.getActivePage({ clientId: 'late' })?.url(), 'https://a.test/',
    'the adopted id is what lets the slot survive the reconnect');
});

test('reset clears every client slot', async () => {
  const pages = [makeTabPage({ url: 'https://a.test/' })];
  const runtime = makeRelayRuntime({ pages, targets: () => [] });
  await runtime.ensureBrowser();
  runtime.setActivePage(pages[0], { clientId: 'a' });
  await runtime.reset();
  assert.equal(runtime.getActivePage({ clientId: 'a' }), null);
});
