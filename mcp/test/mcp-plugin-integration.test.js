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
import { loadPluginRuntime } from '../src/plugin-runtime.js';
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';

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

test('browser session runtime exposes loaded plugins to eval snippets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-runtime-plugin-test-'));
  const pluginDir = join(dir, 'tagger');
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, 'index.js'), `
    export default {
      name: 'tagger',
      helpers: {
        async tagger(page, ctx, state, value) {
          state.tagged = value;
          return { value, url: page.url(), pageCount: ctx.pages().length };
        }
      }
    };
  `);
  await writeFile(join(pluginDir, 'SKILL.md'), `---
name: tagger
description: Tags the active page.
---
Use tagger(value) to tag the active page.`);

  const pluginRuntime = await loadPluginRuntime({ pluginsDir: dir, logPrefix: '[bf-test]' });
  const page = {
    isClosed: () => false,
    url: () => 'https://example.test/',
    title: async () => 'Example',
    on: () => {},
  };
  const ctx = { pages: () => [page], on: () => {} };
  page.context = () => ctx;
  const browser = {
    isConnected: () => true,
    contexts: () => [ctx],
    on: () => {},
    close: async () => {},
  };
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => browser,
    getRelayHttpUrl: () => 'http://127.0.0.1:1',
    buildExecContext,
    runCode,
    pluginHelpers: pluginRuntime.helpers,
    pluginSkillRuntime: pluginRuntime.skillRuntime,
  });

  const result = await runtime.runCommand({
    timeout: 5000,
    code: `
      const catalog = pluginCatalog();
      const helpText = pluginHelp('tagger');
      const tagged = await tagger('ok');
      return { catalog, helpText, tagged, stateValue: state.tagged };
    `,
  });

  assert.equal(result.catalog[0].name, 'tagger');
  assert.match(result.helpText, /Use tagger/);
  assert.deepEqual(result.tagged, { value: 'ok', url: 'https://example.test/', pageCount: 1 });
  assert.equal(result.stateValue, 'ok');

  await rm(dir, { recursive: true });
});
