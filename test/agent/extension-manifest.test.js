import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

test('manifest includes sidePanel permission and default_path', () => {
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel.default_path, 'agent-panel.html');
});
