import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexStderrStepPayload,
  buildCodexExecArgs,
  getDefaultModelContextWindow,
  normalizeCodexLine,
  shouldSuppressCodexStderrLine,
} from '../../agent/src/codex-runner.js';

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

test('maps codex item.completed agent_message commentary to chat.commentary', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"item.completed","item":{"type":"agent_message","text":"hello","phase":"commentary"}}',
  });
  assert.equal(evt.event, 'chat.commentary');
  assert.equal(evt.payload.delta, 'hello');
});

test('maps codex item.completed agent_message final_answer to chat.final', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: '{"type":"item.completed","item":{"type":"agent_message","text":"done","phase":"final_answer"}}',
  });
  assert.equal(evt.event, 'chat.final');
  assert.equal(evt.payload.text, 'done');
});

test('buildCodexExecArgs includes --model when session model is set', () => {
  const args = buildCodexExecArgs({ prompt: 'hi', model: 'gpt-5' });
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '--model', 'gpt-5', 'hi']);
});

test('buildCodexExecArgs includes reasoning effort override when set', () => {
  const args = buildCodexExecArgs({ prompt: 'hi', reasoningEffort: 'medium' });
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort="medium"', 'hi']);
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
    '--skip-git-repo-check',
    '--model',
    'gpt-5',
    'hi',
  ]);
});

test('buildCodexExecArgs omits --model when model is empty', () => {
  const args = buildCodexExecArgs({ prompt: 'hi', model: '' });
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', 'hi']);
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

test('suppresses refresh_token_reused auth stderr block', () => {
  const state = {};
  assert.equal(
    shouldSuppressCodexStderrLine(
      '2026-03-04T08:56:12.804579Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {',
      state,
    ),
    true,
  );
  assert.equal(shouldSuppressCodexStderrLine('  "error": {', state), true);
  assert.equal(shouldSuppressCodexStderrLine('    "code": "refresh_token_reused"', state), true);
  assert.equal(shouldSuppressCodexStderrLine('  }', state), true);
  assert.equal(shouldSuppressCodexStderrLine('}', state), true);
  assert.equal(
    shouldSuppressCodexStderrLine(
      '2026-03-04T08:56:12.804795Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      state,
    ),
    true,
  );
});

test('does not suppress non-auth stderr lines', () => {
  const state = {};
  assert.equal(
    shouldSuppressCodexStderrLine(
      '2026-03-04T08:56:14.841913Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot',
      state,
    ),
    false,
  );
  assert.equal(
    shouldSuppressCodexStderrLine(
      '2026-03-04T08:56:23.764711Z ERROR rmcp::transport::async_rw: Error reading from stream',
      state,
    ),
    false,
  );
});

test('builds human-readable stderr summary payload with singular/plural label', () => {
  const single = buildCodexStderrStepPayload({ count: 1, lines: ['first warning'] });
  assert.equal(single.message, 'Codex stderr (1 line)');
  assert.deepEqual(single.details, ['first warning']);

  const plural = buildCodexStderrStepPayload({ count: 2, lines: ['first', 'second'] });
  assert.equal(plural.message, 'Codex stderr (2 lines)');
  assert.deepEqual(plural.details, ['first', 'second']);
});

test('stderr summary payload keeps only latest detail lines', () => {
  const lines = Array.from({ length: 11 }, (_, i) => `line-${i + 1}`);
  const payload = buildCodexStderrStepPayload({ count: lines.length, lines });
  assert.equal(payload.message, 'Codex stderr (11 lines)');
  assert.deepEqual(payload.details, lines.slice(-8));
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

test('treats zero model_context_window in token_count as missing context window', () => {
  const line = JSON.stringify({
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 120, total_tokens: 1120 },
      model_context_window: 0,
      reasoning_output_tokens: 14,
    },
  });
  const evt = normalizeCodexLine({ runId: 'r1', sessionId: 's1', line });
  assert.equal(evt.event, 'run.usage');
  assert.equal(evt.payload.modelContextWindow, null);
  assert.equal(evt.payload.totalTokens, 1120);
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

test('maps response_item function_call/function_call_output into keyed tool lifecycle events', () => {
  const start = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_123',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'rg --files' }),
      },
    }),
  });
  const done = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'ok',
      },
    }),
  });

  assert.equal(start.event, 'tool.started');
  assert.equal(start.payload.callId, 'call_123');
  assert.equal(start.payload.command, 'rg --files');
  assert.equal(done.event, 'tool.final');
  assert.equal(done.payload.callId, 'call_123');
  assert.equal(done.payload.stepKey, 'tool:call_123');
});

test('maps event_msg agent_message commentary to chat.commentary and final_answer to chat.final', () => {
  const commentary = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'commentary',
        message: 'Inspecting files',
      },
    }),
  });
  const final = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'final_answer',
        message: 'All done',
      },
    }),
  });

  assert.equal(commentary.event, 'chat.commentary');
  assert.equal(commentary.payload.delta, 'Inspecting files');
  assert.equal(final.event, 'chat.final');
  assert.equal(final.payload.text, 'All done');
});

test('maps agent_message without phase to chat.commentary for reasoning timeline support', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Hello without phase',
      },
    }),
  });
  assert.equal(evt.event, 'chat.commentary');
  assert.equal(evt.payload.delta, 'Hello without phase');
});

test('maps response_item assistant message without phase to chat.commentary', () => {
  const evt = normalizeCodexLine({
    runId: 'r1',
    sessionId: 's1',
    line: JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Final text without phase' }],
      },
    }),
  });
  assert.equal(evt.event, 'chat.commentary');
  assert.equal(evt.payload.delta, 'Final text without phase');
});

test('getDefaultModelContextWindow returns known context windows for codex models', () => {
  assert.equal(getDefaultModelContextWindow('codex-mini-latest'), 200_000);
  assert.equal(getDefaultModelContextWindow('gpt-5.3-codex'), 400_000);
  assert.equal(getDefaultModelContextWindow('gpt-5.4'), 272_000);
  assert.equal(getDefaultModelContextWindow('GPT-5.3-CODEX'), 400_000);
});

test('getDefaultModelContextWindow returns null for unknown or missing models', () => {
  assert.equal(getDefaultModelContextWindow('unknown-model'), null);
  assert.equal(getDefaultModelContextWindow(null), null);
  assert.equal(getDefaultModelContextWindow(''), null);
});
