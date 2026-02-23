import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import https from 'node:https';

const REGISTRY_URL = 'https://raw.githubusercontent.com/ivalsaraj/browserforce/main/plugins/registry.json';
const BASE_RAW = 'https://raw.githubusercontent.com/ivalsaraj/browserforce/main/';

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

  const js = await fetchPluginFile(`${BASE_RAW}${entry.file}`, 'BF_TEST_PLUGIN_JS');

  // SHA-256 integrity check (skip if registry entry has null hash — dev/test mode)
  if (entry.sha256?.js) {
    const actual = createHash('sha256').update(js).digest('hex');
    if (actual !== entry.sha256.js) {
      throw new Error(`Plugin "${name}" integrity check failed — sha256 mismatch`);
    }
  }

  const destDir = join(pluginsDir, name);
  await mkdir(destDir, { recursive: true });

  // Write atomically: write to .tmp, then rename — prevents partial installs
  const tmpJs = join(destDir, 'index.js.tmp');
  await writeFile(tmpJs, js);
  await rename(tmpJs, join(destDir, 'index.js'));

  if (entry.skill) {
    try {
      const skill = await fetchPluginFile(`${BASE_RAW}${entry.skill}`, 'BF_TEST_PLUGIN_SKILL');
      await writeFile(join(destDir, 'SKILL.md'), skill);
    } catch { /* SKILL.md optional */ }
  }
}
