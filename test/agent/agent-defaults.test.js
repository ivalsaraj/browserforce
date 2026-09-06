import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AUTO_CLOSE_MINUTES,
  resolveAutoCloseMinutes,
  resolveDedicatedWindow,
} from '../../extension/agent-defaults.js';

test('auto-close defaults ON when the setting was never chosen', () => {
  assert.equal(resolveAutoCloseMinutes({}), DEFAULT_AUTO_CLOSE_MINUTES);
  assert.equal(resolveAutoCloseMinutes(undefined), DEFAULT_AUTO_CLOSE_MINUTES);
  assert.ok(DEFAULT_AUTO_CLOSE_MINUTES > 0, 'default must actually be enabled');
});

test('an explicit Off (0) is respected, not overridden by the default', () => {
  // The whole point of `??` over `||`: 0 is a real user choice.
  assert.equal(resolveAutoCloseMinutes({ autoCloseMinutes: 0 }), 0);
});

test('an explicit interval is respected', () => {
  assert.equal(resolveAutoCloseMinutes({ autoCloseMinutes: 30 }), 30);
});

test('a malformed stored value falls back to the default', () => {
  for (const autoCloseMinutes of ['10', null, 1.5, -5, NaN, {}]) {
    assert.equal(resolveAutoCloseMinutes({ autoCloseMinutes }), DEFAULT_AUTO_CLOSE_MINUTES,
      `autoCloseMinutes=${String(autoCloseMinutes)}`);
  }
});

test('dedicated window defaults ON when never chosen', () => {
  assert.equal(resolveDedicatedWindow({}), true);
  assert.equal(resolveDedicatedWindow(undefined), true);
});

test('dedicated window respects an explicit off', () => {
  assert.equal(resolveDedicatedWindow({ dedicatedWindow: false }), false);
  assert.equal(resolveDedicatedWindow({ dedicatedWindow: true }), true);
});

test('popup mirrors the same auto-close default (it cannot import modules)', () => {
  const popupJs = fs.readFileSync('extension/popup.js', 'utf8');
  const m = popupJs.match(/DEFAULT_AUTO_CLOSE_MINUTES\s*=\s*(\d+)/);
  assert.ok(m, 'popup.js must declare DEFAULT_AUTO_CLOSE_MINUTES');
  assert.equal(Number(m[1]), DEFAULT_AUTO_CLOSE_MINUTES,
    'popup default must match extension/agent-defaults.js');
});
