import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

function cli(args, env) {
  return exec('node', ['bin.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
}

test('browserforce agent start allocates a non-conflicting port', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bf-agent-cli-home-'));
  try {
    const { stdout } = await cli(['agent', 'start', '--json'], { HOME: home });
    const body = JSON.parse(stdout);
    assert.equal(body.started, true);
    assert.ok(Number.isInteger(body.port));
    assert.ok(Number.isInteger(body.pid));

    await cli(['agent', 'stop', '--json'], { HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('browserforce agent status prints chatd health', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bf-agent-cli-home-'));
  try {
    await cli(['agent', 'start', '--json'], { HOME: home });
    const { stdout } = await cli(['agent', 'status', '--json'], { HOME: home });
    const body = JSON.parse(stdout);
    assert.equal(body.running, true);
    assert.equal(body.health.ok, true);
    await cli(['agent', 'stop', '--json'], { HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
