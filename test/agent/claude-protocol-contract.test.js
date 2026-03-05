import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJsonlFixture(name) {
  const path = join(process.cwd(), 'test', 'agent', 'fixtures', name);
  const raw = readFileSync(path, 'utf8').trim();
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('claude start-run fixture locks expected JSONL event shape', () => {
  const rows = readJsonlFixture('claude-jsonl-start-run.sample');
  assert.equal(rows.length >= 3, true);
  assert.equal(rows[0]?.type, 'system');
  assert.equal(rows[0]?.subtype, 'init');
  assert.equal(typeof rows[0]?.session_id, 'string');

  const assistantRows = rows.filter((row) => row?.type === 'assistant');
  assert.equal(assistantRows.length >= 1, true);
  assert.equal(
    assistantRows.every((row) => Array.isArray(row?.message?.content)),
    true,
  );

  const resultRow = rows.find((row) => row?.type === 'result');
  assert.equal(resultRow?.subtype, 'success');
  assert.equal(typeof resultRow?.result, 'string');
  assert.equal(typeof resultRow?.usage?.input_tokens, 'number');
  assert.equal(typeof resultRow?.usage?.output_tokens, 'number');
});

test('claude resume fixture locks resume continuity fields and flag contract', () => {
  const rows = readJsonlFixture('claude-jsonl-resume-run.sample');
  assert.equal(rows.length >= 2, true);
  assert.equal(rows[0]?.type, 'system');
  assert.equal(rows[0]?.subtype, 'init');
  assert.equal(rows[0]?.resumed, true);
  assert.equal(typeof rows[0]?.session_id, 'string');

  const resultRow = rows.find((row) => row?.type === 'result');
  assert.equal(typeof resultRow?.session_id, 'string');
  assert.equal(resultRow?.session_id, rows[0]?.session_id);

  const expectedResumeInvocation = ['-p', '--output-format', 'stream-json', '--resume', '<providerSessionId>', '<prompt>'];
  assert.deepEqual(expectedResumeInvocation.slice(0, 4), ['-p', '--output-format', 'stream-json', '--resume']);
});
