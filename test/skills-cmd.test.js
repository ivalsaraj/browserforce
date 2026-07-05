// test/skills-cmd.test.js — ESM (root package is "type": "module")
//
// Unit tests for the runtime-served skills command (mirrors agent-browser's
// cli/src/skills.rs parser/discovery), plus a few real-path integration checks
// through bin.js against the shipped skill-data/core skill.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  parseFrontmatter,
  truncateDescription,
  discoverSkills,
  collectSupplementaryFiles,
  skillsList,
  skillsGet,
  skillsPath,
} from '../mcp/src/skills-cmd.js';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function mkSkill(dir, name, description, { hidden = false } = {}) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const hiddenLine = hidden ? 'hidden: true\n' : '';
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${hiddenLine}---\n\n# ${name}\n\nBody.\n`,
  );
  return skillDir;
}

describe('skills-cmd: parseFrontmatter', () => {
  it('parses a basic name + description block', () => {
    const fm = parseFrontmatter('---\nname: test-skill\ndescription: A test skill.\n---\n\n# Test\n');
    assert.deepEqual(fm, { name: 'test-skill', description: 'A test skill.', hidden: false });
  });

  it('joins a multi-line (indented continuation) description', () => {
    const fm = parseFrontmatter('---\nname: test\ndescription: First line\n  continued here\n  and here\n---\n');
    assert.equal(fm.name, 'test');
    assert.equal(fm.description, 'First line continued here and here');
    assert.equal(fm.hidden, false);
  });

  it('parses hidden: true', () => {
    const fm = parseFrontmatter('---\nname: stub\ndescription: A bootstrap stub.\nhidden: true\n---\n');
    assert.equal(fm.hidden, true);
  });

  it('returns null when the name field is missing', () => {
    assert.equal(parseFrontmatter('---\ndescription: No name field\n---\n'), null);
  });

  it('returns null when there is no frontmatter', () => {
    assert.equal(parseFrontmatter('# Just a heading\n\nNo frontmatter.\n'), null);
  });
});

describe('skills-cmd: truncateDescription (unicode-safe)', () => {
  it('returns short strings unchanged', () => {
    assert.equal(truncateDescription('short', 10), 'short');
  });

  it('truncates long ASCII at a word boundary with an ellipsis', () => {
    const out = truncateDescription('this is a longer description that should be truncated', 20);
    assert.ok(out.endsWith('...'));
    assert.ok(out.length <= 23, `expected bounded length, got ${out.length}`);
    assert.ok(!out.slice(0, -3).endsWith(' '));
  });

  it('does not split a multibyte code point', () => {
    const desc = 'Browse éléments and 日本語 pages quickly';
    const out = truncateDescription(desc, 20);
    assert.ok(out.endsWith('...'));
    assert.ok(!out.includes('\uFFFD'), 'no replacement character from a split surrogate');
    // Every code point in the output is a prefix code point of the source.
    assert.ok(desc.startsWith(out.slice(0, -3)));
  });
});

describe('skills-cmd: discoverSkills', () => {
  let tmp;
  before(() => { tmp = join(tmpdir(), `bf-skills-${Math.random().toString(36).slice(2)}`); mkdirSync(tmp, { recursive: true }); });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('discovers skills sorted by name and skips dirs without SKILL.md', () => {
    mkSkill(tmp, 'beta', 'Beta skill');
    mkSkill(tmp, 'alpha', 'Alpha skill');
    mkdirSync(join(tmp, 'not-a-skill'), { recursive: true });
    writeFileSync(join(tmp, 'not-a-skill', 'README.md'), 'hi');

    const skills = discoverSkills([tmp]);
    assert.equal(skills.length, 2);
    assert.equal(skills[0].name, 'alpha');
    assert.equal(skills[1].name, 'beta');
  });
});

describe('skills-cmd: collectSupplementaryFiles + skillsGet --full', () => {
  let tmp;
  before(() => {
    tmp = join(tmpdir(), `bf-skills-full-${Math.random().toString(36).slice(2)}`);
    const skillDir = mkSkill(tmp, 'core', 'Core skill');
    const refs = join(skillDir, 'references');
    mkdirSync(refs, { recursive: true });
    writeFileSync(join(refs, 'commands.md'), '# Commands\n');
    writeFileSync(join(refs, 'auth.md'), '# Auth\n');
  });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('collects supplementary reference files sorted by filename', () => {
    const files = collectSupplementaryFiles(join(tmp, 'core'));
    assert.equal(files.length, 2);
    assert.equal(files[0].path, 'references/auth.md');
    assert.equal(files[1].path, 'references/commands.md');
  });

  it('skillsGet --full attaches supplementary files; without --full it does not', () => {
    const withFull = skillsGet([tmp], ['core'], { full: true });
    assert.equal(withFull.success, true);
    assert.ok(Array.isArray(withFull.data[0].files));
    assert.ok(withFull.data[0].files.some((f) => f.path === 'references/commands.md'));

    const noFull = skillsGet([tmp], ['core'], { full: false });
    assert.equal(noFull.data[0].files, undefined);
  });

  it('skillsGet returns success:false for an unknown skill', () => {
    const res = skillsGet([tmp], ['ghost'], {});
    assert.equal(res.success, false);
    assert.match(res.error, /Skill not found: ghost/);
  });
});

describe('skills-cmd: skillsList / skillsPath hidden filtering', () => {
  let tmp;
  before(() => {
    tmp = join(tmpdir(), `bf-skills-hidden-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    mkSkill(tmp, 'visible', 'Visible skill');
    mkSkill(tmp, 'stub', 'Hidden stub', { hidden: true });
  });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('skillsList omits hidden skills', () => {
    const res = skillsList([tmp]);
    const names = res.data.map((s) => s.name);
    assert.ok(names.includes('visible'));
    assert.ok(!names.includes('stub'));
  });

  it('skillsPath can still resolve a hidden skill by name', () => {
    const res = skillsPath([tmp], 'stub');
    assert.equal(res.success, true);
    assert.ok(res.data.path.endsWith(join('', 'stub')));
  });
});

describe('skills-cmd: real CLI path (browserforce skills ...)', () => {
  it('skills list --json includes the shipped core skill', async () => {
    const { stdout } = await exec('node', ['bin.js', 'skills', 'list', '--json'], { cwd: ROOT });
    const res = JSON.parse(stdout);
    assert.equal(res.success, true);
    assert.ok(res.data.some((s) => s.name === 'core'), 'core skill should be listed');
  });

  it('skills get core --json returns the SKILL.md content', async () => {
    const { stdout } = await exec('node', ['bin.js', 'skills', 'get', 'core', '--json'], { cwd: ROOT });
    const res = JSON.parse(stdout);
    assert.equal(res.success, true);
    assert.equal(res.data[0].name, 'core');
    assert.match(res.data[0].content, /BrowserForce/);
  });

  it('shipped core skill teaches the unified command workflow (not legacy forms)', async () => {
    const { stdout } = await exec('node', ['bin.js', 'skills', 'get', 'core', '--full', '--json'], { cwd: ROOT });
    const res = JSON.parse(stdout);
    const content = res.data[0].content;

    // Session commands + multi-tab named-tab workflow are the primary path.
    assert.match(content, /browserforce open .* --as docs/);
    assert.match(content, /browserforce use t2/);
    assert.match(content, /browserforce snapshot\b/);
    assert.match(content, /--tab docs/);
    assert.match(content, /--replace/);
    assert.match(content, /run "click @e2 --tab docs"|browserforce run "/);
    // Brittle guidance stays out (last-page indexing; --sessiond spelling).
    assert.ok(!/pages\(\)\[.*length - 1\]/.test(content), 'core skill must not teach last-page indexing');
    assert.ok(!content.includes('--sessiond'), 'core skill must not teach the legacy --sessiond spelling');
    // Stable-handle rule is explicit.
    assert.match(content, /never by list position/);

    const commandsRef = res.data[0].files.find((f) => f.path === 'references/commands.md');
    assert.ok(commandsRef, 'commands reference ships with the skill');
    assert.match(commandsRef.content, /browserforce open <url> \[--as name\] \[--replace\]/);
    assert.match(commandsRef.content, /stable `t<N>` handles/);
  });

  it('skills get core --full --json attaches references/commands.md', async () => {
    const { stdout } = await exec('node', ['bin.js', 'skills', 'get', 'core', '--full', '--json'], { cwd: ROOT });
    const res = JSON.parse(stdout);
    assert.ok(res.data[0].files.some((f) => f.path === 'references/commands.md'));
  });

  it('skills path core --json points at the core skill directory', async () => {
    const { stdout } = await exec('node', ['bin.js', 'skills', 'path', 'core', '--json'], { cwd: ROOT });
    const res = JSON.parse(stdout);
    assert.equal(res.success, true);
    assert.ok(res.data.path.includes(join('skill-data', 'core')));
  });

  it('skills get nonexistent --json fails with success:false and exit 1', async () => {
    let out;
    let code = 0;
    try {
      out = (await exec('node', ['bin.js', 'skills', 'get', 'nope', '--json'], { cwd: ROOT })).stdout;
    } catch (err) {
      out = err.stdout;
      code = err.code;
    }
    assert.equal(code, 1);
    assert.equal(JSON.parse(out).success, false);
  });
});
