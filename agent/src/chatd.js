import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickChatdPort } from './port-resolver.js';
import { isAllowedOrigin, verifyBearer } from './auth.js';
import { startCodexRun } from './codex-runner.js';
import {
  appendMessage,
  createSession,
  getSession,
  isValidModelId,
  isValidSessionId,
  listSessions,
  readMessages,
  updateSession,
} from './session-store.js';

const BF_DIR = join(homedir(), '.browserforce');
const CHATD_URL_PATH = join(BF_DIR, 'chatd-url.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const MODEL_LIST_TIMEOUT_MS = 5000;

function parseTopLevelTomlString(raw, key) {
  const lines = String(raw || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;

    const doubleQuoted = line.match(new RegExp(`^${key}\\s*=\\s*\"([^\"]+)\"(?:\\s*#.*)?$`));
    if (doubleQuoted) return doubleQuoted[1].trim();

    const singleQuoted = line.match(new RegExp(`^${key}\\s*=\\s*'([^']+)'(?:\\s*#.*)?$`));
    if (singleQuoted) return singleQuoted[1].trim();
  }
  return null;
}

async function resolveConfiguredModel() {
  const envModel = String(process.env.BF_CHATD_DEFAULT_MODEL || '').trim();
  if (envModel && isValidModelId(envModel)) return envModel;

  try {
    const raw = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
    const model = parseTopLevelTomlString(raw, 'model');
    if (model && isValidModelId(model)) return model;
  } catch {
    // no local codex config is fine
  }
  return null;
}

function dedupeModelRows(rows) {
  const seen = new Set();
  const out = [{ value: null, label: 'Default' }];
  for (const row of rows) {
    if (!row || typeof row.value !== 'string') continue;
    const value = row.value.trim();
    if (!value || seen.has(value) || !isValidModelId(value)) continue;
    seen.add(value);
    out.push({ value, label: row.label || value });
  }
  return out;
}

function safeParseJsonLine(line) {
  if (typeof line !== 'string') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeModelCatalogRows(models) {
  return (Array.isArray(models) ? models : [])
    .filter((row) => row && typeof row === 'object' && !row.hidden)
    .map((row) => {
      const value = String(row.model || row.id || '').trim();
      const label = String(row.displayName || row.model || row.id || '').trim();
      if (!value || !isValidModelId(value)) return null;
      return { value, label: label || value };
    })
    .filter(Boolean);
}

async function fetchCodexModelCatalog({
  command = process.env.BF_CHATD_CODEX_COMMAND || 'codex',
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let settled = false;
    let stderrText = '';
    let stdoutBuffer = '';

    const finish = (error, models = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      if (error) reject(error);
      else resolve(models);
    };

    const timer = setTimeout(() => {
      finish(new Error('Timed out while loading Codex models'));
    }, timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrText += String(chunk || '');
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk || '');
      let idx = stdoutBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        idx = stdoutBuffer.indexOf('\n');
        if (!line) continue;

        const msg = safeParseJsonLine(line);
        if (!msg || typeof msg !== 'object') continue;

        if (msg.id === 1 && msg.error) {
          finish(new Error(msg.error?.message || 'Codex initialize failed'));
          return;
        }
        if (msg.id === 1 && msg.result) {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'model/list',
              params: { includeHidden: false, limit: 100 },
            })}\n`);
          } catch {
            finish(new Error('Failed to request Codex model list'));
          }
          continue;
        }

        if (msg.id === 2 && msg.error) {
          finish(new Error(msg.error?.message || 'Codex model/list failed'));
          return;
        }

        if (msg.id === 2 && msg.result) {
          finish(null, msg.result?.data || []);
        }
      }
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('exit', (code) => {
      if (settled) return;
      finish(new Error(`Codex app-server exited before model/list (${code ?? 'unknown'}) ${stderrText}`.trim()));
    });

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'browserforce-chatd', version: '1.0.0' },
          capabilities: { experimentalApi: false },
        },
      })}\n`);
    } catch {
      finish(new Error('Failed to initialize Codex app-server'));
    }
  });
}

async function listModelPresets({ storageRoot, modelFetcher } = {}) {
  let liveRows = [];
  if (typeof modelFetcher === 'function') {
    try {
      const liveModels = await modelFetcher();
      liveRows = normalizeModelCatalogRows(liveModels);
    } catch {
      liveRows = [];
    }
  }

  const configuredModel = await resolveConfiguredModel();
  const sessions = await listSessions({ limit: 200, storageRoot });
  const sessionRows = sessions
    .map((session) => String(session?.model || '').trim())
    .filter(Boolean)
    .map((value) => ({ value, label: value }));

  const configuredRow = configuredModel && !liveRows.some((row) => row.value === configuredModel)
    ? [{ value: configuredModel, label: `${configuredModel} (Configured)` }]
    : [];

  return dedupeModelRows([...liveRows, ...configuredRow, ...sessionRows]);
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function safeDecodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function buildEvent({ event, runId, sessionId, payload }) {
  return {
    event,
    runId,
    sessionId,
    payload: payload || {},
    timestamp: nowIso(),
  };
}

async function writeChatdUrlFile({ port, token, writeChatdUrl = true, urlPath = CHATD_URL_PATH }) {
  if (!writeChatdUrl) return;
  await fs.mkdir(dirname(urlPath), { recursive: true });
  await fs.writeFile(urlPath, `${JSON.stringify({ port, token })}\n`, { mode: 0o600 });
}

async function clearChatdUrlFile({ writeChatdUrl = true, urlPath = CHATD_URL_PATH }) {
  if (!writeChatdUrl) return;
  try {
    await fs.unlink(urlPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function createDefaultRunExecutor({ codexCwd } = {}) {
  return ({ runId, sessionId, message, model, onEvent, onExit, onError }) => startCodexRun({
    runId,
    sessionId,
    prompt: message,
    model,
    cwd: codexCwd,
    onEvent,
    onExit,
    onError,
  });
}

export async function startChatd(opts = {}) {
  const writeChatdUrl = opts.writeChatdUrl !== false;
  const ephemeralStorageRoot = (!opts.storageRoot && !writeChatdUrl)
    ? await fs.mkdtemp(join(tmpdir(), 'bf-chatd-'))
    : null;
  const storageRoot = opts.storageRoot || ephemeralStorageRoot;
  const token = opts.token || process.env.BF_CHATD_TOKEN || randomBytes(32).toString('base64url');
  const chatdUrlPath = opts.chatdUrlPath || process.env.BF_CHATD_URL_PATH || CHATD_URL_PATH;
  const runExecutor = opts.runExecutor || createDefaultRunExecutor({ codexCwd: opts.codexCwd || process.cwd() });
  const modelFetcher = opts.modelFetcher || (() => fetchCodexModelCatalog({
    command: opts.codexCommand || process.env.BF_CHATD_CODEX_COMMAND || 'codex',
    timeoutMs: Number(process.env.BF_CHATD_MODEL_LIST_TIMEOUT_MS || MODEL_LIST_TIMEOUT_MS),
  }));

  let desiredPort = Number.isFinite(opts.port) ? Number(opts.port) : Number(process.env.BF_CHATD_PORT || 0);
  if (!Number.isInteger(desiredPort) || desiredPort < 0) desiredPort = 0;

  if (desiredPort === 0) {
    desiredPort = await pickChatdPort({
      envPort: Number(process.env.BF_CHATD_PORT || 0),
      rangeStart: 19280,
      rangeEnd: 19320,
    }).catch(() => 0);
  }

  const startedAt = Date.now();
  const sseClients = new Set();
  const runs = new Map();

  const broadcast = (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      if (client.sessionId && client.sessionId !== evt.sessionId) continue;
      try {
        client.res.write(line);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  async function finalizeRun(run, finalText) {
    if (!run || run.status !== 'running' || run.finalSent) return;
    run.finalSent = true;
    run.status = 'done';
    await appendMessage({ sessionId: run.sessionId, role: 'assistant', text: finalText, storageRoot });
    broadcast(buildEvent({ event: 'chat.final', runId: run.runId, sessionId: run.sessionId, payload: { text: finalText } }));
    runs.delete(run.runId);
  }

  function failRun(run, errorMessage) {
    if (!run || run.status !== 'running') return;
    run.status = 'error';
    broadcast(buildEvent({
      event: 'run.error',
      runId: run.runId,
      sessionId: run.sessionId,
      payload: { error: errorMessage || 'Run failed' },
    }));
    runs.delete(run.runId);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const base = `http://${req.headers.host || '127.0.0.1'}`;
      const url = new URL(req.url || '/', base);

      if (url.pathname === '/health' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          port: server.address()?.port || desiredPort,
          uptimeMs: Date.now() - startedAt,
        });
        return;
      }

      if (url.pathname.startsWith('/v1/')) {
        const origin = req.headers.origin;
        if (!isAllowedOrigin(origin)) {
          json(res, 403, { error: 'Forbidden - invalid origin' });
          return;
        }
        if (!verifyBearer(req, token)) {
          json(res, 401, { error: 'Unauthorized' });
          return;
        }
      }

      if (url.pathname === '/v1/sessions' && req.method === 'GET') {
        const sessions = await listSessions({ storageRoot });
        json(res, 200, { sessions });
        return;
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = await listModelPresets({ storageRoot, modelFetcher });
        json(res, 200, { models });
        return;
      }

      if (url.pathname === '/v1/sessions' && req.method === 'POST') {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        try {
          const session = await createSession({
            title: body.title || 'New chat',
            model: body.model ?? null,
            storageRoot,
          });
          json(res, 201, session);
        } catch (error) {
          json(res, 400, { error: error?.message || 'Invalid session body' });
        }
        return;
      }

      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === 'PATCH') {
        const decodedSessionId = safeDecodeComponent(sessionMatch[1]);
        if (!decodedSessionId || !isValidSessionId(decodedSessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }

        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        try {
          const updated = await updateSession({
            sessionId: decodedSessionId,
            patch: {
              ...(Object.prototype.hasOwnProperty.call(body, 'title') ? { title: body.title } : {}),
              ...(Object.prototype.hasOwnProperty.call(body, 'model') ? { model: body.model } : {}),
            },
            storageRoot,
          });
          if (!updated) {
            json(res, 404, { error: 'Session not found' });
            return;
          }
          json(res, 200, updated);
        } catch (error) {
          json(res, 400, { error: error?.message || 'Invalid session patch' });
        }
        return;
      }

      const messagesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && req.method === 'GET') {
        const decodedSessionId = safeDecodeComponent(messagesMatch[1]);
        if (!decodedSessionId || !isValidSessionId(decodedSessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 100);
        const messages = await readMessages({ sessionId: decodedSessionId, limit, storageRoot });
        json(res, 200, { sessionId: decodedSessionId, messages });
        return;
      }

      if (url.pathname === '/v1/events' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || null;
        if (sessionId && !isValidSessionId(sessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');

        const client = {
          res,
          sessionId,
          heartbeat: setInterval(() => {
            try {
              res.write(': ping\n\n');
            } catch {
              // closed socket
            }
          }, 15000),
        };
        sseClients.add(client);

        req.on('close', () => {
          clearInterval(client.heartbeat);
          sseClients.delete(client);
        });
        return;
      }

      if (url.pathname === '/v1/runs' && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        const { sessionId, message } = body || {};
        if (!sessionId || typeof sessionId !== 'string') {
          json(res, 400, { error: 'sessionId is required' });
          return;
        }
        if (!isValidSessionId(sessionId)) {
          json(res, 400, { error: 'sessionId is invalid' });
          return;
        }
        if (!message || typeof message !== 'string') {
          json(res, 400, { error: 'message is required' });
          return;
        }
        const session = await getSession({ sessionId, storageRoot });
        if (!session) {
          json(res, 404, { error: 'Session not found' });
          return;
        }

        const runId = randomBytes(12).toString('base64url');
        const run = {
          runId,
          sessionId,
          status: 'running',
          abort: null,
          assistantBuffer: '',
          finalSent: false,
          queue: Promise.resolve(),
        };

        const enqueue = (fn) => {
          run.queue = run.queue.then(fn, fn);
        };

        try {
          await appendMessage({ sessionId, role: 'user', text: message, storageRoot });
          runs.set(runId, run);

          const handle = runExecutor({
            runId,
            sessionId,
            message,
            model: session.model || null,
            onEvent: (evt) => {
              enqueue(async () => {
                const active = runs.get(runId);
                if (!active || active.status !== 'running') return;

                if (evt.event === 'chat.delta') {
                  const delta = evt.payload?.delta || '';
                  if (delta) {
                    active.assistantBuffer += delta;
                    broadcast(buildEvent({ event: 'chat.delta', runId, sessionId, payload: { delta } }));
                  }
                  return;
                }

                if (evt.event === 'chat.final') {
                  const text = evt.payload?.text || active.assistantBuffer || '';
                  await finalizeRun(active, text);
                  return;
                }

                if (evt.event === 'run.error') {
                  failRun(active, evt.payload?.error || 'Run failed');
                  return;
                }

                if (evt.event === 'run.started') {
                  return;
                }

                broadcast(buildEvent({ event: evt.event, runId, sessionId, payload: evt.payload }));
              });
            },
            onExit: ({ code, signal }) => {
              enqueue(async () => {
                const active = runs.get(runId);
                if (!active || active.status !== 'running') return;

                if (signal === 'SIGTERM' || active.status === 'aborted') return;

                if (active.assistantBuffer) {
                  await finalizeRun(active, active.assistantBuffer);
                  return;
                }

                if (code === 0) {
                  await finalizeRun(active, '');
                  return;
                }

                failRun(active, `codex exited with code ${code ?? 'unknown'}`);
              });
            },
            onError: (error) => {
              enqueue(() => {
                const active = runs.get(runId);
                failRun(active, error?.message || 'Failed to start codex');
              });
            },
          });

          run.abort = handle?.abort || null;
          broadcast(buildEvent({ event: 'run.started', runId, sessionId, payload: { message, model: session.model || null } }));
          json(res, 202, { ok: true, runId, sessionId });
        } catch (error) {
          runs.delete(runId);
          json(res, 500, { error: error?.message || 'Failed to start run' });
        }
        return;
      }

      const abortMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/abort$/);
      if (abortMatch && (req.method === 'DELETE' || req.method === 'POST')) {
        const decodedRunId = safeDecodeComponent(abortMatch[1]);
        if (!decodedRunId) {
          json(res, 400, { error: 'Invalid runId' });
          return;
        }

        const run = runs.get(decodedRunId);
        if (!run) {
          json(res, 404, { error: 'Run not found' });
          return;
        }

        run.status = 'aborted';
        run.abort?.();
        runs.delete(decodedRunId);
        broadcast(buildEvent({ event: 'run.aborted', runId: decodedRunId, sessionId: run.sessionId, payload: {} }));
        json(res, 200, { ok: true, runId: decodedRunId, aborted: true });
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 500, { error: error?.message || 'Internal server error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(desiredPort, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  await writeChatdUrlFile({ port, token, writeChatdUrl, urlPath: chatdUrlPath });

  const stop = async () => {
    for (const run of runs.values()) {
      run.status = 'aborted';
      run.abort?.();
    }
    runs.clear();

    for (const client of sseClients) {
      clearInterval(client.heartbeat);
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();

    await new Promise((resolve) => server.close(resolve));
    await clearChatdUrlFile({ writeChatdUrl, urlPath: chatdUrlPath });
    if (ephemeralStorageRoot) {
      await fs.rm(ephemeralStorageRoot, { recursive: true, force: true });
    }
  };

  return {
    token,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop,
  };
}

async function main() {
  const daemon = await startChatd({
    port: Number(process.env.BF_CHATD_PORT || 0),
    token: process.env.BF_CHATD_TOKEN,
    writeChatdUrl: true,
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[chatd] ${error.stack || error.message}`);
    process.exit(1);
  });
}

export { CHATD_URL_PATH };
