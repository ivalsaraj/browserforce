import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/agent-panel.html', 'utf8');

test('agent panel has inline model and session selectors with popovers', () => {
  assert.match(html, /id="bf-model-trigger"/);
  assert.match(html, /id="bf-session-trigger"/);
  assert.match(html, /id="bf-new-session"/);
  assert.match(html, /aria-label="New Session"/);
  assert.match(html, /id="bf-model-panel"/);
  assert.match(html, /id="bf-session-panel"/);
  assert.match(html, /id="bf-model-list"/);
  assert.match(html, /id="bf-switch-session-list"/);
  assert.match(html, /id="bf-tab-attach-banner"/);
  assert.match(html, /id="bf-tab-attach-text"/);
  assert.match(html, /id="bf-attach-current-tab"/);
});

test('agent panel no longer renders title or persistent session sidebar', () => {
  assert.doesNotMatch(html, /<h1/);
  assert.doesNotMatch(html, /<aside class="sessions">/);
});
