import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  await writeFile(join(pluginDir, 'SKILL.md'), '# hello\nUse greet() to say hi.');

  const { loadPlugins } = await import('../src/plugin-loader.js');
  const plugins = await loadPlugins(dir);

  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'hello');
  assert.equal(typeof plugins[0].helpers.greet, 'function');
  assert.equal(plugins[0]._skill, '# hello\nUse greet() to say hi.');

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
    { name: 'a', _skill: 'Use foo() for X.' },
    { name: 'b', _skill: '' },
    { name: 'c', _skill: 'Use bar() for Y.' },
  ];
  const appendix = buildPluginSkillAppendix(plugins);
  assert.ok(appendix.includes('PLUGIN: a'));
  assert.ok(appendix.includes('Use foo() for X.'));
  assert.ok(appendix.includes('PLUGIN: c'));
  assert.ok(!appendix.includes('PLUGIN: b'));
});
