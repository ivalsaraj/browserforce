import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertBrowserforceCoreSkill } from './browserforce-skill-contract.js';

const exec = promisify(execFile);

test('OpenCode installs the complete BrowserForce skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browserforce-skill-'));
  const project = join(root, 'project');
  await mkdir(project);
  const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config') };
  try {
    const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
    await exec('npx', ['-y', 'skills', 'add', repo, '--agent', 'opencode', '--skill', 'browserforce', '--copy', '--yes'], { cwd: project, env });
    const installed = await readFile(join(project, '.agents/skills/browserforce/SKILL.md'), 'utf8');
    assertBrowserforceCoreSkill(installed, 'installed skill');
    const listed = await exec('npx', ['-y', 'skills', 'list', '--agent', 'opencode'], { cwd: project, env });
    assert.match(listed.stdout, /browserforce/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
