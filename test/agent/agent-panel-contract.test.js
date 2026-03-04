import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/agent-panel.html', 'utf8');
const css = fs.readFileSync('extension/agent-panel.css', 'utf8');
const panelJs = fs.readFileSync('extension/agent-panel.js', 'utf8');

test('agent panel has inline model and session selectors with popovers', () => {
  assert.match(html, /id="bf-model-trigger"/);
  assert.match(html, /id="bf-session-trigger"/);
  assert.match(html, /id="bf-new-session"/);
  assert.match(html, /aria-label="New Session"/);
  assert.match(html, /id="bf-model-panel"/);
  assert.match(html, /id="bf-session-panel"/);
  assert.match(html, /id="bf-model-list"/);
  assert.match(html, /id="bf-thinking-list"/);
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
  assert.match(css, /\.composer-box\.is-thinking::before/);
  assert.match(css, /\.composer-box\.is-thinking \.composer-textarea/);
  assert.match(css, /\.btn-send[\s\S]*border-radius:\s*999px/);
});

test('composer action buttons respect hidden attribute for send/stop swapping', () => {
  assert.match(css, /\.composer-actions button\[hidden\][\s\S]*display:\s*none/);
});

test('reasoning title rows use shimmer and enter transition treatment', () => {
  assert.match(panelJs, /shouldAnimateLatestReasoningTitle/);
  assert.match(panelJs, /title-label/);
  assert.match(panelJs, /shimmer-text/);
  assert.match(panelJs, /title-transition-in/);
  assert.match(css, /\.step-label\.title-label/);
  assert.match(css, /\.step-label\.title-label\.shimmer-text/);
  assert.match(css, /\.step-label\.title-label\.title-transition-in/);
  assert.match(css, /@keyframes reasoning-shimmer/);
  assert.match(css, /@keyframes reasoning-title-in/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('done step icon uses branded animated svg check treatment', () => {
  assert.match(css, /\.run-step-icon\.icon-done/);
  assert.match(css, /\.run-step-icon-done-svg/);
  assert.match(css, /\.run-step-icon-done-ring/);
  assert.match(css, /\.run-step-icon-done-check/);
  assert.match(css, /@keyframes run-step-done-ring-draw/);
  assert.match(css, /@keyframes run-step-done-check-draw/);
});

test('agent panel includes visible startup error empty-state treatment', () => {
  assert.match(panelJs, /state\.startupIssue = null/);
  assert.match(panelJs, /class="empty-state error-state"/);
  assert.match(panelJs, /empty-command/);
  assert.match(css, /\.empty-state\.error-state/);
  assert.match(css, /\.empty-icon\.error/);
  assert.match(css, /\.empty-command code/);
});

test('collapsed execute helper preview has tree-like branch styling', () => {
  assert.match(css, /\.step-branch-preview/);
  assert.match(css, /\.step-branch-node/);
  assert.match(css, /\.step-branch-node::before/);
  assert.match(css, /\.step-branch-call/);
  assert.match(css, /\.step-branch-preview\.done \.step-branch-call[\s\S]*var\(--crail-dark\)/);
});

test('startup error card action buttons have dedicated styling hooks', () => {
  assert.match(css, /\.empty-actions/);
  assert.match(css, /\.empty-action-btn/);
  assert.match(css, /\.empty-action-btn\.secondary/);
});
