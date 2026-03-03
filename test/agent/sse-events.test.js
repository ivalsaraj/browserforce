import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../../extension/agent-panel-state.js';

const baseState = {
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  runs: {},
  latestUsageBySession: {},
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

test('run.aborted preserves partial assistant output in transcript history', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, { event: 'chat.delta', runId: 'r1', sessionId: 's1', payload: { delta: 'Partial answer' } });
  const s3 = applyEvent(s2, { event: 'run.aborted', runId: 'r1', sessionId: 's1', payload: {} });
  const message = s3.messagesBySession.s1?.at(-1);

  assert.equal(message?.role, 'assistant');
  assert.equal(message?.runId, 'r1');
  assert.equal(message?.text, 'Partial answer');
  assert.equal(Array.isArray(message?.timeline), true);
  assert.equal(message.timeline.some((item) => item.type === 'text'), true);
  assert.equal(message.timeline.some((item) => item.type === 'step' && item.status === 'aborted'), true);
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

test('chat and tool events preserve inline timeline order', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, { event: 'chat.delta', runId: 'r1', sessionId: 's1', payload: { delta: 'First chunk. ' } });
  const s3 = applyEvent(s2, { event: 'tool.started', runId: 'r1', sessionId: 's1', payload: { tool: 'execute' } });
  const s4 = applyEvent(s3, { event: 'chat.delta', runId: 'r1', sessionId: 's1', payload: { delta: 'Second chunk.' } });
  const timeline = s4.runs.r1.timeline || [];

  assert.deepEqual(
    timeline.map((item) => item.type),
    ['text', 'step', 'text'],
  );
  assert.equal(timeline[0]?.text, 'First chunk. ');
  assert.match(timeline[1]?.label || '', /execute/i);
  assert.equal(timeline[2]?.text, 'Second chunk.');
});

test('chat.final stores timeline with assistant transcript message', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, { event: 'chat.delta', runId: 'r1', sessionId: 's1', payload: { delta: 'Done.' } });
  const s3 = applyEvent(s2, { event: 'tool.started', runId: 'r1', sessionId: 's1', payload: { tool: 'execute' } });
  const s4 = applyEvent(s3, { event: 'chat.final', runId: 'r1', sessionId: 's1', payload: { text: 'Done.' } });
  const message = s4.messagesBySession.s1.at(-1);

  assert.equal(message?.role, 'assistant');
  assert.equal(Array.isArray(message?.timeline), true);
  assert.equal(message.timeline.length >= 2, true);
  assert.equal(message.timeline.some((item) => item.type === 'step'), true);
  assert.equal(message.timeline.some((item) => item.type === 'text'), true);
});

test('run.error appends a final failed step', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, { event: 'run.error', runId: 'r1', sessionId: 's1', payload: { error: 'boom' } });
  const last = s2.runs.r1.steps.at(-1);
  assert.equal(last.status, 'failed');
  assert.match(last.label, /boom/);
});

test('run.event is converted into a visible in-flight step', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, {
    event: 'run.event',
    runId: 'r1',
    sessionId: 's1',
    payload: {
      type: 'item.started',
      item: {
        type: 'reasoning',
        summary: 'Planning skill invocation',
      },
    },
  });
  const last = s2.runs.r1.steps.at(-1);
  assert.equal(last.status, 'running');
  assert.equal(last.kind, 'reasoning');
  assert.match(last.label, /Planning skill invocation/);
});

test('run.event captures detail lines for collapsible tool-call rendering', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, {
    event: 'run.event',
    runId: 'r1',
    sessionId: 's1',
    payload: {
      item: {
        summary: 'Explored 2 files, 1 search',
        text: 'Read chatd.js\nSearched for run.aborted\nRead sse-events.test.js',
      },
    },
  });
  const lastStep = s2.runs.r1.steps.at(-1);
  const lastTimeline = s2.runs.r1.timeline.at(-1);
  assert.equal(lastStep?.label, 'Explored 2 files, 1 search');
  assert.deepEqual(lastStep?.details, [
    'Read chatd.js',
    'Searched for run.aborted',
    'Read sse-events.test.js',
  ]);
  assert.deepEqual(lastTimeline?.details, lastStep?.details);
});

test('run.usage stores normalized usage for run and session', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, {
    event: 'run.usage',
    runId: 'r1',
    sessionId: 's1',
    payload: {
      totalTokens: 1120,
      modelContextWindow: 258400,
      cachedInputTokens: 700,
    },
  });

  assert.equal(s2.runs.r1.usage.totalTokens, 1120);
  assert.equal(s2.latestUsageBySession.s1.modelContextWindow, 258400);
  assert.equal(s2.latestUsageBySession.s1.cachedInputTokens, 700);
});

test('run.usage accepts missing context window without crashing', () => {
  const s1 = applyEvent(baseState, { event: 'run.started', runId: 'r1', sessionId: 's1', payload: {} });
  const s2 = applyEvent(s1, {
    event: 'run.usage',
    runId: 'r1',
    sessionId: 's1',
    payload: {
      totalTokens: 1120,
    },
  });
  assert.equal(s2.latestUsageBySession.s1.totalTokens, 1120);
  assert.equal(Object.prototype.hasOwnProperty.call(s2.latestUsageBySession.s1, 'modelContextWindow'), false);
});
