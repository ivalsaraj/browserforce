import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const bg = fs.readFileSync('extension/background.js', 'utf8');

test('createTab imports and uses the plan resolver', () => {
  assert.match(bg, /import \{ resolveCreateWindowPlan \} from '\.\/window-affinity\.js'/);
  assert.match(bg, /resolveCreateTabWindowPlan\(params, !!settings\.dedicatedWindow\)/);
});

test('createTab reads the dedicatedWindow setting from storage', () => {
  assert.match(bg, /'dedicatedWindow'/);
});

test('new-window plan opens a background window via chrome.windows.create', () => {
  assert.match(bg, /plan\.action === 'new-window'/);
  assert.match(bg, /chrome\.windows\.create\(/);
  assert.match(bg, /focused:\s*false/);
});
