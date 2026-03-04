import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STORAGE_ROOT = join(homedir(), '.browserforce', 'agent', 'sessions');
const INDEX_FILE = 'index.json';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const indexWriteQueues = new Map();

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

function normalizeRunId(runId) {
  if (runId == null) return null;
  const normalized = String(runId).trim();
  if (!normalized) return null;
  if (!RUN_ID_RE.test(normalized)) {
    throw new Error('appendMessage requires a safe runId');
  }
  return normalized;
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const label = String(step.label || '').trim();
  if (!label) return null;
  const kind = String(step.kind || '').trim() || 'reasoning';
  const normalizedStatus = String(step.status || '').trim().toLowerCase();
  const status = normalizedStatus === 'completed' || normalizedStatus === 'success' || normalizedStatus === 'succeeded'
    ? 'done'
    : (normalizedStatus || 'running');
  const key = String(step.key || '').trim();
  const details = Array.isArray(step.details)
    ? step.details
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 8)
    : [];
  return {
    kind,
    status,
    label: label.length > 160 ? `${label.slice(0, 157)}...` : label,
    ...(key ? { key: key.length > 220 ? key.slice(0, 220) : key } : {}),
    ...(details.length > 0 ? { details } : {}),
  };
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map(normalizeStep)
    .filter(Boolean)
    .slice(-100);
}

function normalizeTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'text') {
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text) return null;
    return { type: 'text', text };
  }
  const step = normalizeStep(entry);
  if (!step) return null;
  return { type: 'step', ...step };
}

function normalizeTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  const entries = [];
  const isTerminal = (status) => ['done', 'failed', 'aborted'].includes(String(status || '').toLowerCase());
  const isGenericLabel = (label) => {
    const normalized = String(label || '').trim().toLowerCase();
    return normalized === 'tool call started' || normalized === 'tool call completed' || normalized === 'working...';
  };
  for (const item of timeline.slice(-200)) {
    const normalized = normalizeTimelineEntry(item);
    if (!normalized) continue;
    const last = entries[entries.length - 1];
    if (normalized.type === 'text' && last?.type === 'text') {
      last.text = `${last.text || ''}${normalized.text || ''}`;
      continue;
    }
    if (normalized.type === 'step' && normalized.key) {
      const index = (() => {
        for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
          const entry = entries[idx];
          if (entry?.type === 'step' && entry.key === normalized.key) return idx;
        }
        return -1;
      })();
      if (index >= 0) {
        const existing = entries[index];
        entries[index] = {
          ...existing,
          ...normalized,
          label: (isGenericLabel(normalized.label) && existing?.label) ? existing.label : normalized.label,
          details: normalized.details && normalized.details.length > 0 ? normalized.details : existing?.details,
        };
        continue;
      }
    }
    if (
      normalized.type === 'step'
      && !normalized.key
      && isTerminal(normalized.status)
    ) {
      const index = (() => {
        for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
          const entry = entries[idx];
          if (
            entry
            && entry.type === 'step'
            && !entry.key
            && entry.kind === normalized.kind
            && entry.label === normalized.label
            && !isTerminal(entry.status)
          ) {
            return idx;
          }
        }
        return -1;
      })();
      if (index >= 0) {
        const existing = entries[index];
        entries[index] = {
          ...existing,
          ...normalized,
          details: normalized.details && normalized.details.length > 0 ? normalized.details : existing?.details,
        };
        continue;
      }
    }
    if (
      normalized.type === 'step'
      && last?.type === 'step'
      && last.label === normalized.label
      && last.kind === normalized.kind
      && last.status === normalized.status
      && last.key === normalized.key
    ) {
      continue;
    }
    entries.push(normalized);
  }
  return entries.slice(-200);
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
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, path);
  } finally {
    try { await fs.unlink(tmpPath); } catch {}
  }
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

function normalizeUsageNumber(value, fieldName) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`providerState.codex.latestUsage.${fieldName} must be a non-negative number`);
  }
  return Math.round(parsed);
}

function normalizeLatestUsage(latestUsage) {
  if (latestUsage == null) return null;
  if (!isObject(latestUsage)) {
    throw new Error('providerState.codex.latestUsage must be an object');
  }

  const fields = [
    'modelContextWindow',
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ];

  const normalized = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(latestUsage, field)) continue;
    const value = normalizeUsageNumber(latestUsage[field], field);
    if (value != null) normalized[field] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeCodexProviderState(patchCodex, currentCodex) {
  if (patchCodex == null) return null;
  if (!isObject(patchCodex)) {
    throw new Error('providerState.codex must be an object');
  }

  const normalized = isObject(currentCodex) ? { ...currentCodex } : {};

  if (Object.prototype.hasOwnProperty.call(patchCodex, 'sessionId')) {
    if (patchCodex.sessionId == null || String(patchCodex.sessionId).trim() === '') {
      delete normalized.sessionId;
    } else {
      const sessionId = String(patchCodex.sessionId).trim();
      if (!isValidSessionId(sessionId)) {
        throw new Error('providerState.codex.sessionId must be a safe session id');
      }
      normalized.sessionId = sessionId;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patchCodex, 'latestUsage')) {
    const latestUsage = normalizeLatestUsage(patchCodex.latestUsage);
    if (latestUsage == null) delete normalized.latestUsage;
    else normalized.latestUsage = latestUsage;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeProviderState(providerStatePatch, currentProviderState) {
  if (!isObject(providerStatePatch)) {
    throw new Error('providerState must be an object');
  }
  const normalized = isObject(currentProviderState) ? { ...currentProviderState } : {};

  if (Object.prototype.hasOwnProperty.call(providerStatePatch, 'codex')) {
    const codex = normalizeCodexProviderState(providerStatePatch.codex, normalized.codex);
    if (codex == null) delete normalized.codex;
    else normalized.codex = codex;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
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
    if (Object.prototype.hasOwnProperty.call(patch, 'providerState')) {
      const providerState = normalizeProviderState(patch.providerState, current.providerState);
      if (providerState == null) delete next.providerState;
      else next.providerState = providerState;
    }
    next.updatedAt = now;
    sessions[idx] = next;
    await writeIndex(root, sessions);
    return next;
  });
}

export async function appendMessage({ sessionId, role, text, runId, steps, timeline, storageRoot } = {}) {
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
  const safeRunId = normalizeRunId(runId);
  if (safeRunId) {
    entry.runId = safeRunId;
  }
  const normalizedSteps = normalizeSteps(steps);
  if (normalizedSteps.length > 0) {
    entry.steps = normalizedSteps;
  }
  const normalizedTimeline = normalizeTimeline(timeline);
  if (normalizedTimeline.length > 0) {
    entry.timeline = normalizedTimeline;
  }

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
