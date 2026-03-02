import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STORAGE_ROOT = join(homedir(), '.browserforce', 'agent', 'sessions');
const INDEX_FILE = 'index.json';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const indexWriteQueues = new Map();

function resolveStorageRoot(storageRoot) {
  return storageRoot || DEFAULT_STORAGE_ROOT;
}

function indexPath(storageRoot) {
  return join(storageRoot, INDEX_FILE);
}

function messageLogPath(storageRoot, sessionId) {
  return join(storageRoot, `${sessionId}.jsonl`);
}

export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

export function isValidModelId(model) {
  return typeof model === 'string' && MODEL_ID_RE.test(model);
}

function assertValidSessionId(sessionId, fnName) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`${fnName} requires a safe sessionId`);
  }
}

async function ensureStorageRoot(storageRoot) {
  await fs.mkdir(storageRoot, { recursive: true });
}

async function readIndex(storageRoot) {
  const path = indexPath(storageRoot);
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid session index: ${error?.message || 'unable to parse json'}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
    throw new Error('invalid session index: missing sessions array');
  }

  return parsed.sessions;
}

async function writeIndex(storageRoot, sessions) {
  const path = indexPath(storageRoot);
  const tmpPath = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, path);
}

async function withIndexWriteLock(storageRoot, operation) {
  const queue = indexWriteQueues.get(storageRoot) || Promise.resolve();
  const next = queue.then(operation, operation);
  indexWriteQueues.set(storageRoot, next.catch(() => {}));
  return next;
}

function normalizeModel(model) {
  if (model == null) return null;
  const trimmed = String(model).trim();
  if (!trimmed) return null;
  if (!isValidModelId(trimmed)) {
    throw new Error('model must be a safe model id');
  }
  return trimmed;
}

function sortSessionsNewestFirst(a, b) {
  const aTs = Date.parse(a.updatedAt || a.createdAt || 0);
  const bTs = Date.parse(b.updatedAt || b.createdAt || 0);
  return bTs - aTs;
}

export async function createSession({ title = 'New chat', model = null, storageRoot } = {}) {
  const root = resolveStorageRoot(storageRoot);
  await ensureStorageRoot(root);

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const session = {
    sessionId,
    title,
    model: normalizeModel(model),
    createdAt: now,
    updatedAt: now,
  };

  await withIndexWriteLock(root, async () => {
    const sessions = await readIndex(root);
    sessions.push(session);
    await writeIndex(root, sessions);
  });

  return session;
}

export async function listSessions({ limit = 50, storageRoot } = {}) {
  const root = resolveStorageRoot(storageRoot);
  await ensureStorageRoot(root);
  const sessions = await readIndex(root);
  return sessions
    .slice()
    .sort(sortSessionsNewestFirst)
    .slice(0, limit);
}

export async function getSession({ sessionId, storageRoot } = {}) {
  assertValidSessionId(sessionId, 'getSession');
  const root = resolveStorageRoot(storageRoot);
  await ensureStorageRoot(root);
  const sessions = await readIndex(root);
  return sessions.find((row) => row.sessionId === sessionId) || null;
}

export async function updateSession({ sessionId, patch = {}, storageRoot } = {}) {
  assertValidSessionId(sessionId, 'updateSession');
  if (!patch || typeof patch !== 'object') {
    throw new Error('updateSession requires patch');
  }

  const root = resolveStorageRoot(storageRoot);
  await ensureStorageRoot(root);
  const now = new Date().toISOString();

  return withIndexWriteLock(root, async () => {
    const sessions = await readIndex(root);
    const idx = sessions.findIndex((row) => row.sessionId === sessionId);
    if (idx === -1) return null;

    const current = sessions[idx];
    const next = { ...current };
    if (typeof patch.title === 'string') {
      next.title = patch.title.trim() || current.title || 'New chat';
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
      next.model = normalizeModel(patch.model);
    }
    next.updatedAt = now;
    sessions[idx] = next;
    await writeIndex(root, sessions);
    return next;
  });
}

export async function appendMessage({ sessionId, role, text, storageRoot } = {}) {
  assertValidSessionId(sessionId, 'appendMessage');
  if (!role) throw new Error('appendMessage requires role');
  if (typeof text !== 'string') throw new Error('appendMessage requires text');

  const root = resolveStorageRoot(storageRoot);
  await ensureStorageRoot(root);

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    sessionId,
    role,
    text,
    createdAt: now,
  };

  const logPath = messageLogPath(root, sessionId);
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');

  await withIndexWriteLock(root, async () => {
    const sessions = await readIndex(root);
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) {
      sessions.push({
        sessionId,
        title: 'Recovered chat',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      sessions[idx] = {
        ...sessions[idx],
        updatedAt: now,
      };
    }
    await writeIndex(root, sessions);
  });

  return entry;
}

export async function readMessages({ sessionId, limit = 100, storageRoot } = {}) {
  assertValidSessionId(sessionId, 'readMessages');

  const root = resolveStorageRoot(storageRoot);
  await ensureStorageRoot(root);

  const logPath = messageLogPath(root, sessionId);
  let raw;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (rows.length <= limit) return rows;
  return rows.slice(rows.length - limit);
}
