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

test('maps codex item.completed agent_message to chat.delta (not premature final)', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
  });
  assert.equal(evt.event, 'chat.delta');
  assert.equal(evt.payload.delta, 'hello');
});

test('buildCodexExecArgs includes --model when session model is set', () => {
  const args = buildCodexExecArgs({ prompt: 'hi', model: 'gpt-5' });
  assert.deepEqual(args, ['exec', '--json', '--model', 'gpt-5', 'hi']);
});

test('buildCodexExecArgs emits resume invocation when codex session id is provided', () => {
  const args = buildCodexExecArgs({
    prompt: 'hi',
    model: 'gpt-5',
    resumeSessionId: '019caa6f-8c63-7c81-a542-3dbcf922d065',
  });
  assert.deepEqual(args, [
    'exec',
    'resume',
    '019caa6f-8c63-7c81-a542-3dbcf922d065',
    '--json',
    '--model',
    'gpt-5',
    'hi',
  ]);
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

test('maps codex turn.completed usage into run.usage event', () => {
  const line = JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 700,
      output_tokens: 120,
    },
  });
  const evt = normalizeCodexLine({ runId: 'r1', sessionId: 's1', line });
  assert.equal(evt.event, 'run.usage');
  assert.equal(evt.payload.modelContextWindow, null);
  assert.equal(evt.payload.totalTokens, 1120);
  assert.equal(evt.payload.inputTokens, 1000);
  assert.equal(evt.payload.cachedInputTokens, 700);
  assert.equal(evt.payload.outputTokens, 120);
});

test('maps codex token_count into run.usage event', () => {
  const line = JSON.stringify({
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 120, total_tokens: 1120 },
      model_context_window: 258400,
      reasoning_output_tokens: 14,
    },
  });
  const evt = normalizeCodexLine({ runId: 'r1', sessionId: 's1', line });
  assert.equal(evt.event, 'run.usage');
  assert.equal(evt.payload.modelContextWindow, 258400);
  assert.equal(evt.payload.totalTokens, 1120);
  assert.equal(evt.payload.reasoningOutputTokens, 14);
});

test('maps codex thread.started provider session id event to run.provider_session', () => {
  const line = JSON.stringify({
    type: 'thread.started',
    thread_id: '019caa6f-8c63-7c81-a542-3dbcf922d065',
  });
  const evt = normalizeCodexLine({ runId: 'r1', sessionId: 's1', line });
  assert.equal(evt.event, 'run.provider_session');
  assert.equal(evt.payload.provider, 'codex');
  assert.equal(evt.payload.sessionId, '019caa6f-8c63-7c81-a542-3dbcf922d065');
});
