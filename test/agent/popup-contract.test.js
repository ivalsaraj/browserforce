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
  assert.match(html, /class="auto-mode-note-text"/);
  assert.match(html, /NOTE:\s*Auto mode is on\./);
  assert.match(popupCss, /\.auto-mode-note\s*\{/);
  assert.match(popupCss, /\.auto-mode-note-text\s*\{/);
  assert.match(popupCss, /\.auto-mode-note-text[\s\S]*width:\s*100%/);
  assert.match(popupCss, /\.auto-mode-note-text[\s\S]*white-space:\s*nowrap/);
  assert.equal(/\.auto-mode-note-text[\s\S]*text-overflow:\s*ellipsis/.test(popupCss), false);
  assert.match(popupJs, /function\s+fitAutoModeNoteText\(/);
  assert.match(popupJs, /scrollWidth\s*>\s*autoModeNoteTextEl\.clientWidth/);
  assert.match(popupJs, /requestAnimationFrame\(fitAutoModeNoteText\)/);
  assert.match(popupCss, /margin:\s*10px\s+-16px\s+-16px/);
  assert.match(popupCss, /\.auto-mode-note::before[\s\S]*background:\s*var\(--bf-danger-fg\)/);
  assert.match(popupCss, /\.auto-mode-note::after[\s\S]*background:\s*var\(--bf-accent\)/);
  assert.equal(/\.bf-popup\.auto-mode\s*\{[\s\S]*dotted/.test(popupCss), false);
});
