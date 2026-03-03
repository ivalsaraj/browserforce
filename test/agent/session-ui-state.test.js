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
