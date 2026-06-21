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

test('background suppresses recursive group resync while BrowserForce is applying its own group changes', () => {
  assert.match(backgroundJs, /let isSyncingTabGroup = false;/);
  assert.match(backgroundJs, /if \(changeInfo\.groupId !== undefined && !isSyncingTabGroup\) \{/);
  assert.match(backgroundJs, /isSyncingTabGroup = true;/);
  assert.match(backgroundJs, /isSyncingTabGroup = false;/);
});

test('background delays tab-group reconciliation until after manual attach settles', () => {
  assert.match(backgroundJs, /setTimeout\(\(\) => queueSyncTabGroup\(\), TAB_GROUP_SYNC_AFTER_ATTACH_MS\)/);
  assert.match(backgroundJs, /const TAB_GROUP_SYNC_AFTER_ATTACH_MS = \d+;/);
});

test('background re-announces manually attached tabs after relay reconnect', () => {
  assert.match(backgroundJs, /function notifyRelayManualTabAttached\(tabId,\s*entry\)/);
  assert.match(backgroundJs, /function notifyRelayAttachedTabs\(\)/);
  assert.match(backgroundJs, /for \(const \[tabId,\s*entry\] of attachedTabs\)/);
  assert.match(backgroundJs, /notifyRelayAttachedTabs\(\);/);
});

test('attachCurrentTab replays already-attached tabs to repair relay state', () => {
  const attachBranch = backgroundJs.match(/if \(attachedTabs\.has\(tab\.id\)\) \{[\s\S]*?\n      \}/);
  assert.ok(attachBranch, 'already-attached branch should be present');
  assert.match(attachBranch[0], /attachTab\(tab\.id,\s*attachedTabs\.get\(tab\.id\)\.sessionId,\s*\{\s*origin:\s*'manual'\s*\}\)/);
  assert.match(attachBranch[0], /notifyRelayManualTabAttached\(tab\.id,\s*entry\)/);
  assert.match(attachBranch[0], /alreadyAttached:\s*true/);
  assert.doesNotMatch(attachBranch[0], /error:\s*'Already attached'/);
});

test('background tracks attached tab provenance without adding a new relay command', () => {
  assert.match(backgroundJs, /origin:\s*'manual'/);
  assert.match(backgroundJs, /origin:\s*'agent-created'/);
  assert.match(backgroundJs, /origin:\s*entry\.origin/);
  assert.doesNotMatch(backgroundJs, /case 'getAttachedTabs':/);
});

test('background reconnect replay preserves attached tab provenance', () => {
  assert.match(backgroundJs, /function notifyRelayManualTabAttached\(tabId,\s*entry\)/);
  assert.match(backgroundJs, /origin:\s*entry\.origin/);
  assert.match(backgroundJs, /function notifyRelayAttachedTabs\(\)/);
  assert.match(backgroundJs, /for \(const \[tabId,\s*entry\] of attachedTabs\)/);
});

test('background reconnects when relay slot handoff finishes', () => {
  assert.match(backgroundJs, /extension\/status/);
  assert.match(backgroundJs, /connected/);
  assert.match(backgroundJs, /connected === false/);
});
