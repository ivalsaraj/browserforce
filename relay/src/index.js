const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer, WebSocket } = require('ws');
const { createCdpLogger } = require('./cdp-log.js');

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 19222;
const COMMAND_TIMEOUT_MS = 30000;
const PING_INTERVAL_MS = 5000;
const DEFAULT_CDP_LOG_BUFFER_LIMIT = 10000;
const RESTRICTIONS_FETCH_TIMEOUT_MS = 2000;
const RESTRICTIONS_FAIL_CLOSED = Object.freeze({ mode: 'manual', noNewTabs: true });
// Leak guard for label-keyed window affinity entries (which outlive their
// connection by design). FIFO-evict the oldest pin beyond this size.
const MAX_AFFINITY_ENTRIES = 50;

const BF_DIR = path.join(os.homedir(), '.browserforce');
const TOKEN_FILE = path.join(BF_DIR, 'auth-token');
const CDP_URL_FILE = path.join(BF_DIR, 'cdp-url');
const CHATD_URL_FILE = path.join(BF_DIR, 'chatd-url.json');
const BF_PLUGINS_DIR = path.join(BF_DIR, 'plugins');
const CLIENT_MODE_SINGLE = 'single-active';
const CLIENT_MODE_MULTI = 'multi-client';

// ─── Logging ─────────────────────────────────────────────────────────────────

function ts() { return new Date().toTimeString().slice(0, 8); }
function log(...args) { console.log(`[${ts()}]`, ...args); }
function logErr(...args) { console.error(`[${ts()}]`, ...args); }

function resolvePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function sanitizeClientLabel(label) {
  if (typeof label !== 'string') return null;
  const cleaned = label.trim().replace(/[^\w .:@/-]/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, 80);
}

// ─── HTTP Host Validation ────────────────────────────────────────────────────
//
// Local-only protection against DNS rebinding: reject non-local Host headers
// before URL parsing so a public hostname cannot be mapped onto relay routes.
// A missing Host header is deliberately allowed for local non-browser clients
// (curl, Node scripts) — this is a compatibility exception, not a relaxation
// of the local-only security model (the relay still binds 127.0.0.1 only).

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

// Introspection endpoints carry local browsing metadata (tab URLs/titles) and
// must not be readable cross-origin by arbitrary websites. Wildcard CORS stays
// the default for CDP-discovery/health routes only.
const NO_WILDCARD_CORS_PATHS = new Set(['/extension/status', '/attached-tabs']);

function shouldAllowWildcardCors(pathname) {
  return !NO_WILDCARD_CORS_PATHS.has(pathname);
}

// ─── Token Persistence ──────────────────────────────────────────────────────

function getOrCreateAuthToken() {
  try {
    fs.mkdirSync(BF_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (token.length > 0) return token;
    }
  } catch { /* fall through to generate */ }

  const token = crypto.randomBytes(32).toString('base64url');
  try { fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); } catch {}
  return token;
}

function writeCdpUrlFile(cdpUrl) {
  try {
    fs.mkdirSync(BF_DIR, { recursive: true });
    fs.writeFileSync(CDP_URL_FILE, cdpUrl, { mode: 0o600 });
  } catch (e) {
    logErr('[relay] Failed to write CDP URL file:', e.message);
  }
}

function getClientMode() {
  // Default to multi-client for zero-config MCP onboarding.
  const mode = (process.env.BF_CLIENT_MODE || CLIENT_MODE_MULTI).trim();
  return mode === CLIENT_MODE_SINGLE ? CLIENT_MODE_SINGLE : CLIENT_MODE_MULTI;
}

// ─── RelayServer ─────────────────────────────────────────────────────────────

const DEFAULT_BROWSER_CONTEXT_ID = 'bf-default-context';
// Synthetic browser-level session a CDP client opens via Target.attachToBrowserTarget
// (Playwright's newCDPSession() routes its Target.attachToTarget through this
// "client root session"). Real Chrome returns a real sessionId here; returning a
// stable sentinel lets us route commands sent on it to the browser-command handler
// and echo the sessionId back so the client matches the response to its callback.
const BF_BROWSER_SESSION_ID = 'bf-browser-session';
const DEFAULT_AGENT_PREFERENCES = Object.freeze({
  executionMode: 'parallel',
  parallelVisibilityMode: 'foreground-tab',
});

// Commands Playwright sends automatically to every page during initialization.
// We intercept these on unattached tabs and return synthetic responses so
// chrome.debugger.attach() is never called until the AI actually uses the tab.
// This preserves dark mode and avoids the "controlled by automated software"
// bar appearing on every open tab.
const INIT_ONLY_METHODS = new Set([
  // Runtime
  'Runtime.enable', 'Runtime.disable', 'Runtime.runIfWaitingForDebugger',
  'Runtime.addBinding',
  // Page lifecycle + scripting
  'Page.enable', 'Page.disable',
  'Page.getFrameTree',                         // needs shaped response — see syntheticInitResponse()
  'Page.setLifecycleEventsEnabled',
  'Page.setInterceptFileChooserDialog', 'Page.setPrerenderingAllowed',
  'Page.setBypassCSP',
  'Page.addScriptToEvaluateOnNewDocument',     // needs shaped response — returns { identifier }
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.createIsolatedWorld',                  // synthetic ONLY while unattached; forwarded when attached so Playwright's utility world (locator actions) exists — see docs/knowledge/knowledge1.md 2026-07-06
  'Page.setFontFamilies',
  // Network / Fetch
  'Fetch.enable', 'Fetch.disable',
  'Network.enable', 'Network.disable', 'Network.setBypassServiceWorker',
  'Network.setExtraHTTPHeaders', 'Network.setCacheDisabled',
  // Target
  'Target.setAutoAttach', 'Target.setDiscoverTargets',
  // Logging
  'Log.enable', 'Log.disable',
  'Console.enable', 'Console.disable',
  // CSS / DOM
  'CSS.enable', 'CSS.disable',
  'DOM.enable', 'DOM.disable',
  'Inspector.enable',
  // Workers
  'ServiceWorker.enable', 'ServiceWorker.disable',
  // Debugger
  'Debugger.enable', 'Debugger.disable',
  // Security
  'Security.enable', 'Security.disable',
  'Security.setIgnoreCertificateErrors',
  // Performance
  'Performance.enable', 'Performance.disable',
  // Emulation — init and optional overrides Playwright sets up front
  'Emulation.setEmulatedMedia', 'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled', 'Emulation.setDefaultBackgroundColorOverride',
  'Emulation.setAutomationOverride', 'Emulation.setFocusEmulationEnabled',
  'Emulation.setScriptExecutionDisabled',
  'Emulation.setLocaleOverride', 'Emulation.setTimezoneOverride',
  'Emulation.setUserAgentOverride', 'Emulation.setGeolocationOverride',
]);

// Return a well-shaped synthetic response for init commands that need more than {}.
function syntheticInitResponse(method, target) {
  switch (method) {
    case 'Page.getFrameTree':
      // Playwright reads frameTree.frame.id and frameTree.frame.url
      return {
        frameTree: {
          frame: {
            id: target.targetId || `frame-${target.tabId}`,
            url: target.targetInfo?.url || 'about:blank',
            securityOrigin: '',
            mimeType: 'text/html',
          },
        },
      };
    case 'Page.addScriptToEvaluateOnNewDocument':
      // Playwright stores the identifier to remove the script later
      return { identifier: `bf-stub-${target.tabId}-${Date.now()}` };
    default:
      return {};
  }
}

function normalizeAgentPreferences(raw) {
  const executionMode = raw?.executionMode === 'sequential' ? 'sequential' : 'parallel';
  // Keep relay behavior locked to visible tabs in the current window.
  const parallelVisibilityMode = 'foreground-tab';
  return { executionMode, parallelVisibilityMode };
}

// Single validity predicate for window ids (agent window affinity). A real
// Chrome tab always carries an integer windowId; anything else (undefined,
// float, string) is treated as "unknown" and never pinned or surfaced.
function integerWindowId(value) {
  return Number.isInteger(value) ? value : undefined;
}

// Single shaper for OUTBOUND CDP targetInfo payloads so optional `windowId` is
// injected consistently and no shaper can silently drop it. Stored relay target
// metadata stays source-shaped; this only shapes what we send to Playwright.
function buildTargetInfo(target) {
  const info = {
    targetId: target.targetId,
    type: 'page',
    title: target.targetInfo?.title || '',
    url: target.targetInfo?.url || '',
    attached: true,
    browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
  };
  const windowId = integerWindowId(target.windowId ?? target.targetInfo?.windowId);
  if (windowId !== undefined) info.windowId = windowId;
  return info;
}

// Normalize a raw extension iframe targetInfo so OOPIF targets carry the same
// invariants Playwright's CRBrowser._onAttachedToTarget asserts — notably
// browserContextId (see AGENTS.md "browserContextId Requirement"). The extension
// may omit fields; fill them deterministically here so getTargets/getTargetInfo
// stay consistent.
function buildOopifTargetInfo(rawTargetInfo) {
  return {
    targetId: rawTargetInfo.targetId,
    type: 'iframe',
    title: rawTargetInfo.title || '',
    url: rawTargetInfo.url || '',
    attached: true,
    browserContextId: rawTargetInfo.browserContextId || DEFAULT_BROWSER_CONTEXT_ID,
  };
}

class RelayServer {
  constructor(port = DEFAULT_PORT, pluginsDir = BF_PLUGINS_DIR) {
    this.port = port;
    this.pluginsDir = pluginsDir;
    this.authToken = getOrCreateAuthToken();
    this.clientMode = getClientMode();
    this.activeClient = null; // { id, ws, connectedAt, lastSeenAt }
    this.clientSeq = 0;

    // Extension connection (single slot)
    this.ext = null;
    this.extMsgId = 0;
    this.extPending = new Map(); // id -> { resolve, reject, timer }
    this.pingTimer = null;

    // CDP clients
    this.clients = new Set();
    this.clientMeta = new WeakMap();
    this.clientById = new Map();

    // Target tracking
    this.targets = new Map();      // sessionId -> { tabId, targetId, targetInfo }
    this.tabToSession = new Map(); // tabId -> sessionId
    this.childSessions = new Map(); // childSessionId -> { tabId, parentSessionId }
    this.oopifTargets = new Map();  // iframe targetId -> { childSessionId, tabId, targetInfo }
    this.aliasSessions = new Map(); // aliasSessionId -> { primarySessionId, clientId } (explicit newCDPSession re-attach to an already-attached page)
    // Agent window affinity: affinityKey -> windowId. Key is 'label:<explicit
    // label>' when the client passed ?label= (e.g. MCP's browserforce-mcp),
    // else the connection id. Explicit-label entries survive disconnects so
    // the 15s MCP idle-disconnect/reset cycle reuses the same agent window
    // instead of spawning a new dedicated window per reconnect.
    this.agentWindowByAffinityKey = new Map();
    this.sessionCounter = 0;

    // State
    this.autoAttachEnabled = false;
    this.autoAttachParams = null;

    // Pending extension reload ack resolver (at most one at a time)
    this._extReloadResolve = null;

    // CDP traffic logger, initialized on start.
    this.cdpLogger = null;

    // In-memory log buffer for options UI polling.
    this.cdpLogEntries = [];
    this.cdpLogSeq = 0;
    this.cdpLogBufferLimit = resolvePositiveInt(
      process.env.BROWSERFORCE_CDP_LOG_BUFFER_LIMIT,
      DEFAULT_CDP_LOG_BUFFER_LIMIT,
    );

    this.startedAt = Date.now();
  }

  start({ writeCdpUrl = true } = {}) {
    this.startedAt = Date.now();
    this.cdpLogEntries = [];
    this.cdpLogSeq = 0;
    this.clientById.clear();
    try {
      this.cdpLogger = createCdpLogger();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log('[relay] Warning: CDP logger disabled:', message);
      this.cdpLogger = null;
    }
    const server = http.createServer((req, res) => this._handleHttp(req, res));

    this.extWss = new WebSocketServer({ noServer: true });
    this.cdpWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
    this.extWss.on('connection', (ws, req) => this._onExtConnect(ws, req));
    this.cdpWss.on('connection', (ws, req) => this._onCdpConnect(ws, req));

    this.server = server;

    return new Promise((resolve) => {
      server.listen(this.port, '127.0.0.1', () => {
        this.port = server.address().port;
        const cdpUrl = `ws://127.0.0.1:${this.port}/cdp?token=${this.authToken}`;
        if (writeCdpUrl) writeCdpUrlFile(cdpUrl);
        console.log('');
        console.log('  BrowserForce');
        console.log('  ────────────────────────────────────────');
        console.log(`  Status:   http://127.0.0.1:${this.port}/`);
        console.log(`  CDP:      ${cdpUrl}`);
        console.log(`  Config:   ${BF_DIR}/`);
        console.log('  ────────────────────────────────────────');
        console.log('');
        console.log('  Waiting for extension to connect...');
        console.log('');
        resolve({ port: this.port, authToken: this.authToken });
      });
    });
  }

  _logCdp(entry) {
    const withClientLabel = { ...entry };
    if (withClientLabel.clientId && !withClientLabel.clientLabel) {
      const meta = this.clientById.get(withClientLabel.clientId);
      if (meta?.label) {
        withClientLabel.clientLabel = meta.label;
      }
    }

    const withTimestamp = {
      timestamp: new Date().toISOString(),
      ...withClientLabel,
    };
    this.cdpLogSeq += 1;
    const bufferedEntry = { seq: this.cdpLogSeq, ...withTimestamp };
    this.cdpLogEntries.push(bufferedEntry);
    if (this.cdpLogEntries.length > this.cdpLogBufferLimit) {
      this.cdpLogEntries.shift();
    }

    if (!this.cdpLogger || typeof this.cdpLogger.log !== 'function') {
      return;
    }
    this.cdpLogger.log(withTimestamp);
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────

  async _handleHttp(req, res) {
    // Host validation runs before URL parsing so a non-local Host cannot be
    // mapped onto relay routes (DNS rebinding protection). A missing Host
    // header is allowed for local non-browser clients.
    const parsedHost = parseHttpHostHeader(req.headers.host);
    if ((req.headers.host && !parsedHost) || (parsedHost && !ALLOWED_HTTP_HOSTS.has(parsedHost))) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Forbidden - Invalid Host header');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    res.setHeader('Content-Type', 'application/json');
    if (shouldAllowWildcardCors(url.pathname)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (url.pathname === '/') {
      res.end(JSON.stringify({
        status: 'ok',
        extension: !!this.ext,
        targets: this.targets.size,
        clients: this.clients.size,
      }));
      return;
    }

    if (url.pathname === '/client-slot') {
      const activeWsOpen = this.activeClient?.ws?.readyState === WebSocket.OPEN;
      const busy = this.clientMode === CLIENT_MODE_SINGLE && activeWsOpen;
      res.end(JSON.stringify({
        mode: this.clientMode,
        busy,
        activeClientId: busy ? this.activeClient.id : null,
        connectedAt: busy ? this.activeClient.connectedAt : null,
        clients: this.clients.size,
      }));
      return;
    }

    if (url.pathname === '/extension/status') {
      res.end(JSON.stringify(this._getExtensionStatusBody()));
      return;
    }

    if (url.pathname === '/attached-tabs') {
      res.end(JSON.stringify({ tabs: this._getAttachedTabInfos() }));
      return;
    }

    if (url.pathname === '/json/version') {
      res.end(JSON.stringify({
        Browser: 'BrowserForce/1.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/cdp?token=${this.authToken}`,
      }));
      return;
    }

    if (url.pathname === '/json/list' || url.pathname === '/json') {
      const list = [...this.targets.values()].map((t) => ({
        id: t.targetId,
        title: t.targetInfo?.title || '',
        url: t.targetInfo?.url || '',
        type: 'page',
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/cdp?token=${this.authToken}`,
      }));
      res.end(JSON.stringify(list));
      return;
    }

    if (url.pathname === '/restrictions') {
      if (!this.ext) {
        res.end(JSON.stringify({ mode: 'auto', lockUrl: false, noNewTabs: false, readOnly: false, instructions: '' }));
        return;
      }
      try {
        const restrictions = await this._sendToExt('getRestrictions');
        res.end(JSON.stringify(restrictions));
      } catch (err) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: 'Extension not responding' }));
      }
      return;
    }

    if (url.pathname === '/agent-preferences') {
      if (!this.ext) {
        res.end(JSON.stringify(DEFAULT_AGENT_PREFERENCES));
        return;
      }
      try {
        const preferences = await this._sendToExt('getAgentPreferences');
        res.end(JSON.stringify(normalizeAgentPreferences(preferences)));
      } catch {
        res.end(JSON.stringify(DEFAULT_AGENT_PREFERENCES));
      }
      return;
    }

    if (url.pathname === '/chatd-url' && req.method === 'GET') {
      if (!this._requireExtensionOrigin(req, res)) return;
      try {
        const body = fs.readFileSync(CHATD_URL_FILE, 'utf8');
        const parsed = JSON.parse(body);
        if (!Number.isInteger(parsed?.port) || typeof parsed?.token !== 'string') {
          throw new Error('invalid shape');
        }

        let healthy = false;
        try {
          const healthRes = await fetch(`http://127.0.0.1:${parsed.port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          healthy = healthRes.ok;
        } catch {
          healthy = false;
        }
        if (!healthy) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'chatd not running' }));
          return;
        }
        res.end(JSON.stringify(parsed));
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'chatd not running' }));
          return;
        }
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'invalid chatd-url metadata' }));
      }
      return;
    }

    if (url.pathname === '/logs/status' && req.method === 'GET') {
      if (!this._requireExtensionOrigin(req, res)) return;
      res.end(JSON.stringify(this._logsStatus()));
      return;
    }

    if (url.pathname === '/logs/cdp' && req.method === 'GET') {
      if (!this._requireExtensionOrigin(req, res)) return;
      const after = resolvePositiveInt(url.searchParams.get('after'), 0);
      const limit = Math.min(resolvePositiveInt(url.searchParams.get('limit'), 300), 1000);
      res.end(JSON.stringify(this._logsSlice({ after, limit })));
      return;
    }

    // ─── Plugin Routes ───────────────────────────────────────────────────────

    const isPluginsListPath = url.pathname === '/plugins' || url.pathname === '/v1/plugins';
    if (isPluginsListPath && req.method === 'GET') {
      try {
        const entries = fs.existsSync(this.pluginsDir)
          ? fs.readdirSync(this.pluginsDir, { withFileTypes: true })
              .filter(d => d.isDirectory())
              .map(d => d.name)
          : [];
        res.end(JSON.stringify({ plugins: entries }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const isPluginsInstallPath = url.pathname === '/plugins/install' || url.pathname === '/v1/plugins/install';
    if (isPluginsInstallPath && req.method === 'POST') {
      if (!this._requireAuth(req, res)) return;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { name } = JSON.parse(body);
          if (!name) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'name required' }));
            return;
          }
          const { installPlugin } = require('./plugin-installer.cjs');
          await installPlugin(name, this.pluginsDir);
          res.end(JSON.stringify({ ok: true, plugin: name }));
        } catch (err) {
          res.statusCode = 422;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/(?:v1\/)?plugins\/([a-z0-9_-]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      if (!this._requireAuth(req, res)) return;
      const name = deleteMatch[1];
      try {
        const pluginPath = path.join(this.pluginsDir, name);
        if (!fs.existsSync(pluginPath)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `Plugin "${name}" not installed` }));
          return;
        }
        fs.rmSync(pluginPath, { recursive: true });
        res.end(JSON.stringify({ ok: true, plugin: name }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/extension/reload' && req.method === 'POST') {
      if (!this._requireAuth(req, res)) return;
      if (!this.ext || this.ext.ws.readyState !== WebSocket.OPEN) {
        res.end(JSON.stringify({ reloaded: false, reason: 'not connected' }));
        return;
      }
      // Await ack with 2.5s timeout; extension sends 'reload-ack' before restarting
      const reloaded = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._extReloadResolve = null;
          resolve(false);
        }, 2500);
        this._extReloadResolve = () => {
          clearTimeout(timer);
          this._extReloadResolve = null;
          resolve(true);
        };
        try {
          this.ext.ws.send(JSON.stringify({ method: 'reload' }));
        } catch {
          clearTimeout(timer);
          this._extReloadResolve = null;
          resolve(false);
        }
      });
      res.end(JSON.stringify({ reloaded }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ─── Auth Helper ─────────────────────────────────────────────────────────

  _requireAuth(req, res) {
    // Double gate: Bearer token + Origin restriction.
    // The relay's /json/version exposes the auth token unauthenticated (required
    // by Playwright for CDP discovery), so Bearer alone isn't sufficient —
    // any local browser tab could read the token and call write endpoints.
    // Restricting Origin to chrome-extension:// closes that vector.
    const origin = req.headers['origin'] || '';
    if (origin && !origin.startsWith('chrome-extension://')) {
      // Origin present but not the extension — reject (CSRF / browser tab attack)
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'Forbidden — invalid origin' }));
      return false;
    }
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token || token !== this.authToken) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized — Bearer token required' }));
      return false;
    }
    return true;
  }

  _extensionOriginFromReq(req) {
    const parseExtensionOrigin = (value) => {
      if (!value || !value.startsWith('chrome-extension://')) return null;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'chrome-extension:' || !parsed.host) return null;
        return `chrome-extension://${parsed.host}`;
      } catch {
        return null;
      }
    };

    const origin = parseExtensionOrigin(req?.headers?.origin || '');
    if (origin) return origin;

    const referer = req?.headers?.referer || req?.headers?.referrer || '';
    return parseExtensionOrigin(referer);
  }

  // Explicit label from the connect URL's query params (null when absent).
  // Only these create durable window affinity — _deriveClientLabel() below
  // ALWAYS returns some display label (UA-derived fallbacks like
  // 'playwright-client'/'cdp-client'), which must never be shared across
  // unrelated clients as an affinity key.
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
      // Malformed request URL — treat as unlabeled.
      return null;
    }
  }

  _deriveClientLabel(req) {
    const fromQuery = this._explicitClientLabel(req);
    if (fromQuery) return fromQuery;

    const origin = req?.headers?.origin || '';
    if (origin.startsWith('chrome-extension://')) {
      const extensionId = origin.replace('chrome-extension://', '');
      return `extension:${extensionId.slice(0, 12)}`;
    }

    const ua = (req?.headers?.['user-agent'] || '').toLowerCase();
    if (ua.includes('claude')) return 'claude-client';
    if (ua.includes('openai')) return 'openai-client';
    if (ua.includes('playwright')) return 'playwright-client';
    if (ua.includes('node')) return 'node-client';

    return 'cdp-client';
  }

  _requireExtensionOrigin(req, res) {
    const origin = this._extensionOriginFromReq(req);
    const requestedExtensionId = String(req?.headers?.['x-browserforce-extension-id'] || '').trim();
    const extensionIdPattern = /^[a-p]{32}$/;

    if (!origin && !extensionIdPattern.test(requestedExtensionId)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'Forbidden — extension origin required' }));
      return false;
    }

    const trustedOrigin = this.ext?.origin;
    if (!trustedOrigin) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'Extension not connected' }));
      return false;
    }

    if (origin) {
      if (origin !== trustedOrigin) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'Forbidden — extension origin mismatch' }));
        return false;
      }
      return true;
    }

    const trustedExtensionId = String(trustedOrigin).replace('chrome-extension://', '');
    if (requestedExtensionId !== trustedExtensionId) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'Forbidden — extension origin mismatch' }));
      return false;
    }

    return true;
  }

  // ─── Attached Tab Status ────────────────────────────────────────────────

  _getAttachedTabInfos() {
    return [...this.targets.values()].map((target) => {
      const info = {
        tabId: target.tabId,
        sessionId: this.tabToSession.get(target.tabId) || null,
        targetId: target.targetId,
        title: target.targetInfo?.title || '',
        url: target.targetInfo?.url || '',
        debuggerAttached: !!target.debuggerAttached,
        origin: target.origin || 'unknown',
      };
      // Surface windowId only when known, preserving the response shape for
      // older extension messages that never sent window metadata.
      const windowId = integerWindowId(target.windowId ?? target.targetInfo?.windowId);
      if (windowId !== undefined) info.windowId = windowId;
      // Real (non-init) activity clock — answers "why didn't my tab auto-close?".
      if (Number.isInteger(target.lastCommandAt)) {
        info.lastCommandAt = target.lastCommandAt;
        info.idleMs = Date.now() - target.lastCommandAt;
      }
      return info;
    });
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

  _logsStatus() {
    const clients = [];
    for (const client of this.clients) {
      const meta = this.clientMeta.get(client);
      if (!meta) continue;
      clients.push({
        id: meta.id,
        label: meta.label,
        connectedAt: meta.connectedAt,
        origin: meta.origin,
        userAgent: meta.userAgent,
        remoteAddress: meta.remoteAddress,
      });
    }

    const counts = {
      fromPlaywright: 0,
      toPlaywright: 0,
      fromExtension: 0,
      toExtension: 0,
    };
    for (const entry of this.cdpLogEntries) {
      if (entry.direction === 'from-playwright') counts.fromPlaywright += 1;
      if (entry.direction === 'to-playwright') counts.toPlaywright += 1;
      if (entry.direction === 'from-extension') counts.fromExtension += 1;
      if (entry.direction === 'to-extension') counts.toExtension += 1;
    }

    return {
      relay: {
        connectedSince: new Date(this.startedAt).toISOString(),
        uptimeMs: Date.now() - this.startedAt,
      },
      extension: this.ext
        ? {
            connected: true,
            connectedAt: this.ext.connectedAt,
            origin: this.ext.origin,
            userAgent: this.ext.userAgent,
            remoteAddress: this.ext.remoteAddress,
          }
        : { connected: false },
      clients: {
        count: this.clients.size,
        items: clients,
      },
      targets: this.targets.size,
      logs: {
        entriesBuffered: this.cdpLogEntries.length,
        latestSeq: this.cdpLogSeq,
        directionCounts: counts,
      },
    };
  }

  _logsSlice({ after = 0, limit = 300 } = {}) {
    const oldestSeq = this.cdpLogEntries.length > 0
      ? this.cdpLogEntries[0].seq
      : this.cdpLogSeq + 1;
    const tooOld = after > 0 && after < oldestSeq - 1;

    const newer = this.cdpLogEntries.filter((entry) => entry.seq > after);
    const skipped = Math.max(0, newer.length - limit);
    const entries = skipped > 0 ? newer.slice(skipped) : newer;

    return {
      after,
      latestSeq: this.cdpLogSeq,
      oldestSeq,
      resetRequired: tooOld,
      skipped,
      entries,
    };
  }

  // ─── WebSocket Upgrade ───────────────────────────────────────────────────

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/extension') {
      // Validate origin
      const origin = this._extensionOriginFromReq(req);
      if (!origin) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      // Single slot
      if (this.ext) {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
        socket.destroy();
        return;
      }
      this.extWss.handleUpgrade(req, socket, head, (ws) => {
        this.extWss.emit('connection', ws, req);
      });
      return;
    }

    if (url.pathname === '/cdp') {
      const token = url.searchParams.get('token');
      if (token !== this.authToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (this.clientMode === CLIENT_MODE_SINGLE) {
        if (this.activeClient && this.activeClient.ws.readyState === WebSocket.OPEN) {
          const body = JSON.stringify({ error: 'Another CDP client is already connected' });
          socket.write(
            `HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
          );
          socket.destroy();
          return;
        }
      }
      this.cdpWss.handleUpgrade(req, socket, head, (ws) => {
        this.cdpWss.emit('connection', ws, req);
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }

  // ─── Extension Connection ────────────────────────────────────────────────

  _onExtConnect(ws, req) {
    log('[relay] Extension connected');
    const origin = this._extensionOriginFromReq(req);
    this.ext = {
      ws,
      connectedAt: new Date().toISOString(),
      origin: origin || null,
      userAgent: req?.headers?.['user-agent'] || null,
      remoteAddress: req?.socket?.remoteAddress || null,
    };

    ws.on('message', (data) => {
      try {
        this._handleExtMessage(JSON.parse(data.toString()));
      } catch (e) {
        logErr('[relay] Extension message parse error:', e.message);
      }
    });

    ws.on('close', () => {
      log('[relay] Extension disconnected');
      this._cleanupExtension();
    });

    ws.on('error', (err) => {
      logErr('[relay] Extension WS error:', err.message);
    });

    // Ping keepalive
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  _cleanupExtension() {
    this.ext = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;

    // Reject all pending extension commands
    for (const [id, pending] of this.extPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Extension disconnected'));
    }
    this.extPending.clear();

    // Notify CDP clients: all targets gone
    for (const [sessionId, target] of this.targets) {
      this._broadcastCdp({
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: target.targetId },
      });
    }
    this.targets.clear();
    this.tabToSession.clear();
    this.childSessions.clear();
    this.oopifTargets.clear();
    this.aliasSessions.clear();
  }

  _handleExtMessage(msg) {
    // Response to a command we sent
    if (msg.id !== undefined && this.extPending.has(msg.id)) {
      const pending = this.extPending.get(msg.id);
      this.extPending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Events from extension
    if (msg.method === 'pong') return;

    if (msg.method === 'reload-ack') {
      if (this._extReloadResolve) this._extReloadResolve();
      return;
    }

    if (msg.method === 'cdpEvent') {
      this._handleCdpEventFromExt(msg.params);
      return;
    }

    if (msg.method === 'tabDetached') {
      this._handleTabDetached(msg.params);
      return;
    }

    if (msg.method === 'tabUpdated') {
      this._handleTabUpdated(msg.params);
      return;
    }

    if (msg.method === 'manualTabAttached') {
      const { tabId, sessionId, targetId, targetInfo, origin, windowId } = msg.params;
      const allowedOrigins = new Set(['manual', 'agent-created', 'relay-attached']);
      const storedOrigin = allowedOrigins.has(origin) ? origin : 'unknown';
      const existingSessionId = this.tabToSession.get(tabId);
      const relaySessionId = existingSessionId || `bf-session-${++this.sessionCounter}`;
      const existing = this.targets.get(relaySessionId);
      const resolvedWindowId = integerWindowId(windowId ?? targetInfo?.windowId)
        ?? existing?.windowId;
      this.targets.set(relaySessionId, {
        tabId,
        targetId: targetId || `bf-target-${tabId}`,
        targetInfo: targetInfo || { url: '', title: '' },
        windowId: resolvedWindowId,
        debuggerAttached: true,
        // Preserve provenance when updating an existing tab; only overwrite when
        // the incoming origin is an allowlisted value. The legacy message name
        // is "manualTabAttached" but the payload may carry agent-created or
        // relay-attached provenance during reconnect replay.
        origin: existing?.origin && !allowedOrigins.has(origin) ? existing.origin : storedOrigin,
      });
      this.tabToSession.set(tabId, relaySessionId);

      // Notify connected CDP clients
      if (!existingSessionId) {
        for (const client of this.clients) {
          if (client.readyState === 1) { // WebSocket.OPEN
            const target = this.targets.get(relaySessionId);
            this._sendTargetCreatedEvent(client, target);
            this._sendAttachedEvent(client, relaySessionId, target);
          }
        }
      }
      return;
    }
  }

  /** Send command to extension, returns promise */
  _sendToExt(method, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ext || this.ext.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Extension not connected'));
        return;
      }

      const id = ++this.extMsgId;
      const timer = setTimeout(() => {
        this.extPending.delete(id);
        reject(new Error(`Extension command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.extPending.set(id, { resolve, reject, timer });
      this.ext.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // ─── Restrictions Guard (fail-closed) ──────────────────────────────────────

  /**
   * Fetch restrictions for the Target.createTarget guard. Fail-closed: every
   * inability-to-read path (extension missing, timeout, malformed response,
   * extension error, transport failure) returns manual+noNewTabs so tab
   * creation is blocked deterministically. Do not cache — settings can change
   * from the popup between requests.
   */
  async _getRestrictionsSafe() {
    try {
      const raw = await this._sendToExt('getRestrictions', {}, { timeoutMs: RESTRICTIONS_FETCH_TIMEOUT_MS });
      if (!raw || typeof raw !== 'object') {
        return RESTRICTIONS_FAIL_CLOSED;
      }
      return {
        mode: raw.mode === 'manual' ? 'manual' : 'auto',
        noNewTabs: !!raw.noNewTabs,
      };
    } catch {
      return RESTRICTIONS_FAIL_CLOSED;
    }
  }

  // ─── CDP Events from Extension ──────────────────────────────────────────

  _handleCdpEventFromExt({ tabId, method, params, childSessionId }) {
    const sessionId = this.tabToSession.get(tabId);
    if (!sessionId) {
      this._logCdp({
        direction: 'from-extension',
        message: { method, params, tabId, childSessionId },
      });
      return;
    }

    // Track child sessions (iframes / OOPIFs)
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      this.childSessions.set(params.sessionId, { tabId, parentSessionId: sessionId });
      // Index cross-origin iframe targets so Target.attachToTarget/getTargets can
      // resolve them. Store the NORMALIZED targetInfo so every command that returns
      // it stays consistent (browserContextId etc.).
      if (params.targetInfo?.type === 'iframe' && params.targetInfo.targetId) {
        this.oopifTargets.set(params.targetInfo.targetId, {
          childSessionId: params.sessionId,
          tabId,
          targetInfo: buildOopifTargetInfo(params.targetInfo),
        });
      }
    }
    if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      this.childSessions.delete(params.sessionId);
      for (const [targetId, info] of this.oopifTargets) {
        if (info.childSessionId === params.sessionId) this.oopifTargets.delete(targetId);
      }
    }

    // Route: child-session events must preserve the child session id so
    // Playwright can bind frame/OOPIF execution contexts to the right target.
    const outerSessionId = childSessionId || sessionId;

    this._logCdp({
      direction: 'from-extension',
      message: { method, params, tabId, sessionId: outerSessionId, childSessionId },
    });

    this._broadcastCdp({ method, params, sessionId: outerSessionId });
  }

  // Drop explicit-attach alias sessions matching a predicate. Aliases are created
  // by Target.attachToTarget (newCDPSession re-attach) and normally removed by
  // Target.detachFromTarget; this is the safety net for the paths where the owning
  // client or the underlying primary target goes away WITHOUT a clean detach, so
  // the map cannot grow unbounded across a long-lived daemon's many snapshots.
  _dropAliasSessions(predicate) {
    for (const [aliasId, entry] of this.aliasSessions) {
      if (predicate(aliasId, entry)) this.aliasSessions.delete(aliasId);
    }
  }

  _handleTabDetached({ tabId, reason }) {
    const sessionId = this.tabToSession.get(tabId);
    if (!sessionId) return;

    const target = this.targets.get(sessionId);

    // Clean up child sessions for this tab
    for (const [childId, child] of this.childSessions) {
      if (child.tabId === tabId) this.childSessions.delete(childId);
    }
    for (const [targetId, info] of this.oopifTargets) {
      if (info.tabId === tabId) this.oopifTargets.delete(targetId);
    }

    this.targets.delete(sessionId);
    this.tabToSession.delete(tabId);
    this._dropAliasSessions((_id, entry) => entry.primarySessionId === sessionId);

    this._broadcastCdp({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: target?.targetId },
    });

    log(`[relay] Tab ${tabId} detached (${reason})`);
  }

  _handleTabUpdated({ tabId, url, title }) {
    const sessionId = this.tabToSession.get(tabId);
    if (!sessionId) return;

    const target = this.targets.get(sessionId);
    if (!target) return;

    if (url) target.targetInfo.url = url;
    if (title) target.targetInfo.title = title;

    this._broadcastCdp({
      method: 'Target.targetInfoChanged',
      params: {
        targetInfo: {
          targetId: target.targetId,
          type: 'page',
          title: target.targetInfo.title || '',
          url: target.targetInfo.url || '',
          attached: true,
          browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
        },
      },
    });
  }

  // ─── CDP Client Connection ──────────────────────────────────────────────

  _onCdpConnect(ws, req) {
    const clientId = `bf-cdp-${++this.clientSeq}`;
    ws._bfClientId = clientId;
    if (this.clientMode === CLIENT_MODE_SINGLE) {
      const now = Date.now();
      this.activeClient = { id: clientId, ws, connectedAt: now, lastSeenAt: now };
    }
    const clientMeta = {
      id: clientId,
      label: this._deriveClientLabel(req),
      affinityLabel: this._explicitClientLabel(req),
      connectedAt: new Date().toISOString(),
      origin: req?.headers?.origin || null,
      userAgent: req?.headers?.['user-agent'] || null,
      remoteAddress: req?.socket?.remoteAddress || null,
    };
    this.clientMeta.set(ws, clientMeta);
    this.clientById.set(clientId, clientMeta);
    log(`[relay] CDP client connected (${clientId})`);
    this.clients.add(ws);

    ws.on('message', (data) => {
      if (this.clientMode === CLIENT_MODE_SINGLE && this.activeClient?.id === clientId) {
        this.activeClient.lastSeenAt = Date.now();
      }
      try {
        const msg = JSON.parse(data.toString());
        this._handleCdpClientMessage(ws, msg);
      } catch (e) {
        logErr('[relay] CDP client message error:', e.message);
      }
    });

    ws.on('close', () => {
      const meta = this.clientMeta.get(ws);
      log(`[relay] CDP client disconnected (${meta?.id || 'unknown'})`);
      if (meta?.id) {
        this.clientById.delete(meta.id);
        // Connection-keyed affinity dies with the connection; explicit-label
        // affinity (key 'label:...') survives so the next same-label client
        // reuses the agent window.
        if (!meta.affinityLabel) this.agentWindowByAffinityKey.delete(meta.id);
        // Drop any explicit-attach aliases this client never detached.
        this._dropAliasSessions((_id, entry) => entry.clientId === meta.id);
      }
      this.clients.delete(ws);
      if (this.activeClient?.ws === ws) {
        this.activeClient = null;
      }
    });

    ws.on('error', (err) => {
      logErr('[relay] CDP client WS error:', err.message);
    });
  }

  async _handleCdpClientMessage(ws, msg) {
    const clientId = this.clientMeta.get(ws)?.id || null;
    const { id, method, params, sessionId } = msg;
    this._logCdp({
      direction: 'from-playwright',
      clientId,
      message: { id, method, params, sessionId },
    });

    try {
      let result;
      if (sessionId && sessionId !== BF_BROWSER_SESSION_ID) {
        result = await this._forwardToTab(sessionId, method, params, id, clientId);
      } else {
        // No sessionId (connection root) OR the synthetic browser session that a
        // CDP client's newCDPSession() opens — both are browser-level. The
        // response below echoes `sessionId` (when present) so the client routes
        // it to the browser session's callback, mirroring real Chrome.
        result = await this._handleBrowserCommand(ws, id, method, params, clientId, sessionId);
      }
      if (result !== undefined) {
        const response = { id, result };
        if (sessionId) response.sessionId = sessionId;
        this._logCdp({
          direction: 'to-playwright',
          clientId,
          message: response,
        });
        ws.send(JSON.stringify(response));
      }
    } catch (err) {
      const response = {
        id,
        error: { code: -32000, message: err.message },
      };
      if (sessionId) response.sessionId = sessionId;
      this._logCdp({
        direction: 'to-playwright',
        clientId,
        message: response,
      });
      ws.send(JSON.stringify(response));
    }
  }

  async _handleBrowserCommand(ws, msgId, method, params, clientId, sessionId) {
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'BrowserForce/1.0',
          userAgent: 'BrowserForce',
          jsVersion: '',
        };

      case 'Target.setDiscoverTargets':
        // Emit targetCreated for all known targets
        for (const [, target] of this.targets) {
          this._sendTargetCreatedEvent(ws, target, clientId);
        }
        return {};

      case 'Target.setAutoAttach': {
        this.autoAttachEnabled = true;
        this.autoAttachParams = params;
        // Respond immediately, then attach tabs asynchronously. Echo the
        // incoming sessionId (e.g. BF_BROWSER_SESSION_ID, when a CDP client opens
        // newCDPSession and enables auto-attach on that browser session) so the
        // reply routes to the SENDING session's callback — matching the shared
        // response path below and avoiding the root-session
        // `_CRSession._onMessage` assertion this patch exists to eliminate.
        // Omitted for the connection root (no sessionId), unchanged from before.
        const autoAttachResponse = { id: msgId, result: {} };
        if (sessionId) autoAttachResponse.sessionId = sessionId;
        this._logCdp({
          direction: 'to-playwright',
          clientId,
          message: autoAttachResponse,
        });
        ws.send(JSON.stringify(autoAttachResponse));
        this._autoAttachAllTabs(ws).catch((e) => {
          logErr('[relay] Auto-attach error:', e.message);
        });
        return undefined; // Already sent response
      }

      case 'Target.getTargets':
        return {
          targetInfos: [
            ...[...this.targets.values()].map((t) => buildTargetInfo(t)),
            ...[...this.oopifTargets.values()].map((o) => o.targetInfo),
          ],
        };

      case 'Target.getTargetInfo': {
        if (params?.targetId) {
          for (const target of this.targets.values()) {
            if (target.targetId === params.targetId) {
              return { targetInfo: buildTargetInfo(target) };
            }
          }
          const oopif = this.oopifTargets.get(params.targetId);
          if (oopif) return { targetInfo: oopif.targetInfo };
        }
        // No targetId or unrecognized targetId → return browser target
        return {
          targetInfo: {
            targetId: params?.targetId || 'browser',
            type: 'browser',
            title: '',
            url: '',
            attached: true,
          },
        };
      }

      case 'Target.attachToBrowserTarget':
        // Playwright's newCDPSession() first opens a "client root session" via
        // Target.attachToBrowserTarget, then sends Target.attachToTarget ON that
        // session. We previously fell through to `default: {}` (no sessionId), so
        // the client's browser session had sessionId=undefined and sent the
        // follow-up attachToTarget with NO wire sessionId; our reply (also no
        // sessionId) routed to the client's ROOT session, which has no callback
        // for that id, tripping `_CRSession._onMessage`'s `assert(!object.id)`
        // and closing the socket. Returning a real (sentinel) browser sessionId —
        // and routing/echoing it (see _handleCdpClientMessage) — makes the client
        // tag the follow-up with this id and match the reply to its callback,
        // exactly as real Chrome does.
        return { sessionId: BF_BROWSER_SESSION_ID };

      case 'Target.attachToTarget': {
        // Sent on the browser session (above) by a CDP client's newCDPSession()/
        // attachToTarget(); the connect handshake discovers pages via
        // Target.setAutoAttach, never attachToTarget. Returning the page's PRIMARY
        // sessionId here would make the client register a SECOND CRSession under
        // that id, OVERWRITING the page's main session in its routing map — then
        // the next in-flight response for the (busy) page has no matching callback
        // and trips the same `assert(!object.id)`. Real Chrome hands out a NEW,
        // distinct flat session for an already-attached target, so mirror that:
        // return a fresh alias sessionId mapped to the same tab. Commands route to
        // the tab and responses are tagged with the alias; tab EVENTS stay on the
        // primary session (an explicit CDP session only needs command/replies —
        // e.g. the aria snapshot engine).
        for (const [primarySessionId, target] of this.targets) {
          if (target.targetId === params.targetId) {
            const aliasSessionId = `bf-alias-${++this.sessionCounter}`;
            // Tag with the owning clientId so the alias is dropped if that client
            // disconnects before it sends Target.detachFromTarget (see ws 'close').
            this.aliasSessions.set(aliasSessionId, { primarySessionId, clientId });
            return { sessionId: aliasSessionId };
          }
        }
        // Cross-origin iframe (OOPIF): resolve to the existing child sessionId.
        const oopif = this.oopifTargets.get(params.targetId);
        if (oopif) return { sessionId: oopif.childSessionId };
        throw new Error(`Target ${params.targetId} not found or not attached`);
      }

      case 'Target.detachFromTarget': {
        // A CDP client's CDPSession.detach() sends this on the parent/root
        // session with the alias in params.sessionId. Drop the alias mapping so
        // it does not accumulate; the real debugger stays attached for the
        // primary session. No-op for any non-alias sessionId.
        if (params?.sessionId) this.aliasSessions.delete(params.sessionId);
        return {};
      }

      case 'Target.createTarget':
        return this._createTarget(ws, params, clientId);

      case 'Target.closeTarget':
        return this._closeTarget(params);

      case 'Browser.setDownloadBehavior':
        return {};

      case 'Target.getBrowserContexts':
        return { browserContextIds: [DEFAULT_BROWSER_CONTEXT_ID] };

      default:
        // Unknown browser-level commands get a no-op response
        return {};
    }
  }

  // ─── Tab Management ─────────────────────────────────────────────────────

  async _autoAttachAllTabs(ws) {
    if (!this.ext) return;

    const { tabs } = await this._sendToExt('listTabs');
    const visibleTabs = Array.isArray(tabs) ? tabs : [];
    log(`[relay] Browser has ${visibleTabs.length} tab(s) — exposing as lazy targets`);

    const currentTabIds = new Set(
      visibleTabs
        .map((tab) => Number(tab?.tabId))
        .filter((tabId) => Number.isInteger(tabId)),
    );

    for (const [sessionId, target] of [...this.targets]) {
      if (
        target.origin === 'relay-discovered'
        && !target.debuggerAttached
        && !currentTabIds.has(target.tabId)
      ) {
        this.targets.delete(sessionId);
        this.tabToSession.delete(target.tabId);
        this._dropAliasSessions((_id, entry) => entry.primarySessionId === sessionId);
        this._broadcastCdp({
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId: target.targetId },
        });
      }
    }

    for (const tab of visibleTabs) {
      const tabId = Number(tab?.tabId);
      if (!Number.isInteger(tabId)) continue;
      const existingSessionId = this.tabToSession.get(tabId);
      const sessionId = existingSessionId || `bf-session-${++this.sessionCounter}`;
      const targetId = tab.targetId || `bf-target-${tabId}`;
      const existing = this.targets.get(sessionId);
      const isNewTarget = !existing;
      const targetInfo = {
        ...(existing?.targetInfo || {}),
        targetId: existing?.targetId || targetId,
        type: 'page',
        title: tab.title || '',
        url: tab.url || '',
        browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
      };

      // The extension persists agentCreatedTabs across SW restarts and
      // surfaces them here; relay memory of origins is wiped on extension
      // disconnect, so discovery is the only way to re-learn agent tabs.
      // Only 'agent-created' is accepted — 'manual' must come from a real
      // manualTabAttached notification, never from discovery.
      const discoveredOrigin = tab.origin === 'agent-created' ? 'agent-created' : undefined;

      this.targets.set(sessionId, {
        tabId,
        targetId: existing?.targetId || targetId,
        targetInfo,
        windowId: integerWindowId(tab.windowId) ?? existing?.windowId,
        debuggerAttached: !!existing?.debuggerAttached,
        attachPromise: existing?.attachPromise || null,
        origin: existing?.origin || discoveredOrigin || 'relay-discovered',
        // Keep the real-activity clock across client-reconnect rediscovery,
        // or every fresh connect would reset /attached-tabs idleMs to blank.
        lastCommandAt: existing?.lastCommandAt,
      });
      this.tabToSession.set(tabId, sessionId);
      if (isNewTarget) {
        this._sendTargetCreatedEvent(ws, this.targets.get(sessionId));
      }
    }

    for (const [sessionId, target] of this.targets) {
      this._sendAttachedEvent(ws, sessionId, target);
    }
  }

  /** Attach debugger to a tab on demand (lazy). Race-safe via attachPromise. */
  async _ensureDebuggerAttached(target, sessionId) {
    if (target.debuggerAttached) return;

    // If another command already triggered attachment, wait for it
    if (target.attachPromise) {
      await target.attachPromise;
      return;
    }

    target.attachPromise = (async () => {
      try {
        log(`[relay] Lazy-attaching debugger to tab ${target.tabId} (triggered by: ${target._triggerMethod || '?'}) ${target.targetInfo?.url}`);
        // Preserve manual/agent-created provenance; only anonymous discoveries
        // become relay-attached. Demoting agent-created would exempt the tab
        // from auto-close after any SW-restart re-adoption.
        const preservedOrigin = (target.origin === 'manual' || target.origin === 'agent-created')
          ? target.origin
          : 'relay-attached';
        const result = await this._sendToExt('attachTab', {
          tabId: target.tabId,
          sessionId,
          origin: preservedOrigin,
        });
        if (result.targetId) target.chromeTargetId = result.targetId;
        if (result.targetInfo) {
          target.targetInfo = {
            ...result.targetInfo,
            targetId: target.targetId,
            browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
          };
        }
        target.debuggerAttached = true;
        target.origin = preservedOrigin;
      } finally {
        // ALWAYS clear, including on failure: a rejected attachPromise would
        // otherwise stick to the target (rediscovery preserves attachPromise)
        // and instantly re-throw the stale error for every later command —
        // the tab would be permanently unusable until relay restart. Clearing
        // lets the next real command retry the attach (e.g. after a frozen
        // tab wakes up). In-flight waiters still see this attempt's outcome.
        target.attachPromise = null;
      }
    })();

    await target.attachPromise;
  }

  _sendTargetCreatedEvent(ws, target, clientId) {
    const event = {
      method: 'Target.targetCreated',
      params: {
        targetInfo: buildTargetInfo(target),
      },
    };
    this._logCdp({
      direction: 'to-playwright',
      clientId,
      message: event,
    });
    ws.send(JSON.stringify(event));
  }

  _sendAttachedEvent(ws, sessionId, target) {
    const event = {
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: buildTargetInfo(target),
        waitingForDebugger: false,
      },
    };
    this._logCdp({
      direction: 'to-playwright',
      message: event,
    });
    ws.send(JSON.stringify(event));
  }

  // Affinity key for a CDP client: explicit labels are durable across
  // reconnects ('label:<label>'); unlabeled clients fall back to their
  // connection id (cleared on disconnect).
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

  // Pin the agent to a window on its first real tab use so later created tabs
  // stay in that window. Uses one predicate (Number.isInteger) and only the
  // first suitable window wins per affinity key.
  _seedAgentWindowAffinity(clientId, target) {
    const key = this._affinityKey(clientId);
    if (!key || this.agentWindowByAffinityKey.has(key)) return;
    const windowId = target?.windowId ?? target?.targetInfo?.windowId;
    if (Number.isInteger(windowId)) {
      this._pinAgentWindow(key, windowId);
    }
  }

  async _createTarget(ws, params, clientId) {
    // Fail-closed guard: block tab creation in attached-only/no-new-tabs
    // sessions, including when restrictions cannot be read from the extension.
    const restrictions = await this._getRestrictionsSafe();
    if (restrictions.mode === 'manual' || restrictions.noNewTabs) {
      throw new Error('New tabs are disabled in BrowserForce attached-tab mode.');
    }

    const sessionId = `s${++this.sessionCounter}`;
    const createParams = {
      url: params.url || 'about:blank',
      sessionId,
    };
    // Pin the new tab to the agent's established window when we have one.
    const affinityKey = this._affinityKey(clientId);
    const pinnedWindowId = affinityKey
      ? this.agentWindowByAffinityKey.get(affinityKey)
      : undefined;
    const sentPinned = Number.isInteger(pinnedWindowId);
    if (sentPinned) createParams.windowId = pinnedWindowId;

    const result = await this._sendToExt('createTab', createParams);

    // Re-pin affinity from the window the extension actually used:
    // - sentPinned → overwrite. Closed-window refresh: if the pinned window was
    //   gone, the extension fell back to the current window and returned its
    //   real windowId, so re-pin there (no-op when the window was still open).
    // - otherwise → establish first-wins only when no affinity exists yet.
    //   NOTE: with true-concurrent first creates (the user changing focus
    //   between two extension-handled creates) the tabs may land in different
    //   windows, but affinity still resolves deterministically to the first
    //   established window. Playwright awaits newPage() sequentially, so a
    //   per-client serialization queue would be over-engineering.
    const resultWindowId = integerWindowId(
      result.windowId ?? result.targetInfo?.windowId
    );
    if (affinityKey && resultWindowId !== undefined) {
      if (sentPinned || !this.agentWindowByAffinityKey.has(affinityKey)) {
        this._pinAgentWindow(affinityKey, resultWindowId);
      }
    }

    const target = {
      tabId: result.tabId,
      targetId: result.targetId,
      targetInfo: result.targetInfo,
      windowId: resultWindowId,
      debuggerAttached: true, // createTab attaches debugger immediately
      attachPromise: null,
      origin: 'agent-created',
    };
    this.targets.set(sessionId, target);
    this.tabToSession.set(result.tabId, sessionId);

    // Broadcast attachedToTarget to ALL clients. Shape the outbound targetInfo
    // through buildTargetInfo, preserving the url fallback for empty titles/urls.
    this._broadcastCdp({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: buildTargetInfo({
          targetId: result.targetId,
          windowId: resultWindowId,
          targetInfo: {
            ...result.targetInfo,
            url: result.targetInfo?.url || params.url || 'about:blank',
          },
        }),
        waitingForDebugger: false,
      },
    });

    return { targetId: result.targetId };
  }

  async _closeTarget(params) {
    let tabId;
    let sessionId;

    for (const [sid, target] of this.targets) {
      if (target.targetId === params.targetId) {
        tabId = target.tabId;
        sessionId = sid;
        break;
      }
    }

    if (!tabId) throw new Error('Target not found');

    await this._sendToExt('closeTab', { tabId });

    // Clean up child sessions
    for (const [childId, child] of this.childSessions) {
      if (child.tabId === tabId) this.childSessions.delete(childId);
    }
    for (const [targetId, info] of this.oopifTargets) {
      if (info.tabId === tabId) this.oopifTargets.delete(targetId);
    }

    this.targets.delete(sessionId);
    this.tabToSession.delete(tabId);
    this._dropAliasSessions((_id, entry) => entry.primarySessionId === sessionId);

    this._broadcastCdp({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: params.targetId },
    });

    return { success: true };
  }

  // ─── CDP Command Forwarding ─────────────────────────────────────────────

  async _forwardToTab(sessionId, method, params, id, clientId) {
    // Main session
    const target = this.targets.get(sessionId);
    if (target) {
      if (!target.debuggerAttached) {
        // Playwright sends init-only commands to every page it learns about.
        // Return synthetic {} so we never attach the debugger until the AI
        // actually uses the tab — preserves dark mode and avoids the automation
        // info bar on every open tab.
        if (INIT_ONLY_METHODS.has(method)) {
          return syntheticInitResponse(method, target);
        }
        // First real (non-init) command on this tab pins the agent's window
        // affinity, so later created tabs land in the same window even after
        // the user changes Chrome focus.
        this._seedAgentWindowAffinity(clientId, target);
        target.lastCommandAt = Date.now();
        target._triggerMethod = method;
        await this._ensureDebuggerAttached(target, sessionId);
      } else if (!INIT_ONLY_METHODS.has(method)) {
        this._seedAgentWindowAffinity(clientId, target);
        // Real-activity clock for /attached-tabs observability (init storm
        // excluded, mirroring the extension's passive-flag idle semantics).
        target.lastCommandAt = Date.now();
      }
      this._logCdp({
        direction: 'to-extension',
        clientId,
        message: {
          id,
          method,
          params: params || {},
          sessionId,
          tabId: target.tabId,
        },
      });
      const payload = {
        tabId: target.tabId,
        method,
        params: params || {},
      };
      // Init storm (Playwright re-sends ~40 init commands per reconnect) must
      // not reset the extension's per-tab idle clock, or auto-close never fires.
      if (INIT_ONLY_METHODS.has(method)) payload.passive = true;
      return this._sendToExt('cdpCommand', payload);
    }

    // Alias session: an explicit newCDPSession() re-attach to an already-attached
    // page (see Target.attachToTarget). It IS the page's main target, so route to
    // the primary target's tab with no childSessionId, mirroring the primary
    // path's lazy-attach + init-only handling. Tab events stay on the primary
    // session; only command responses (tagged with this alias) come back here.
    const aliasEntry = this.aliasSessions.get(sessionId);
    if (aliasEntry) {
      const aliasPrimarySessionId = aliasEntry.primarySessionId;
      const primaryTarget = this.targets.get(aliasPrimarySessionId);
      if (!primaryTarget) {
        this.aliasSessions.delete(sessionId);
        throw new Error(`Session '${sessionId}' not found`);
      }
      if (!primaryTarget.debuggerAttached) {
        if (INIT_ONLY_METHODS.has(method)) {
          return syntheticInitResponse(method, primaryTarget);
        }
        this._seedAgentWindowAffinity(clientId, primaryTarget);
        primaryTarget.lastCommandAt = Date.now();
        primaryTarget._triggerMethod = method;
        await this._ensureDebuggerAttached(primaryTarget, aliasPrimarySessionId);
      } else if (!INIT_ONLY_METHODS.has(method)) {
        // Alias sessions (newCDPSession) carry real work — e.g. the snapshot
        // engine's AX fetches — so they count as activity and seed affinity
        // exactly like the main-session path.
        this._seedAgentWindowAffinity(clientId, primaryTarget);
        primaryTarget.lastCommandAt = Date.now();
      }
      this._logCdp({
        direction: 'to-extension',
        clientId,
        message: {
          id,
          method,
          params: params || {},
          sessionId,
          tabId: primaryTarget.tabId,
          aliasOf: aliasPrimarySessionId,
        },
      });
      const aliasPayload = {
        tabId: primaryTarget.tabId,
        method,
        params: params || {},
      };
      if (INIT_ONLY_METHODS.has(method)) aliasPayload.passive = true;
      return this._sendToExt('cdpCommand', aliasPayload);
    }

    // Child session (iframe / OOPIF)
    const child = this.childSessions.get(sessionId);
    if (child) {
      // Ensure parent tab's debugger is attached
      const parentSessionId = this.tabToSession.get(child.tabId);
      const parentTarget = parentSessionId && this.targets.get(parentSessionId);
      if (parentTarget && !parentTarget.debuggerAttached) {
        await this._ensureDebuggerAttached(parentTarget, parentSessionId);
      }
      // OOPIF work is real activity on the parent tab.
      if (parentTarget && !INIT_ONLY_METHODS.has(method)) {
        this._seedAgentWindowAffinity(clientId, parentTarget);
        parentTarget.lastCommandAt = Date.now();
      }
      this._logCdp({
        direction: 'to-extension',
        clientId,
        message: {
          id,
          method,
          params: params || {},
          sessionId,
          tabId: child.tabId,
          childSessionId: sessionId,
          parentSessionId,
        },
      });
      const childPayload = {
        tabId: child.tabId,
        method,
        params: params || {},
        childSessionId: sessionId,
      };
      if (INIT_ONLY_METHODS.has(method)) childPayload.passive = true;
      return this._sendToExt('cdpCommand', childPayload);
    }

    throw new Error(`Session '${sessionId}' not found`);
  }

  // ─── Broadcast ──────────────────────────────────────────────────────────

  _broadcastCdp(msg) {
    this._logCdp({
      direction: 'to-playwright',
      message: msg,
    });
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  stop() {
    clearInterval(this.pingTimer);
    this.server?.close();
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { RelayServer, DEFAULT_PORT, BF_DIR, TOKEN_FILE, CDP_URL_FILE };

// ─── CLI Entry ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const port = parseInt(process.env.RELAY_PORT || process.argv[2] || DEFAULT_PORT, 10);
  const relay = new RelayServer(port);
  relay.start();

  process.on('SIGINT', () => {
    log('\n[relay] Shutting down...');
    relay.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    relay.stop();
    process.exit(0);
  });
}
