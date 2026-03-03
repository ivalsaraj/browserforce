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
