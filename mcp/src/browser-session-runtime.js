// browser-session-runtime.js — shared browser/session runtime for the MCP server
// and the CLI session daemon. Owns the persistent browser connection, userState,
// idle-disconnect lifecycle, console capture, and cached agent
// preferences/restrictions so both protocol surfaces share identical behavior.
//
// The runtime is transport-agnostic: callers inject `connectBrowser` (how to
// produce a connected Playwright browser) and relay HTTP access. MCP injects a
// relay+CDP connect; the CLI sessiond injects real-or-managed backend connects.

const MAX_LOGS_PER_PAGE = 5000;
const DEFAULT_INITIAL_PAGE_DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_INITIAL_PAGE_DISCOVERY_POLL_MS = 100;

const DEFAULT_AGENT_PREFERENCES = Object.freeze({
  executionMode: 'parallel',
  parallelVisibilityMode: 'foreground-tab',
});
const DEFAULT_BROWSERFORCE_RESTRICTIONS = Object.freeze({
  mode: 'auto',
  lockUrl: false,
  noNewTabs: false,
  readOnly: false,
  instructions: '',
});

function normalizeAgentPreferences(raw) {
  const executionMode = raw?.executionMode === 'sequential' ? 'sequential' : 'parallel';
  // Keep behavior locked to visible tabs in the current window.
  const parallelVisibilityMode = 'foreground-tab';
  return { executionMode, parallelVisibilityMode };
}

function normalizeRestrictions(raw) {
  return {
    mode: raw?.mode === 'manual' ? 'manual' : 'auto',
    lockUrl: !!raw?.lockUrl,
    noNewTabs: !!raw?.noNewTabs,
    readOnly: !!raw?.readOnly,
    instructions: typeof raw?.instructions === 'string' ? raw.instructions : '',
  };
}

// Canonical "is this page handle still usable" predicate — IDENTICAL to
// exec-engine.js isUsablePage(). Kept as a local copy on purpose: this runtime is
// import-free by design (see header) and exec-engine.js pulls a heavy module
// graph, so importing the helper would couple the transport-agnostic runtime to
// it. Keep the two predicates in sync.
function isUsablePage(page) {
  try {
    return !!page && typeof page.isClosed === 'function' && !page.isClosed();
  } catch {
    return false;
  }
}

export function createBrowserSessionRuntime(deps = {}) {
  const {
    connectBrowser = null,
    getRelayHttpUrl = () => '',
    fetch: fetchImpl,
    idleDisconnectMs = 0,
    onConnected = () => {},
    setTimeout: setTimeoutImpl = globalThis.setTimeout,
    clearTimeout: clearTimeoutImpl = globalThis.clearTimeout,
    initialPageDiscoveryTimeoutMs = DEFAULT_INITIAL_PAGE_DISCOVERY_TIMEOUT_MS,
    initialPageDiscoveryPollMs = DEFAULT_INITIAL_PAGE_DISCOVERY_POLL_MS,
    // Execution boundary deps (injected so the runtime stays decoupled from
    // exec-engine and unit-testable). runCommand is the single place CLI atomic
    // verbs run user snippets — always through runCode()'s guarded boundary.
    buildExecContext = null,
    runCode = null,
    pluginHelpers = {},
    pluginSkillRuntime = {},
  } = deps;

  const doFetch = fetchImpl || globalThis.fetch;

  // The connect source is swappable so the CLI sessiond can wire a negotiated
  // backend (real relay+CDP vs managed launch) after construction.
  let connectBrowserFn = connectBrowser;

  let userState = {};
  let browser = null;
  let browserConnectPromise = null;
  let idleBrowserDisconnectTimer = null;
  let activeBrowserOperations = 0;

  // Negotiated backend metadata (set by the CLI sessiond after backend
  // selection). Kept in the shared runtime so any protocol surface can report a
  // consistent { backend, requestedBackend, fallbackReason, warning }.
  let backendInfo = { backend: null, requestedBackend: null, fallbackReason: null, warning: null };

  // ─── Console Log Capture ───────────────────────────────────────────────────
  const consoleLogs = new Map();
  const pagesWithListeners = new WeakSet();
  let contextListenerAttached = false;

  // ─── Cached Preferences / Restrictions ─────────────────────────────────────
  let cachedAgentPreferences = null;
  let cachedBrowserforceRestrictions = null;

  // ─── Tab identity state ──────────────────────────────────────────────────────
  // Named tabs (user-assigned labels) live beside — never inside — the active
  // tab so naming/forgetting a tab can never move the session focus. Stable
  // handles (t1, t2, ...) are keyed by page identity in a WeakMap: they are
  // assigned once per page in first-listed order and NEVER renumber when other
  // tabs close or when the page's URL/title changes.
  const namedPages = new Map(); // name → page
  let stableHandles = new WeakMap(); // page → 't<N>'
  let nextStableHandleNumber = 1;

  // Structured tab-state failure. The runtime stays import-free (see header),
  // so it throws plain Errors with a stable `code`; the command registry maps
  // codes to agent-facing BrowserforceCommandError suggestions.
  function tabStateError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function getContext() {
    if (!browser?.isConnected()) throw new Error('Not connected to relay. Is the relay running?');
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error('No browser context available');
    return contexts[0];
  }

  function getPages() {
    return getContext().pages();
  }

  function setupConsoleCapture(page) {
    if (pagesWithListeners.has(page)) return;
    pagesWithListeners.add(page);

    consoleLogs.set(page, []);

    page.on('console', (msg) => {
      try {
        const entry = `[${msg.type()}] ${msg.text()}`;
        let logs = consoleLogs.get(page);
        if (!logs) {
          logs = [];
          consoleLogs.set(page, logs);
        }
        logs.push(entry);
        if (logs.length > MAX_LOGS_PER_PAGE) {
          logs.shift();
        }
      } catch { /* msg.text() can throw if page navigated */ }
    });

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        consoleLogs.set(page, []);
      }
    });

    page.on('close', () => {
      consoleLogs.delete(page);
    });
  }

  function ensureAllPagesCapture() {
    try {
      for (const page of getPages()) {
        setupConsoleCapture(page);
      }
    } catch { /* not connected yet */ }
  }

  function clearIdleBrowserDisconnectTimer() {
    if (!idleBrowserDisconnectTimer) return;
    clearTimeoutImpl(idleBrowserDisconnectTimer);
    idleBrowserDisconnectTimer = null;
  }

  async function disconnectIdleBrowser() {
    if (!browser?.isConnected() || activeBrowserOperations > 0) return;
    try {
      await browser.close();
    } catch {
      // The connection may already be gone.
    }
  }

  function scheduleIdleBrowserDisconnect() {
    clearIdleBrowserDisconnectTimer();
    if (idleDisconnectMs <= 0) return;
    if (!browser?.isConnected() || activeBrowserOperations > 0) return;

    idleBrowserDisconnectTimer = setTimeoutImpl(() => {
      idleBrowserDisconnectTimer = null;
      disconnectIdleBrowser().catch(() => {});
    }, idleDisconnectMs);

    if (typeof idleBrowserDisconnectTimer?.unref === 'function') {
      idleBrowserDisconnectTimer.unref();
    }
  }

  function beginOperation() {
    activeBrowserOperations += 1;
    clearIdleBrowserDisconnectTimer();
  }

  function endOperation() {
    activeBrowserOperations = Math.max(0, activeBrowserOperations - 1);
    scheduleIdleBrowserDisconnect();
  }

  async function waitForInitialPageDiscovery(ctx, { timeoutMs = initialPageDiscoveryTimeoutMs } = {}) {
    const started = Date.now();
    while (ctx.pages().length === 0 && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeoutImpl(resolve, initialPageDiscoveryPollMs));
    }
  }

  async function ensureBrowser() {
    clearIdleBrowserDisconnectTimer();
    if (browser?.isConnected()) return;
    if (browserConnectPromise) {
      await browserConnectPromise;
      return;
    }

    browserConnectPromise = (async () => {
      if (typeof connectBrowserFn !== 'function') {
        throw new Error('browser session runtime: a connectBrowser dependency is required to connect');
      }
      const nextBrowser = await connectBrowserFn();
      browser = nextBrowser;
      browser.on('disconnected', () => {
        clearIdleBrowserDisconnectTimer();
        browser = null;
        contextListenerAttached = false;
        consoleLogs.clear();
      });
      onConnected();

      try {
        const ctx = browser.contexts()[0];
        if (ctx && !contextListenerAttached) {
          ctx.on('page', (page) => setupConsoleCapture(page));
          contextListenerAttached = true;
          await waitForInitialPageDiscovery(ctx);
          for (const page of ctx.pages()) {
            setupConsoleCapture(page);
          }
        }
      } catch { /* context not ready yet — capture will attach lazily */ }
    })();

    try {
      await browserConnectPromise;
    } finally {
      browserConnectPromise = null;
    }
  }

  async function getAgentPreferencesForSession() {
    if (cachedAgentPreferences) {
      return cachedAgentPreferences;
    }

    try {
      const response = await doFetch(`${getRelayHttpUrl()}/agent-preferences`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const raw = await response.json();
      cachedAgentPreferences = normalizeAgentPreferences(raw);
      return cachedAgentPreferences;
    } catch {
      cachedAgentPreferences = { ...DEFAULT_AGENT_PREFERENCES };
      return cachedAgentPreferences;
    }
  }

  async function getBrowserforceRestrictionsForSession({ forceRefresh = false } = {}) {
    if (cachedBrowserforceRestrictions && !forceRefresh) {
      return cachedBrowserforceRestrictions;
    }

    try {
      const response = await doFetch(`${getRelayHttpUrl()}/restrictions`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const raw = await response.json();
      cachedBrowserforceRestrictions = normalizeRestrictions(raw);
      return cachedBrowserforceRestrictions;
    } catch {
      cachedBrowserforceRestrictions = { ...DEFAULT_BROWSERFORCE_RESTRICTIONS };
      return cachedBrowserforceRestrictions;
    }
  }

  // Resolve the page atomic verbs operate on. The shared runtime OWNS the
  // persistent active page as `userState.page` (=== `state.page` in snippets):
  // once a verb (or an `eval` doing `state.page = ...`) establishes it, every
  // later verb targets the SAME tab — including the canned snippets that
  // reference the raw top-level `page` (get url/title, press, wait). Without this
  // those snippets fell back to `getPages()[0]`, which in real Chrome is an
  // arbitrary one of dozens of open tabs (the documented `snapshot → click`
  // flow then acted on the wrong tab). A closed/stale handle is dropped and
  // re-seeded from the first context page so it never sticks. Pinning keeps
  // `buildExecContext`'s `activePage()` (userState.page first) and the raw
  // top-level `page` in agreement.
  function resolveActivePage(ctx) {
    const current = userState.page;
    if (isUsablePage(current)) return current;
    if (current) userState.page = null;
    const first = ctx.pages()[0] || null;
    if (first) userState.page = first;
    return first;
  }

  // ─── Tab identity APIs ───────────────────────────────────────────────────────

  /** Pin `page` as the persistent active tab (state.page). */
  function setActivePage(page) {
    if (!isUsablePage(page)) {
      throw tabStateError('TAB_NOT_USABLE', 'Cannot activate a closed page.');
    }
    userState.page = page;
    return page;
  }

  /** Current active tab, or null. Closed handles are dropped, never returned. */
  function getActivePage() {
    const current = userState.page;
    if (isUsablePage(current)) return current;
    if (current) userState.page = null;
    return null;
  }

  /** Stable `t<N>` handle for a page — assigned once, permanent for the page. */
  function getStablePageHandle(page) {
    if (!page) return null;
    let handle = stableHandles.get(page);
    if (!handle) {
      handle = `t${nextStableHandleNumber}`;
      nextStableHandleNumber += 1;
      stableHandles.set(page, handle);
    }
    return handle;
  }

  /** All open pages with their stable handles, in current context order. */
  function listStablePages() {
    return getPages()
      .filter((page) => isUsablePage(page))
      .map((page) => ({ handle: getStablePageHandle(page), page }));
  }

  function pruneNamedPages() {
    for (const [name, page] of namedPages) {
      if (!isUsablePage(page)) namedPages.delete(name);
    }
  }

  /**
   * Assign a user-facing name to a page. Names are unique: reassigning an
   * in-use name requires `replace: true` (which moves the name and leaves the
   * previously named page open and unnamed).
   */
  function setNamedPage(name, page, { replace = false } = {}) {
    const key = String(name ?? '').trim();
    if (!key) throw tabStateError('BAD_TAB_NAME', 'Tab name must be a non-empty string.');
    if (!isUsablePage(page)) throw tabStateError('TAB_NOT_USABLE', 'Cannot name a closed page.');
    pruneNamedPages();
    const existing = namedPages.get(key);
    if (existing && existing !== page && !replace) {
      throw tabStateError('TAB_NAME_IN_USE', `Tab name "${key}" is already in use.`);
    }
    namedPages.set(key, page);
    return { name: key, replaced: !!existing && existing !== page };
  }

  /** Page for a name, or null. Names pointing at closed pages are pruned. */
  function getNamedPage(name) {
    const key = String(name ?? '').trim();
    const page = namedPages.get(key);
    if (!page) return null;
    if (!isUsablePage(page)) {
      namedPages.delete(key);
      return null;
    }
    return page;
  }

  /** Move a name to a new label. Colliding with an existing name requires replace. */
  function renamePageName(oldName, newName, { replace = false } = {}) {
    const from = String(oldName ?? '').trim();
    const to = String(newName ?? '').trim();
    if (!to) throw tabStateError('BAD_TAB_NAME', 'New tab name must be a non-empty string.');
    const page = getNamedPage(from);
    if (!page) throw tabStateError('TAB_NAME_NOT_FOUND', `No tab named "${from}".`);
    if (from === to) return { name: to, replaced: false };
    const existing = getNamedPage(to);
    if (existing && !replace) {
      throw tabStateError('TAB_NAME_IN_USE', `Tab name "${to}" is already in use.`);
    }
    namedPages.delete(from);
    namedPages.set(to, page);
    return { name: to, replaced: !!existing };
  }

  /** Remove a name mapping. Returns whether the name existed. */
  function forgetPageName(name) {
    return namedPages.delete(String(name ?? '').trim());
  }

  /** All live name → page mappings (closed pages pruned). */
  function listPageNames() {
    pruneNamedPages();
    return [...namedPages.entries()].map(([name, page]) => ({ name, page }));
  }

  function nameForPage(page) {
    for (const [name, candidate] of namedPages) {
      if (candidate === page) return name;
    }
    return null;
  }

  /**
   * Structured rows for every open tab — the single builder behind `tabs` on
   * ALL surfaces (sessiond JSON, CLI --json, MCP text rendering), so stable
   * handles can never exist in one output and not another.
   */
  async function listTabRows() {
    await ensureBrowser();
    beginOperation();
    try {
      // Use resolveActivePage (not getActivePage) so the row marked active is
      // the tab a subsequent unnamed command would actually target.
      const active = resolveActivePage(getContext());
      const rows = [];
      const stable = listStablePages();
      for (let index = 0; index < stable.length; index += 1) {
        const { handle, page } = stable[index];
        let title = '';
        let url = '';
        try { title = await page.title(); } catch { /* page navigating/closed */ }
        try { url = page.url(); } catch { /* page closed mid-listing */ }
        rows.push({
          handle,
          index,
          title,
          url,
          active: page === active,
          name: nameForPage(page),
        });
      }
      return rows;
    } finally {
      endOperation();
    }
  }

  /**
   * Soft-match a tab query WITHOUT changing the active tab. Matching tiers:
   * 1. exact stable handle (`t3`, case-insensitive) — a miss fails immediately
   *    (a stale handle must never silently soft-match URL/title text),
   * 2. exact name,
   * 3. bare integer = 1-based list position (supported, but warns to use the
   *    stable handle next time),
   * 4. exact URL,
   * 5. URL substring,
   * 6. title substring.
   * A tier with multiple hits throws TAB_AMBIGUOUS listing candidates — never
   * silently picks one. Returns `{ page, matchedBy, warning }`.
   */
  async function resolveTabTarget(query) {
    const q = String(query ?? '').trim();
    if (!q) {
      throw tabStateError('TAB_NOT_FOUND', 'Empty tab target. Run tabs to list open tabs.');
    }
    await ensureBrowser();
    beginOperation();
    try {
      const stable = listStablePages();

      if (/^t\d+$/i.test(q)) {
        const wanted = q.toLowerCase();
        const hit = stable.find((row) => row.handle === wanted);
        if (hit) return { page: hit.page, matchedBy: 'handle', warning: null };
        throw tabStateError('TAB_NOT_FOUND', `No tab with handle "${wanted}". Run tabs to list open tabs.`);
      }

      const named = getNamedPage(q);
      if (named) return { page: named, matchedBy: 'name', warning: null };

      if (/^\d+$/.test(q)) {
        const row = stable[Number(q) - 1];
        if (!row) {
          throw tabStateError('TAB_NOT_FOUND', `No tab at position ${q}. Run tabs to list open tabs.`);
        }
        return {
          page: row.page,
          matchedBy: 'index',
          warning: `Selected tab by list position ${q}. Positions shift when tabs close — use the stable handle ${row.handle} next time.`,
        };
      }

      const metas = [];
      for (const row of stable) {
        let url = '';
        let title = '';
        try { url = row.page.url() || ''; } catch { /* closed mid-match */ }
        try { title = (await row.page.title()) || ''; } catch { /* closed mid-match */ }
        metas.push({ ...row, url, title });
      }
      const lower = q.toLowerCase();
      const tiers = [
        ['url', metas.filter((m) => m.url === q)],
        ['url-substring', metas.filter((m) => m.url.toLowerCase().includes(lower))],
        ['title-substring', metas.filter((m) => m.title.toLowerCase().includes(lower))],
      ];
      for (const [matchedBy, hits] of tiers) {
        if (hits.length === 1) return { page: hits[0].page, matchedBy, warning: null };
        if (hits.length > 1) {
          const candidates = hits.map((m) => `${m.handle} "${m.title}" ${m.url}`).join('; ');
          throw tabStateError(
            'TAB_AMBIGUOUS',
            `"${q}" matches ${hits.length} tabs: ${candidates}. Use a stable handle or a more specific query.`,
          );
        }
      }
      throw tabStateError('TAB_NOT_FOUND', `No tab matched "${q}". Run tabs to list open tabs.`);
    } finally {
      endOperation();
    }
  }

  /**
   * Resolve the page a command should act on WITHOUT changing the active tab.
   * No `tab` → the persistent active page. With `tab` → the full soft-matching
   * tiers of resolveTabTarget(). Throws TAB_NOT_FOUND / TAB_AMBIGUOUS.
   */
  async function resolveCommandPage({ tab } = {}) {
    if (tab == null || String(tab).trim() === '') {
      return resolveActivePage(getContext());
    }
    const target = await resolveTabTarget(tab);
    return target.page;
  }

  /**
   * Open a new page (optionally navigating it) and make it the active tab.
   * Restriction gating (noNewTabs/manual) is the caller's responsibility —
   * this runtime stays import-free and mechanical. On navigation failure the
   * page is closed (never leaks a blank orphan tab) and the error propagates.
   */
  async function openNewPage({ url = '', timeout = 30000 } = {}) {
    await ensureBrowser();
    beginOperation();
    try {
      const ctx = getContext();
      const page = await ctx.newPage();
      setupConsoleCapture(page);
      if (url) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        } catch (err) {
          try { await page.close(); } catch { /* already closed */ }
          throw err;
        }
      }
      setActivePage(page);
      return page;
    } finally {
      endOperation();
    }
  }

  /**
   * Run a user snippet against the live session through the guarded runCode()
   * boundary. Ensures the browser is connected, resolves the persistent active
   * page (state.page) so every verb targets the same tab, and counts the work as
   * an active operation so the idle disconnect timer never fires mid-command.
   * Returns runCode()'s raw result.
   */
  async function runCommand({ code, timeout = 30000 } = {}) {
    if (typeof buildExecContext !== 'function' || typeof runCode !== 'function') {
      throw new Error('browser session runtime: buildExecContext and runCode deps are required for runCommand');
    }
    await ensureBrowser();
    beginOperation();
    try {
      const ctx = getContext();
      const page = resolveActivePage(ctx);
      const execCtx = buildExecContext(
        page,
        ctx,
        userState,
        { consoleLogs, setupConsoleCapture },
        pluginHelpers,
        await getAgentPreferencesForSession(),
        await getBrowserforceRestrictionsForSession(),
        pluginSkillRuntime,
      );
      return await runCode(code, execCtx, timeout);
    } finally {
      endOperation();
    }
  }

  async function reset() {
    clearIdleBrowserDisconnectTimer();
    if (browser) {
      try { await browser.close(); } catch { /* connection may already be dead */ }
    }
    browser = null;
    browserConnectPromise = null;
    userState = {};
    cachedAgentPreferences = null;
    cachedBrowserforceRestrictions = null;
    contextListenerAttached = false;
    consoleLogs.clear();
    namedPages.clear();
    stableHandles = new WeakMap();
    nextStableHandleNumber = 1;
  }

  return {
    get userState() { return userState; },
    get browser() { return browser; },
    get consoleLogs() { return consoleLogs; },
    get activeBrowserOperations() { return activeBrowserOperations; },
    isConnected() { return !!browser?.isConnected?.(); },
    hasPendingIdleDisconnect() { return idleBrowserDisconnectTimer !== null; },
    setConnectBrowser(fn) { connectBrowserFn = fn; },
    setBackendInfo(info = {}) {
      backendInfo = {
        backend: info.backend ?? null,
        requestedBackend: info.requestedBackend ?? null,
        fallbackReason: info.fallbackReason ?? null,
        warning: info.warning ?? null,
      };
      return backendInfo;
    },
    getBackendInfo() { return { ...backendInfo }; },
    setupConsoleCapture,
    ensureAllPagesCapture,
    beginOperation,
    endOperation,
    ensureBrowser,
    getContext,
    getPages,
    runCommand,
    setActivePage,
    getActivePage,
    setNamedPage,
    getNamedPage,
    renamePageName,
    forgetPageName,
    listPageNames,
    getStablePageHandle,
    listStablePages,
    listTabRows,
    resolveTabTarget,
    resolveCommandPage,
    openNewPage,
    getAgentPreferencesForSession,
    getBrowserforceRestrictionsForSession,
    reset,
  };
}
