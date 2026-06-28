// mcp/src/skills-cmd.js — runtime-served skills for the BrowserForce CLI.
//
// Ports agent-browser's cli/src/skills.rs (frontmatter parsing, discovery,
// unicode-safe truncation, supplementary-file collection) to JS. Skill content
// ships in two directories, both searched and both packaged:
//   - skills/      — discovery stubs (picked up by `npx skills add`). The
//                    BrowserForce stub is intentionally NOT hidden (see Task 11
//                    Step 4): OpenCode can filter hidden installed skills out
//                    entirely, which would hide the redirect from the model.
//   - skill-data/  — the runtime skill content served by `skills get` (`core`).
//
// Output mirrors the BrowserForce envelope subset used by agent-browser:
//   { success: true, data }  /  { success: false, error }.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIRS = ['skills', 'skill-data'];

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * @returns {{ name: string, description: string, hidden: boolean } | null}
 */
export function parseFrontmatter(content) {
  const trimmed = String(content ?? '').replace(/^\s+/, '');
  if (!trimmed.startsWith('---')) return null;
  const afterOpening = trimmed.slice(3);
  const end = afterOpening.indexOf('\n---');
  if (end === -1) return null;
  const frontmatter = afterOpening.slice(0, end);

  const lines = frontmatter.split('\n');
  let name = null;
  let description = null;
  let hidden = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('name:')) {
      name = line.slice('name:'.length).trim();
    } else if (line.startsWith('description:')) {
      let desc = line.slice('description:'.length).trim();
      // Consume YAML continuation lines (indented with spaces or a tab).
      while (i + 1 < lines.length && (lines[i + 1].startsWith('  ') || lines[i + 1].startsWith('\t'))) {
        i += 1;
        desc += ` ${lines[i].trim()}`;
      }
      description = desc;
    } else if (line.startsWith('hidden:')) {
      const val = line.slice('hidden:'.length).trim();
      hidden = val === 'true' || val === 'yes';
    }
  }

  if (name === null) return null;
  return { name, description: description ?? '', hidden };
}

/**
 * Unicode-safe truncation: never splits a code point, breaks at the last space
 * inside the budget, and appends an ellipsis.
 */
export function truncateDescription(desc, maxLen) {
  const s = String(desc ?? '');
  if (s.length <= maxLen) return s;
  // Build the longest code-point-aligned prefix that fits the budget.
  let slice = '';
  for (const ch of s) {
    if (slice.length + ch.length > maxLen) break;
    slice += ch;
  }
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace === -1 ? slice.length : lastSpace;
  return `${slice.slice(0, cut)}...`;
}

/** Discover all skills across the given directories, sorted by name. */
export function discoverSkills(dirs) {
  const skills = [];
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      let content;
      try { content = readFileSync(join(skillDir, 'SKILL.md'), 'utf8'); }
      catch { continue; }
      const fm = parseFrontmatter(content);
      if (fm) skills.push({ ...fm, dir: skillDir });
    }
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills;
}

/** Collect supplementary files (references/, templates/) for a skill, sorted. */
export function collectSupplementaryFiles(skillDir) {
  const files = [];
  for (const sub of ['references', 'templates']) {
    const subdir = join(skillDir, sub);
    let entries;
    try { entries = readdirSync(subdir, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const content = readFileSync(join(subdir, entry.name), 'utf8');
        files.push({ path: `${sub}/${entry.name}`, content });
      } catch { /* unreadable file — skip */ }
    }
  }
  return files;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); }
  catch { return false; }
}

/**
 * Locate the skill directories to search. Resolution order:
 *   1. BF_SKILLS_DIR env override (a single directory, used as-is)
 *   2. <package root>/{skills,skill-data} (package root = two levels above this
 *      file at mcp/src/skills-cmd.js)
 */
export function findSkillsDirs({ env = process.env } = {}) {
  const override = env.BF_SKILLS_DIR;
  if (override && isDir(override)) return [override];
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return SKILL_DIRS.map((d) => join(root, d)).filter(isDir);
}

function readSkillContent(skillDir) {
  try { return readFileSync(join(skillDir, 'SKILL.md'), 'utf8'); }
  catch { return ''; }
}

/** `skills list` — visible (non-hidden) skills with name + description. */
export function skillsList(dirs) {
  const skills = discoverSkills(dirs).filter((s) => !s.hidden);
  return { success: true, data: skills.map((s) => ({ name: s.name, description: s.description })) };
}

/** `skills get <name...> [--all] [--full]` — full SKILL.md (+ supplementary). */
export function skillsGet(dirs, names = [], { all = false, full = false } = {}) {
  const allSkills = discoverSkills(dirs);

  let targets;
  if (all) {
    targets = allSkills.filter((s) => !s.hidden);
  } else {
    targets = [];
    for (const name of names) {
      if (typeof name === 'string' && name.startsWith('-')) continue; // ignore stray flags
      const found = allSkills.find((s) => s.name === name);
      if (!found) return { success: false, error: `Skill not found: ${name}` };
      targets.push(found);
    }
  }

  if (targets.length === 0) {
    return { success: false, error: 'No skill name provided. Usage: browserforce skills get <name>' };
  }

  const data = targets.map((s) => {
    const obj = { name: s.name, content: readSkillContent(s.dir) };
    if (full) {
      const files = collectSupplementaryFiles(s.dir);
      if (files.length > 0) obj.files = files;
    }
    return obj;
  });
  return { success: true, data };
}

/** `skills path [name]` — directory of a named skill, or all search roots. */
export function skillsPath(dirs, name) {
  if (name) {
    const found = discoverSkills(dirs).find((s) => s.name === name);
    if (!found) return { success: false, error: `Skill not found: ${name}` };
    return { success: true, data: { name: found.name, path: found.dir } };
  }
  return { success: true, data: { paths: [...dirs] } };
}
