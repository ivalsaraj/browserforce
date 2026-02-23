// CJS version of mcp/src/plugin-installer.js — keep in sync
const { mkdir, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const REGISTRY_URL = 'https://raw.githubusercontent.com/ivalsaraj/browserforce/main/plugins/registry.json';
const BASE_RAW = 'https://raw.githubusercontent.com/ivalsaraj/browserforce/main/';

function httpsGetRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'browserforce' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchRegistry() {
  if (process.env.BF_TEST_REGISTRY) return JSON.parse(process.env.BF_TEST_REGISTRY);
  const raw = await httpsGetRaw(REGISTRY_URL);
  return JSON.parse(raw);
}

async function installPlugin(name, pluginsDir) {
  const registry = await fetchRegistry();
  const entry = registry.plugins?.find(p => p.name === name);
  if (!entry) throw new Error(`Plugin "${name}" not found in registry`);

  const js = await httpsGetRaw(`${BASE_RAW}${entry.file}`);

  if (entry.sha256?.js) {
    const actual = crypto.createHash('sha256').update(js).digest('hex');
    if (actual !== entry.sha256.js) throw new Error(`Plugin "${name}" integrity check failed`);
  }

  const destDir = path.join(pluginsDir, name);
  await mkdir(destDir, { recursive: true });

  const tmpJs = path.join(destDir, 'index.js.tmp');
  await writeFile(tmpJs, js);
  await rename(tmpJs, path.join(destDir, 'index.js'));

  if (entry.skill) {
    try {
      const skill = await httpsGetRaw(`${BASE_RAW}${entry.skill}`);
      await writeFile(path.join(destDir, 'SKILL.md'), skill);
    } catch { /* optional */ }
  }
}

module.exports = { installPlugin };
