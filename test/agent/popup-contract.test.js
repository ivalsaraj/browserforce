import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/popup.html', 'utf8');

test('popup includes Open BrowserForce Agent button', () => {
  assert.match(html, /Open BrowserForce Agent/);
});
