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

test('messages.loaded collapses legacy running+done duplicate tool entries on reload', () => {
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
      runId: 'run_3',
      timeline: [
        { type: 'step', kind: 'tool', status: 'running', label: "/bin/zsh -lc 'rg --files'" },
        { type: 'step', kind: 'tool', status: 'done', label: "/bin/zsh -lc 'rg --files'" },
        { type: 'text', text: 'Done' },
      ],
    }],
  });

  const timeline = next.runs.run_3?.timeline || [];
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0]?.type, 'step');
  assert.equal(timeline[0]?.status, 'done');
  assert.equal(timeline[1]?.type, 'text');
});

test('messages.loaded collapses generic terminal tool row onto latest running row', () => {
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
      runId: 'run_4',
      timeline: [
        { type: 'step', kind: 'tool', status: 'running', label: "/bin/zsh -lc 'cat skills/browserforce/SKILL.md'" },
        { type: 'step', kind: 'tool', status: 'done', label: 'Tool call completed' },
        { type: 'text', text: 'Done' },
      ],
    }],
  });

  const timeline = next.runs.run_4?.timeline || [];
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0]?.status, 'done');
  assert.match(timeline[0]?.label || '', /cat skills\/browserforce\/SKILL\.md/);
});

test('messages.loaded strips shell wrapper prefixes from tool labels and details', () => {
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
      runId: 'run_5',
      timeline: [{
        type: 'step',
        kind: 'tool',
        status: 'done',
        label: "/bin/zsh -lc \"sed -n '1,220p' AGENTS.local.md\"",
        details: [
          "/bin/zsh -lc 'rg --files'",
        ],
      }],
    }],
  });

  const step = next.runs.run_5?.timeline?.[0];
  assert.equal(step?.label, "sed -n '1,220p' AGENTS.local.md");
  assert.deepEqual(step?.details, ['rg --files']);
});

test('session.metadata.loaded hydrates persisted codex usage for reopened session', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [{
      sessionId: 's1',
      title: 'New Session',
    }],
    runs: {},
    messagesBySession: {},
    latestUsageBySession: {},
  };

  const next = reduceState(state, {
    type: 'session.metadata.loaded',
    sessionId: 's1',
    session: {
      sessionId: 's1',
      predictedTitle: 'Pricing Sheet Summary',
      firstMessageTab: {
        url: 'https://example.com/pricing',
      },
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
  assert.equal(next.sessions[0]?.predictedTitle, 'Pricing Sheet Summary');
  assert.equal(next.sessions[0]?.firstMessageTab?.url, 'https://example.com/pricing');
});

test('messages.loaded strips hidden session title prefix from stored assistant content before hydrating runs', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {},
    latestUsageBySession: {},
  };

  const next = reduceState(state, {
    type: 'messages.loaded',
    sessionId: 's1',
    messages: [{
      role: 'assistant',
      text: '[[BF_SESSION_TITLE]] Pricing Sheet Summary\n\nVisible answer',
      runId: 'run_1',
      timeline: [
        { type: 'text', text: '[[BF_SESSION_TITLE]] Pricing Sheet Summary\n\nVisible answer' },
      ],
    }],
  });

  assert.equal(next.messagesBySession.s1?.[0]?.text, 'Visible answer');
  assert.equal(next.runs.run_1?.text, 'Visible answer');
  assert.equal(next.runs.run_1?.timeline?.[0]?.text, 'Visible answer');
});

test('messages.loaded strips hidden session title prefix from stored reasoning labels and timeline text', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [],
    runs: {},
    messagesBySession: {},
    latestUsageBySession: {},
  };

  const next = reduceState(state, {
    type: 'messages.loaded',
    sessionId: 's1',
    messages: [{
      role: 'assistant',
      text: '',
      runId: 'run_2',
      timeline: [
        { type: 'step', kind: 'reasoning', status: 'running', key: 'commentary:1', label: '[[BF_SESSION_TITLE]] Pricing Sheet Summary' },
        { type: 'text', text: '[[BF_SESSION_TITLE]] Pricing Sheet Summary\n\nVisible answer' },
      ],
    }],
  });

  const timeline = next.runs.run_2?.timeline || [];
  const messageTimeline = next.messagesBySession.s1?.[0]?.timeline || [];

  assert.equal(timeline.some((item) => String(item?.label || '').includes('[[BF_SESSION_TITLE]]')), false);
  assert.equal(timeline.some((item) => String(item?.text || '').includes('[[BF_SESSION_TITLE]]')), false);
  assert.equal(messageTimeline.some((item) => String(item?.label || '').includes('[[BF_SESSION_TITLE]]')), false);
  assert.equal(messageTimeline.some((item) => String(item?.text || '').includes('[[BF_SESSION_TITLE]]')), false);
  assert.equal(timeline.some((item) => item?.type === 'text' && item?.text === 'Visible answer'), true);
});
