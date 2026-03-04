import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/agent-panel.html', 'utf8');
const css = fs.readFileSync('extension/agent-panel.css', 'utf8');

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
  assert.match(html, /id="bf-context-usage"/);
  assert.match(
    html,
    /id="bf-chat-form"[\s\S]*class="composer-box"[\s\S]*<\/div>\s*<div id="bf-context-usage"/,
  );
});

test('agent panel no longer renders title or persistent session sidebar', () => {
  assert.doesNotMatch(html, /<h1/);
  assert.doesNotMatch(html, /<aside class="sessions">/);
});

test('agent panel does not render a BrowserForce heading bar', () => {
  assert.doesNotMatch(html, /class="brand-name"/);
});

test('agent panel keeps horizontal overflow contained in transcript cards', () => {
  assert.match(css, /\.transcript[\s\S]*overflow-x:\s*hidden/);
  assert.match(css, /\.bubble-assistant code[\s\S]*overflow-wrap:\s*anywhere/);
});

test('tab attach banner uses defined light-theme tokens only', () => {
  assert.match(css, /\.tab-attach[\s\S]*background:\s*var\(--linen\)/);
  assert.match(css, /\.tab-attach[\s\S]*color:\s*var\(--text-muted\)/);
  assert.match(css, /\.tab-attach-btn[\s\S]*background:\s*var\(--crail-soft\)/);
  assert.match(css, /\.tab-attach-btn[\s\S]*color:\s*var\(--crail-dark\)/);
  assert.doesNotMatch(css, /var\(--card-bg\)/);
  assert.doesNotMatch(css, /var\(--muted\)/);
  assert.doesNotMatch(css, /var\(--accent-soft\)/);
  assert.doesNotMatch(css, /var\(--accent-soft-text\)/);
});

test('agent panel composer matches compact/expanded shell structure', () => {
  assert.doesNotMatch(html, /id="bf-attach-btn"/);
  assert.doesNotMatch(html, /icon-mic/);
  assert.match(html, /id="bf-stop-run"[\s\S]*icon-stop/);
  assert.match(html, /id="bf-send-btn"/);
  assert.match(css, /\.composer-box\.is-multiline/);
  assert.match(css, /\.btn-send[\s\S]*border-radius:\s*999px/);
});
