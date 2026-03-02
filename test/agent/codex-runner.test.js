import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs, normalizeCodexLine } from '../../agent/src/codex-runner.js';

test('maps text delta line to chat.delta event', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"delta","text":"hi"}',
  });

  assert.equal(evt.event, 'chat.delta');
  assert.equal(evt.payload.delta, 'hi');
});

test('maps final line to chat.final event', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"final","text":"done"}',
  });

  assert.equal(evt.event, 'chat.final');
  assert.equal(evt.payload.text, 'done');
});

test('maps codex item.completed agent_message to chat.final', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
  });
  assert.equal(evt.event, 'chat.final');
  assert.equal(evt.payload.text, 'hello');
});

test('buildCodexExecArgs includes --model when session model is set', () => {
  const args = buildCodexExecArgs({ prompt: 'hi', model: 'gpt-5' });
  assert.deepEqual(args, ['exec', '--json', '--model', 'gpt-5', 'hi']);
});

test('buildCodexExecArgs omits --model when model is empty', () => {
  const args = buildCodexExecArgs({ prompt: 'hi', model: '' });
  assert.deepEqual(args, ['exec', '--json', 'hi']);
});

test('maps transient codex error line to non-fatal tool event', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"error","message":"Reconnecting... 2/5"}',
  });

  assert.equal(evt.event, 'tool.delta');
  assert.equal(evt.payload.level, 'warning');
  assert.match(evt.payload.message, /Reconnecting/);
});
