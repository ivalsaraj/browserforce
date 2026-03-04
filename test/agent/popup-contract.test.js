import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/popup.html', 'utf8');
const optionsJs = fs.readFileSync('extension/options.js', 'utf8');

test('popup includes Open BrowserForce Agent button', () => {
  assert.match(html, /Open BrowserForce Agent/);
});

test('logs viewer requests include extension identity header', () => {
  assert.match(optionsJs, /chrome\?\.runtime\?\.id/);
  assert.match(optionsJs, /'x-browserforce-extension-id'/);
});
