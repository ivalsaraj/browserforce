import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import https from 'node:https';

const REGISTRY_URL = 'https://raw.githubusercontent.com/ivalsaraj/browserforce/main/plugins/registry.json';

function httpsGetRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'browserforce' } }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchRegistry() {
  // Test override
  if (process.env.BF_TEST_REGISTRY) {
    return JSON.parse(process.env.BF_TEST_REGISTRY);
  }
  const raw = await httpsGetRaw(REGISTRY_URL);
  return JSON.parse(raw);
}

async function fetchPluginFile(url, testEnvKey) {
  if (process.env[testEnvKey]) return process.env[testEnvKey];
  return httpsGetRaw(url);
}

/**
 * Install a plugin from the registry into destDir/<name>/.
 * @param {string} name
 * @param {string} pluginsDir  — e.g. ~/.browserforce/plugins
 */
export async function installPlugin(name, pluginsDir) {
  const registry = await fetchRegistry();
  const entry = registry.plugins?.find(p => p.name === name);
  if (!entry) throw new Error(`Plugin "${name}" not found in registry`);

  if (!entry.url) throw new Error(`Plugin "${name}" registry entry missing required field: url`);

  const js = await fetchPluginFile(entry.url, 'BF_TEST_PLUGIN_JS');

  // SHA-256 integrity check (skip if registry entry omits sha256 — dev/test mode)
  if (entry.sha256) {
    const actual = createHash('sha256').update(js).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`Plugin "${name}" integrity check failed — sha256 mismatch`);
    }
  }

  const destDir = join(pluginsDir, name);
  await mkdir(destDir, { recursive: true });

  // Write atomically: write to .tmp, then rename — prevents partial installs
  const tmpJs = join(destDir, 'index.js.tmp');
  await writeFile(tmpJs, js);
  await rename(tmpJs, join(destDir, 'index.js'));

  if (entry.skill_url) {
    try {
      const skill = await fetchPluginFile(entry.skill_url, 'BF_TEST_PLUGIN_SKILL');
      await writeFile(join(destDir, 'SKILL.md'), skill);
    } catch { /* SKILL.md optional */ }
  }
}
