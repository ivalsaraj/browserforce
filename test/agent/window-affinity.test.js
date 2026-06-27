import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCreateWindowPlan } from '../../extension/window-affinity.js';

test('uses the requested window when it is a valid integer window', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    currentWindowId: 111,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});

test('falls back to the current window when the requested window is closed/invalid', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 500,
    isRequestedWindowValid: false,
    currentWindowId: 700,
  });
  assert.deepEqual(plan, { action: 'current-window', windowId: 700 });
});

test('falls back to the current window when no window is requested', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: 700,
  });
  assert.deepEqual(plan, { action: 'current-window', windowId: 700 });
});

test('falls back when the requested window is a non-integer', () => {
  for (const requestedWindowId of ['222', 3.5, null]) {
    assert.deepEqual(
      resolveCreateWindowPlan({ requestedWindowId, isRequestedWindowValid: true, currentWindowId: 700 }),
      { action: 'current-window', windowId: 700 },
    );
  }
});

test('carries an undefined current window when Chrome reports none and no valid request', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: undefined,
  });
  assert.deepEqual(plan, { action: 'current-window', windowId: undefined });
});

test('spawns a new dedicated window when enabled and no valid window is requested', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: 700,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'new-window' });
});

test('spawns a new dedicated window when enabled and the requested window is closed', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 500,
    isRequestedWindowValid: false,
    currentWindowId: 700,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'new-window' });
});

test('still honors a valid requested window even when dedicated mode is enabled', () => {
  const plan = resolveCreateWindowPlan({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    currentWindowId: 111,
    dedicatedWindowEnabled: true,
  });
  assert.deepEqual(plan, { action: 'use-window', windowId: 222 });
});
