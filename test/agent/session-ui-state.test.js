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
