import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const js = fs.readFileSync('extension/agent-panel.js', 'utf8');

test('sendMessage validates run creation response status', () => {
  assert.match(js, /async function sendMessage[\s\S]*if \(!res\.ok\)/);
  assert.match(js, /Failed to send message/);
  assert.match(js, /messages: existing/);
});

test('submit handler preserves draft on send failure', () => {
  assert.match(js, /chatFormEl\.addEventListener\('submit'/);
  assert.match(js, /try\s*\{\s*await sendMessage\(text\);[\s\S]*chatInputEl\.value = '';/);
  assert.match(js, /catch\s*\(\w+\)\s*\{[\s\S]*chatInputEl\.value = text;/);
});
