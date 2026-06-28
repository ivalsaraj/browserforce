const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocket } = require('ws');
const { RelayServer, DEFAULT_PORT, BF_DIR } = require('../src/index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find a free port to avoid collisions between tests */
function getRandomPort() {
  return 19300 + Math.floor(Math.random() * 700);
}

/** HTTP GET as a promise */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

/** HTTP GET with custom headers */
function httpGetWithHeaders(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname + opts.search,
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw HTTP GET that lets the test control the exact inbound Host header (bypasses URL-derived host). */
function rawHttpGet({ port, path: reqPath = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method: 'GET',
      headers,
    }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Install an extension fixture that makes relay getRestrictions fail in a
 * specific mode, for the Target.createTarget fail-closed guard tests.
 * Returns a cleanup function (or null for extension-missing). Records every
 * command the extension sees into seenExtensionCommands.
 */
async function installRestrictionsFailureFixture(mode, { seenExtensionCommands, port }) {
  if (mode === 'extension-missing') {
    return null; // no extension connected; cleanup is a no-op
  }

  const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
    headers: { Origin: 'chrome-extension://test' },
  });

  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
    if (msg.id !== undefined) seenExtensionCommands.push(msg);

    if (msg.id && msg.method === 'getRestrictions') {
      if (mode === 'timeout') {
        // Intentionally do not respond — let the relay time out.
        return;
      }
      if (mode === 'malformed-response') {
        ext.send(JSON.stringify({ id: msg.id, result: 'not-an-object' }));
        return;
      }
      if (mode === 'extension-error') {
        ext.send(JSON.stringify({ id: msg.id, error: 'restrictions unavailable' }));
        return;
      }
      if (mode === 'transport-failure') {
        // Drop the transport mid-request to simulate a WS failure.
        ext.close();
        return;
      }
    }

    if (msg.id && msg.method === 'createTab') {
      // Defensive: should never be reached, but respond so a regression
      // doesn't hang the test.
      ext.send(JSON.stringify({
        id: msg.id,
        result: { tabId: 999, targetId: 't-999', targetInfo: { url: 'about:blank', title: '' } },
      }));
    }
  });

  return async () => { ext.close(); await sleep(50); };
}

/** Connect a WebSocket and wait for open */
function connectWs(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect timeout'));
    }, 3000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Read one message from a WebSocket */
function readMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS read timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Send a JSON message and read the response (matched by id) */
async function sendAndReceive(ws, msg, timeoutMs = 3000) {
  ws.send(JSON.stringify(msg));
  return readMessage(ws, timeoutMs);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJsonlEntries(logFilePath) {
  const raw = fs.readFileSync(logFilePath, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForCondition(check, {
  timeoutMs = 3000,
  intervalMs = 25,
  description = 'condition',
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
}

// ─── Token Persistence ───────────────────────────────────────────────────────

describe('Token Persistence', () => {
  const tmpDir = path.join(os.tmpdir(), `bf-test-${crypto.randomBytes(4).toString('hex')}`);
  const origBfDir = BF_DIR;

  it('defaults to multi-client mode', () => {
    delete process.env.BF_CLIENT_MODE;
    const relay = new RelayServer(getRandomPort());
    assert.equal(relay.clientMode, 'multi-client');
  });

  it('creates auth token file on first run', () => {
    // RelayServer reads token from the global BF_DIR.
    // We just verify the token is a non-empty string.
    const relay = new RelayServer(getRandomPort());
    assert.ok(relay.authToken, 'authToken should be set');
    assert.ok(relay.authToken.length >= 20, 'authToken should be at least 20 chars');
  });

  it('token is stable across RelayServer instances', () => {
    const a = new RelayServer(getRandomPort());
    const b = new RelayServer(getRandomPort());
    assert.equal(a.authToken, b.authToken, 'Same token file means same token');
  });
});

// ─── HTTP Endpoints ──────────────────────────────────────────────────────────

describe('HTTP Endpoints', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200); // Wait for server to bind
  });

  after(() => {
    relay.stop();
  });

  it('GET / returns health status', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.extension, false);
    assert.equal(body.targets, 0);
    assert.equal(body.clients, 0);
  });

  it('GET /json/version returns CDP discovery info', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/json/version`);
    assert.equal(status, 200);
    assert.ok(body.Browser.includes('BrowserForce'));
    assert.equal(body['Protocol-Version'], '1.3');
    assert.ok(body.webSocketDebuggerUrl.includes(`token=${relay.authToken}`));
  });

  it('GET /json/list returns empty array when no targets', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('GET /json is alias for /json/list', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/json`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /unknown returns 404', async () => {
    const { status } = await httpGet(`http://127.0.0.1:${port}/unknown`);
    assert.equal(status, 404);
  });
});

describe('Chatd URL Endpoint', () => {
  let relay;
  let port;
  const chatdUrlPath = path.join(BF_DIR, 'chatd-url.json');

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
    fs.rmSync(chatdUrlPath, { force: true });
  });

  after(() => {
    relay.stop();
    fs.rmSync(chatdUrlPath, { force: true });
  });

  it('GET /chatd-url returns 404 when chatd not running', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/chatd-url`, {
      Origin: 'chrome-extension://test',
    });
    assert.equal(status, 404);
    assert.match(body.error, /chatd not running/);

    ext.close();
    await sleep(50);
  });

  it('GET /chatd-url returns 404 when metadata is stale', async () => {
    fs.writeFileSync(chatdUrlPath, JSON.stringify({ port: 65534, token: 'stale' }));

    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/chatd-url`, {
      Origin: 'chrome-extension://test',
    });
    assert.equal(status, 404);
    assert.match(body.error, /chatd not running/);

    ext.close();
    await sleep(50);
  });

  it('GET /chatd-url accepts extension id header when Origin is absent', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/chatd-url`, {
      'x-browserforce-extension-id': 'abcdefghijklmnopabcdefghijklmnop',
    });
    assert.equal(status, 404);
    assert.match(body.error, /chatd not running/);

    ext.close();
    await sleep(50);
  });

  it('GET /chatd-url rejects mismatched extension id header', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/chatd-url`, {
      'x-browserforce-extension-id': 'ponmlkjihgfedcbaponmlkjihgfedcba',
    });
    assert.equal(status, 403);
    assert.match(body.error, /origin mismatch/);

    ext.close();
    await sleep(50);
  });
});

// ─── Logs Viewer Endpoints ───────────────────────────────────────────────────

describe('Logs Viewer Endpoints', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('GET /logs/status requires chrome-extension origin', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/logs/status`);
    assert.equal(status, 403);
    assert.match(body.error, /extension origin required/);
  });

  it('GET /logs/cdp requires chrome-extension origin', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/logs/cdp`);
    assert.equal(status, 403);
    assert.match(body.error, /extension origin required/);
  });

  it('GET /logs/status returns active client metadata and direction counters', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    cdp.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    await readMessage(cdp, 3000);

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/logs/status`, {
      Origin: 'chrome-extension://test',
    });
    assert.equal(status, 200);
    assert.equal(body.clients.count, 1);
    assert.ok(Array.isArray(body.clients.items));
    assert.equal(body.clients.items.length, 1);
    assert.match(body.clients.items[0].id, /^bf-(cdp|client)-\d+$/);
    assert.ok(body.clients.items[0].label, 'client label should be present');
    assert.ok(body.logs.directionCounts.fromPlaywright >= 1);
    assert.ok(body.logs.directionCounts.toPlaywright >= 1);

    cdp.close();
    ext.close();
    await sleep(50);
  });

  it('GET /logs/status accepts extension referer when Origin is absent', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/logs/status`, {
      Referer: 'chrome-extension://test/options.html',
    });
    assert.equal(status, 200);
    assert.equal(body.extension?.connected, true);

    ext.close();
    await sleep(50);
  });

  it('GET /logs/cdp supports incremental polling with after/limit', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    cdp.send(JSON.stringify({ id: 10, method: 'Browser.getVersion' }));
    await readMessage(cdp, 3000);

    const first = await httpGetWithHeaders(`http://127.0.0.1:${port}/logs/cdp?after=0&limit=200`, {
      Origin: 'chrome-extension://test',
    });
    assert.equal(first.status, 200);
    assert.ok(Array.isArray(first.body.entries));
    assert.ok(first.body.entries.length > 0);
    const newestSeq = first.body.latestSeq;
    const hasBrowserGetVersion = first.body.entries.some((entry) => entry.message?.method === 'Browser.getVersion');
    assert.equal(hasBrowserGetVersion, true, 'Should include Browser.getVersion CDP entry');

    const second = await httpGetWithHeaders(`http://127.0.0.1:${port}/logs/cdp?after=${newestSeq}&limit=200`, {
      Origin: 'chrome-extension://test',
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.entries.length, 0);
    assert.equal(second.body.after, newestSeq);
    assert.equal(second.body.resetRequired, false);

    cdp.close();
    ext.close();
    await sleep(50);
  });

  it('GET /logs/status rejects extension origins that do not match connected extension', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/logs/status`, {
      Origin: 'chrome-extension://other',
    });
    assert.equal(status, 403);
    assert.match(body.error, /origin mismatch/);

    ext.close();
    await sleep(50);
  });
});

// ─── Plugin Endpoints ────────────────────────────────────────────────────────

describe('Plugin API Endpoints', () => {
  let relay, port, pluginsDir;

  before(async () => {
    port = getRandomPort();
    pluginsDir = path.join(os.tmpdir(), `bf-plugins-test-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(pluginsDir, { recursive: true });
    relay = new RelayServer(port, pluginsDir);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
    fs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  function httpRequest(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const opts = new URL(url);
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request({
        hostname: opts.hostname, port: opts.port,
        path: opts.pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('GET /plugins returns empty list when no plugins installed', async () => {
    const { status, body } = await httpRequest('GET', `http://127.0.0.1:${port}/plugins`);
    assert.equal(status, 200);
    assert.deepEqual(body, { plugins: [] });
  });

  it('GET /plugins returns installed plugin names', async () => {
    fs.mkdirSync(path.join(pluginsDir, 'my-plugin'), { recursive: true });
    const { status, body } = await httpRequest('GET', `http://127.0.0.1:${port}/plugins`);
    assert.equal(status, 200);
    assert.ok(body.plugins.includes('my-plugin'));
    fs.rmSync(path.join(pluginsDir, 'my-plugin'), { recursive: true });
  });

  it('POST /plugins/install requires Bearer token', async () => {
    const { status, body } = await httpRequest('POST', `http://127.0.0.1:${port}/plugins/install`, { name: 'test' });
    assert.equal(status, 401);
    assert.ok(body.error.includes('Unauthorized'));
  });

  it('DELETE /plugins/:name requires Bearer token', async () => {
    const { status } = await httpRequest('DELETE', `http://127.0.0.1:${port}/plugins/test`, null, {});
    assert.equal(status, 401);
  });

  it('DELETE /plugins/:name returns 404 for non-existent plugin', async () => {
    const { status, body } = await httpRequest('DELETE', `http://127.0.0.1:${port}/plugins/ghost`, null, {
      Authorization: `Bearer ${relay.authToken}`,
      Origin: 'chrome-extension://test',
    });
    assert.equal(status, 404);
    assert.ok(body.error.includes('"ghost"'));
  });

  it('DELETE /plugins/:name removes installed plugin dir', async () => {
    const pluginPath = path.join(pluginsDir, 'to-remove');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'index.js'), 'module.exports = {};');

    const { status, body } = await httpRequest('DELETE', `http://127.0.0.1:${port}/plugins/to-remove`, null, {
      Authorization: `Bearer ${relay.authToken}`,
      Origin: 'chrome-extension://test',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(fs.existsSync(pluginPath), false);
  });
});

// ─── Extension Reload Endpoint ───────────────────────────────────────────────

describe('Extension Reload Endpoint', () => {
  let relay, port;

  function httpRequest(method, url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const opts = new URL(url);
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request({
        hostname: opts.hostname, port: opts.port,
        path: opts.pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => relay.stop());

  it('POST /extension/reload without token returns 401', async () => {
    const { status, body } = await httpRequest('POST', `http://127.0.0.1:${port}/extension/reload`, {});
    assert.equal(status, 401);
    assert.ok(body.error.includes('Unauthorized'));
  });

  it('POST /extension/reload with invalid token returns 401', async () => {
    const { status, body } = await httpRequest('POST', `http://127.0.0.1:${port}/extension/reload`, {}, {
      Authorization: 'Bearer bad-token',
    });
    assert.equal(status, 401);
    assert.ok(body.error.includes('Unauthorized'));
  });

  it('POST /extension/reload with valid token but no extension returns { reloaded: false }', async () => {
    const { status, body } = await httpRequest('POST', `http://127.0.0.1:${port}/extension/reload`, {}, {
      Authorization: `Bearer ${relay.authToken}`,
    });
    assert.equal(status, 200);
    assert.equal(body.reloaded, false);
  });

  it('POST /extension/reload with extension connected and ack returns { reloaded: true }', async () => {
    // Connect a mock extension that sends reload-ack
    const extWs = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    extWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'reload') {
        extWs.send(JSON.stringify({ method: 'reload-ack' }));
      }
    });

    const { status, body } = await httpRequest('POST', `http://127.0.0.1:${port}/extension/reload`, {}, {
      Authorization: `Bearer ${relay.authToken}`,
    });

    extWs.close();
    assert.equal(status, 200);
    assert.equal(body.reloaded, true);
  });

  it('POST /extension/reload with extension connected but no ack times out to { reloaded: false }', async () => {
    // Re-start relay to get a fresh extension slot (previous test's close may not have fully cleaned up)
    relay.stop();
    await sleep(100);
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);

    // Connect a mock extension that does NOT send reload-ack
    const extWs = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const { status, body } = await httpRequest('POST', `http://127.0.0.1:${port}/extension/reload`, {}, {
      Authorization: `Bearer ${relay.authToken}`,
    });

    extWs.close();
    assert.equal(status, 200);
    assert.equal(body.reloaded, false);
  });
});

// ─── WebSocket Security ──────────────────────────────────────────────────────

describe('WebSocket Security', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('rejects /extension without chrome-extension:// origin', async () => {
    try {
      const ws = await connectWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { Origin: 'https://evil.com' },
      });
      ws.close();
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('403') || err.message.includes('Unexpected'));
    }
  });

  it('rejects /cdp without valid token', async () => {
    try {
      const ws = await connectWs(`ws://127.0.0.1:${port}/cdp?token=invalid`);
      ws.close();
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected'));
    }
  });

  it('rejects /cdp with no token', async () => {
    try {
      const ws = await connectWs(`ws://127.0.0.1:${port}/cdp`);
      ws.close();
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected'));
    }
  });

  it('accepts /extension with chrome-extension:// origin', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://abcdef123456' },
    });
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('accepts /cdp with valid token', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('rejects second /cdp client in single-active mode', async () => {
    const prevMode = process.env.BF_CLIENT_MODE;
    process.env.BF_CLIENT_MODE = 'single-active';
    const singleRelay = new RelayServer(getRandomPort());
    await singleRelay.start({ writeCdpUrl: false });
    let c1;
    let c2;
    try {
      assert.equal(singleRelay.clientMode, 'single-active');
      c1 = await connectWs(`ws://127.0.0.1:${singleRelay.port}/cdp?token=${singleRelay.authToken}`);
      await assert.rejects(
        (async () => {
          c2 = await connectWs(`ws://127.0.0.1:${singleRelay.port}/cdp?token=${singleRelay.authToken}`);
          c2.close();
        })(),
        /409|Unexpected/
      );
    } finally {
      if (c1 && c1.readyState === WebSocket.OPEN) c1.close();
      if (c2 && c2.readyState === WebSocket.OPEN) c2.close();
      singleRelay.stop();
      if (prevMode === undefined) delete process.env.BF_CLIENT_MODE;
      else process.env.BF_CLIENT_MODE = prevMode;
    }
  });

  it('allows multiple /cdp clients when BF_CLIENT_MODE=multi-client', async () => {
    const prevMode = process.env.BF_CLIENT_MODE;
    process.env.BF_CLIENT_MODE = 'multi-client';
    const multiRelay = new RelayServer(getRandomPort());
    await multiRelay.start({ writeCdpUrl: false });
    let c1;
    let c2;
    try {
      c1 = await connectWs(`ws://127.0.0.1:${multiRelay.port}/cdp?token=${multiRelay.authToken}`);
      c2 = await connectWs(`ws://127.0.0.1:${multiRelay.port}/cdp?token=${multiRelay.authToken}`);
      assert.equal(c1.readyState, WebSocket.OPEN);
      assert.equal(c2.readyState, WebSocket.OPEN);
    } finally {
      if (c1 && c1.readyState === WebSocket.OPEN) c1.close();
      if (c2 && c2.readyState === WebSocket.OPEN) c2.close();
      multiRelay.stop();
      if (prevMode === undefined) delete process.env.BF_CLIENT_MODE;
      else process.env.BF_CLIENT_MODE = prevMode;
    }
  });

  it('allows standby client after active client disconnects', async () => {
    const prevMode = process.env.BF_CLIENT_MODE;
    process.env.BF_CLIENT_MODE = 'single-active';
    const singleRelay = new RelayServer(getRandomPort());
    await singleRelay.start({ writeCdpUrl: false });

    let activeClient;
    let standbyClient;
    let rejectedClient;
    try {
      activeClient = await connectWs(`ws://127.0.0.1:${singleRelay.port}/cdp?token=${singleRelay.authToken}`);
      const slotWhileActive = await httpGet(`http://127.0.0.1:${singleRelay.port}/client-slot`);
      assert.equal(slotWhileActive.status, 200);
      assert.equal(slotWhileActive.body.busy, true);

      await assert.rejects(
        (async () => {
          rejectedClient = await connectWs(`ws://127.0.0.1:${singleRelay.port}/cdp?token=${singleRelay.authToken}`);
          rejectedClient.close();
        })(),
        /409|Unexpected/
      );

      const activeClosed = new Promise((resolve) => activeClient.once('close', resolve));
      activeClient.close();
      await activeClosed;

      await waitForCondition(() => singleRelay.activeClient === null, {
        description: 'active client slot release',
      });

      const slotAfterDisconnect = await httpGet(`http://127.0.0.1:${singleRelay.port}/client-slot`);
      assert.equal(slotAfterDisconnect.status, 200);
      assert.equal(slotAfterDisconnect.body.busy, false);

      standbyClient = await connectWs(`ws://127.0.0.1:${singleRelay.port}/cdp?token=${singleRelay.authToken}`);
      assert.equal(standbyClient.readyState, WebSocket.OPEN);
    } finally {
      if (activeClient && activeClient.readyState === WebSocket.OPEN) activeClient.close();
      if (standbyClient && standbyClient.readyState === WebSocket.OPEN) standbyClient.close();
      if (rejectedClient && rejectedClient.readyState === WebSocket.OPEN) rejectedClient.close();
      singleRelay.stop();
      if (prevMode === undefined) delete process.env.BF_CLIENT_MODE;
      else process.env.BF_CLIENT_MODE = prevMode;
    }
  });

  it('GET /client-slot returns mode and active status', async () => {
    const prevMode = process.env.BF_CLIENT_MODE;
    process.env.BF_CLIENT_MODE = 'single-active';
    const singleRelay = new RelayServer(getRandomPort());
    await singleRelay.start({ writeCdpUrl: false });

    let activeClient;
    try {
      const before = await httpGet(`http://127.0.0.1:${singleRelay.port}/client-slot`);
      assert.equal(before.status, 200);
      assert.deepEqual(before.body, {
        mode: 'single-active',
        busy: false,
        activeClientId: null,
        connectedAt: null,
        clients: 0,
      });

      activeClient = await connectWs(`ws://127.0.0.1:${singleRelay.port}/cdp?token=${singleRelay.authToken}`);

      const during = await httpGet(`http://127.0.0.1:${singleRelay.port}/client-slot`);
      assert.equal(during.status, 200);
      assert.equal(during.body.mode, 'single-active');
      assert.equal(during.body.busy, true);
      assert.equal(typeof during.body.activeClientId, 'string');
      assert.equal(typeof during.body.connectedAt, 'number');
      assert.equal(during.body.clients, 1);

      const activeClosed = new Promise((resolve) => activeClient.once('close', resolve));
      activeClient.close();
      await activeClosed;

      await waitForCondition(() => singleRelay.activeClient === null, {
        description: 'active client slot release',
      });

      const after = await httpGet(`http://127.0.0.1:${singleRelay.port}/client-slot`);
      assert.equal(after.status, 200);
      assert.deepEqual(after.body, {
        mode: 'single-active',
        busy: false,
        activeClientId: null,
        connectedAt: null,
        clients: 0,
      });
    } finally {
      if (activeClient && activeClient.readyState === WebSocket.OPEN) activeClient.close();
      singleRelay.stop();
      if (prevMode === undefined) delete process.env.BF_CLIENT_MODE;
      else process.env.BF_CLIENT_MODE = prevMode;
    }
  });

  it('rejects second extension connection (single slot)', async () => {
    const ws1 = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://first' },
    });

    try {
      const ws2 = await connectWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { Origin: 'chrome-extension://second' },
      });
      ws2.close();
      assert.fail('Should have rejected second connection');
    } catch (err) {
      assert.ok(err.message.includes('409') || err.message.includes('Unexpected'));
    }

    ws1.close();
    await sleep(100); // Let cleanup happen
  });
});

// ─── CDP Protocol ────────────────────────────────────────────────────────────

describe('CDP Protocol', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('Browser.getVersion returns synthetic response', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 1,
      method: 'Browser.getVersion',
    });
    assert.equal(res.id, 1);
    assert.ok(res.result.product.includes('BrowserForce'));
    assert.equal(res.result.protocolVersion, '1.3');
    cdp.close();
  });

  it('Target.setDiscoverTargets returns empty result', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 2,
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    });
    assert.equal(res.id, 2);
    assert.deepEqual(res.result, {});
    cdp.close();
  });

  it('Target.getTargets returns empty list when no tabs attached', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 3,
      method: 'Target.getTargets',
    });
    assert.equal(res.id, 3);
    assert.ok(Array.isArray(res.result.targetInfos));
    assert.equal(res.result.targetInfos.length, 0);
    cdp.close();
  });

  it('Browser.setDownloadBehavior returns empty result', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 4,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: '/tmp' },
    });
    assert.equal(res.id, 4);
    assert.deepEqual(res.result, {});
    cdp.close();
  });

  it('Target.getTargetInfo returns browser target for unknown targetId', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 5,
      method: 'Target.getTargetInfo',
      params: { targetId: 'nonexistent' },
    });
    assert.equal(res.id, 5);
    assert.ok(res.result.targetInfo);
    assert.equal(res.result.targetInfo.type, 'browser');
    cdp.close();
  });

  it('Target.attachToTarget returns error for unknown target', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 6,
      method: 'Target.attachToTarget',
      params: { targetId: 'nonexistent' },
    });
    assert.equal(res.id, 6);
    assert.ok(res.error);
    cdp.close();
  });

  it('unknown browser-level command returns empty result', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 7,
      method: 'Browser.someUnknownMethod',
    });
    assert.equal(res.id, 7);
    assert.deepEqual(res.result, {});
    cdp.close();
  });
});

// ─── Extension ↔ Relay Communication ─────────────────────────────────────────

describe('Extension Communication', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('relay sends ping to extension', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const msg = await readMessage(ext, 6000); // ping comes every 5s
    assert.equal(msg.method, 'ping');

    ext.close();
    await sleep(100);
  });

  it('extension can respond to pong', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    // Wait for ping
    const ping = await readMessage(ext, 6000);
    assert.equal(ping.method, 'ping');

    // Send pong (should not error)
    ext.send(JSON.stringify({ method: 'pong' }));
    await sleep(100);
    assert.equal(ext.readyState, WebSocket.OPEN);

    ext.close();
    await sleep(100);
  });

  it('health endpoint reflects extension connection', async () => {
    // Before connection
    const before = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(before.body.extension, false);

    // Connect extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    await sleep(50);
    const during = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(during.body.extension, true);

    // Disconnect
    ext.close();
    await sleep(100);
    const after = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(after.body.extension, false);
  });
});

// ─── Target.setAutoAttach with Mock Extension ────────────────────────────────

describe('Auto-attach Flow', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('auto-attach exposes existing browser tabs as lazy targets', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const extCommands = [];
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        extCommands.push(msg.method);
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabs: [
                { tabId: 1, url: 'https://gmail.com', title: 'Gmail', active: true },
                { tabId: 2, url: 'https://github.com', title: 'GitHub', active: false },
              ],
            },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    }));
    await sleep(500);

    // Should have response but NO attachedToTarget events (tabs not exposed)
    const response = messages.find((m) => m.id === 1);
    assert.ok(response, 'Should receive response to setAutoAttach');
    assert.deepEqual(response.result, {});

    const created = messages.filter((m) => m.method === 'Target.targetCreated');
    assert.equal(created.length, 2, 'Should create CDP targets for existing tabs');
    assert.deepEqual(
      created.map((m) => m.params.targetInfo.url).sort(),
      ['https://github.com', 'https://gmail.com'],
    );

    const attached = messages.filter((m) => m.method === 'Target.attachedToTarget');
    assert.equal(attached.length, 2, 'Should report existing tabs as targets');
    assert.deepEqual(
      attached.map((m) => m.params.targetInfo.url).sort(),
      ['https://github.com', 'https://gmail.com'],
    );
    assert.ok(
      messages.findIndex((m) => m.method === 'Target.targetCreated') <
        messages.findIndex((m) => m.method === 'Target.attachedToTarget'),
      'Should announce target creation before attaching sessions',
    );

    const targets = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(targets.body.length, 2);

    cdp.send(JSON.stringify({ id: 2, method: 'Target.getTargets', params: {} }));
    const getTargets = await waitForCondition(
      () => messages.find((m) => m.id === 2),
      { description: 'Target.getTargets response' },
    );
    assert.equal(getTargets.result.targetInfos.length, 2);
    assert.ok(getTargets.result.targetInfos.every((target) => target.browserContextId === 'bf-default-context'));

    assert.ok(extCommands.includes('listTabs'), 'Should request tab metadata');
    assert.ok(created.every((m) => m.params.targetInfo.browserContextId === 'bf-default-context'));
    assert.ok(!extCommands.includes('attachTab'), 'Should not attach debugger during discovery');
    assert.ok(!extCommands.includes('createTab'), 'Should not create tabs during discovery');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('auto-attach reuses discovered sessions without duplicating targets', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'listTabs') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabs: [{ tabId: 3, url: 'https://mantle.example', title: 'Mantle', active: true }] },
        }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    cdp.on('message', () => {});

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(200);
    const firstSessionId = relay.tabToSession.get(3);
    assert.ok(firstSessionId, 'Should map discovered tab to relay session');

    cdp.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(200);
    assert.equal(relay.tabToSession.get(3), firstSessionId);
    assert.equal([...relay.targets.values()].filter((target) => target.tabId === 3).length, 1);

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('relay-discovered targets attach lazily after init-only commands', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    const extCommands = [];
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id !== undefined) {
        extCommands.push(msg.method);
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabs: [{ tabId: 4, url: 'https://lazy.example', title: 'Lazy', active: true }] },
          }));
        } else if (msg.method === 'attachTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: msg.params.tabId,
              targetId: 'real-target-4',
              targetInfo: { targetId: 'real-target-4', type: 'page', title: 'Lazy', url: 'https://lazy.example' },
            },
          }));
        } else if (msg.method === 'cdpCommand') {
          ext.send(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value: 'ok' } } }));
        } else if (msg.method === 'closeTab') {
          ext.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    const attached = await waitForCondition(
      () => messages.find((m) => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.url === 'https://lazy.example'),
      { description: 'lazy discovered target' },
    );
    const sessionId = attached.params.sessionId;
    const advertisedTargetId = attached.params.targetInfo.targetId;
    assert.equal(advertisedTargetId, 'bf-target-4');

    cdp.send(JSON.stringify({ id: 2, method: 'Runtime.enable', params: {}, sessionId }));
    await waitForCondition(() => messages.find((m) => m.id === 2), { description: 'Runtime.enable response' });
    assert.equal(extCommands.filter((method) => method === 'attachTab').length, 0);

    cdp.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: '"ok"' }, sessionId }));
    await waitForCondition(() => messages.find((m) => m.id === 3), { description: 'Runtime.evaluate response' });
    assert.equal(extCommands.filter((method) => method === 'attachTab').length, 1);
    assert.ok(extCommands.indexOf('attachTab') < extCommands.indexOf('cdpCommand'));
    assert.equal(relay.targets.get(sessionId).targetId, advertisedTargetId);
    assert.equal(relay.targets.get(sessionId).chromeTargetId, 'real-target-4');

    cdp.send(JSON.stringify({ id: 4, method: 'Runtime.evaluate', params: { expression: '"again"' }, sessionId }));
    await waitForCondition(() => messages.find((m) => m.id === 4), { description: 'second Runtime.evaluate response' });
    assert.equal(extCommands.filter((method) => method === 'attachTab').length, 1);

    cdp.send(JSON.stringify({ id: 5, method: 'Target.closeTarget', params: { targetId: advertisedTargetId } }));
    const closeResponse = await waitForCondition(() => messages.find((m) => m.id === 5), { description: 'Target.closeTarget response' });
    assert.equal(closeResponse.result.success, true);
    assert.ok(extCommands.includes('closeTab'), 'Should close by original advertised targetId after lazy attach');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('auto-attach prunes stale relay-discovered targets from fresh tab metadata', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    let listCallCount = 0;
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'listTabs') {
        listCallCount += 1;
        const tabs = listCallCount === 1
          ? [
              { tabId: 5, url: 'https://closed.example', title: 'Closed', active: false },
              { tabId: 6, url: 'https://kept.example/old', title: 'Old', active: true },
            ]
          : [
              { tabId: 6, url: 'https://kept.example/new', title: 'New', active: true },
            ];
        ext.send(JSON.stringify({ id: msg.id, result: { tabs } }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    cdp.on('message', () => {});

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(200);
    const keptSessionId = relay.tabToSession.get(6);
    assert.ok(relay.tabToSession.get(5));
    assert.ok(keptSessionId);

    cdp.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(200);
    assert.equal(relay.tabToSession.has(5), false);
    assert.equal(relay.tabToSession.get(6), keptSessionId);
    assert.equal(relay.targets.get(keptSessionId).targetInfo.url, 'https://kept.example/new');
    assert.equal(relay.targets.get(keptSessionId).targetInfo.title, 'New');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('Target.createTarget eagerly attaches a new tab', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const extCommands = [];

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        extCommands.push(msg.method);
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 100,
              targetId: 'real-target-100',
              targetInfo: { targetId: 'real-target-100', type: 'page', title: '', url: msg.params.url || 'about:blank' },
              sessionId: msg.params.sessionId,
            },
          }));
        } else if (msg.method === 'cdpCommand') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value: 'done' } },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // Auto-attach (returns no tabs)
    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(300);

    // Create a new tab via Target.createTarget (simulates context.newPage())
    cdp.send(JSON.stringify({ id: 2, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    await sleep(300);

    // Should have: createTab called on extension
    assert.ok(extCommands.includes('createTab'), 'Should call createTab on extension');

    // Should receive attachedToTarget event + createTarget response
    const attached = messages.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should receive attachedToTarget');
    assert.equal(attached.params.targetInfo.url, 'about:blank');

    const createRes = messages.find((m) => m.id === 2);
    assert.ok(createRes, 'Should receive createTarget response');
    assert.ok(createRes.result.targetId, 'Should have targetId');

    // Target is eagerly attached — CDP commands work immediately
    const sessionId = attached.params.sessionId;
    cdp.send(JSON.stringify({
      id: 10,
      method: 'Runtime.evaluate',
      params: { expression: '"test"' },
      sessionId,
    }));
    await sleep(200);

    // cdpCommand should be called directly (no attachTab needed — already attached)
    assert.ok(extCommands.includes('cdpCommand'), 'CDP command forwarded to extension');
    assert.ok(!extCommands.includes('attachTab'), 'No lazy attachTab needed (eager via createTab)');

    cdp.close();
    ext.close();
    await sleep(100);
  });

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

  it('Target.createTarget re-pins to the fallback window when the pinned window was closed', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const createCommands = [];
    let nextTabId = 400;

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
        // Simulate the extension's closed-window fallback: a request for the
        // now-closed window 500 lands in the current window 700 instead.
        let windowId;
        if (msg.params.windowId === undefined) windowId = 500;
        else if (msg.params.windowId === 500) windowId = 700;
        else windowId = msg.params.windowId;
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId,
            windowId,
            targetId: `real-target-${tabId}`,
            targetInfo: { targetId: `real-target-${tabId}`, type: 'page', title: '', url: msg.params.url || 'about:blank', windowId },
            sessionId: msg.params.sessionId,
          },
        }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);

    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://one.example' } }));
    await sleep(200);
    cdp.send(JSON.stringify({ id: 2, method: 'Target.createTarget', params: { url: 'https://two.example' } }));
    await sleep(200);
    cdp.send(JSON.stringify({ id: 3, method: 'Target.createTarget', params: { url: 'https://three.example' } }));
    await sleep(200);

    assert.equal(createCommands.length, 3);
    assert.equal(createCommands[0].windowId, undefined);
    assert.equal(createCommands[1].windowId, 500);
    assert.equal(createCommands[2].windowId, 700);

    cdp.close();
    ext.close();
    await sleep(100);
  });
});

// ─── CDP Command Forwarding ──────────────────────────────────────────────────

describe('CDP Command Forwarding', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('forwards session-level commands to extension and returns response', async () => {
    // Connect mock extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 10, targetId: 'real-target-10', sessionId: msg.params.sessionId,
              targetInfo: { targetId: 'real-target-10', type: 'page', title: 'Example', url: msg.params.url || 'about:blank' },
            },
          }));
        } else if (msg.method === 'cdpCommand') {
          if (msg.params.method === 'Page.navigate') {
            ext.send(JSON.stringify({ id: msg.id, result: { frameId: 'frame-123', loaderId: 'loader-456' } }));
          } else if (msg.params.method === 'Runtime.evaluate') {
            ext.send(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value: 'hello' } } }));
          }
        }
      }
    });

    // Connect CDP client
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // Create tab (simulates context.newPage())
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://example.com' } }));
    await sleep(300);

    // Find sessionId from attachedToTarget event
    const attached = messages.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should have attached event');
    const sessionId = attached.params.sessionId;

    // Send Page.navigate via session
    cdp.send(JSON.stringify({
      id: 10, method: 'Page.navigate',
      params: { url: 'https://example.com/page2' }, sessionId,
    }));
    await sleep(200);

    const navResponse = messages.find((m) => m.id === 10);
    assert.ok(navResponse, 'Should receive navigate response');
    assert.equal(navResponse.result.frameId, 'frame-123');
    assert.equal(navResponse.sessionId, sessionId);

    // Send Runtime.evaluate via session
    cdp.send(JSON.stringify({
      id: 11, method: 'Runtime.evaluate',
      params: { expression: '"hello"' }, sessionId,
    }));
    await sleep(200);

    const evalResponse = messages.find((m) => m.id === 11);
    assert.ok(evalResponse, 'Should receive evaluate response');
    assert.equal(evalResponse.result.result.value, 'hello');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('returns error for commands on unknown session', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 99,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
      sessionId: 'nonexistent-session',
    });
    assert.equal(res.id, 99);
    assert.ok(res.error);
    assert.ok(res.error.message.includes('not found'));
    cdp.close();
  });
});

// ─── CDP Event Forwarding ────────────────────────────────────────────────────

describe('CDP Event Forwarding', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('forwards CDP events from extension to CDP client', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 20, targetId: 'real-target-20', sessionId: msg.params.sessionId,
              targetInfo: { targetId: 'real-target-20', type: 'page', title: 'Test', url: msg.params.url || 'about:blank' },
            },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    // Create tab (instead of auto-attach)
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://test.com' } }));
    await sleep(300);

    const attached = events.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should have attachedToTarget event');
    const sessionId = attached.params.sessionId;

    // Extension sends a CDP event
    ext.send(JSON.stringify({
      method: 'cdpEvent',
      params: {
        tabId: 20,
        method: 'Page.loadEventFired',
        params: { timestamp: 12345.678 },
      },
    }));

    await sleep(200);

    const loadEvent = events.find((m) => m.method === 'Page.loadEventFired');
    assert.ok(loadEvent, 'CDP client should receive the event');
    assert.equal(loadEvent.params.timestamp, 12345.678);
    assert.equal(loadEvent.sessionId, sessionId);

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('preserves child session id for child-session CDP events', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 30, targetId: 'real-target-30', sessionId: msg.params.sessionId,
              targetInfo: { targetId: 'real-target-30', type: 'page', title: 'Child Session Test', url: msg.params.url || 'about:blank' },
            },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://test-child.com' } }));
    await sleep(300);

    const attached = events.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should have attachedToTarget event');
    const parentSessionId = attached.params.sessionId;

    // Child target attach event comes on parent session.
    ext.send(JSON.stringify({
      method: 'cdpEvent',
      params: {
        tabId: 30,
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'child-session-1',
          targetInfo: {
            targetId: 'child-target-1',
            type: 'iframe',
            title: '',
            url: 'https://example-iframe.test/',
            attached: true,
            parentFrameId: 'frame-parent-1',
            browserContextId: 'bf-default-context',
          },
          waitingForDebugger: false,
        },
      },
    }));
    await sleep(100);

    const childAttach = events.find(
      (m) => m.method === 'Target.attachedToTarget' && m.params?.sessionId === 'child-session-1',
    );
    assert.ok(childAttach, 'Should receive child Target.attachedToTarget event');
    assert.equal(childAttach.sessionId, parentSessionId);

    // Child-session runtime event must be emitted on the child session id.
    ext.send(JSON.stringify({
      method: 'cdpEvent',
      params: {
        tabId: 30,
        method: 'Runtime.executionContextCreated',
        params: {
          context: {
            id: 101,
            origin: 'https://example-iframe.test',
            name: '',
            auxData: { isDefault: true, type: 'default' },
          },
        },
        childSessionId: 'child-session-1',
      },
    }));
    await sleep(150);

    const childRuntime = events.find(
      (m) => m.method === 'Runtime.executionContextCreated' && m.params?.context?.id === 101,
    );
    assert.ok(childRuntime, 'Should receive child Runtime.executionContextCreated event');
    assert.equal(childRuntime.sessionId, 'child-session-1');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('resolves Target.attachToTarget + getTargets for OOPIF iframe targets', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, { headers: { Origin: 'chrome-extension://test' } });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined && msg.method === 'createTab') {
        ext.send(JSON.stringify({ id: msg.id, result: { tabId: 31, targetId: 'real-target-31', sessionId: msg.params.sessionId, targetInfo: { targetId: 'real-target-31', type: 'page', title: 'OOPIF Test', url: msg.params.url || 'about:blank' } } }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://oopif-parent.test' } }));
    await sleep(300);

    // Extension reports an auto-attached cross-origin iframe. NOTE: browserContextId is
    // deliberately OMITTED here — the relay must normalize it.
    ext.send(JSON.stringify({ method: 'cdpEvent', params: { tabId: 31, method: 'Target.attachedToTarget', params: { sessionId: 'oopif-session-1', targetInfo: { targetId: 'oopif-target-1', type: 'iframe', title: '', url: 'https://cross.test/', attached: true }, waitingForDebugger: false } } }));
    await sleep(100);

    const attachResp = await sendAndReceive(cdp, { id: 2, method: 'Target.attachToTarget', params: { targetId: 'oopif-target-1' } });
    assert.equal(attachResp.result.sessionId, 'oopif-session-1', 'attachToTarget returns the existing child sessionId');

    const targetsResp = await sendAndReceive(cdp, { id: 3, method: 'Target.getTargets', params: {} });
    const oopifInfo = targetsResp.result.targetInfos.find((t) => t.targetId === 'oopif-target-1');
    assert.ok(oopifInfo, 'getTargets includes the OOPIF target');
    assert.equal(oopifInfo.type, 'iframe', 'OOPIF target typed as iframe');
    assert.equal(oopifInfo.browserContextId, 'bf-default-context', 'relay normalizes browserContextId even when the extension omits it');

    const infoResp = await sendAndReceive(cdp, { id: 4, method: 'Target.getTargetInfo', params: { targetId: 'oopif-target-1' } });
    assert.equal(infoResp.result.targetInfo.browserContextId, 'bf-default-context', 'getTargetInfo returns the normalized OOPIF info');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('Target.attachToTarget still rejects unknown targets', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, { headers: { Origin: 'chrome-extension://test' } });
    ext.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.method === 'ping') ext.send(JSON.stringify({ method: 'pong' })); else if (m.id && m.method === 'getRestrictions') ext.send(JSON.stringify({ id: m.id, result: { mode: 'auto' } })); });
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const resp = await sendAndReceive(cdp, { id: 1, method: 'Target.attachToTarget', params: { targetId: 'nope' } });
    assert.ok(resp.error, 'unknown target rejected');
    cdp.close(); ext.close(); await sleep(100);
  });
});

// ─── CDP JSONL Logging ──────────────────────────────────────────────────────

describe('CDP JSONL Logging', () => {
  let logDir;
  let logFilePath;
  let originalLogFileEnv;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cdp-log-'));
    logFilePath = path.join(logDir, 'cdp-traffic.jsonl');
    originalLogFileEnv = process.env.BROWSERFORCE_CDP_LOG_FILE_PATH;
    process.env.BROWSERFORCE_CDP_LOG_FILE_PATH = logFilePath;
  });

  afterEach(() => {
    if (originalLogFileEnv === undefined) delete process.env.BROWSERFORCE_CDP_LOG_FILE_PATH;
    else process.env.BROWSERFORCE_CDP_LOG_FILE_PATH = originalLogFileEnv;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('creates and truncates the CDP JSONL log file on relay start', async () => {
    let firstRelay;
    let secondRelay;

    try {
      firstRelay = new RelayServer(getRandomPort());
      await firstRelay.start({ writeCdpUrl: false });
      assert.equal(fs.existsSync(logFilePath), true, 'CDP log file should be created on start');

      firstRelay.stop();
      firstRelay = null;

      fs.writeFileSync(logFilePath, '{"stale":true}\n');
      assert.ok(fs.statSync(logFilePath).size > 0, 'CDP log file should contain stale data before restart');

      secondRelay = new RelayServer(getRandomPort());
      await secondRelay.start({ writeCdpUrl: false });
      assert.equal(fs.existsSync(logFilePath), true, 'CDP log file should still exist after restart');
      assert.equal(fs.readFileSync(logFilePath, 'utf8'), '', 'CDP log file should be truncated on each start');
    } finally {
      secondRelay?.stop();
      firstRelay?.stop();
    }
  });

  it('logs command/event traffic with direction and method in JSONL entries', async () => {
    let relay;
    let ext;
    let cdp;

    try {
      relay = new RelayServer(getRandomPort());
      await relay.start({ writeCdpUrl: false });

      ext = await connectWs(`ws://127.0.0.1:${relay.port}/extension`, {
        headers: { Origin: 'chrome-extension://test' },
      });

      ext.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
        if (msg.id === undefined) return;

        if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 501,
              targetId: 'real-target-501',
              sessionId: msg.params.sessionId,
              targetInfo: {
                targetId: 'real-target-501',
                type: 'page',
                title: 'Logging Test',
                url: msg.params.url || 'about:blank',
              },
            },
          }));
        } else if (msg.method === 'cdpCommand' && msg.params.method === 'Runtime.evaluate') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value: 'ok' } },
          }));
        }
      });

      cdp = await connectWs(`ws://127.0.0.1:${relay.port}/cdp?token=${relay.authToken}`);
      const cdpMessages = [];
      cdp.on('message', (data) => cdpMessages.push(JSON.parse(data.toString())));

      cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://example.com' } }));
      const attached = await waitForCondition(
        () => cdpMessages.find((m) => m.method === 'Target.attachedToTarget'),
        { description: 'Target.attachedToTarget event after createTarget' },
      );
      const sessionId = attached.params.sessionId;

      cdp.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: '"ok"' },
        sessionId,
      }));
      await waitForCondition(
        () => cdpMessages.find((m) => m.id === 2),
        { description: 'Runtime.evaluate response' },
      );

      ext.send(JSON.stringify({
        method: 'cdpEvent',
        params: {
          tabId: 501,
          method: 'Page.loadEventFired',
          params: { timestamp: 42 },
        },
      }));
      await waitForCondition(
        () => cdpMessages.find((m) => m.method === 'Page.loadEventFired'),
        { description: 'Page.loadEventFired event routed to CDP client' },
      );

      assert.equal(fs.existsSync(logFilePath), true, 'CDP log file should exist');
      const entries = readJsonlEntries(logFilePath);
      const directions = new Set(entries.map((entry) => entry.direction));
      const methods = entries.map((entry) => entry?.message?.method).filter(Boolean);
      const labeledClientEntry = entries.find((entry) => entry.clientId);

      assert.ok(directions.has('from-playwright'), 'Should log from-playwright direction');
      assert.ok(directions.has('to-extension'), 'Should log to-extension direction');
      assert.ok(directions.has('from-extension'), 'Should log from-extension direction');
      assert.ok(directions.has('to-playwright'), 'Should log to-playwright direction');
      assert.ok(methods.includes('Runtime.evaluate'), 'Should log Runtime.evaluate method');
      assert.ok(methods.includes('Page.loadEventFired'), 'Should log Page.loadEventFired method');
      assert.ok(labeledClientEntry?.clientLabel, 'Client-labeled entries should include clientLabel');
    } finally {
      cdp?.close();
      ext?.close();
      relay?.stop();
    }
  });
});

// ─── Tab Lifecycle ───────────────────────────────────────────────────────────

describe('Tab Lifecycle', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('tab detach event removes target and notifies CDP client', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 30, targetId: 't-30', sessionId: msg.params.sessionId,
              targetInfo: { targetId: 't-30', type: 'page', title: 'A', url: msg.params.url || 'about:blank' },
            },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    // Create tab
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://a.com' } }));
    await sleep(300);

    // Verify target exists
    let list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 1);

    // Extension reports tab detached
    ext.send(JSON.stringify({
      method: 'tabDetached',
      params: { tabId: 30, reason: 'tab_closed' },
    }));
    await sleep(200);

    // Verify target removed
    list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 0);

    // CDP client should have received detach event
    const detached = events.find((m) => m.method === 'Target.detachedFromTarget');
    assert.ok(detached, 'Should receive detach event');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('tab update event updates target info', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 40, targetId: 't-40', sessionId: msg.params.sessionId,
              targetInfo: { targetId: 't-40', type: 'page', title: 'Old', url: msg.params.url || 'about:blank' },
            },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    // Create tab
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://old.com' } }));
    await sleep(300);

    // Extension sends tabUpdated
    ext.send(JSON.stringify({
      method: 'tabUpdated',
      params: { tabId: 40, url: 'https://new.com', title: 'New Page' },
    }));
    await sleep(200);

    // CDP client should receive targetInfoChanged
    const changed = events.find((m) => m.method === 'Target.targetInfoChanged');
    assert.ok(changed, 'Should receive targetInfoChanged');
    assert.equal(changed.params.targetInfo.url, 'https://new.com');
    assert.equal(changed.params.targetInfo.title, 'New Page');

    // json/list should reflect updated info
    const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body[0].url, 'https://new.com');
    assert.equal(list.body[0].title, 'New Page');

    cdp.close();
    ext.close();
    await sleep(100);
  });
});

// ─── Extension Disconnect Cleanup ────────────────────────────────────────────

describe('Extension Disconnect', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('cleans up all targets when extension disconnects', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
        } else if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabId: 50, targetId: 't-50', sessionId: msg.params.sessionId,
              targetInfo: { targetId: 't-50', type: 'page', title: 'X', url: msg.params.url || 'about:blank' },
            },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    // Create tab
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://x.com' } }));
    await sleep(300);

    // Verify target exists
    let list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 1);

    // Disconnect extension
    ext.close();
    await sleep(200);

    // All targets should be gone
    list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 0);

    // CDP client should have received detach event
    const detached = events.find((m) => m.method === 'Target.detachedFromTarget');
    assert.ok(detached, 'Should notify CDP client of target loss');

    cdp.close();
    await sleep(100);
  });
});

// ─── GET /restrictions Endpoint ──────────────────────────────────────────────

describe('GET /restrictions endpoint', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('returns 200 with default restrictions when no extension is connected', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/restrictions`);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      mode: 'auto',
      lockUrl: false,
      noNewTabs: false,
      readOnly: false,
      instructions: '',
    });
  });

  it('returns application/json content-type when no extension is connected', async () => {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/restrictions`, (res) => {
        assert.ok(
          res.headers['content-type'].includes('application/json'),
          'Content-Type should be application/json',
        );
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  });

  it('forwards getRestrictions to extension and returns its response', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const extRestrictions = {
      mode: 'locked',
      lockUrl: true,
      noNewTabs: true,
      readOnly: false,
      instructions: 'Only visit example.com',
    };

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id !== undefined && msg.method === 'getRestrictions') {
        ext.send(JSON.stringify({ id: msg.id, result: extRestrictions }));
      }
    });

    await sleep(50); // Let extension register

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/restrictions`);
    assert.equal(status, 200);
    assert.deepEqual(body, extRestrictions);

    ext.close();
    await sleep(100);
  });
});

// ─── GET /agent-preferences Endpoint ────────────────────────────────────────

describe('GET /agent-preferences endpoint', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('returns defaults when no extension is connected', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/agent-preferences`);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      executionMode: 'parallel',
      parallelVisibilityMode: 'foreground-tab',
    });
  });

  it('forwards getAgentPreferences to extension and returns its response', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const extPreferences = {
      executionMode: 'sequential',
      parallelVisibilityMode: 'foreground-tab',
    };

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id !== undefined && msg.method === 'getAgentPreferences') {
        ext.send(JSON.stringify({ id: msg.id, result: extPreferences }));
      }
    });

    await sleep(50);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/agent-preferences`);
    assert.equal(status, 200);
    assert.deepEqual(body, extPreferences);

    ext.close();
    await sleep(100);
  });

  it('normalizes rotate-visible to foreground-tab', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined && msg.method === 'getAgentPreferences') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            executionMode: 'parallel',
            parallelVisibilityMode: 'rotate-visible',
          },
        }));
      }
    });

    await sleep(50);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/agent-preferences`);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      executionMode: 'parallel',
      parallelVisibilityMode: 'foreground-tab',
    });

    ext.close();
    await sleep(100);
  });
});

// ─── manualTabAttached Handler ───────────────────────────────────────────────

describe('manualTabAttached handler', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('creates session and broadcasts Target.attachedToTarget to CDP clients', async () => {
    // Connect mock extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); }
    });

    // Connect CDP client
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    await sleep(50); // Let both connections settle

    // Extension sends manualTabAttached
    ext.send(JSON.stringify({
      method: 'manualTabAttached',
      params: {
        tabId: 999,
        sessionId: 'manual-999-123',
        targetId: 'bf-target-999',
        targetInfo: { url: 'https://example.com', title: 'Example' },
      },
    }));

    await sleep(200);

    // CDP client should have received Target.attachedToTarget
    const attached = events.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should receive Target.attachedToTarget event');

    // sessionId should be in bf-session-N format
    assert.ok(
      /^bf-session-\d+$/.test(attached.params.sessionId),
      `sessionId "${attached.params.sessionId}" should match bf-session-N`,
    );

    // targetInfo fields should be correct
    assert.equal(attached.params.targetInfo.url, 'https://example.com');
    assert.equal(attached.params.targetInfo.title, 'Example');
    assert.equal(attached.params.targetInfo.targetId, 'bf-target-999');
    assert.equal(attached.params.targetInfo.type, 'page');
    assert.equal(attached.params.targetInfo.browserContextId, 'bf-default-context');
    assert.equal(attached.params.waitingForDebugger, false);

    // Relay state: target should be in /json/list
    const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].url, 'https://example.com');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('adds target to tabToSession and targets maps', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    cdp.on('message', () => {}); // drain messages

    await sleep(50);

    ext.send(JSON.stringify({
      method: 'manualTabAttached',
      params: {
        tabId: 888,
        sessionId: 'manual-888-456',
        targetId: 'bf-target-888',
        targetInfo: { url: 'https://other.com', title: 'Other' },
      },
    }));

    await sleep(200);

    // tabToSession should map tabId 888 to a bf-session-N
    assert.ok(relay.tabToSession.has(888), 'tabToSession should contain tabId 888');
    const sessionId = relay.tabToSession.get(888);
    assert.ok(/^bf-session-\d+$/.test(sessionId), 'Mapped session should be bf-session-N');

    // targets should contain the session
    assert.ok(relay.targets.has(sessionId), 'targets map should contain the session');
    const target = relay.targets.get(sessionId);
    assert.equal(target.tabId, 888);
    assert.equal(target.targetId, 'bf-target-888');
    assert.equal(target.debuggerAttached, true);

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('updates existing manual tab target instead of duplicating it', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); }
    });

    await sleep(50);

    const firstAttach = {
      method: 'manualTabAttached',
      params: {
        tabId: 777,
        sessionId: 'manual-777-1',
        targetId: 'bf-target-777',
        targetInfo: { url: 'https://first.example', title: 'First' },
      },
    };
    ext.send(JSON.stringify(firstAttach));
    await sleep(100);

    const sessionId = relay.tabToSession.get(777);
    assert.ok(sessionId, 'tabToSession should contain tabId 777');

    ext.send(JSON.stringify({
      method: 'manualTabAttached',
      params: {
        tabId: 777,
        sessionId: 'manual-777-2',
        targetId: 'bf-target-777-updated',
        targetInfo: { url: 'https://second.example', title: 'Second' },
      },
    }));
    await sleep(100);

    assert.equal(relay.tabToSession.get(777), sessionId, 'tab should keep the original relay session');
    assert.equal([...relay.targets.values()].filter((target) => target.tabId === 777).length, 1);
    const target = relay.targets.get(sessionId);
    assert.equal(target.targetId, 'bf-target-777-updated');
    assert.equal(target.targetInfo.url, 'https://second.example');
    assert.equal(target.targetInfo.title, 'Second');

    const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.filter((target) => target.url === 'https://second.example').length, 1);

    ext.close();
    await sleep(100);
  });
});

// ─── Extension Status Endpoints ─────────────────────────────────────────────

describe('Extension Status Endpoints', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

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
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    ext.send(JSON.stringify({
      method: 'manualTabAttached',
      params: {
        tabId: 44,
        sessionId: 'manual-44-1',
        targetId: 'bf-target-44',
        origin: 'manual',
        windowId: 902,
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
    assert.equal(status.body.manualAttachedTabs[0].windowId, 902);

    ext.close();
    await sleep(100);
  });

  it('GET /attached-tabs returns the attached tab list', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

    ext.send(JSON.stringify({
      method: 'manualTabAttached',
      params: {
        tabId: 45,
        sessionId: 'manual-45-1',
        targetId: 'bf-target-45',
        origin: 'manual',
        windowId: 903,
        targetInfo: { url: 'https://attached.example', title: 'Attached' },
      },
    }));
    await sleep(100);

    const res = await httpGet(`http://127.0.0.1:${port}/attached-tabs`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tabs));
    assert.equal(res.body.tabs.length, 1);
    assert.equal(res.body.tabs[0].tabId, 45);
    assert.equal(res.body.tabs[0].origin, 'manual');
    assert.equal(res.body.tabs[0].windowId, 903);

    ext.close();
    await sleep(100);
  });

  it('preserves non-manual origin when attached tabs are replayed after reconnect', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') ext.send(JSON.stringify({ method: 'pong' }));
      if (msg.id && msg.method === 'getRestrictions') ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } }));
    });

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

    ext.close();
    await sleep(100);
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
      headers: { Host: '127.0.0.1:bad' },
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
});

// ─── Target.createTarget Restrictions Guard ─────────────────────────────────

describe('Target.createTarget restrictions guard', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('rejects Target.createTarget when no-new-tabs restriction is active', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    const seenCommands = [];
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id !== undefined) seenCommands.push(msg);
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

    await sleep(50);
    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    await sleep(300);

    const response = messages.find((m) => m.id === 1);
    assert.ok(response?.error, 'createTarget should fail');
    assert.match(response.error.message || response.error, /New tabs are disabled|manual attached-tab mode/);
    assert.equal(
      seenCommands.filter((msg) => msg.method === 'createTab').length,
      0,
      'createTab must not be sent when restrictions block new tabs',
    );

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('rejects Target.createTarget without createTab when restrictions cannot be read', async () => {
    for (const failureMode of ['extension-missing', 'timeout', 'malformed-response', 'extension-error', 'transport-failure']) {
      const seenExtensionCommands = [];
      const cleanup = await installRestrictionsFailureFixture(failureMode, { seenExtensionCommands, port });
      const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
      const messages = [];
      cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

      cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
      // timeout mode waits up to ~2s for the restrictions fetch to time out
      await sleep(failureMode === 'timeout' ? 2600 : 400);

      const response = messages.find((m) => m.id === 1);
      assert.ok(response?.error, `expected createTarget to fail closed for ${failureMode}`);
      assert.match(
        response.error.message || response.error,
        /New tabs are disabled|Cannot read BrowserForce restrictions|attached-tab mode/,
        `expected fail-closed error for ${failureMode}`,
      );
      assert.equal(
        seenExtensionCommands.filter((msg) => msg.method === 'createTab').length,
        0,
        `createTab must not be sent when restrictions fail via ${failureMode}`,
      );

      cdp.close();
      await cleanup?.();
      await sleep(100);
    }
  });
});

// ─── Auto-start Relay ─────────────────────────────────────────────────────

describe('ensureRelay', () => {
  let ensureRelay;
  let isRelayRunning;

  before(async () => {
    const mod = await import('../../mcp/src/exec-engine.js');
    ensureRelay = mod.ensureRelay;
    // Access isRelayRunning indirectly — test via ensureRelay behavior
  });

  it('is a no-op when relay is already running', async () => {
    const port = getRandomPort();
    const relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);

    const origPort = process.env.RELAY_PORT;
    process.env.RELAY_PORT = String(port);
    try {
      const start = Date.now();
      await ensureRelay(); // should detect running relay, no spawn
      const elapsed = Date.now() - start;
      // Detection should be fast — under 1s (no polling loop)
      assert.ok(elapsed < 1000, `ensureRelay took ${elapsed}ms, expected < 1000ms`);
    } finally {
      if (origPort === undefined) delete process.env.RELAY_PORT;
      else process.env.RELAY_PORT = origPort;
      relay.stop();
    }
  });

  it('throws when relay cannot start on an occupied port', async () => {
    // Occupy a port with a non-relay HTTP server (returns 404, not the relay health JSON)
    const port = getRandomPort();
    const blocker = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise(r => blocker.listen(port, '127.0.0.1', r));

    const origPort = process.env.RELAY_PORT;
    process.env.RELAY_PORT = String(port);

    try {
      // ensureRelay pings the port — gets 404 (not ok), tries to spawn relay,
      // but relay can't bind (port occupied) → times out
      await assert.rejects(
        () => ensureRelay(),
        { message: /Failed to auto-start relay/ },
      );
    } finally {
      if (origPort === undefined) delete process.env.RELAY_PORT;
      else process.env.RELAY_PORT = origPort;
      blocker.close();
    }
  });
});

// ─── Explicit newCDPSession() Handshake: browser session + alias ─────────────
// Regression coverage for the real-Chrome `snapshot --sessiond` crash fix.
// A CDP client's newCDPSession(page) opens Target.attachToBrowserTarget, then
// sends Target.attachToTarget ON that browser session. The relay must:
//   1. return a real (sentinel) browser sessionId so the attachToTarget RESPONSE
//      routes to the client's browser-session callback (not root → avoids the
//      Playwright `_CRSession._onMessage` `assert(!object.id)` crash), and
//   2. return a DISTINCT alias for an already-attached page so it never
//      overwrites the page's primary session in the client routing map,
// while never leaking alias entries across detach / disconnect / target loss.
describe('CDP Explicit Session Handshake (newCDPSession alias)', () => {
  let relay;
  let port;

  beforeEach(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(150);
    // Seed a primary page target as if discovered + lazily attached, so
    // Target.attachToTarget resolves it (matched by targetId).
    relay.targets.set('bf-session-1', { targetId: 'TARGET-PRIMARY', tabId: 4242 });
    relay.tabToSession.set(4242, 'bf-session-1');
  });

  afterEach(() => {
    relay.stop();
  });

  it('attachToBrowserTarget returns a browser session; attachToTarget echoes it + returns a distinct alias', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    try {
      const rb = await sendAndReceive(cdp, { id: 1, method: 'Target.attachToBrowserTarget' });
      const browserSession = rb.result.sessionId;
      assert.ok(browserSession, 'attachToBrowserTarget must return a non-empty sessionId');

      const ra = await sendAndReceive(cdp, {
        id: 2,
        method: 'Target.attachToTarget',
        params: { targetId: 'TARGET-PRIMARY', flatten: true },
        sessionId: browserSession,
      });
      // The reply must be tagged with the browser session so the client matches
      // it to that session's callback — this is the actual crash fix.
      assert.equal(ra.sessionId, browserSession, 'attachToTarget reply must echo the browser session');
      const alias = ra.result.sessionId;
      assert.ok(alias.startsWith('bf-alias-'), `expected bf-alias-* id, got ${alias}`);
      assert.notEqual(alias, 'bf-session-1', 'alias must NOT reuse the page primary session id');
      assert.ok(relay.aliasSessions.has(alias), 'alias must be tracked');
      assert.equal(relay.aliasSessions.get(alias).primarySessionId, 'bf-session-1');
    } finally {
      cdp.close();
    }
  });

  it('detachFromTarget drops the alias mapping', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    try {
      const rb = await sendAndReceive(cdp, { id: 1, method: 'Target.attachToBrowserTarget' });
      const browserSession = rb.result.sessionId;
      const ra = await sendAndReceive(cdp, {
        id: 2,
        method: 'Target.attachToTarget',
        params: { targetId: 'TARGET-PRIMARY', flatten: true },
        sessionId: browserSession,
      });
      const alias = ra.result.sessionId;
      assert.ok(relay.aliasSessions.has(alias));

      const rd = await sendAndReceive(cdp, {
        id: 3,
        method: 'Target.detachFromTarget',
        params: { sessionId: alias },
        sessionId: browserSession,
      });
      assert.deepEqual(rd.result, {});
      assert.ok(!relay.aliasSessions.has(alias), 'detach must drop the alias');
    } finally {
      cdp.close();
    }
  });

  it('drops aliases when the owning CDP client disconnects without detaching', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const rb = await sendAndReceive(cdp, { id: 1, method: 'Target.attachToBrowserTarget' });
    const ra = await sendAndReceive(cdp, {
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: 'TARGET-PRIMARY', flatten: true },
      sessionId: rb.result.sessionId,
    });
    const alias = ra.result.sessionId;
    assert.ok(relay.aliasSessions.has(alias));

    cdp.close();
    await sleep(150);
    assert.ok(!relay.aliasSessions.has(alias), 'client disconnect must drop its un-detached aliases');
  });

  it('drops aliases when their primary target detaches (_handleTabDetached)', () => {
    relay.aliasSessions.set('bf-alias-detach', { primarySessionId: 'bf-session-1', clientId: 'cli-x' });
    relay.aliasSessions.set('bf-alias-other', { primarySessionId: 'bf-session-OTHER', clientId: 'cli-x' });
    relay._handleTabDetached({ tabId: 4242, reason: 'test' });
    assert.ok(!relay.aliasSessions.has('bf-alias-detach'), 'alias for detached primary must be dropped');
    assert.ok(relay.aliasSessions.has('bf-alias-other'), 'unrelated alias must survive');
  });

  it('_dropAliasSessions removes only entries matching the predicate', () => {
    relay.aliasSessions.set('a1', { primarySessionId: 's1', clientId: 'c1' });
    relay.aliasSessions.set('a2', { primarySessionId: 's2', clientId: 'c2' });
    relay._dropAliasSessions((_id, entry) => entry.clientId === 'c1');
    assert.ok(!relay.aliasSessions.has('a1'), 'matching alias must be dropped');
    assert.ok(relay.aliasSessions.has('a2'), 'non-matching alias must survive');
  });

  it('clears all aliases when the extension disconnects (_cleanupExtension)', () => {
    relay.aliasSessions.set('a1', { primarySessionId: 's1', clientId: 'c1' });
    relay.aliasSessions.set('a2', { primarySessionId: 's2', clientId: 'c2' });
    relay._cleanupExtension();
    assert.equal(relay.aliasSessions.size, 0, 'extension disconnect must clear all aliases');
  });

  it('Target.setAutoAttach on the browser session echoes the browser sessionId', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    try {
      const rb = await sendAndReceive(cdp, { id: 1, method: 'Target.attachToBrowserTarget' });
      const browserSession = rb.result.sessionId;
      // setAutoAttach sends its OWN response (not via the shared echo path). On the
      // browser session it MUST still echo the sessionId, or the reply routes to the
      // client root with no callback → the `_CRSession._onMessage` assertion crash.
      const ra = await sendAndReceive(cdp, {
        id: 2,
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId: browserSession,
      });
      assert.equal(ra.id, 2);
      assert.equal(ra.sessionId, browserSession, 'setAutoAttach reply must echo the browser session');
      assert.deepEqual(ra.result, {});
    } finally {
      cdp.close();
    }
  });

  it('root Target.setAutoAttach (no sessionId) still replies WITHOUT a sessionId', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    try {
      const rr = await sendAndReceive(cdp, {
        id: 1,
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      });
      assert.equal(rr.id, 1);
      assert.deepEqual(rr.result, {});
      assert.ok(rr.sessionId === undefined, 'root setAutoAttach must not invent a sessionId');
    } finally {
      cdp.close();
    }
  });
});
