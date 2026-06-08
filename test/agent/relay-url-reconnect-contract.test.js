import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const popupJs = fs.readFileSync('extension/popup.js', 'utf8');
const backgroundJs = fs.readFileSync('extension/background.js', 'utf8');

test('popup save flow requests relay reconnect and shows feedback states', () => {
  assert.match(popupJs, /Connecting\.\.\./);
  assert.match(popupJs, /Connected/);
  assert.match(popupJs, /Connection failed/);
  assert.match(popupJs, /type:\s*'updateRelayUrl'/);
});

test('background handles updateRelayUrl message and triggers reconnect', () => {
  assert.match(backgroundJs, /msg\.type === 'updateRelayUrl'/);
  assert.match(backgroundJs, /requestRelayReconnect\(/);
  assert.match(backgroundJs, /const previousRelayUrl = currentRelayUrl/);
  assert.match(backgroundJs, /currentRelayUrl = previousRelayUrl/);
});

test('background reconciles tab groups when attached tabs move between windows', () => {
  assert.match(backgroundJs, /chrome\.tabs\.onAttached\.addListener\(onTabAttachedToWindow\)/);
  assert.match(backgroundJs, /chrome\.tabs\.onDetached\.addListener\(onTabDetachedFromWindow\)/);
  assert.match(backgroundJs, /function onTabAttachedToWindow\(tabId\)/);
  assert.match(backgroundJs, /function onTabDetachedFromWindow\(tabId\)/);
  assert.match(backgroundJs, /if \(!attachedTabs\.has\(tabId\)\) return;/);
  assert.match(backgroundJs, /queueSyncTabGroup\(\);/);
});

test('background re-announces manually attached tabs after relay reconnect', () => {
  assert.match(backgroundJs, /function notifyRelayManualTabAttached\(tabId,\s*entry\)/);
  assert.match(backgroundJs, /function notifyRelayAttachedTabs\(\)/);
  assert.match(backgroundJs, /for \(const \[tabId,\s*entry\] of attachedTabs\)/);
  assert.match(backgroundJs, /notifyRelayAttachedTabs\(\);/);
});
