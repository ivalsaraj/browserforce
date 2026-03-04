// mcp/test/mcp-plugin-integration.test.js
// Tests that plugin helpers actually appear in execute scope at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExecContext, runCode } from '../src/exec-engine.js';
import {
  loadPlugins,
  buildPluginHelpers,
  buildPluginSkillAppendix,
  buildPluginSkillRuntime,
} from '../src/plugin-loader.js';

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

test('plugin appendix is metadata-only and runtime help remains available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-mcp-test-'));
  const pluginDir = join(dir, 'tagger');
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, 'index.js'), `
    export default {
      name: 'tagger',
      helpers: { tagger: () => 'ok' },
    };
  `);
  await writeFile(join(pluginDir, 'SKILL.md'), `---
name: tagger
description: Tags elements with labels.
---
Use tagger() to tag elements.

## examples
- tagger('hero')`);

  const plugins = await loadPlugins(dir);
  const appendix = buildPluginSkillAppendix(plugins);
  const pluginSkillRuntime = buildPluginSkillRuntime(plugins);
  const mockPage = { isClosed: () => false, url: () => 'about:blank', title: async () => '' };

  const ctx = buildExecContext(
    mockPage,
    { pages: () => [mockPage] },
    {},
    {},
    buildPluginHelpers(plugins),
    {},
    {},
    pluginSkillRuntime,
  );

  assert.ok(appendix.includes('PLUGIN: tagger'));
  assert.ok(appendix.includes('Tags elements with labels.'));
  assert.ok(!appendix.includes('Use tagger() to tag elements.'));

  const catalog = await runCode('return pluginCatalog()', ctx, 5000);
  assert.equal(Array.isArray(catalog), true);
  assert.equal(catalog[0].name, 'tagger');
  assert.equal(catalog[0].description, 'Tags elements with labels.');

  const help = await runCode('return pluginHelp("tagger", "examples")', ctx, 5000);
  assert.ok(help.includes("tagger('hero')"));

  await rm(dir, { recursive: true });
});
