import { matchPagesToTargets } from './tab-identity.js';

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
    // Plugin deps may be plain objects (sessiond wires them after plugin load)
    // OR functions (lazy accessors, resolved at runCommand() time) — the MCP
    // server constructs the runtime at module scope BEFORE loadPluginRuntime()
    // finishes, so it passes accessors that read the loaded plugin runtime.
    buildExecContext = null,
    runCode = null,
    pluginHelpers = {},
    pluginSkillRuntime = {},
  } = deps;

  const resolveDep = (dep) => (typeof dep === 'function' ? dep() : dep) || {};

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
  // name → { targetId, page, gen }. Names key on relay target id for the same
  // reason handles do: reconnect replaces every Page object, and a Page-keyed
  // name map deleted every user-assigned name on each idle disconnect. `page`
  // is a cache re-bound on each listing; `targetId` is the identity.
  const namedPages = new Map();
  const handlesByTargetId = new Map(); // relay targetId → 't<N>' — survives reconnect
  let stableHandles = new WeakMap(); // page → 't<N>' — fallback when no relay target
  let nextStableHandleNumber = 1;

  // ─── Relay-target identity ─────────────────────────────────────────────────
  // Last good relay snapshot + per-page identity, so one failed fetch cannot
  // renumber every handle. Returning [] on failure would unmatch every page,
  // fall everything back to per-connection identity, and mint fresh handles on
  // the next call — reintroducing the exact defect this identity arc removes.
  let lastRelayTargets = null;
  let targetIdByPage = new WeakMap();

  // A Page from a previous connection is ORPHANED, not closed — isClosed()
  // returns false — so isUsablePage() alone can never decide whether a stored
  // page is still live. The generation counter can.
  let connectionGeneration = 0;
  let identityCache = { generation: -1, rows: [] };

  // One shared active page was correct while one agent used the session. With
  // orchestrators delegating to parallel subagents it silently stomps: agent-2
  // runs `use`, and agent-1's next unpinned command acts on agent-2's tab.
  // Identified clients get their own slot; unidentified ones share, so every
  // existing sequential caller is unaffected.
  //
  // clientId → { targetId, page, gen }. Storing the PAGE alone would repeat the
  // bug this whole arc fixes: reconnect replaces every Page object, the slot
  // would look dead, and the client would silently fall back to the SHARED page
  // — i.e. onto another agent's tab. targetId is what survives, so the slot
  // rebinds instead.
  const activePageByClient = new Map();

  // Cost guard for exact resolution of the tabs the URL matcher could not
  // identify: if something has gone wrong and half the listing is unmatched,
  // degrading to per-connection handles beats opening dozens of alias sessions
  // on the relay (it mints one per Target.attachToTarget).
  const AMBIGUOUS_RESOLUTION_LIMIT = 8;

  /** Relay identity applies only to the real-Chrome backend. Null = MCP = real. */
  function relayBackendActive() {
    return !backendInfo.backend || backendInfo.backend === 'real';
  }

  /** Live Page for a relay target id, from the last identity refresh. */
  function pageForTargetId(targetId) {
    if (!targetId || identityCache.generation !== connectionGeneration) return null;
    return identityCache.rows.find((r) => r.targetId === targetId)?.page ?? null;
  }

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
    // Target discovery STREAMS on the relay bridge: with 100+ real tabs the
    // first page appears immediately but the full set arrives over seconds,
    // with irregular gaps while Playwright initializes each page. Returning
    // early made tabs/use act on a partial list (a not-yet-discovered tab
    // soft-matched as TAB_NOT_FOUND). Two exit conditions, bounded by
    // timeoutMs:
    //   1. Exact: the relay's /extension/status reports how many tab targets
    //      exist — return as soon as Playwright has discovered them all.
    //   2. Heuristic (relay unreachable — managed backend, tests): count is
    //      non-zero and stable for several consecutive polls.
    // Polls use REAL timers (not the injectable setTimeoutImpl): this is an
    // internal wait, and fake-clock tests inject timers that never fire on
    // their own — an injected poll timer would deadlock ensureBrowser.
    let expectedCount = 0;
    try {
      const relayHttpUrl = relayBackendActive() && typeof getRelayHttpUrl === 'function' ? getRelayHttpUrl() : null;
      if (relayHttpUrl) {
        const response = await doFetch(`${relayHttpUrl}/extension/status`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          const body = await response.json();
          if (Array.isArray(body?.attachedTabs)) expectedCount = body.attachedTabs.length;
        }
      }
    } catch { /* no relay on this backend — fall back to settle heuristic */ }

    // 6 polls ≈ 600ms of no growth. Playwright's streamed page inits can gap
    // a few hundred ms on the relay bridge; shorter windows settled early and
    // produced partial tab lists when the exact-count fetch was unavailable.
    const settlePolls = 6;
    let lastCount = -1;
    let stablePolls = 0;
    while (Date.now() - started < timeoutMs) {
      const count = ctx.pages().length;
      if (expectedCount > 0 && count >= expectedCount) return;
      if (count > 0 && count === lastCount) {
        stablePolls += 1;
        if (stablePolls >= settlePolls) return;
      } else {
        stablePolls = 0;
      }
      lastCount = count;
      await new Promise((resolve) => globalThis.setTimeout(resolve, initialPageDiscoveryPollMs));
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
        // Every Page object is about to be replaced by the reconnect. Bumping
        // the generation is what lets identity tell an orphaned Page from a
        // live one — isClosed() cannot.
        connectionGeneration += 1;
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
  function resolveActivePage(ctx, { clientId = null } = {}) {
    if (clientId) {
      const own = getActivePage({ clientId });
      if (own) return own;
      // A slot that exists but resolved to null is BLOCKED (its tab is gone or
      // unrebindable). Seeding it from pages()[0] would put the client on an
      // arbitrary tab — very possibly another agent's.
      if (activePageByClient.has(clientId)) return null;
    }
    const current = userState.page;
    if (isUsablePage(current)) return current;
    if (current) userState.page = null;
    const first = ctx.pages()[0] || null;
    if (first) userState.page = first;
    return first;
  }

  // ─── Tab identity APIs ───────────────────────────────────────────────────────

  /** Pin `page` as the active tab — the client's own slot, or the shared one. */
  function setActivePage(page, { clientId = null, targetId = null } = {}) {
    if (!isUsablePage(page)) {
      throw tabStateError('TAB_NOT_USABLE', 'Cannot activate a closed page.');
    }
    if (clientId) {
      activePageByClient.set(clientId, { targetId, page, gen: connectionGeneration });
      return page;
    }
    userState.page = page;
    return page;
  }

  /**
   * Every client-slot write funnels through here, so no path can store a null
   * id by omission — and a slot with no id cannot rebind after a reconnect,
   * which is the entire point. A page with no relay identity (managed backend)
   * still legitimately stores null.
   */
  function setActivePageForClient(page, clientId) {
    return setActivePage(page, { clientId, targetId: targetIdByPage.get(page) ?? null });
  }

  /** Current active tab, or null. Closed handles are dropped, never returned. */
  function getActivePage({ clientId = null } = {}) {
    if (clientId) {
      const slot = activePageByClient.get(clientId);
      if (slot) {
        // Generation check FIRST. isUsablePage only asks isClosed(), and a Page
        // from the previous connection reports false — it is orphaned, not
        // closed. Trusting it would hand back a handle onto a dead CDP session.
        if (slot.gen === connectionGeneration && isUsablePage(slot.page)) return slot.page;
        const rebound = slot.targetId ? pageForTargetId(slot.targetId) : null;
        if (rebound) { slot.page = rebound; slot.gen = connectionGeneration; return rebound; }
        // Fail closed AND keep the slot. Deleting it means the next command
        // finds no slot, falls through to the shared page, and the cross-agent
        // stomp is back one call later. A blocked slot clears only on explicit
        // reselection (use/open) or reset.
        slot.page = null;
        return null;
      }
      // No slot yet: inherit the shared page. That is what makes a delegated
      // subagent useful before it picks its own tab.
    }
    const current = userState.page;
    if (isUsablePage(current)) return current;
    if (current) userState.page = null;
    return null;
  }

  /**
   * `state` as one client sees it: `page` is that client's own active tab,
   * every other key is the shared session state. A scoped activePage() alone
   * does NOT scope `state.page` — an eval reading it would see another client's
   * tab, and one assigning it would move them.
   */
  function stateViewFor(clientId) {
    if (!clientId) return userState;
    return new Proxy(userState, {
      get(target, prop, receiver) {
        if (prop === 'page') return getActivePage({ clientId });
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value, receiver) {
        if (prop === 'page') {
          if (value == null) { activePageByClient.delete(clientId); return true; }
          setActivePageForClient(value, clientId);
          return true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
      has(target, prop) {
        if (prop === 'page') return getActivePage({ clientId }) != null;
        return Reflect.has(target, prop);
      },
    });
  }

  /**
   * Backfill: a slot stored before its page was ever listed (a `state.page`
   * assignment inside an eval) holds no target id and could never rebind.
   */
  function adoptTargetIdsForClientSlots(rows) {
    for (const slot of activePageByClient.values()) {
      if (slot.targetId || !slot.page) continue;
      const match = rows.find((r) => r.page === slot.page);
      if (match?.targetId) slot.targetId = match.targetId;
    }
  }

  /**
   * Stable `t<N>` handle. Keyed by relay target id when one is known, because
   * Playwright rebuilds every Page object on the idle reconnect — a Page-keyed
   * map renumbered every tab on every reconnect and an agent acting on a stale
   * handle silently hit the WRONG TAB. Falls back to page identity (valid for
   * one connection) when there is no relay target: a managed/headless backend
   * has no target ids.
   */
  function getStablePageHandle(page, targetId = null) {
    if (!page) return null;
    if (targetId) {
      let handle = handlesByTargetId.get(targetId);
      if (!handle) {
        // PROMOTE an existing fallback handle instead of minting a new number.
        // A failed first fetch gives the page a per-connection handle;
        // allocating a fresh one on recovery would change a handle already
        // handed to an agent and strand the old one.
        handle = stableHandles.get(page) ?? `t${nextStableHandleNumber++}`;
        handlesByTargetId.set(targetId, handle);
      }
      stableHandles.set(page, handle); // fast path for lookups with no id to hand
      return handle;
    }
    let handle = stableHandles.get(page);
    if (!handle) {
      handle = `t${nextStableHandleNumber++}`;
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

  /**
   * Relay target list: id, url and title for EVERY tab, with no debugger attach.
   *
   * Returns `{ targets, authoritative }` per call and NEVER sets a shared
   * authority flag: a module-level flag read after an await races with parallel
   * clients — a concurrent listing could treat a stale cached snapshot as
   * authoritative and assign a closed target to a fresh page.
   *
   * Skipped entirely unless the negotiated backend is real Chrome. sessiond
   * constructs this runtime BEFORE negotiateBackend() and passes
   * getRelayHttpUrl unconditionally, so a managed or headless session on a
   * machine with a relay running would otherwise match its own pages against
   * the real browser's targets. MCP never calls setBackendInfo and is always
   * real, so a null backend means "use the relay".
   */
  async function fetchRelayTargets({ timeoutMs = 1500 } = {}) {
    if (!relayBackendActive()) return { targets: [], authoritative: false };
    const relayHttpUrl = typeof getRelayHttpUrl === 'function' ? getRelayHttpUrl() : null;
    if (!relayHttpUrl) return { targets: [], authoritative: false };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await doFetch(`${relayHttpUrl}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok) {
          const body = await response.json();
          if (Array.isArray(body)) {
            lastRelayTargets = body;
            return { targets: body, authoritative: true };
          }
        }
      } catch { /* retry once, then fall through to the last good snapshot */ }
    }
    return { targets: lastRelayTargets ?? [], authoritative: false };
  }

  /**
   * Exact identity for the tabs the URL matcher could not pair (duplicate URLs).
   *
   * Bounded by the ambiguous set, not the tab count: a 72-tab listing with two
   * about:blank tabs opens two alias sessions, not 72 — which is why a full
   * listing cannot be done this way (the relay mints an alias session per
   * Target.attachToTarget). Sessions are detached immediately.
   */
  async function resolveAmbiguousTargetIds(ctx, rows) {
    // Only where relay identity is the identity source. A managed backend has
    // no target ids to be durable across, and a runtime with no relay URL is
    // per-connection by design — opening a CDP session per unmatched page there
    // is cost with nothing to buy.
    const relayHttpUrl = typeof getRelayHttpUrl === 'function' ? getRelayHttpUrl() : null;
    if (!relayBackendActive() || !relayHttpUrl || typeof ctx?.newCDPSession !== 'function') return;
    const unresolved = rows.filter((r) => !r.targetId);
    if (unresolved.length === 0 || unresolved.length > AMBIGUOUS_RESOLUTION_LIMIT) return;
    await Promise.all(unresolved.map(async (row) => {
      let session;
      try {
        session = await ctx.newCDPSession(row.page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo?.targetId) {
          row.targetId = targetInfo.targetId;
          targetIdByPage.set(row.page, targetInfo.targetId);
          row.handle = getStablePageHandle(row.page, targetInfo.targetId);
        }
      } catch { /* leave it on a per-connection handle */ } finally {
        try { await session?.detach(); } catch { /* already gone */ }
      }
    }));
  }

  /**
   * Open pages with their relay target id, title and stable handle.
   *
   * Titles come from the relay because page.title() cannot be trusted here: on
   * a lazily-attached tab the relay acks Runtime.enable synthetically, no
   * execution context arrives, and the bounded read times out to '' — which is
   * why every tab in a real many-tab session listed as "(untitled)". The
   * bounded read stays as the fallback for backends with no relay.
   */
  async function listIdentifiedPages() {
    await ensureBrowser(); // callers may run before any connection exists
    // Captured BEFORE any await and re-checked after: a listing that spans a
    // disconnect resolves old Page objects, and publishing them under the NEW
    // generation would let pageForTargetId hand out an orphan with the
    // generation check itself vouching for it.
    const startedAt = connectionGeneration;
    const ctx = getContext();
    const pages = ctx.pages().filter((page) => isUsablePage(page));
    const urls = pages.map((page) => { try { return page.url() || ''; } catch { return ''; } });
    const { targets, authoritative } = await fetchRelayTargets();
    const identities = matchPagesToTargets(urls, targets);
    const rows = await Promise.all(pages.map(async (page, i) => {
      // A page already identified in this connection keeps its target id even
      // if this round's match failed (stale URL, duplicate URL, failed fetch).
      // Identity may only be learned, never silently forgotten.
      const matched = identities[i] ?? { targetId: null, title: '' };
      // A STALE snapshot may only CONFIRM identity for a Page we already knew.
      // Rematching a fresh Page against cached targets lets a replacement tab
      // at the same URL inherit the closed tab's target id — and its handle.
      const knownId = targetIdByPage.get(page) ?? null;
      const targetId = (authoritative ? matched.targetId : null) ?? knownId;
      if (authoritative && matched.targetId) targetIdByPage.set(page, matched.targetId);
      // The relay title is used only when this listing actually paired the page
      // with a target, or when a stale snapshot paired it with the SAME target
      // we already knew. A stale snapshot may not supply a title to a page it
      // never identified: a replacement tab at the same URL would show the dead
      // tab's title, and could then be selected by it. null = no relay title,
      // distinct from a target whose title is genuinely empty.
      const relayTitle = matched.targetId && (authoritative || matched.targetId === knownId)
        ? (matched.title || '')
        : null;
      return {
        page,
        url: urls[i],
        targetId,
        title: relayTitle ?? await pageTitleBounded(page),
        handle: getStablePageHandle(page, targetId),
      };
    }));
    await resolveAmbiguousTargetIds(ctx, rows);
    if (authoritative) {
      // The relay synthesizes bf-target-<tabId> when the extension has no real
      // CDP target id, and CHROME REUSES TAB IDS — so a closed-then-reopened
      // tab can present the same synthesized id and inherit the previous tab's
      // handle. Evict ids the relay no longer lists. Only on an authoritative
      // listing: a failed fetch is not evidence that a tab closed.
      const live = new Set(targets.map((t) => t?.id).filter(Boolean));
      for (const id of handlesByTargetId.keys()) if (!live.has(id)) handlesByTargetId.delete(id);
    }
    if (startedAt !== connectionGeneration) return listIdentifiedPages(); // retry on the new connection
    identityCache = { generation: connectionGeneration, rows };
    rebindNamedPages(rows, { authoritative, targets });
    adoptTargetIdsForClientSlots(rows);
    return rows;
  }

  // Drop a name only when its tab is really gone. A stale `page` after a
  // reconnect is NOT gone — rebindNamedPages() re-points it.
  function pruneNamedPages() {
    for (const [name, entry] of namedPages) {
      if (!entry.targetId && !isUsablePage(entry.page)) namedPages.delete(name);
    }
  }

  /**
   * Re-point named entries at the current Page objects.
   *
   * A target-keyed name is deleted ONLY when the relay listing is authoritative
   * and does not contain its target — an unreachable relay is not evidence that
   * a tab closed, and deleting on a failed fetch silently loses user names.
   */
  function rebindNamedPages(identified, { authoritative, targets }) {
    const byTargetId = new Map(identified.filter((i) => i.targetId).map((i) => [i.targetId, i.page]));
    // Existence comes from the RAW target list, never from `identified`: a tab
    // can be present in /json/list yet unmatched here (its URL changed, or it
    // shares a URL with another tab). Treating "unmatched" as "gone" deletes a
    // name for a tab that is plainly still open. The LOCAL snapshot, never
    // lastRelayTargets — a concurrent listing can overwrite the shared one
    // between this call's fetch and this line.
    const liveTargetIds = new Set(
      (targets ?? []).map((t) => t?.id).filter((id) => typeof id === 'string' && id),
    );
    for (const [name, entry] of namedPages) {
      if (!entry.targetId) continue;
      const page = byTargetId.get(entry.targetId);
      if (page) { entry.page = page; entry.gen = connectionGeneration; continue; }
      if (authoritative && !liveTargetIds.has(entry.targetId)) namedPages.delete(name);
    }
    pruneNamedPages();
  }

  // Canonical tab-name validator — the ONLY gate for names entering
  // namedPages (setNamedPage and renamePageName both route through it).
  // Names must be identifier-like (plan requirement) and must never take the
  // stable-handle shape t<N>: resolveTabTarget() resolves handles BEFORE
  // names, so a tab literally named "t2" would be permanently unreachable.
  const TAB_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const STABLE_HANDLE_SHAPE = /^t\d+$/i;

  function assertValidTabName(name) {
    const key = String(name ?? '').trim();
    if (!key) throw tabStateError('BAD_TAB_NAME', 'Tab name must be a non-empty string.');
    if (!TAB_NAME_PATTERN.test(key)) {
      throw tabStateError(
        'BAD_TAB_NAME',
        `Invalid tab name "${key}". Names must be identifier-like: start with a letter or underscore, then letters, digits, hyphens, or underscores (e.g. docs, api-docs).`,
      );
    }
    if (STABLE_HANDLE_SHAPE.test(key)) {
      throw tabStateError(
        'BAD_TAB_NAME',
        `Invalid tab name "${key}": t<number> is reserved for stable tab handles. Pick a different name (e.g. docs).`,
      );
    }
    return key;
  }

  /**
   * Assign a user-facing name to a page. Names are unique: reassigning an
   * in-use name requires `replace: true` (which moves the name and leaves the
   * previously named page open and unnamed).
   */
  function setNamedPage(name, page, { replace = false, targetId = null } = {}) {
    const key = assertValidTabName(name);
    if (!isUsablePage(page)) throw tabStateError('TAB_NOT_USABLE', 'Cannot name a closed page.');
    pruneNamedPages(); // a closed no-target page must not block its name
    const existing = namedPages.get(key);
    const isSameTab = existing && (existing.page === page
      || (targetId && existing.targetId === targetId));
    if (existing && !isSameTab && !replace) {
      throw tabStateError('TAB_NAME_IN_USE', `Tab name "${key}" is already in use.`);
    }
    namedPages.set(key, { targetId, page, gen: connectionGeneration });
    return { name: key, replaced: !!existing && !isSameTab };
  }

  /** Page for a name, or null. Names pointing at closed pages are pruned. */
  function getNamedPage(name) {
    const key = String(name ?? '').trim();
    const entry = namedPages.get(key);
    if (!entry) return null;
    // Generation before usability: a Page from a dead connection is orphaned,
    // not closed, so isClosed() is false and this would hand back a handle onto
    // a dead CDP session.
    if (entry.gen === connectionGeneration && isUsablePage(entry.page)) return entry.page;
    const rebound = entry.targetId ? pageForTargetId(entry.targetId) : null;
    if (rebound) { entry.page = rebound; entry.gen = connectionGeneration; return rebound; }
    if (!entry.targetId) { namedPages.delete(key); return null; }
    // Target-keyed but unresolved: fail closed and KEEP the name. Falling
    // through to soft matching would act on a different tab.
    return null;
  }

  /** Move a name to a new label. Colliding with an existing name requires replace. */
  function renamePageName(oldName, newName, { replace = false } = {}) {
    const from = String(oldName ?? '').trim();
    const to = assertValidTabName(newName);
    const page = getNamedPage(from);
    if (!page) throw tabStateError('TAB_NAME_NOT_FOUND', `No tab named "${from}".`);
    if (from === to) return { name: to, replaced: false };
    const existing = getNamedPage(to);
    if (existing && !replace) {
      throw tabStateError('TAB_NAME_IN_USE', `Tab name "${to}" is already in use.`);
    }
    // Move the whole entry so the target id — the durable identity — travels
    // with the name.
    namedPages.set(to, namedPages.get(from));
    namedPages.delete(from);
    return { name: to, replaced: !!existing };
  }

  /** Remove a name mapping. Returns whether the name existed. */
  function forgetPageName(name) {
    return namedPages.delete(String(name ?? '').trim());
  }

  /** All live name → page mappings (closed pages pruned). */
  function listPageNames() {
    pruneNamedPages();
    return [...namedPages.entries()].map(([name, entry]) => ({ name, page: entry.page }));
  }

  function nameForPage(page, targetId = null) {
    for (const [name, entry] of namedPages) {
      if (targetId && entry.targetId === targetId) return name;
      if (entry.page === page) return name;
    }
    return null;
  }

  /**
   * Structured rows for every open tab — the single builder behind `tabs` on
   * ALL surfaces (sessiond JSON, CLI --json, MCP text rendering), so stable
   * handles can never exist in one output and not another.
   */
  // Bounded page.title() read. On the real relay bridge, title() NEVER resolves
  // for a tab whose debugger was never lazily attached: Playwright waits for an
  // execution context, but the relay synthetically acked Runtime.enable while
  // the tab was unattached (INIT_ONLY_METHODS), so no context is ever announced
  // — and title() sends no CDP command that would trigger the lazy attach.
  // With dozens of real tabs, one unbounded title() hangs `tabs`/`use` forever.
  // Bound the read and fall back to '' — the URL remains the row's identifier.
  async function pageTitleBounded(page, ms = 1000) {
    let timer;
    try {
      return await Promise.race([
        page.title(),
        new Promise((resolve) => { timer = setTimeoutImpl(() => resolve(''), ms); }),
      ]) || '';
    } catch {
      return ''; // page navigating/closed mid-read
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  /**
   * Inspect paths only. openNewPage() is how an empty browser gets its first
   * tab, so it must never be gated on there being one — and neither must the
   * raw eval escape hatch, which can legitimately call context.newPage().
   *
   * Raised HERE, not in ensureBrowser(): its context block ends in a bare catch
   * that would swallow this silently.
   */
  function assertPagesAvailable() {
    if (getPages().filter(isUsablePage).length === 0) {
      throw tabStateError('NO_TABS', 'BrowserForce is connected but Chrome has no tabs. Open a tab and retry.');
    }
  }

  async function listTabRows({ clientId = null } = {}) {
    await ensureBrowser();
    assertPagesAvailable();
    beginOperation();
    try {
      // Identity FIRST: resolveActivePage consults client slots, and after a
      // reconnect those rebind only once listIdentifiedPages has run. Resolving
      // first marked the shared tab — or nothing — as active.
      const identified = await listIdentifiedPages();
      // Use resolveActivePage (not getActivePage) so the row marked active is
      // the tab a subsequent unnamed command would actually target.
      const active = resolveActivePage(getContext(), { clientId });
      return identified.map(({ page, handle, title, url, targetId }, index) => ({
        handle,
        index,
        title,
        url,
        targetId,
        active: page === active,
        name: nameForPage(page, targetId),
      }));
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
    assertPagesAvailable();
    beginOperation();
    try {
      const stable = await listIdentifiedPages();

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

      // listIdentifiedPages already carries url and title, relay-sourced where
      // available — no second bounded title read.
      const metas = stable;
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
  async function resolveCommandPage({ tab, clientId = null } = {}) {
    if (tab == null || String(tab).trim() === '') {
      return resolveActivePage(getContext(), { clientId });
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
  async function openNewPage({ url = '', timeout = 30000, clientId = null } = {}) {
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
      // The caller's OWN active tab, never the shared one: `open` in one
      // subagent must not move another agent's page.
      if (clientId) setActivePageForClient(page, clientId);
      else setActivePage(page);
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
   *
   * An optional `page` pins THIS run to an explicit target (a command's --tab
   * page) WITHOUT touching userState.page: the pin travels to buildExecContext
   * as `pinnedPage`, so concurrent commands against other tabs stay isolated.
   * A stale pin fails loudly rather than silently falling back to the active
   * tab (acting on the wrong tab is worse than failing).
   *
   * Returns runCode()'s raw result.
   */
  async function runCommand({ code, timeout = 30000, page: pinnedPage = null, requiresPage = true, clientId = null } = {}) {
    if (typeof buildExecContext !== 'function' || typeof runCode !== 'function') {
      throw new Error('browser session runtime: buildExecContext and runCode deps are required for runCommand');
    }
    await ensureBrowser();
    // One gate for the whole atomic-verb surface (CLI, sessiond and MCP all
    // route through here), so a verb added later cannot silently miss it.
    // Opting out is explicit: only `eval` does, because it can create the
    // first tab itself.
    if (requiresPage) assertPagesAvailable();
    beginOperation();
    try {
      const ctx = getContext();
      let page;
      if (pinnedPage) {
        if (!isUsablePage(pinnedPage)) {
          throw tabStateError('TAB_NOT_USABLE', 'The target tab was closed before the command ran. Run tabs to list open tabs.');
        }
        page = pinnedPage;
      } else {
        // After a reconnect a client slot rebinds only once identity has been
        // refreshed; without this the first post-reconnect command fails closed
        // and the agent sees a spurious "no active tab".
        if (clientId && identityCache.generation !== connectionGeneration) {
          await listIdentifiedPages();
        }
        page = resolveActivePage(ctx, { clientId });
      }
      const execCtx = buildExecContext(
        page,
        ctx,
        // The client-scoped view: `state.page` reads and writes the caller's own
        // slot, every other key stays shared. This also scopes the exec
        // context's activePage(), which reads userState.page.
        stateViewFor(clientId),
        { consoleLogs, setupConsoleCapture, pinnedPage: pinnedPage || null },
        resolveDep(pluginHelpers),
        await getAgentPreferencesForSession(),
        await getBrowserforceRestrictionsForSession(),
        resolveDep(pluginSkillRuntime),
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
    activePageByClient.clear();
    // Every identity cache, not just the handle map: leaving any of them means
    // a post-reset fetch failure applies stale identity or titles to a brand-new
    // page graph.
    stableHandles = new WeakMap();
    handlesByTargetId.clear();
    targetIdByPage = new WeakMap();
    lastRelayTargets = null;
    identityCache = { generation: -1, rows: [] };
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
    assertValidTabName,
    assertPagesAvailable,
    setActivePageForClient,
    stateViewFor,
    setNamedPage,
    getNamedPage,
    renamePageName,
    forgetPageName,
    listPageNames,
    getStablePageHandle,
    listStablePages,
    listIdentifiedPages,
    listTabRows,
    resolveTabTarget,
    resolveCommandPage,
    openNewPage,
    getAgentPreferencesForSession,
    getBrowserforceRestrictionsForSession,
    reset,
  };
}
