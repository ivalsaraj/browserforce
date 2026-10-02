import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Static contract test (mirrors debugger-resume-contract.test.js): the service
// worker can't be loaded outside Chrome, so assert the source contract for
// releasing debugger pauses nobody else will see. See AGENTS.md "Orphaned
// Debugger Pauses".
const bg = fs.readFileSync('extension/background.js', 'utf8');

function functionBody(name) {
  const start = bg.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} present`);
  const next = bg.indexOf('\nfunction ', start + 1);
  return bg.slice(start, next === -1 ? undefined : next);
}

test('the pure policy helper is imported', () => {
  assert.match(bg, /import \{ resolveOrphanedPause, isNonEmptyString \} from '\.\/orphan-pause-policy\.js';/);
});

test('only string child session ids are tracked', () => {
  const body = functionBody('onDebuggerEvent');
  assert.match(body, /'Target\.attachedToTarget' && isNonEmptyString\(params\?\.sessionId\)/);
});

test('children of a tab without an attachedTabs entry are cleared on detach and close', () => {
  // Tracked before the attached guard, so cleanup must not sit behind it either.
  const assertBefore = (body, first, second) => {
    const firstIdx = body.indexOf(first);
    assert.ok(firstIdx >= 0, `${first} present`);
    assert.ok(firstIdx < body.indexOf(second), `${first} must precede ${second}`);
  };
  assertBefore(functionBody('onDebuggerDetach'), 'forgetChildSessions(source.tabId)', 'if (attachedTabs.has(source.tabId))');
  assertBefore(functionBody('onTabRemoved'), 'forgetChildSessions(tabId)', 'if (!isAttached) return');
});

test('child sessions are tracked before the relay and attachedTabs guards', () => {
  const body = functionBody('onDebuggerEvent');
  const trackIdx = body.indexOf('childSessions.set(');
  const guardIdx = body.indexOf('ws.readyState !== WebSocket.OPEN');
  assert.ok(trackIdx > 0 && guardIdx > 0);
  assert.ok(trackIdx < guardIdx, 'tracking must precede the relay guard');
});

test('an event nobody will see is resolved locally, whether the relay is down or the tab entry is missing', () => {
  const body = functionBody('onDebuggerEvent');
  assert.match(body, /if \(!ws \|\| ws\.readyState !== WebSocket\.OPEN \|\| !entry\) \{\s*(\/\/[^\n]*\n\s*)*resolveOrphanedPauseLocally\(source, method, params\);\s*return;/);
});

test('local resolution is best-effort and logged, never an unhandled rejection', () => {
  const body = functionBody('resolveOrphanedPauseLocally');
  assert.match(body, /chrome\.debugger\.sendCommand\([\s\S]*\)\.catch\(/);
});

test('losing the live relay socket resumes every known child session', () => {
  assert.match(bg, /if \(wasActiveRelay\) resumeAllChildSessions\(\);/);
  const body = functionBody('resumeAllChildSessions');
  assert.match(body, /'Runtime\.runIfWaitingForDebugger'\)\.catch\(/);
});
