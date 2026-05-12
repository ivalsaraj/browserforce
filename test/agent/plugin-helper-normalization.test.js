import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePluginHelperNames,
  normalizePluginHelperPrefix,
} from '../../extension/plugin-helper-normalization.js';

test('normalizePluginHelperNames trims, validates, and deduplicates helper calls', () => {
  assert.deepEqual(
    normalizePluginHelperNames([' searchSheet ', 'searchSheet', '$select', '2bad', '']),
    ['searchSheet', '$select'],
  );
});

test('normalizePluginHelperPrefix lowercases valid helper prefixes', () => {
  assert.equal(normalizePluginHelperPrefix('Sheets1'), 'sheets1');
  assert.equal(normalizePluginHelperPrefix('sheets1'), 'sheets1');
  assert.equal(normalizePluginHelperPrefix('sheets_helper'), '');
});
