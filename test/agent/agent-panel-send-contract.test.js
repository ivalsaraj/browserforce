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

test('sidepanel auto-attaches current tab and sends browserContext with runs', () => {
  assert.match(js, /async function ensureCurrentTabAttached\(\)/);
  assert.match(js, /runtimeMessage\(\{\s*type:\s*'attachCurrentTab'\s*\}\)/);
  assert.match(js, /runtimeMessage\(\{\s*type:\s*'getStatus'\s*\}\)/);
  assert.match(js, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(js, /attachCurrentTabBtn\.addEventListener\('click'/);
  assert.match(js, /await ensureCurrentTabAttached\(\);/);
  assert.match(js, /const browserContext = await getActiveTabContext\(\);/);
  assert.match(js, /JSON\.stringify\(\{\s*sessionId,\s*message:\s*text,\s*browserContext\s*\}\)/);
});

test('enter key submits composer and shift+enter keeps newline', () => {
  assert.match(js, /chatInputEl\.addEventListener\('keydown'/);
  assert.match(js, /if\s*\(\s*event\.key\s*!==\s*'Enter'\s*\|\|\s*event\.shiftKey\s*\)\s*return;/);
  assert.match(js, /event\.preventDefault\(\);/);
  assert.match(js, /chatFormEl\.requestSubmit\(\);/);
});
