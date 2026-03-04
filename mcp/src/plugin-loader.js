import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

export const PLUGINS_DIR = join(homedir(), '.browserforce', 'plugins');

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

const CANONICAL_SKILL_META_KEYS = new Set([
  'name',
  'description',
  'helpers',
  'tools',
  'when_to_use',
]);
const CANONICAL_SKILL_LIST_KEYS = new Set([
  'helpers',
  'tools',
  'when_to_use',
]);

function parseBlockScalarValue(lines, style) {
  if (style === '|') {
    return lines.join('\n').trimEnd();
  }

  // Minimal folded-scalar support for `>`: fold newlines into spaces.
  return lines
    .map((line) => line.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeListItem(value) {
  return stripWrappingQuotes(String(value || '').trim());
}

function parseInlineList(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeListItem).filter(Boolean);
    }
  } catch { /* fall back to scalar parsing */ }
  return null;
}

function normalizeMetaValue(key, value) {
  const normalizedValue = typeof value === 'string' ? value.trim() : value;
  if (!CANONICAL_SKILL_LIST_KEYS.has(key)) {
    return normalizedValue;
  }

  const inline = parseInlineList(normalizedValue);
  if (inline) return inline;
  if (typeof normalizedValue !== 'string') return [];
  if (!normalizedValue) return [];
  if (normalizedValue.includes(',')) {
    return normalizedValue.split(',').map(normalizeListItem).filter(Boolean);
  }
  return [normalizeListItem(normalizedValue)].filter(Boolean);
}

function parseSkillFrontmatter(rawSkill = '') {
  const skillText = typeof rawSkill === 'string' ? rawSkill : '';

  try {
    if (!skillText.startsWith('---')) {
      return { meta: {}, body: skillText };
    }

    const match = skillText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/);
    if (!match) {
      return { meta: {}, body: skillText };
    }

    const [, rawMeta, rawBody] = match;
    const meta = {};
    const lines = rawMeta.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const keyMatch = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
      if (!keyMatch) continue;

      const key = keyMatch[1].trim().toLowerCase();
      const rawValue = keyMatch[2].trim();

      if (rawValue === '|' || rawValue === '>') {
        const blockLines = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const blockLine = lines[j];
          if (blockLine.trim() === '') {
            blockLines.push('');
            continue;
          }
          if (!/^\s+/.test(blockLine)) {
            break;
          }
          blockLines.push(blockLine.replace(/^\s+/, ''));
        }

        i = j - 1;
        if (!CANONICAL_SKILL_META_KEYS.has(key)) continue;
        meta[key] = normalizeMetaValue(key, parseBlockScalarValue(blockLines, rawValue));
        continue;
      }

      if (rawValue === '' && CANONICAL_SKILL_LIST_KEYS.has(key)) {
        const listItems = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const listLine = lines[j];
          if (!listLine.trim()) continue;
          if (!/^\s+/.test(listLine)) break;
          const listMatch = listLine.match(/^\s*-\s+(.+)$/);
          if (!listMatch) break;
          listItems.push(normalizeListItem(listMatch[1]));
        }
        i = j - 1;
        meta[key] = listItems.filter(Boolean);
        continue;
      }

      if (!CANONICAL_SKILL_META_KEYS.has(key)) continue;
      meta[key] = normalizeMetaValue(key, stripWrappingQuotes(rawValue));
    }

    return { meta, body: rawBody };
  } catch {
    return { meta: {}, body: skillText };
  }
}

function normalizeMarkdownHeading(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/^[\d.)\s-]+/, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSkillSections(skillBody = '') {
  const normalizedBody = typeof skillBody === 'string' ? skillBody.replace(/\r\n/g, '\n') : '';
  const sections = {};
  const headingEntries = [];
  const lines = normalizedBody.split('\n');
  let offset = 0;
  let activeFence = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (!activeFence) {
        activeFence = { char: fence[0], len: fence.length };
      } else if (fence[0] === activeFence.char && fence.length >= activeFence.len) {
        activeFence = null;
      }
    } else if (!activeFence) {
      const headingMatch = line.match(/^\s*##\s+(.+?)\s*$/);
      if (headingMatch) {
        headingEntries.push({
          headingText: String(headingMatch[1] || '').trim(),
          lineStart: offset,
          contentStart: offset + line.length + 1,
        });
      }
    }
    offset += line.length + 1;
  }

  if (headingEntries.length === 0) return sections;

  for (let i = 0; i < headingEntries.length; i++) {
    const { headingText, contentStart } = headingEntries[i];
    const key = normalizeMarkdownHeading(headingText);
    if (!key) continue;
    const contentEnd = i + 1 < headingEntries.length ? headingEntries[i + 1].lineStart : normalizedBody.length;
    const safeContentStart = Math.min(contentStart, normalizedBody.length);
    const sectionBody = normalizedBody.slice(safeContentStart, contentEnd).trim();
    if (sectionBody) {
      sections[key] = sectionBody;
    }
  }

  return sections;
}

/**
 * Scan pluginsDir for subfolders with index.js. Loads each as an ESM module.
 * @param {string} [pluginsDir]
 * @returns {Promise<Array>}
 */
export async function loadPlugins(pluginsDir = PLUGINS_DIR) {
  const plugins = [];

  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Permission or IO error — log but don't crash
      process.stderr.write(`[bf-plugins] Cannot read plugins dir: ${err.message}\n`);
    }
    return plugins; // missing directory is fine — no plugins installed
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsDir, entry.name);
    const indexPath = join(pluginDir, 'index.js');

    let mod;
    try {
      mod = await import(pathToFileURL(indexPath).href);
    } catch (err) {
      process.stderr.write(`[bf-plugins] Failed to load ${entry.name}: ${err.message}\n`);
      continue;
    }

    const plugin = mod.default;
    if (!plugin?.name) {
      process.stderr.write(`[bf-plugins] Skipping ${entry.name}: export missing 'name' field\n`);
      continue;
    }

    let skill = '';
    try {
      skill = await readFile(join(pluginDir, 'SKILL.md'), 'utf8');
    } catch { /* SKILL.md is optional */ }
    const { meta: skillMeta, body: skillBody } = parseSkillFrontmatter(skill);

    plugins.push({
      ...plugin,
      _skill: skill,
      _skillMeta: skillMeta,
      _skillBody: skillBody,
      _dir: pluginDir,
    });
    process.stderr.write(`[bf-plugins] Loaded plugin: ${plugin.name}\n`);
  }

  return plugins;
}

/**
 * Merge helpers from all plugins into a flat object.
 * Last plugin wins on name collision (with a warning).
 */
export function buildPluginHelpers(plugins) {
  const helpers = {};
  for (const plugin of plugins) {
    if (!plugin.helpers) continue;
    for (const [name, fn] of Object.entries(plugin.helpers)) {
      if (helpers[name]) {
        process.stderr.write(`[bf-plugins] Helper name conflict: "${name}" — ${plugin.name} overwrites previous\n`);
      }
      helpers[name] = fn;
    }
  }
  return helpers;
}

/**
 * Build the SKILL.md appendix to append to the execute tool prompt.
 * Includes plugins that provide either non-empty SKILL.md content or parsed
 * frontmatter metadata.
 */
export function buildPluginSkillAppendix(plugins) {
  const lines = [];
  lines.push('\n\n═══ PLUGINS (METADATA-ONLY) ═══');
  lines.push('Use pluginCatalog() for plugin metadata, then pluginHelp(name, section?) for details on demand.');

  let included = 0;
  for (const plugin of plugins) {
    const skillBody = typeof plugin._skillBody === 'string' ? plugin._skillBody : plugin._skill;
    const hasSkill = typeof skillBody === 'string' && skillBody.trim().length > 0;
    const meta = plugin._skillMeta && typeof plugin._skillMeta === 'object' ? plugin._skillMeta : {};
    const hasMeta = Object.keys(meta).length > 0;
    if (!hasSkill && !hasMeta) continue;
    included += 1;

    const helperNames = Object.keys(plugin.helpers || {});
    const description = String(meta.description || '').trim() || 'No description provided';
    lines.push('');
    lines.push(`PLUGIN: ${plugin.name}`);
    lines.push(`description: ${description}`);
    lines.push(`helpers: ${helperNames.length ? helperNames.join(', ') : '(none)'}`);
  }

  if (included === 0) {
    lines.push('No plugin skills currently advertise metadata.');
  }

  return lines.join('\n');
}

export function buildPluginSkillRuntime(plugins) {
  const catalog = [];
  const byName = {};

  for (const plugin of plugins) {
    const normalizedName = String(plugin.name).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(byName, normalizedName)) {
      process.stderr.write(
        `[bf-plugins] Duplicate plugin skill name after normalization: "${plugin.name}" conflicts with "${byName[normalizedName].name}" (key "${normalizedName}"). Keeping first.\n`
      );
      continue;
    }

    const helperNames = Object.keys(plugin.helpers || {});
    const meta = plugin._skillMeta && typeof plugin._skillMeta === 'object' ? plugin._skillMeta : {};
    const skillBody = (typeof plugin._skillBody === 'string' ? plugin._skillBody : plugin._skill || '').trim();
    const description = String(meta.description || '').trim() || '';
    const sections = extractSkillSections(skillBody);
    const sectionNames = Object.keys(sections);

    catalog.push({
      name: plugin.name,
      description: description || 'No description provided',
      helpers: helperNames,
      sections: sectionNames,
    });

    byName[normalizedName] = {
      name: plugin.name,
      description,
      text: skillBody,
      sections,
      helpers: helperNames,
    };
  }

  return { catalog, byName };
}
