// mcp/test/mcp-plugin-integration.test.js
// Tests that plugin helpers actually appear in execute scope at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExecContext, runCode } from '../src/exec-engine.js';
import { loadPlugins, buildPluginHelpers, buildPluginSkillAppendix } from '../src/plugin-loader.js';

test('plugin helper is callable in execute scope after loadPlugins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-mcp-test-'));
  const pluginDir = join(dir, 'counter');
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, 'index.js'), `
    export default {
      name: 'counter',
      helpers: {
        async countChars(page, ctx, state, str) { return str.length; }
      }
    };
  `);

  const plugins = await loadPlugins(dir);
  const pluginHelpers = buildPluginHelpers(plugins);

  const mockPage = { isClosed: () => false, url: () => 'about:blank', title: async () => '' };
  const ctx = buildExecContext(mockPage, { pages: () => [mockPage] }, {}, {}, pluginHelpers);

  const result = await runCode('return await countChars("hello world")', ctx, 5000);
  assert.equal(result, 11);

  await rm(dir, { recursive: true });
});

test('plugin SKILL.md content is included in plugin appendix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-mcp-test-'));
  const pluginDir = join(dir, 'tagger');
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, 'index.js'), `export default { name: 'tagger', helpers: {} };`);
  await writeFile(join(pluginDir, 'SKILL.md'), 'Use tagger() to tag elements.');

  const plugins = await loadPlugins(dir);
  const appendix = buildPluginSkillAppendix(plugins);

  assert.ok(appendix.includes('PLUGIN: tagger'));
  assert.ok(appendix.includes('Use tagger() to tag elements.'));

  await rm(dir, { recursive: true });
});
