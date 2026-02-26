import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const postinstallScript = join(repoRoot, 'scripts', 'postinstall-openclaw.mjs');

function buildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }
  return env;
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'bf-postinstall-'));
  const cwd = join(root, 'cwd');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home };
}

function writeSpawnHook({ hookPath, logPath }) {
  const hookSource = `const cp = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');

cp.spawn = function spawnStub(command, args = []) {
  appendFileSync(${JSON.stringify(logPath)}, [command, ...(Array.isArray(args) ? args : [])].join(' ') + '\\n');
  const child = new EventEmitter();
  process.nextTick(() => child.emit('close', 0));
  return child;
};
`;

  writeFileSync(hookPath, hookSource, 'utf8');
}

async function runPostinstall({ cwd = repoRoot, env = {}, nodeArgs = [] } = {}) {
  return exec(process.execPath, [...nodeArgs, postinstallScript], {
    cwd,
    env: buildEnv(env),
  });
}

describe('postinstall openclaw hook', () => {
  it('exits 0 and does nothing when BROWSERFORCE_SETUP_OPENCLAW is unset', async () => {
    const sandbox = createSandbox();
    try {
      const { stdout } = await runPostinstall({
        cwd: sandbox.cwd,
        env: {
          BROWSERFORCE_SETUP_OPENCLAW: null,
          BROWSERFORCE_SETUP_OPENCLAW_FORCE: null,
          BROWSERFORCE_SETUP_OPENCLAW_APPLY: null,
          HOME: sandbox.home,
          PATH: '',
        },
      });

      assert.equal(stdout.trim(), '');
      assert.equal(existsSync(join(sandbox.home, '.openclaw')), false);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it('runs dry-run setup command when opt-in is enabled in CI-safe mode', async () => {
    const sandbox = createSandbox();
    try {
      const { stdout } = await runPostinstall({
        cwd: sandbox.cwd,
        env: {
          BROWSERFORCE_SETUP_OPENCLAW: '1',
          BROWSERFORCE_SETUP_OPENCLAW_FORCE: '1',
          BROWSERFORCE_SETUP_OPENCLAW_APPLY: null,
          CI: '1',
          HOME: sandbox.home,
          PATH: '',
        },
      });

      assert.match(stdout, /"target"\s*:\s*"openclaw"/);
      assert.match(stdout, /"dryRun"\s*:\s*true/);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it('exits 0 and skips setup command in CI when force is not enabled', async () => {
    const sandbox = createSandbox();
    try {
      const { stdout } = await runPostinstall({
        cwd: sandbox.cwd,
        env: {
          BROWSERFORCE_SETUP_OPENCLAW: '1',
          BROWSERFORCE_SETUP_OPENCLAW_FORCE: null,
          BROWSERFORCE_SETUP_OPENCLAW_APPLY: null,
          CI: '1',
          HOME: sandbox.home,
          PATH: '',
        },
      });

      assert.equal(stdout.trim(), '');
      assert.equal(existsSync(join(sandbox.home, '.openclaw')), false);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it('runs dry-run setup command before apply command when apply mode is enabled', async () => {
    const sandbox = createSandbox();
    const hookPath = join(sandbox.root, 'spawn-hook.cjs');
    const logPath = join(sandbox.root, 'spawn-invocations.log');
    writeSpawnHook({ hookPath, logPath });

    try {
      const { stdout } = await runPostinstall({
        cwd: sandbox.cwd,
        nodeArgs: ['--require', hookPath],
        env: {
          BROWSERFORCE_SETUP_OPENCLAW: '1',
          BROWSERFORCE_SETUP_OPENCLAW_FORCE: '1',
          BROWSERFORCE_SETUP_OPENCLAW_APPLY: '1',
          CI: null,
          HOME: sandbox.home,
          PATH: '',
        },
      });

      assert.equal(stdout.trim(), '');

      const invocations = readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const expectedCommandPrefix = `${process.execPath} ${join(repoRoot, 'bin.js')} setup openclaw`;
      assert.deepEqual(invocations, [
        `${expectedCommandPrefix} --dry-run --json`,
        `${expectedCommandPrefix} --json`,
      ]);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
});
