import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * Check npm registry for a newer version of browserforce.
 * Result is cached for 24 h in ~/.browserforce/update-check.json.
 * Returns { current, latest } if an update is available, otherwise null.
 * Never throws — all errors resolve to null.
 */
export async function checkForUpdate() {
  // package.json is two levels up from mcp/src/
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version;

  const cacheDir = join(homedir(), '.browserforce');
  const cacheFile = join(cacheDir, 'update-check.json');

  // Return cached result if still fresh (< 24 h)
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (Date.now() - cached.checkedAt < 86_400_000) {
      return semverGt(cached.latest, current) ? { current, latest: cached.latest } : null;
    }
  } catch { /* no cache yet, or invalid */ }

  // Fetch latest from npm registry — let errors propagate to caller
  const latest = await new Promise((resolve, reject) => {
    const req = https.get(
      'https://registry.npmjs.org/browserforce/latest',
      { headers: { 'User-Agent': 'browserforce-cli' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => { try { resolve(JSON.parse(data).version); } catch { reject(new Error('parse error')); } });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });

  // Persist to cache
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latest }));
  } catch { /* ignore cache write errors */ }

  return semverGt(latest, current) ? { current, latest } : null;
}
