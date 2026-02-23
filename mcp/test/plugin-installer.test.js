import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Tests the ESM version (CLI path)
test('installPlugin writes index.js and SKILL.md to dest dir', async (t) => {
  // We test with a mock fetch — patch global fetch
  const dir = await mkdtemp(join(tmpdir(), 'bf-install-test-'));

  // Registry schema matches registry.json: url/skill_url/sha256 (flat string)
  const fakeRegistry = {
    plugins: [{
      name: 'testplugin',
      url: 'https://example.com/plugins/testplugin/index.js',
      skill_url: 'https://example.com/plugins/testplugin/SKILL.md',
      sha256: null, // null = skip integrity check in test mode
    }]
  };

  // Use a test-only override via env var to skip real network call
  process.env.BF_TEST_REGISTRY = JSON.stringify(fakeRegistry);
  process.env.BF_TEST_PLUGIN_JS = 'export default { name: "testplugin" }';
  process.env.BF_TEST_PLUGIN_SKILL = '# testplugin\nTest skill.';

  const { installPlugin } = await import('../src/plugin-installer.js');
  await installPlugin('testplugin', dir);

  const files = await readdir(join(dir, 'testplugin'));
  assert.ok(files.includes('index.js'));
  assert.ok(files.includes('SKILL.md'));

  await rm(dir, { recursive: true });
  delete process.env.BF_TEST_REGISTRY;
  delete process.env.BF_TEST_PLUGIN_JS;
  delete process.env.BF_TEST_PLUGIN_SKILL;
});

test('installPlugin throws for unknown plugin name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-install-test-'));
  process.env.BF_TEST_REGISTRY = JSON.stringify({ plugins: [] });

  const { installPlugin } = await import('../src/plugin-installer.js');
  await assert.rejects(
    () => installPlugin('nonexistent', dir),
    /not found in registry/
  );

  await rm(dir, { recursive: true });
  delete process.env.BF_TEST_REGISTRY;
});
