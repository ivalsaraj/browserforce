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

  /**
   * Run a user snippet against the live session through the guarded runCode()
   * boundary. Ensures the browser is connected, builds the exec context from the
   * first context/page, and counts the work as an active operation so the idle
   * disconnect timer never fires mid-command. Returns runCode()'s raw result.
   */
  async function runCommand({ code, timeout = 30000 } = {}) {
    if (typeof buildExecContext !== 'function' || typeof runCode !== 'function') {
      throw new Error('browser session runtime: buildExecContext and runCode deps are required for runCommand');
    }
    await ensureBrowser();
    beginOperation();
    try {
      const ctx = getContext();
      const page = getPages()[0] || null;
      const execCtx = buildExecContext(page, ctx, userState, { consoleLogs, setupConsoleCapture });
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
    getAgentPreferencesForSession,
    getBrowserforceRestrictionsForSession,
    reset,
  };
}
