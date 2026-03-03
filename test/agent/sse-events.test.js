import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../../extension/agent-panel-state.js';

const baseState = {
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  runs: {},
};

test('chat.delta appends to in-flight run text', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const next = applyEvent(s1, { event: 'chat.delta', runId: 'r1', sessionId: 's1', payload: { delta: 'Hi' } });
  assert.equal(next.runs.r1.text, 'Hi');
});

test('chat.final finalizes run output', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const next = applyEvent(s1, { event: 'chat.final', runId: 'r1', sessionId: 's1', payload: { text: 'Done' } });
  assert.equal(next.runs.r1.done, true);
  assert.equal(next.runs.r1.text, 'Done');
  assert.equal(next.messagesBySession.s1.at(-1).text, 'Done');
});

test('run.aborted marks run terminal', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const next = applyEvent(s1, { event: 'run.aborted', runId: 'r1', sessionId: 's1', payload: {} });
  assert.equal(next.runs.r1.done, true);
  assert.equal(next.runs.r1.aborted, true);
});

test('tool and reasoning events are tracked as steps', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, { event: 'tool.started', runId: 'r1', sessionId: 's1', payload: { tool: 'fetch' } });
  const s3 = applyEvent(s2, {
    event: 'tool.delta',
    runId: 'r1',
    sessionId: 's1',
    payload: { type: 'reasoning', text: 'Planning the next action' },
  });
  const s4 = applyEvent(s3, { event: 'tool.final', runId: 'r1', sessionId: 's1', payload: { tool: 'fetch' } });

  assert.equal(Array.isArray(s4.runs.r1.steps), true);
  assert.equal(s4.runs.r1.steps.length, 3);
  assert.match(s4.runs.r1.steps[0].label, /fetch/i);
  assert.match(s4.runs.r1.steps[1].label, /Planning/);
});

test('run.error appends a final failed step', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, { event: 'run.error', runId: 'r1', sessionId: 's1', payload: { error: 'boom' } });
  const last = s2.runs.r1.steps.at(-1);
  assert.equal(last.status, 'failed');
  assert.match(last.label, /boom/);
});
