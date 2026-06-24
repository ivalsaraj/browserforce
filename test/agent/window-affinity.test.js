import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCreateWindowId } from '../../extension/window-affinity.js';

test('returns the requested window when it is a valid integer window', () => {
  const result = resolveCreateWindowId({
    requestedWindowId: 222,
    isRequestedWindowValid: true,
    currentWindowId: 111,
  });
  assert.equal(result, 222);
});

test('falls back to the current window when the requested window is closed/invalid', () => {
  const result = resolveCreateWindowId({
    requestedWindowId: 500,
    isRequestedWindowValid: false,
    currentWindowId: 700,
  });
  assert.equal(result, 700);
});

test('falls back to the current window when no window is requested', () => {
  const result = resolveCreateWindowId({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: 700,
  });
  assert.equal(result, 700);
});

test('falls back when the requested window is a non-integer', () => {
  assert.equal(
    resolveCreateWindowId({ requestedWindowId: '222', isRequestedWindowValid: true, currentWindowId: 700 }),
    700,
  );
  assert.equal(
    resolveCreateWindowId({ requestedWindowId: 3.5, isRequestedWindowValid: true, currentWindowId: 700 }),
    700,
  );
  assert.equal(
    resolveCreateWindowId({ requestedWindowId: null, isRequestedWindowValid: true, currentWindowId: 700 }),
    700,
  );
});

test('returns undefined current window when Chrome reports no current window and no valid request', () => {
  const result = resolveCreateWindowId({
    requestedWindowId: undefined,
    isRequestedWindowValid: false,
    currentWindowId: undefined,
  });
  assert.equal(result, undefined);
});
