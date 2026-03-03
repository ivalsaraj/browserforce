import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceState } from '../../extension/agent-panel-state.js';

test('selectSession replaces active transcript with selected session messages', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {
      s1: [{ role: 'user', text: 'one' }],
      s2: [{ role: 'assistant', text: 'two' }],
    },
  };

  const next = reduceState(state, { type: 'session.selected', sessionId: 's2' });
  assert.equal(next.activeSessionId, 's2');
  assert.equal(next.messagesBySession.s2[0].text, 'two');
});

test('messages.loaded hydrates transcript for the selected session', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {},
  };

  const next = reduceState(state, {
    type: 'messages.loaded',
    sessionId: 's1',
    messages: [{ role: 'assistant', text: 'hello' }],
  });

  assert.equal(next.messagesBySession.s1[0].text, 'hello');
});

test('messages.loaded hydrates stored run metadata for reopened sessions', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {},
  };

  const next = reduceState(state, {
    type: 'messages.loaded',
    sessionId: 's1',
    messages: [{
      role: 'assistant',
      text: 'Done',
      runId: 'run_1',
      steps: [{ kind: 'tool', status: 'done', label: 'Snapshot page' }],
    }],
  });

  assert.equal(next.runs.run_1?.done, true);
  assert.equal(next.runs.run_1?.sessionId, 's1');
  assert.equal(next.runs.run_1?.steps?.length, 1);
  assert.equal(next.runs.run_1?.steps?.[0]?.label, 'Snapshot page');
});

test('messages.loaded hydrates stored timeline entries for reopened sessions', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {},
  };

  const next = reduceState(state, {
    type: 'messages.loaded',
    sessionId: 's1',
    messages: [{
      role: 'assistant',
      text: 'Done',
      runId: 'run_2',
      timeline: [
        { type: 'step', kind: 'tool', status: 'done', label: 'execute' },
        { type: 'text', text: 'Done' },
      ],
    }],
  });

  assert.equal(next.runs.run_2?.done, true);
  assert.equal(Array.isArray(next.runs.run_2?.timeline), true);
  assert.equal(next.runs.run_2?.timeline?.length, 2);
  assert.equal(next.runs.run_2?.timeline?.[0]?.type, 'step');
  assert.equal(next.runs.run_2?.timeline?.[1]?.type, 'text');
});

test('session.metadata.loaded hydrates persisted codex usage for reopened session', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {},
    latestUsageBySession: {},
  };

  const next = reduceState(state, {
    type: 'session.metadata.loaded',
    sessionId: 's1',
    session: {
      sessionId: 's1',
      providerState: {
        codex: {
          latestUsage: {
            modelContextWindow: 258400,
            totalTokens: 1120,
          },
        },
      },
    },
  });

  assert.equal(next.latestUsageBySession.s1.modelContextWindow, 258400);
  assert.equal(next.latestUsageBySession.s1.totalTokens, 1120);
});
