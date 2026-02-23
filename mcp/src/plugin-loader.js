import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

export const PLUGINS_DIR = join(homedir(), '.browserforce', 'plugins');

/**
 * Scan pluginsDir for subfolders with index.js. Loads each as an ESM module.
 * @param {string} [pluginsDir]
 * @returns {Promise<Array>}
 */
export async function loadPlugins(pluginsDir = PLUGINS_DIR) {
  const plugins = [];

  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Permission or IO error — log but don't crash
      process.stderr.write(`[bf-plugins] Cannot read plugins dir: ${err.message}\n`);
    }
    return plugins; // missing directory is fine — no plugins installed
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsDir, entry.name);
    const indexPath = join(pluginDir, 'index.js');

    let mod;
    try {
      mod = await import(pathToFileURL(indexPath).href);
    } catch (err) {
      process.stderr.write(`[bf-plugins] Failed to load ${entry.name}: ${err.message}\n`);
      continue;
    }

    const plugin = mod.default;
    if (!plugin?.name) {
      process.stderr.write(`[bf-plugins] Skipping ${entry.name}: export missing 'name' field\n`);
      continue;
    }

    let skill = '';
    try {
      skill = await readFile(join(pluginDir, 'SKILL.md'), 'utf8');
    } catch { /* SKILL.md is optional */ }

    plugins.push({ ...plugin, _skill: skill, _dir: pluginDir });
    process.stderr.write(`[bf-plugins] Loaded plugin: ${plugin.name}\n`);
  }

  return plugins;
}

/**
 * Merge helpers from all plugins into a flat object.
 * Last plugin wins on name collision (with a warning).
 */
export function buildPluginHelpers(plugins) {
  const helpers = {};
  for (const plugin of plugins) {
    if (!plugin.helpers) continue;
    for (const [name, fn] of Object.entries(plugin.helpers)) {
      if (helpers[name]) {
        process.stderr.write(`[bf-plugins] Helper name conflict: "${name}" — ${plugin.name} overwrites previous\n`);
      }
      helpers[name] = fn;
    }
  }
  return helpers;
}

/**
 * Build the SKILL.md appendix to append to the execute tool prompt.
 * Only includes plugins that have non-empty SKILL.md content.
 */
export function buildPluginSkillAppendix(plugins) {
  const sections = plugins
    .filter(p => p._skill && p._skill.trim())
    .map(p => `\n\n═══ PLUGIN: ${p.name} ═══\n\n${p._skill.trim()}`);
  return sections.join('');
}
