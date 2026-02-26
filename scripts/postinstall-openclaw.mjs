import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const binScriptPath = resolve(scriptDir, '..', 'bin.js');

function isCiEnv() {
  const raw = process.env.CI;
  if (!raw) return false;
  const normalized = String(raw).toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

function runSetup(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binScriptPath, 'setup', 'openclaw', ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`setup openclaw exited with code ${code}`));
    });
  });
}

async function main() {
  if (process.env.BROWSERFORCE_SETUP_OPENCLAW !== '1') return;
  if (isCiEnv() && process.env.BROWSERFORCE_SETUP_OPENCLAW_FORCE !== '1') return;

  await runSetup(['--dry-run', '--json']);

  if (process.env.BROWSERFORCE_SETUP_OPENCLAW_APPLY === '1') {
    await runSetup(['--json']);
  }
}

main().catch((error) => {
  console.error(`[postinstall-openclaw] ${error.message}`);
  process.exitCode = 1;
});
