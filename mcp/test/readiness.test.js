import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadiness } from '../src/readiness.js';

test('an unreachable relay names the command that starts it', () => {
  const { code, message } = classifyReadiness({ statusError: new Error('ECONNREFUSED') });
  assert.equal(code, 'RELAY_UNREACHABLE');
  assert.match(message, /browserforce serve/);
});

test('a disconnected extension names Chrome and the extensions page', () => {
  const { code, message } = classifyReadiness({ status: { connected: false } });
  assert.equal(code, 'EXTENSION_DISCONNECTED');
  assert.match(message, /chrome:\/\/extensions/);
  assert.match(message, /open Chrome/i);
});

test('a malformed status is not READY', () => {
  // { connected: "false" } is truthy; a loose check would start CDP against a
  // relay that never confirmed the extension.
  for (const bad of ['false', 0, null, undefined, {}]) {
    assert.equal(classifyReadiness({ status: { connected: bad } }).code, 'EXTENSION_DISCONNECTED');
  }
  assert.equal(classifyReadiness({ status: {} }).code, 'EXTENSION_DISCONNECTED');
  assert.equal(classifyReadiness({}).code, 'EXTENSION_DISCONNECTED');
});

test('the wording keeps the substrings existing tests match on', () => {
  assert.match(classifyReadiness({ statusError: new Error('x') }).message, /Cannot reach BrowserForce relay/i);
  assert.match(classifyReadiness({ status: { connected: false } }).message, /extension is not connected/i);
});

test('a connected extension with no attached tabs is READY before discovery', () => {
  // Measured live: 72 real tabs, connected:true, attachedTabs:[] — targets do
  // not populate until Target.setAutoAttach. A pre-connect no-tabs check here
  // would reject a healthy browser.
  assert.equal(classifyReadiness({ status: { connected: true, attachedTabs: [] } }).code, 'READY');
});

test('NO_TABS fires only on a post-discovery page count of zero', () => {
  const { code, message } = classifyReadiness({
    status: { connected: true, attachedTabs: [] }, discoveredPageCount: 0,
  });
  assert.equal(code, 'NO_TABS');
  assert.match(message, /open a tab/i);
  assert.equal(classifyReadiness({ status: { connected: true }, discoveredPageCount: 3 }).code, 'READY');
});
