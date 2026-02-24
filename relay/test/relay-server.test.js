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

  it('defaults to single-active client mode', () => {
    delete process.env.BF_CLIENT_MODE;
    const relay = new RelayServer(getRandomPort());
    assert.equal(relay.clientMode, 'single-active');
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
    let c1;
    let c2;
    try {
      c1 = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
      await assert.rejects(
        (async () => {
          c2 = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
          c2.close();
        })(),
        /409|Unexpected/
      );
    } finally {
      if (c1 && c1.readyState === WebSocket.OPEN) c1.close();
      if (c2 && c2.readyState === WebSocket.OPEN) c2.close();
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

  it('auto-attach does not expose existing browser tabs', async () => {
    // Connect mock extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id !== undefined) {
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

    // Connect CDP client
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // Send setAutoAttach
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

    const attached = messages.filter((m) => m.method === 'Target.attachedToTarget');
    assert.equal(attached.length, 0, 'Should NOT report any targets (agent creates own tabs)');

    // Verify no targets in relay state
    const targets = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(targets.body.length, 0);

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

      assert.ok(directions.has('from-playwright'), 'Should log from-playwright direction');
      assert.ok(directions.has('to-extension'), 'Should log to-extension direction');
      assert.ok(directions.has('from-extension'), 'Should log from-extension direction');
      assert.ok(directions.has('to-playwright'), 'Should log to-playwright direction');
      assert.ok(methods.includes('Runtime.evaluate'), 'Should log Runtime.evaluate method');
      assert.ok(methods.includes('Page.loadEventFired'), 'Should log Page.loadEventFired method');
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
