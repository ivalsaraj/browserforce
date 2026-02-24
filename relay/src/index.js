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

const BF_DIR = path.join(os.homedir(), '.browserforce');
const TOKEN_FILE = path.join(BF_DIR, 'auth-token');
const CDP_URL_FILE = path.join(BF_DIR, 'cdp-url');
const BF_PLUGINS_DIR = path.join(BF_DIR, 'plugins');

// ─── Logging ─────────────────────────────────────────────────────────────────

function ts() { return new Date().toTimeString().slice(0, 8); }
function log(...args) { console.log(`[${ts()}]`, ...args); }
function logErr(...args) { console.error(`[${ts()}]`, ...args); }

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

// ─── RelayServer ─────────────────────────────────────────────────────────────

const DEFAULT_BROWSER_CONTEXT_ID = 'bf-default-context';

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
  'Page.createIsolatedWorld',                  // Playwright uses _sendMayFail — response ignored
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

class RelayServer {
  constructor(port = DEFAULT_PORT, pluginsDir = BF_PLUGINS_DIR) {
    this.port = port;
    this.pluginsDir = pluginsDir;
    this.authToken = getOrCreateAuthToken();

    // Extension connection (single slot)
    this.ext = null;
    this.extMsgId = 0;
    this.extPending = new Map(); // id -> { resolve, reject, timer }
    this.pingTimer = null;

    // CDP clients
    this.clients = new Set();

    // Target tracking
    this.targets = new Map();      // sessionId -> { tabId, targetId, targetInfo }
    this.tabToSession = new Map(); // tabId -> sessionId
    this.childSessions = new Map(); // childSessionId -> { tabId, parentSessionId }
    this.sessionCounter = 0;

    // State
    this.autoAttachEnabled = false;
    this.autoAttachParams = null;

    // Pending extension reload ack resolver (at most one at a time)
    this._extReloadResolve = null;

    // CDP traffic logger, initialized on start.
    this.cdpLogger = null;
  }

  start({ writeCdpUrl = true } = {}) {
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
    this.extWss.on('connection', (ws) => this._onExtConnect(ws));
    this.cdpWss.on('connection', (ws) => this._onCdpConnect(ws));

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
    if (!this.cdpLogger || typeof this.cdpLogger.log !== 'function') {
      return;
    }
    this.cdpLogger.log({
      timestamp: new Date().toISOString(),
      ...entry,
    });
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────

  async _handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/') {
      res.end(JSON.stringify({
        status: 'ok',
        extension: !!this.ext,
        targets: this.targets.size,
        clients: this.clients.size,
      }));
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

    // ─── Plugin Routes ───────────────────────────────────────────────────────

    if (url.pathname === '/plugins' && req.method === 'GET') {
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

    if (url.pathname === '/plugins/install' && req.method === 'POST') {
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

    const deleteMatch = url.pathname.match(/^\/plugins\/([a-z0-9_-]+)$/);
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

  // ─── WebSocket Upgrade ───────────────────────────────────────────────────

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/extension') {
      // Validate origin
      const origin = req.headers.origin || '';
      if (!origin.startsWith('chrome-extension://')) {
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
      this.cdpWss.handleUpgrade(req, socket, head, (ws) => {
        this.cdpWss.emit('connection', ws, req);
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }

  // ─── Extension Connection ────────────────────────────────────────────────

  _onExtConnect(ws) {
    log('[relay] Extension connected');
    this.ext = { ws };

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
      const { tabId, sessionId, targetId, targetInfo } = msg.params;
      const relaySessionId = `bf-session-${++this.sessionCounter}`;
      this.targets.set(relaySessionId, {
        tabId,
        targetId: targetId || `bf-target-${tabId}`,
        targetInfo: targetInfo || { url: '', title: '' },
        debuggerAttached: true,
      });
      this.tabToSession.set(tabId, relaySessionId);

      // Notify connected CDP clients
      for (const client of this.clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
          this._sendAttachedEvent(client, relaySessionId, this.targets.get(relaySessionId));
        }
      }
      return;
    }
  }

  /** Send command to extension, returns promise */
  _sendToExt(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ext || this.ext.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Extension not connected'));
        return;
      }

      const id = ++this.extMsgId;
      const timer = setTimeout(() => {
        this.extPending.delete(id);
        reject(new Error(`Extension command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.extPending.set(id, { resolve, reject, timer });
      this.ext.ws.send(JSON.stringify({ id, method, params }));
    });
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
    }
    if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      this.childSessions.delete(params.sessionId);
    }

    // Route: child session events go under the parent's sessionId
    const outerSessionId = childSessionId
      ? (this.childSessions.get(childSessionId)?.parentSessionId || sessionId)
      : sessionId;

    this._logCdp({
      direction: 'from-extension',
      message: { method, params, tabId, sessionId: outerSessionId, childSessionId },
    });

    this._broadcastCdp({ method, params, sessionId: outerSessionId });
  }

  _handleTabDetached({ tabId, reason }) {
    const sessionId = this.tabToSession.get(tabId);
    if (!sessionId) return;

    const target = this.targets.get(sessionId);

    // Clean up child sessions for this tab
    for (const [childId, child] of this.childSessions) {
      if (child.tabId === tabId) this.childSessions.delete(childId);
    }

    this.targets.delete(sessionId);
    this.tabToSession.delete(tabId);

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

  _onCdpConnect(ws) {
    log('[relay] CDP client connected');
    this.clients.add(ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleCdpClientMessage(ws, msg);
      } catch (e) {
        logErr('[relay] CDP client message error:', e.message);
      }
    });

    ws.on('close', () => {
      log('[relay] CDP client disconnected');
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      logErr('[relay] CDP client WS error:', err.message);
    });
  }

  async _handleCdpClientMessage(ws, msg) {
    const { id, method, params, sessionId } = msg;
    this._logCdp({
      direction: 'from-playwright',
      message: { id, method, params, sessionId },
    });

    try {
      let result;
      if (sessionId) {
        result = await this._forwardToTab(sessionId, method, params, id);
      } else {
        result = await this._handleBrowserCommand(ws, id, method, params);
      }
      if (result !== undefined) {
        const response = { id, result };
        if (sessionId) response.sessionId = sessionId;
        this._logCdp({
          direction: 'to-playwright',
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
        message: response,
      });
      ws.send(JSON.stringify(response));
    }
  }

  async _handleBrowserCommand(ws, msgId, method, params) {
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
          const event = {
            method: 'Target.targetCreated',
            params: {
              targetInfo: {
                targetId: target.targetId,
                type: 'page',
                title: target.targetInfo?.title || '',
                url: target.targetInfo?.url || '',
                attached: true,
                browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
              },
            },
          };
          this._logCdp({
            direction: 'to-playwright',
            message: event,
          });
          ws.send(JSON.stringify(event));
        }
        return {};

      case 'Target.setAutoAttach':
        this.autoAttachEnabled = true;
        this.autoAttachParams = params;
        // Respond immediately, then attach tabs asynchronously
        this._logCdp({
          direction: 'to-playwright',
          message: { id: msgId, result: {} },
        });
        ws.send(JSON.stringify({ id: msgId, result: {} }));
        this._autoAttachAllTabs(ws).catch((e) => {
          logErr('[relay] Auto-attach error:', e.message);
        });
        return undefined; // Already sent response

      case 'Target.getTargets':
        return {
          targetInfos: [...this.targets.values()].map((t) => ({
            targetId: t.targetId,
            type: 'page',
            title: t.targetInfo?.title || '',
            url: t.targetInfo?.url || '',
            attached: true,
            browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
          })),
        };

      case 'Target.getTargetInfo': {
        if (params?.targetId) {
          for (const target of this.targets.values()) {
            if (target.targetId === params.targetId) {
              return {
                targetInfo: {
                  targetId: target.targetId,
                  type: 'page',
                  title: target.targetInfo?.title || '',
                  url: target.targetInfo?.url || '',
                  attached: true,
                  browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
                },
              };
            }
          }
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

      case 'Target.attachToTarget': {
        // Find already-attached target by targetId
        for (const [sessionId, target] of this.targets) {
          if (target.targetId === params.targetId) {
            return { sessionId };
          }
        }
        throw new Error(`Target ${params.targetId} not found or not attached`);
      }

      case 'Target.createTarget':
        return this._createTarget(ws, params);

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
    log(`[relay] Browser has ${tabs.length} tab(s) — agent creates own tabs via context.newPage()`);

    // Re-emit attachedToTarget for already-tracked targets (reconnection case)
    for (const [sessionId, target] of this.targets) {
      this._sendAttachedEvent(ws, sessionId, target);
    }

    // Do NOT auto-attach existing browser tabs. Lazy attachment creates broken
    // Playwright Page objects because INIT_ONLY_METHODS fakes Runtime.enable,
    // so Playwright never gets executionContextCreated events → page.evaluate()
    // deadlocks. Instead, the agent creates tabs via context.newPage() which
    // eagerly attaches the debugger via _createTarget.
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
      log(`[relay] Lazy-attaching debugger to tab ${target.tabId} (triggered by: ${target._triggerMethod || '?'}) ${target.targetInfo?.url}`);
      const result = await this._sendToExt('attachTab', {
        tabId: target.tabId,
        sessionId,
      });
      if (result.targetId) target.targetId = result.targetId;
      if (result.targetInfo) target.targetInfo = result.targetInfo;
      target.debuggerAttached = true;
      target.attachPromise = null;
    })();

    await target.attachPromise;
  }

  _sendAttachedEvent(ws, sessionId, target) {
    const event = {
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: {
          targetId: target.targetId,
          type: 'page',
          title: target.targetInfo?.title || '',
          url: target.targetInfo?.url || '',
          attached: true,
          browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
        },
        waitingForDebugger: false,
      },
    };
    this._logCdp({
      direction: 'to-playwright',
      message: event,
    });
    ws.send(JSON.stringify(event));
  }

  async _createTarget(ws, params) {
    const sessionId = `s${++this.sessionCounter}`;
    const result = await this._sendToExt('createTab', {
      url: params.url || 'about:blank',
      sessionId,
    });

    this.targets.set(sessionId, {
      tabId: result.tabId,
      targetId: result.targetId,
      targetInfo: result.targetInfo,
      debuggerAttached: true, // createTab attaches debugger immediately
      attachPromise: null,
    });
    this.tabToSession.set(result.tabId, sessionId);

    // Broadcast attachedToTarget to ALL clients
    this._broadcastCdp({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: {
          targetId: result.targetId,
          type: 'page',
          title: result.targetInfo?.title || '',
          url: result.targetInfo?.url || params.url || 'about:blank',
          attached: true,
          browserContextId: DEFAULT_BROWSER_CONTEXT_ID,
        },
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

    this.targets.delete(sessionId);
    this.tabToSession.delete(tabId);

    this._broadcastCdp({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: params.targetId },
    });

    return { success: true };
  }

  // ─── CDP Command Forwarding ─────────────────────────────────────────────

  async _forwardToTab(sessionId, method, params, id) {
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
        target._triggerMethod = method;
        await this._ensureDebuggerAttached(target, sessionId);
      }
      this._logCdp({
        direction: 'to-extension',
        message: {
          id,
          method,
          params: params || {},
          sessionId,
          tabId: target.tabId,
        },
      });
      return this._sendToExt('cdpCommand', {
        tabId: target.tabId,
        method,
        params: params || {},
      });
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
      this._logCdp({
        direction: 'to-extension',
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
      return this._sendToExt('cdpCommand', {
        tabId: child.tabId,
        method,
        params: params || {},
        childSessionId: sessionId,
      });
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
