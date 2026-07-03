import {
  loadPlugins,
  buildPluginHelpers,
  buildPluginSkillAppendix,
  buildPluginSkillRuntime,
} from './plugin-loader.js';

export function emptyPluginRuntime() {
  return {
    plugins: [],
    helpers: {},
    appendix: buildPluginSkillAppendix([]),
    skillRuntime: { catalog: [], byName: {} },
  };
}

export async function loadPluginRuntime({ pluginsDir, logPrefix = '[bf-mcp]' } = {}) {
  try {
    const finalPluginsDir = pluginsDir || process.env.BF_PLUGINS_DIR;
    const plugins = await loadPlugins(finalPluginsDir);
    const runtime = {
      plugins,
      helpers: buildPluginHelpers(plugins),
      appendix: buildPluginSkillAppendix(plugins),
      skillRuntime: buildPluginSkillRuntime(plugins),
    };
    if (plugins.length > 0) {
      process.stderr.write(`${logPrefix} Loaded ${plugins.length} plugin(s): ${plugins.map((p) => p.name).join(', ')}\n`);
    }
    return runtime;
  } catch (err) {
    process.stderr.write(`${logPrefix} Plugin load error: ${err.message}\n`);
    return emptyPluginRuntime();
  }
}
