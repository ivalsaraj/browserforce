import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/popup.html', 'utf8');
const optionsJs = fs.readFileSync('extension/options.js', 'utf8');
const popupJs = fs.readFileSync('extension/popup.js', 'utf8');
const popupCss = fs.readFileSync('extension/popup.css', 'utf8');

test('popup includes Open BrowserForce Agent button', () => {
  assert.match(html, /Open BrowserForce Agent/);
});

test('logs viewer requests include extension identity header', () => {
  assert.match(optionsJs, /chrome\?\.runtime\?\.id/);
  assert.match(optionsJs, /'x-browserforce-extension-id'/);
});

test('open agent action opens side panel and closes popup', () => {
  assert.match(popupJs, /chrome\.sidePanel\.open\(/);
  assert.match(popupJs, /window\.close\(\)/);
});

test('auto mode uses bottom note instead of dotted popup border', () => {
  assert.match(html, /id="bf-auto-mode-note"/);
  assert.match(html, /Auto mode is on\. The agent can automatically create tabs\./);
  assert.match(popupCss, /\.auto-mode-note\s*\{/);
  assert.equal(/\.bf-popup\.auto-mode\s*\{[\s\S]*dotted/.test(popupCss), false);
});
