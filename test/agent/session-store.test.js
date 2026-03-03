import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  listSessions,
  appendMessage,
  readMessages,
  updateSession,
} from '../../agent/src/session-store.js';

let storageRoot;

test.before(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'bf-sessions-'));
});

test.after(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

test('createSession generates unique session ids', async () => {
  const a = await createSession({ title: 'A', storageRoot });
  const b = await createSession({ title: 'B', storageRoot });
  assert.notEqual(a.sessionId, b.sessionId);
});

test('messages are stored and loaded by sessionId', async () => {
  const { sessionId } = await createSession({ title: 'Test', storageRoot });
  await appendMessage({ sessionId, role: 'user', text: 'hello', storageRoot });
  const rows = await readMessages({ sessionId, limit: 20, storageRoot });
  assert.equal(rows.at(-1).text, 'hello');
});

test('messages preserve optional run metadata used for transcript rehydration', async () => {
  const { sessionId } = await createSession({ title: 'Runs', storageRoot });
  await appendMessage({
    sessionId,
    role: 'assistant',
    text: 'done',
    runId: 'run_123',
    steps: [{ kind: 'tool', status: 'done', label: 'Snapshot page' }],
    timeline: [
      { type: 'step', kind: 'tool', status: 'done', label: 'Snapshot page' },
      { type: 'text', text: 'done' },
    ],
    storageRoot,
  });
  const rows = await readMessages({ sessionId, limit: 20, storageRoot });
  const last = rows.at(-1);
  assert.equal(last.runId, 'run_123');
  assert.deepEqual(last.steps, [{ kind: 'tool', status: 'done', label: 'Snapshot page' }]);
  assert.deepEqual(last.timeline, [
    { type: 'step', kind: 'tool', status: 'done', label: 'Snapshot page' },
    { type: 'text', text: 'done' },
  ]);
});

test('rejects unsafe session ids', async () => {
  await assert.rejects(
    appendMessage({ sessionId: '../escape', role: 'user', text: 'x', storageRoot }),
    /safe sessionId/,
  );
});

test('listSessions returns newest first', async () => {
  const older = await createSession({ title: 'Older', storageRoot });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await createSession({ title: 'Newer', storageRoot });
  const rows = await listSessions({ limit: 10, storageRoot });
  const olderIdx = rows.findIndex((row) => row.sessionId === older.sessionId);
  const newerIdx = rows.findIndex((row) => row.sessionId === newer.sessionId);
  assert.ok(newerIdx !== -1);
  assert.ok(olderIdx !== -1);
  assert.ok(newerIdx < olderIdx);
});

test('updateSession persists per-session model and title', async () => {
  const created = await createSession({ title: 'Before', storageRoot });
  const updated = await updateSession({
    sessionId: created.sessionId,
    patch: { title: 'After', model: 'gpt-5' },
    storageRoot,
  });

  assert.equal(updated?.title, 'After');
  assert.equal(updated?.model, 'gpt-5');

  const rows = await listSessions({ limit: 10, storageRoot });
  const row = rows.find((item) => item.sessionId === created.sessionId);
  assert.equal(row?.title, 'After');
  assert.equal(row?.model, 'gpt-5');
});

test('updateSession persists codex provider session mapping', async () => {
  const created = await createSession({ title: 'Continuity', storageRoot });
  const updated = await updateSession({
    sessionId: created.sessionId,
    patch: {
      providerState: {
        codex: {
          sessionId: '019caa6f-8c63-7c81-a542-3dbcf922d065',
          latestUsage: {
            modelContextWindow: 258400,
            totalTokens: 128125,
            cachedInputTokens: 126592,
          },
        },
      },
    },
    storageRoot,
  });

  assert.equal(updated?.providerState?.codex?.sessionId, '019caa6f-8c63-7c81-a542-3dbcf922d065');
  assert.equal(updated?.providerState?.codex?.latestUsage?.modelContextWindow, 258400);

  const rows = await listSessions({ limit: 10, storageRoot });
  const row = rows.find((item) => item.sessionId === created.sessionId);
  assert.equal(row?.providerState?.codex?.sessionId, '019caa6f-8c63-7c81-a542-3dbcf922d065');
  assert.equal(row?.providerState?.codex?.latestUsage?.totalTokens, 128125);
});

test('listSessions fails fast on corrupted index metadata', async () => {
  writeFileSync(join(storageRoot, 'index.json'), '{this-is-not-json\n', 'utf8');
  await assert.rejects(
    listSessions({ limit: 10, storageRoot }),
    /invalid session index/i,
  );
});
