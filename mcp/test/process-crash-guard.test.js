// Tests for the shared process crash guard. The guard exists because a
// detached promise rejection from user snippet code (exec/eval) killed the
// MCP server process on Node 22 (default --unhandled-rejections=throw),
// taking down BrowserForce for every window until Cursor respawned it.
//
// node:test intercepts process 'unhandledRejection'/'uncaughtException'
// events and fails the running test even when listeners exist, so manual
// process.emit() assertions are impossible here. In-process tests are
// emit-free; every event-driven behavior is proven in subprocesses that
// experience REAL rejections/exceptions.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { installProcessCrashGuard } from '../src/process-crash-guard.js';

const GUARD_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/process-crash-guard.js');
const GUARD_URL = JSON.stringify('file://' + GUARD_PATH);

function runNodeInline(source) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('installProcessCrashGuard (in-process, emit-free)', () => {
  it('first install registers listeners; repeat install is a no-op', () => {
    const rejBefore = process.listenerCount('unhandledRejection');
    const excBefore = process.listenerCount('uncaughtException');
    const first = installProcessCrashGuard({ writeLine: () => {} });
    assert.equal(first.alreadyInstalled, false);
    assert.equal(process.listenerCount('unhandledRejection'), rejBefore + 1);
    assert.equal(process.listenerCount('uncaughtException'), excBefore + 1);

    const second = installProcessCrashGuard({ writeLine: () => {} });
    assert.equal(second.alreadyInstalled, true);
    assert.equal(process.listenerCount('unhandledRejection'), rejBefore + 1, 'no duplicate listeners');
  });
});

describe('installProcessCrashGuard (subprocess reality checks)', () => {
  it('a real detached rejection kills a bare node process (control)', async () => {
    const { code } = await runNodeInline(`
      Promise.reject(new Error('unguarded boom'));
      setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 200);
    `);
    assert.notEqual(code, 0, 'control process must die — proves the crash class is real');
  });

  it('the guard keeps the process alive and logs the rejection to stderr, never stdout', async () => {
    const { code, stdout, stderr } = await runNodeInline(`
      const { installProcessCrashGuard } = await import(${GUARD_URL});
      installProcessCrashGuard({ logPrefix: '[bf-guard-test]' });
      Promise.reject(new Error('guarded boom'));
      setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 200);
    `);
    assert.equal(code, 0, 'guarded process must survive');
    assert.ok(stdout.includes('SURVIVED'));
    assert.ok(stderr.includes('[bf-guard-test]') && stderr.includes('Unhandled rejection') && stderr.includes('guarded boom'));
    assert.ok(!stdout.includes('guarded boom'), 'guard output must never reach stdout (MCP transport)');
  });

  it('the guard keeps the process alive through a real uncaught exception (user timer throw)', async () => {
    const { code, stdout, stderr } = await runNodeInline(`
      const { installProcessCrashGuard } = await import(${GUARD_URL});
      installProcessCrashGuard({ logPrefix: '[bf-guard-test]' });
      setTimeout(() => { throw new Error('timer boom'); }, 0);
      setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 200);
    `);
    assert.equal(code, 0);
    assert.ok(stdout.includes('SURVIVED'));
    assert.ok(stderr.includes('Uncaught exception') && stderr.includes('timer boom'));
  });

  it('an injected writer replaces the stderr default', async () => {
    const { code, stdout, stderr } = await runNodeInline(`
      const { installProcessCrashGuard } = await import(${GUARD_URL});
      const lines = [];
      installProcessCrashGuard({ logPrefix: '[bf-custom]', writeLine: (l) => lines.push(l) });
      Promise.reject(new Error('captured boom'));
      setTimeout(() => { console.log(JSON.stringify(lines)); process.exit(0); }, 200);
    `);
    assert.equal(code, 0);
    const lines = JSON.parse(stdout.trim());
    assert.ok(lines.some((l) => l.includes('[bf-custom]') && l.includes('captured boom')));
    assert.ok(!stderr.includes('captured boom'), 'default stderr writer must not run when a writer is injected');
  });

  it('double install keeps the FIRST writer — the second never receives events', async () => {
    const { code, stdout } = await runNodeInline(`
      const { installProcessCrashGuard } = await import(${GUARD_URL});
      const first = [];
      const second = [];
      installProcessCrashGuard({ writeLine: (l) => first.push(l) });
      const repeat = installProcessCrashGuard({ writeLine: (l) => second.push(l) });
      Promise.reject(new Error('writer isolation'));
      setTimeout(() => {
        console.log(JSON.stringify({ already: repeat.alreadyInstalled, first, second }));
        process.exit(0);
      }, 200);
    `);
    assert.equal(code, 0);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.already, true);
    assert.ok(result.first.some((l) => l.includes('writer isolation')));
    assert.equal(result.second.length, 0, 'second writer must never receive events');
  });
});
