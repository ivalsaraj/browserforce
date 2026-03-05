import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildClaudeExecArgs,
  normalizeClaudeLine,
  startClaudeRun,
} from '../../agent/src/providers/claude-provider.js';

function readFixture(name) {
  const path = join(process.cwd(), 'test', 'agent', 'fixtures', name);
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

test('buildClaudeExecArgs uses stream-json print mode and --resume when provided', () => {
  const fresh = buildClaudeExecArgs({ prompt: 'hello', model: 'claude-sonnet-4-5' });
  assert.deepEqual(fresh, ['-p', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-5', 'hello']);

  const resume = buildClaudeExecArgs({
    prompt: 'hello',
    model: 'claude-sonnet-4-5',
    resumeSessionId: 'claude-session-resume-001',
  });
  assert.deepEqual(
    resume,
    ['-p', '--output-format', 'stream-json', '--resume', 'claude-session-resume-001', '--model', 'claude-sonnet-4-5', 'hello'],
  );
});

test('normalizeClaudeLine maps session continuity, deltas, final text, and usage', () => {
  const lineEvents = readFixture('claude-jsonl-start-run.sample')
    .flatMap((line) => normalizeClaudeLine({ runId: 'r1', sessionId: 's1', line }))
    .filter(Boolean);

  assert.equal(lineEvents.some((evt) => evt.event === 'run.provider_session' && evt.payload?.provider === 'claude'), true);
  assert.equal(lineEvents.some((evt) => evt.event === 'chat.delta'), true);
  assert.equal(lineEvents.some((evt) => evt.event === 'chat.final'), true);
  assert.equal(lineEvents.some((evt) => evt.event === 'run.usage'), true);
});

test('startClaudeRun maps ENOENT command failures to run.error event', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.pid = 4242;

  const events = [];
  let exitPayload = null;
  startClaudeRun({
    runId: 'run-enoent',
    sessionId: 'session-enoent',
    prompt: 'hello',
    spawnImpl: () => child,
    onEvent: (evt) => events.push(evt),
    onExit: (payload) => {
      exitPayload = payload;
    },
  });

  child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(events.some((evt) => evt.event === 'run.error' && /BF_CHATD_CLAUDE_COMMAND/.test(evt.payload?.error || '')), true);
  assert.equal(Number.isInteger(exitPayload?.code), true);
});
