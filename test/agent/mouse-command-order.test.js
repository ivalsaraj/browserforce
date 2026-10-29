import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { syncGhostCursorBeforeClick } from '../../extension/ghost-cursor.js';

const background = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const source = background.slice(background.indexOf('async function cdpCommand'), background.indexOf('// ─── Debugger Event Listeners'));

function fixture({ failPress = false } = {}) {
  const calls = [];
  const queues = new Map();
  let release;
  let markStarted;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const command = runInNewContext(`${source}; cdpCommand`, {
    mouseCommandQueues: queues,
    checkRestriction: async () => null,
    isGhostCursorEnabled: true, isGhostCursorClickSyncEnabled: true,
    syncGhostCursorBeforeClick,
    ghostCursorController: { syncBeforeClick: async () => { markStarted(); await held; return true; } },
    handleGhostCursorInput: () => {}, handleTabBadgeCommand: () => {},
    tabBadgeController: {}, attachedTabs: new Map(), console,
    chrome: { debugger: { sendCommand: async (target, method, params) => {
      calls.push([target.tabId, params.type]);
      if (failPress && params.type === 'mousePressed') throw new Error('press failed');
      return {};
    } } },
  });
  return {
    calls, queues, started, release,
    send: (type, tabId = 1) => command({ tabId, method: 'Input.dispatchMouseEvent', params: { type, x: 20, y: 30 } }),
  };
}

test('mouse release cannot overtake a press waiting for cursor arrival', async () => {
  const f = fixture();
  const down = f.send('mousePressed');
  await f.started;
  const up = f.send('mouseReleased');
  await new Promise(resolve => setImmediate(resolve));
  const whileHeld = [...f.calls];
  f.release();
  await Promise.all([down, up]);
  assert.deepEqual(whileHeld, []);
  assert.deepEqual(f.calls, [[1, 'mousePressed'], [1, 'mouseReleased']]);
  assert.equal(f.queues.size, 0);
});

test('a waiting press does not block mouse commands in another tab', { timeout: 2000 }, async () => {
  const f = fixture();
  const down = f.send('mousePressed');
  await f.started;
  try {
    await f.send('mouseMoved', 2);
    assert.deepEqual(f.calls, [[2, 'mouseMoved']]);
  } finally {
    f.release();
    await down;
  }
  assert.equal(f.queues.size, 0);
});

test('a failed mouse command does not poison later commands in the tab', async () => {
  const f = fixture({ failPress: true });
  const down = f.send('mousePressed');
  await f.started;
  const up = f.send('mouseReleased');
  f.release();
  const results = await Promise.allSettled([down, up]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /press failed/);
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(f.calls, [[1, 'mousePressed'], [1, 'mouseReleased']]);
  assert.equal(f.queues.size, 0);
});
