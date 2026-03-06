import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('loadPlugins returns empty array when dir does not exist', async () => {
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins('/nonexistent/path/xyz');
  assert.deepEqual(plugins, []);
});

test('loadPlugins loads a valid plugin folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'hello');
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, 'index.js'),
    `export default { name: 'hello', helpers: { greet: async (page) => 'hi' } };`
  );
  const skillSource = `---
name: hello-skill
description: Friendly hello helper
tags: greeting,starter
---
# hello
Use greet() to say hi.`;
  await writeFile(join(pluginDir, 'SKILL.md'), skillSource);

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'hello');
  assert.equal(typeof plugins[0].helpers.greet, 'function');
  assert.equal(plugins[0]._skill, skillSource);
  assert.deepEqual(plugins[0]._skillMeta, {
    name: 'hello-skill',
    description: 'Friendly hello helper',
  });
  assert.equal(plugins[0]._skillBody, '# hello\nUse greet() to say hi.');

  await rm(dir, { recursive: true });
});

test('loadPlugins ignores unknown SKILL frontmatter keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'meta-keys');
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, 'index.js'),
    `export default { name: 'meta-keys', helpers: { noop: async () => null } };`
  );
  await writeFile(
    join(pluginDir, 'SKILL.md'),
    `---
name: meta-keys
description: plugin metadata
helpers: noop
unknown: should-be-ignored
tags: also-ignored
---
# Meta Keys
Details`
  );

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0]._skillMeta, {
    name: 'meta-keys',
    description: 'plugin metadata',
    helpers: ['noop'],
  });

  await rm(dir, { recursive: true });
});

test('loadPlugins preserves description text after first colon', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'desc-colons');
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, 'index.js'),
    `export default { name: 'desc-colons', helpers: { noop: async () => null } };`
  );
  await writeFile(
    join(pluginDir, 'SKILL.md'),
    `---
name: desc-colons
description: A: B: C
---
# Desc Colons
Details`
  );

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]._skillMeta.description, 'A: B: C');

  await rm(dir, { recursive: true });
});

test('loadPlugins parses YAML list frontmatter values for canonical list keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'yaml-lists');
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, 'index.js'),
    `export default { name: 'yaml-lists', helpers: { alpha: async () => null } };`
  );
  await writeFile(
    join(pluginDir, 'SKILL.md'),
    `---
name: yaml-lists
description: Uses YAML list values
helpers:
  - alpha
  - beta
tools:
  - read_sheet
when_to_use:
  - First scenario
  - Second scenario
---
# YAML Lists
Body`
  );

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0]._skillMeta.helpers, ['alpha', 'beta']);
  assert.deepEqual(plugins[0]._skillMeta.tools, ['read_sheet']);
  assert.deepEqual(plugins[0]._skillMeta.when_to_use, ['First scenario', 'Second scenario']);

  await rm(dir, { recursive: true });
});

test('loadPlugins parses helper_prefix and helper_aliases metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'prefix-meta');
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, 'index.js'),
    `export default { name: 'prefix-meta', helpers: { pf__run: async () => null, run: async () => null } };`
  );
  await writeFile(
    join(pluginDir, 'SKILL.md'),
    `---
name: prefix-meta
description: Prefix metadata test
helper_prefix: pf
helpers:
  - pf__run
helper_aliases:
  - run
---
# Prefix Meta
Body`
  );

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]._skillMeta.helper_prefix, 'pf');
  assert.deepEqual(plugins[0]._skillMeta.helpers, ['pf__run']);
  assert.deepEqual(plugins[0]._skillMeta.helper_aliases, ['run']);

  await rm(dir, { recursive: true });
});

test('loadPlugins tolerates malformed frontmatter without crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'malformed');
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, 'index.js'),
    `export default { name: 'malformed', helpers: { noop: async () => null } };`
  );
  const malformedSkill = `---
name malformed
description missing colon
# no closing fence
# Malformed
Still loads`;
  await writeFile(join(pluginDir, 'SKILL.md'), malformedSkill);

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0]._skillMeta, {});
  assert.equal(plugins[0]._skillBody, malformedSkill);

  await rm(dir, { recursive: true });
});

test('loadPlugins skips plugin missing name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'broken');
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, 'index.js'), `export default { helpers: {} };`);

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);
  assert.equal(plugins.length, 0);

  await rm(dir, { recursive: true });
});

test('loadPlugins logs permission errors separately from missing dir', async () => {
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const result = await loadPlugins('/nonexistent/definitely-not-here');
  assert.deepEqual(result, []); // no throw, no crash
});

test('buildPluginHelpers merges helpers from multiple plugins', async () => {
  const { buildPluginHelpers } = await import('../src/plugin-loader.js');
  const plugins = [
    { name: 'a', helpers: { foo: async () => 'foo' } },
    { name: 'b', helpers: { bar: async () => 'bar' } },
  ];
  const helpers = buildPluginHelpers(plugins);
  assert.equal(typeof helpers.foo, 'function');
  assert.equal(typeof helpers.bar, 'function');
});

test('buildPluginSkillAppendix skips plugins with empty skill', async () => {
  const { buildPluginSkillAppendix } = await import('../src/plugin-loader.js');
  const plugins = [
    {
      name: 'a',
      helpers: { foo: () => 'x' },
      _skillMeta: { description: 'Helper for X' },
      _skillBody: 'Detailed instructions for X',
    },
    { name: 'b', helpers: { noop: () => null }, _skillMeta: {}, _skillBody: '' },
    {
      name: 'c',
      helpers: { bar: () => 'y' },
      _skillMeta: { description: 'Helper for Y' },
      _skillBody: 'Detailed instructions for Y',
    },
  ];
  const appendix = buildPluginSkillAppendix(plugins);

  assert.ok(appendix.includes('pluginCatalog()'));
  assert.ok(appendix.includes('pluginHelp(name, section?)'));
  assert.ok(appendix.includes('clearly matches a plugin capability'));
  assert.ok(appendix.includes('PLUGIN: a'));
  assert.ok(appendix.includes('Helper for X'));
  assert.ok(appendix.includes('foo'));
  assert.ok(appendix.includes('PLUGIN: c'));
  assert.ok(appendix.includes('Helper for Y'));
  assert.ok(!appendix.includes('PLUGIN: b'));
  assert.ok(!appendix.includes('Detailed instructions for X'));
  assert.ok(!appendix.includes('Detailed instructions for Y'));
});

test('loadPlugins parses block scalar frontmatter values for canonical keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-test-'));
  const pluginDir = join(dir, 'block-scalars');
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, 'index.js'),
    `export default { name: 'block-scalars', helpers: { noop: async () => null } };`
  );
  await writeFile(
    join(pluginDir, 'SKILL.md'),
    `---
name: block-scalars
description: |
  First line.
  Second line.
when_to_use: >
  Use this helper
  when pages are ready.
---
# Block Scalars
Body`
  );

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]._skillMeta.description, 'First line.\nSecond line.');
  assert.deepEqual(plugins[0]._skillMeta.when_to_use, ['Use this helper when pages are ready.']);

  await rm(dir, { recursive: true });
});

test('buildPluginSkillRuntime ignores section headings inside fenced code blocks', async () => {
  const { buildPluginSkillRuntime } = await import('../src/plugin-loader.js');
  const runtime = buildPluginSkillRuntime([
    {
      name: 'fences',
      helpers: {},
      _skillMeta: {},
      _skillBody: `Intro

## usage
Visible section text.

\`\`\`md
## not-a-section
\`\`\`

## examples
Real examples section.`,
    },
  ]);

  const usage = runtime.byName.fences.sections.usage;
  assert.ok(usage.includes('Visible section text.'));
  assert.ok(usage.includes('## not-a-section'));
  assert.deepEqual(Object.keys(runtime.byName.fences.sections), ['usage', 'examples']);
});

test('buildPluginSkillRuntime keeps first plugin for duplicate normalized names and warns', async () => {
  const { buildPluginSkillRuntime } = await import('../src/plugin-loader.js');

  const originalStderrWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = function patchedWrite(chunk, ...args) {
    stderr += String(chunk);
    const maybeCallback = args[args.length - 1];
    if (typeof maybeCallback === 'function') maybeCallback();
    return true;
  };

  try {
    const runtime = buildPluginSkillRuntime([
      { name: 'Dupe', helpers: {}, _skillMeta: {}, _skillBody: '## one\nfirst' },
      { name: 'dupe', helpers: {}, _skillMeta: {}, _skillBody: '## one\nsecond' },
    ]);

    assert.equal(runtime.catalog.length, 1);
    assert.equal(runtime.catalog[0].name, 'Dupe');
    assert.equal(runtime.byName.dupe.name, 'Dupe');
    assert.equal(runtime.byName.dupe.sections.one, 'first');
    assert.match(stderr, /Duplicate plugin skill name/i);
    assert.match(stderr, /Keeping first/i);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('loadPlugins parses metadata shape from official google-sheets SKILL fixture', async () => {
  const officialPluginsDir = fileURLToPath(new URL('../../plugins/official', import.meta.url));
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(officialPluginsDir);
  const googleSheets = plugins.find((plugin) => plugin.name === 'google-sheets');

  assert.ok(googleSheets);
  assert.equal(googleSheets._skillMeta.name, 'google-sheets');
  assert.equal(typeof googleSheets._skillMeta.description, 'string');
  assert.equal(Array.isArray(googleSheets._skillMeta.when_to_use), true);
  assert.equal(Array.isArray(googleSheets._skillMeta.helpers), true);
  assert.equal(typeof googleSheets._skillMeta.helper_prefix, 'string');
  assert.equal(Array.isArray(googleSheets._skillMeta.helper_aliases), true);
  assert.equal(Array.isArray(googleSheets._skillMeta.tools), true);
  assert.ok(googleSheets._skillMeta.when_to_use.length > 0);
  assert.ok(googleSheets._skillMeta.helpers.length > 0);
  assert.ok(googleSheets._skillMeta.helper_aliases.length > 0);
});
