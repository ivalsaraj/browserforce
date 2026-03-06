import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickChatdPort } from './port-resolver.js';
import { isAllowedOrigin, verifyBearer } from './auth.js';
import { startCodexRun } from './codex-runner.js';
import {
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  isValidModelId,
  isValidReasoningEffort,
  isValidSessionId,
  listSessions,
  readMessages,
  updateSession,
} from './session-store.js';

const BF_DIR = join(homedir(), '.browserforce');
const BF_PLUGINS_DIR = join(BF_DIR, 'plugins');
const CHATD_URL_PATH = join(BF_DIR, 'chatd-url.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const MODEL_LIST_TIMEOUT_MS = 5000;
const DEFAULT_REASONING_EFFORT = 'medium';
const PLUGIN_ID_RE = /^[a-z0-9-]{1,64}$/;
const PLUGIN_HELPER_NAME_RE = /^[A-Za-z_$][\w$]{0,127}$/;
const PLUGIN_HELPER_PREFIX_RE = /^[a-z][a-z0-9]{1,31}$/;
const PLUGIN_SKILL_META_KEYS = new Set(['name', 'helpers', 'helper_prefix', 'helper_aliases']);
const PLUGIN_SKILL_LIST_KEYS = new Set(['helpers', 'helper_aliases']);
const LOCAL_FILE_MAX_BYTES = 15 * 1024 * 1024;
const LOCAL_IMAGE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};
const LOCAL_IMAGE_CONTENT_TYPE_SET = new Set(Object.values(LOCAL_IMAGE_CONTENT_TYPES));
const LOCAL_IMAGE_EXTENSION_BY_CONTENT_TYPE = Object.entries(LOCAL_IMAGE_CONTENT_TYPES).reduce((acc, [ext, type]) => {
  if (!acc[type]) acc[type] = ext;
  return acc;
}, {});
const SESSION_TITLE_MARKER = '[[BF_SESSION_TITLE]]';
const MAX_SESSION_TITLE_PREFIX_BUFFER = 200;

function parseTopLevelTomlString(raw, key) {
  const lines = String(raw || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;

    const doubleQuoted = line.match(new RegExp(`^${key}\\s*=\\s*\"([^\"]+)\"(?:\\s*#.*)?$`));
    if (doubleQuoted) return doubleQuoted[1].trim();

    const singleQuoted = line.match(new RegExp(`^${key}\\s*=\\s*'([^']+)'(?:\\s*#.*)?$`));
    if (singleQuoted) return singleQuoted[1].trim();
  }
  return null;
}

async function resolveConfiguredModel() {
  const envModel = String(process.env.BF_CHATD_DEFAULT_MODEL || '').trim();
  if (envModel && isValidModelId(envModel)) return envModel;

  try {
    const raw = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
    const model = parseTopLevelTomlString(raw, 'model');
    if (model && isValidModelId(model)) return model;
  } catch {
    // no local codex config is fine
  }
  return null;
}

async function resolveConfiguredReasoningEffort() {
  const envEffort = String(process.env.BF_CHATD_DEFAULT_REASONING_EFFORT || '').trim().toLowerCase();
  if (envEffort && isValidReasoningEffort(envEffort)) return envEffort;

  try {
    const raw = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
    const effort = String(parseTopLevelTomlString(raw, 'model_reasoning_effort') || '').trim().toLowerCase();
    if (effort && isValidReasoningEffort(effort)) return effort;
  } catch {
    // no local codex config is fine
  }
  return DEFAULT_REASONING_EFFORT;
}

function dedupeModelRows(rows) {
  const seen = new Set();
  const out = [{ value: null, label: 'Default' }];
  for (const row of rows) {
    if (!row || typeof row.value !== 'string') continue;
    const value = row.value.trim();
    if (!value || seen.has(value) || !isValidModelId(value)) continue;
    seen.add(value);
    out.push({ value, label: row.label || value });
  }
  return out;
}

function safeParseJsonLine(line) {
  if (typeof line !== 'string') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeModelCatalogRows(models) {
  return (Array.isArray(models) ? models : [])
    .filter((row) => row && typeof row === 'object' && !row.hidden)
    .map((row) => {
      const value = String(row.model || row.id || '').trim();
      const label = String(row.displayName || row.model || row.id || '').trim();
      if (!value || !isValidModelId(value)) return null;
      return { value, label: label || value };
    })
    .filter(Boolean);
}

function stripWrappingQuotes(value) {
  const text = String(value || '');
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function normalizePluginListItem(value) {
  return stripWrappingQuotes(String(value || '').trim());
}

function parseInlinePluginList(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizePluginListItem).filter(Boolean);
    }
  } catch {
    // Fall back to scalar parsing.
  }
  return null;
}

function normalizePluginSkillMetaValue(key, value) {
  const normalizedValue = typeof value === 'string' ? value.trim() : value;
  if (!PLUGIN_SKILL_LIST_KEYS.has(key)) {
    return normalizedValue;
  }

  const inline = parseInlinePluginList(normalizedValue);
  if (inline) return inline;
  if (typeof normalizedValue !== 'string') return [];
  if (!normalizedValue) return [];
  if (normalizedValue.includes(',')) {
    return normalizedValue.split(',').map(normalizePluginListItem).filter(Boolean);
  }
  return [normalizePluginListItem(normalizedValue)].filter(Boolean);
}

function parsePluginSkillFrontmatter(rawSkill = '') {
  const skillText = typeof rawSkill === 'string' ? rawSkill : '';
  if (!skillText.startsWith('---')) return {};

  const match = skillText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/);
  if (!match) return {};

  const rawMeta = match[1];
  const meta = {};
  const lines = rawMeta.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const keyMatch = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
    if (!keyMatch) continue;

    const key = keyMatch[1].trim().toLowerCase();
    const rawValue = keyMatch[2].trim();
    if (!PLUGIN_SKILL_META_KEYS.has(key)) continue;

    if (rawValue === '' && PLUGIN_SKILL_LIST_KEYS.has(key)) {
      const listItems = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const listLine = lines[j];
        if (!listLine.trim()) continue;
        if (!/^\s+/.test(listLine)) break;
        const listMatch = listLine.match(/^\s*-\s+(.+)$/);
        if (!listMatch) break;
        listItems.push(normalizePluginListItem(listMatch[1]));
      }
      i = j - 1;
      meta[key] = listItems.filter(Boolean);
      continue;
    }

    meta[key] = normalizePluginSkillMetaValue(key, stripWrappingQuotes(rawValue));
  }

  return meta;
}

function normalizePluginHelperName(value) {
  const text = String(value || '').trim();
  if (!text || !PLUGIN_HELPER_NAME_RE.test(text)) return '';
  return text;
}

function normalizePluginHelperNames(input) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = [];
  for (const rawValue of source) {
    const helperName = normalizePluginHelperName(rawValue);
    if (!helperName) continue;
    const key = helperName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(helperName);
  }
  return normalized;
}

function normalizePluginHelperPrefix(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || !PLUGIN_HELPER_PREFIX_RE.test(text)) return '';
  return text;
}

async function fetchCodexModelCatalog({
  command = process.env.BF_CHATD_CODEX_COMMAND || 'codex',
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let settled = false;
    let stderrText = '';
    let stdoutBuffer = '';

    const finish = (error, models = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      if (error) reject(error);
      else resolve(models);
    };

    const timer = setTimeout(() => {
      finish(new Error('Timed out while loading Codex models'));
    }, timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrText += String(chunk || '');
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk || '');
      let idx = stdoutBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        idx = stdoutBuffer.indexOf('\n');
        if (!line) continue;

        const msg = safeParseJsonLine(line);
        if (!msg || typeof msg !== 'object') continue;

        if (msg.id === 1 && msg.error) {
          finish(new Error(msg.error?.message || 'Codex initialize failed'));
          return;
        }
        if (msg.id === 1 && msg.result) {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'model/list',
              params: { includeHidden: false, limit: 100 },
            })}\n`);
          } catch {
            finish(new Error('Failed to request Codex model list'));
          }
          continue;
        }

        if (msg.id === 2 && msg.error) {
          finish(new Error(msg.error?.message || 'Codex model/list failed'));
          return;
        }

        if (msg.id === 2 && msg.result) {
          finish(null, msg.result?.data || []);
        }
      }
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('exit', (code) => {
      if (settled) return;
      finish(new Error(`Codex app-server exited before model/list (${code ?? 'unknown'}) ${stderrText}`.trim()));
    });

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'browserforce-chatd', version: '1.0.0' },
          capabilities: { experimentalApi: false },
        },
      })}\n`);
    } catch {
      finish(new Error('Failed to initialize Codex app-server'));
    }
  });
}

async function listModelPresets({ storageRoot, modelFetcher } = {}) {
  let liveRows = [];
  if (typeof modelFetcher === 'function') {
    try {
      const liveModels = await modelFetcher();
      liveRows = normalizeModelCatalogRows(liveModels);
    } catch {
      liveRows = [];
    }
  }

  const configuredModel = await resolveConfiguredModel();
  const sessions = await listSessions({ limit: 200, storageRoot });
  const sessionRows = sessions
    .map((session) => String(session?.model || '').trim())
    .filter(Boolean)
    .map((value) => ({ value, label: value }));

  const configuredRow = configuredModel && !liveRows.some((row) => row.value === configuredModel)
    ? [{ value: configuredModel, label: `${configuredModel} (Configured)` }]
    : [];

  return dedupeModelRows([...liveRows, ...configuredRow, ...sessionRows]);
}

async function listInstalledPlugins({ pluginsDir = BF_PLUGINS_DIR } = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry?.isDirectory?.()) continue;
    const name = normalizePluginId(entry.name);
    if (!name) continue;

    const pluginDir = join(pluginsDir, entry.name);
    const indexPath = join(pluginDir, 'index.js');
    const skillPath = join(pluginDir, 'SKILL.md');

    let meta = {};
    let skillRaw = '';
    try {
      skillRaw = await fs.readFile(skillPath, 'utf8');
      meta = parsePluginSkillFrontmatter(skillRaw);
    } catch {
      meta = {};
    }

    const [indexSource, indexStat, skillStat] = await Promise.all([
      fs.readFile(indexPath, 'utf8').catch(() => null),
      fs.stat(indexPath).catch(() => null),
      fs.stat(skillPath).catch(() => null),
    ]);

    const helpers = normalizePluginHelperNames(meta.helpers);
    const helperAliases = normalizePluginHelperNames(meta.helper_aliases);
    const helperPrefix = normalizePluginHelperPrefix(meta.helper_prefix);
    const updatedAtMs = Math.max(
      indexStat?.mtimeMs || 0,
      skillStat?.mtimeMs || 0,
    ) || null;
    rows.push({
      name,
      installed: true,
      indexLineCount: typeof indexSource === 'string' ? countLines(indexSource) : null,
      skillLineCount: skillRaw ? countLines(skillRaw) : null,
      updatedAtMs,
      ...(helperPrefix ? { helperPrefix } : {}),
      ...(helpers.length > 0 ? { helpers } : {}),
      ...(helperAliases.length > 0 ? { helperAliases } : {}),
    });
  }
  return rows;
}

function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, '\n');
  const withoutTrailingNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTrailingNewline.split('\n').length;
}

function normalizeNullableCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeNullableTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizePluginCatalogRows(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const byName = new Map();

  for (const row of source) {
    if (!row || typeof row !== 'object') continue;
    const name = normalizePluginId(row.name || row.id);
    if (!name) continue;
    const installed = row.installed !== false;
    const helperPrefix = normalizePluginHelperPrefix(row.helperPrefix || row.helper_prefix);
    const helpers = normalizePluginHelperNames(row.helpers);
    const helperAliases = normalizePluginHelperNames(row.helperAliases || row.helper_aliases);
    const helperCalls = normalizePluginHelperNames([
      ...helpers,
      ...helperAliases,
    ]);

    const previous = byName.get(name) || {
      name,
      installed: false,
      skillLineCount: null,
      indexLineCount: null,
      updatedAtMs: null,
      helperPrefix: '',
      helpers: [],
      helperAliases: [],
      helperCalls: [],
    };

    byName.set(name, {
      name,
      installed: previous.installed || installed,
      skillLineCount: previous.skillLineCount ?? normalizeNullableCount(row.skillLineCount),
      indexLineCount: previous.indexLineCount ?? normalizeNullableCount(row.indexLineCount),
      updatedAtMs: previous.updatedAtMs ?? normalizeNullableTimestamp(row.updatedAtMs),
      helperPrefix: previous.helperPrefix || helperPrefix || '',
      helpers: normalizePluginHelperNames([...previous.helpers, ...helpers]),
      helperAliases: normalizePluginHelperNames([...previous.helperAliases, ...helperAliases]),
      helperCalls: normalizePluginHelperNames([...previous.helperCalls, ...helperCalls]),
    });
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function resolveEffectiveReasoningEffort(sessionReasoningEffort, fallbackReasoningEffort = DEFAULT_REASONING_EFFORT) {
  const sessionValue = String(sessionReasoningEffort || '').trim().toLowerCase();
  if (sessionValue && isValidReasoningEffort(sessionValue)) return sessionValue;

  const fallbackValue = String(fallbackReasoningEffort || '').trim().toLowerCase();
  if (fallbackValue && isValidReasoningEffort(fallbackValue)) return fallbackValue;

  return DEFAULT_REASONING_EFFORT;
}

function normalizePluginId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (!PLUGIN_ID_RE.test(normalized)) return null;
  return normalized;
}

function normalizeEnabledPluginsList(input) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = [];
  for (const rawValue of source) {
    const value = normalizePluginId(rawValue);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function hasInvalidEnabledPluginIds(input) {
  if (input == null) return false;
  if (!Array.isArray(input)) return true;
  for (const rawValue of input) {
    const rawText = String(rawValue || '').trim();
    if (!rawText) continue;
    if (!PLUGIN_ID_RE.test(rawText.toLowerCase())) return true;
  }
  return false;
}

function buildPluginPromptContext(enabledPlugins) {
  const normalized = normalizeEnabledPluginsList(enabledPlugins);
  if (!normalized.length) return '';
  const lines = [
    'Enabled BrowserForce plugins:',
    ...normalized.map((pluginName) => `- ${pluginName}`),
    'If this request appears to match one of these plugins, call pluginHelp(name, section?) for that plugin before using its helpers.',
  ];
  return lines.join('\n');
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function safeDecodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeLocalFilePath(value) {
  const path = String(value || '').trim();
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\0')) return null;
  return path;
}

function localImageContentTypeForPath(path) {
  const extension = extname(String(path || '')).toLowerCase();
  return LOCAL_IMAGE_CONTENT_TYPES[extension] || null;
}

function normalizeUploadImageContentType(value) {
  const normalized = String(value || '').trim().toLowerCase().split(';')[0];
  if (!normalized || !LOCAL_IMAGE_CONTENT_TYPE_SET.has(normalized)) return null;
  return normalized;
}

function sanitizeUploadImageStem(filename) {
  const stem = String(filename || 'image')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
  return stem ? stem.slice(0, 64) : 'image';
}

function resolveUploadImageExtension({ filename, contentType }) {
  const extension = extname(String(filename || '')).toLowerCase();
  if (LOCAL_IMAGE_CONTENT_TYPES[extension] === contentType) return extension;
  return LOCAL_IMAGE_EXTENSION_BY_CONTENT_TYPE[contentType] || null;
}

function decodeUploadImageBase64(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || (text.length % 4) === 1) return null;
  const data = Buffer.from(text, 'base64');
  if (data.length === 0) return null;
  return data;
}

function sanitizeContextText(value, maxLen = 320) {
  if (value == null) return '';
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function isDefaultSessionTitle(title) {
  const lowered = String(title || '').trim().toLowerCase();
  return !lowered || lowered === 'new session' || lowered === 'new chat';
}

function normalizePredictedTitle(value) {
  return sanitizeContextText(value, 120);
}

function normalizeBrowserContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tabId = Number.isInteger(raw.tabId) ? raw.tabId : null;
  const title = sanitizeContextText(raw.title, 180);
  const url = sanitizeContextText(raw.url, 500);
  const favIconUrl = sanitizeContextText(raw.favIconUrl, 2000);
  if (tabId == null && !title && !url && !favIconUrl) return null;
  return { tabId, title, url, favIconUrl };
}

function shouldPredictSessionTitle(session) {
  return !!session && isDefaultSessionTitle(session.title) && !normalizePredictedTitle(session.predictedTitle);
}

function buildSessionTitlePromptInstruction() {
  return [
    'Hidden session-title task: Begin your final user-facing answer with exactly one line in this format:',
    `${SESSION_TITLE_MARKER} <short title>`,
    '',
    'Use 3-8 words based only on the user request. After that blank line, continue with the normal answer. Do not mention the hidden title line.',
  ].join('\n');
}

function buildFirstMessageTabPatch(browserContext) {
  if (!browserContext) return null;
  const patch = {};
  if (browserContext.tabId != null) patch.tabId = browserContext.tabId;
  if (browserContext.title) patch.title = browserContext.title;
  if (browserContext.url) patch.url = browserContext.url;
  if (browserContext.favIconUrl) patch.favIconUrl = browserContext.favIconUrl;
  return Object.keys(patch).length > 0 ? patch : null;
}

function consumeSessionTitlePrefix(buffer, { force = false } = {}) {
  const text = String(buffer || '');
  if (!text) return { pending: !force, predictedTitle: '', visibleText: '' };

  const prefixLength = Math.min(text.length, SESSION_TITLE_MARKER.length);
  const prefixCheck = text.slice(0, prefixLength);
  if (!text.startsWith(SESSION_TITLE_MARKER)) {
    if (!force && SESSION_TITLE_MARKER.startsWith(prefixCheck) && text.length < SESSION_TITLE_MARKER.length) {
      return { pending: true, predictedTitle: '', visibleText: '' };
    }
    return { pending: false, predictedTitle: '', visibleText: text };
  }

  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) {
    if (!force && text.length < MAX_SESSION_TITLE_PREFIX_BUFFER) {
      return { pending: true, predictedTitle: '', visibleText: '' };
    }
    return {
      pending: false,
      predictedTitle: '',
      visibleText: text.replace(/^\[\[BF_SESSION_TITLE\]\]\s*/, ''),
    };
  }

  const rawLine = text.slice(0, newlineIndex).replace(/\r$/, '');
  const predictedTitle = normalizePredictedTitle(rawLine.slice(SESSION_TITLE_MARKER.length).trim());
  let visibleText = text.slice(newlineIndex + 1);
  if (visibleText.startsWith('\r\n')) visibleText = visibleText.slice(2);
  else if (visibleText.startsWith('\n')) visibleText = visibleText.slice(1);
  return { pending: false, predictedTitle, visibleText };
}

function sanitizeRunDelta(run, delta) {
  const text = String(delta || '');
  const prediction = run?.sessionTitlePrediction;
  if (!prediction?.active) {
    return { predictedTitle: '', visibleText: text };
  }
  prediction.buffer += text;
  const result = consumeSessionTitlePrefix(prediction.buffer, { force: false });
  if (result.pending) return { predictedTitle: '', visibleText: '' };
  prediction.active = false;
  prediction.buffer = '';
  return result;
}

function sanitizeRunFinalText(run, finalText) {
  const prediction = run?.sessionTitlePrediction;
  const source = String(finalText || '') || `${prediction?.active ? prediction.buffer : ''}${String(run?.assistantBuffer || '')}`;
  const result = consumeSessionTitlePrefix(source, { force: true });
  if (prediction) {
    prediction.active = false;
    prediction.buffer = '';
  }
  return result;
}

function normalizeUsageNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function normalizePositiveUsageNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeUsagePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const modelContextWindow = normalizePositiveUsageNumber(payload.modelContextWindow);
  const totalTokens = normalizeUsageNumber(payload.totalTokens);
  const inputTokens = normalizeUsageNumber(payload.inputTokens);
  const cachedInputTokens = normalizeUsageNumber(payload.cachedInputTokens);
  const outputTokens = normalizeUsageNumber(payload.outputTokens);
  const reasoningOutputTokens = normalizeUsageNumber(payload.reasoningOutputTokens);

  const normalized = {
    modelContextWindow,
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };

  for (const [key, value] of Object.entries(normalized)) {
    if (value == null) delete normalized[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function isResumeSessionInvalidFailure({ code, error, stderr } = {}) {
  if (!Number.isInteger(code) || code === 0) return false;
  const text = `${String(error || '')}\n${String(stderr || '')}`.toLowerCase();
  return (
    /resume|session|thread/.test(text)
    && /not found|unknown|invalid|no such|does not exist/.test(text)
  );
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isBrowserForceExecutePayload(payload = {}) {
  const name = String(firstString([
    payload.name,
    payload.toolName,
    payload.tool,
  ]) || '').trim().toLowerCase();

  if (name === 'browserforce:execute' || name === 'mcp__browserforce__execute') return true;
  if (name !== 'execute') return false;

  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
  if (args && typeof args.code === 'string') return true;
  if (typeof payload.code === 'string') return true;

  const rawArgs = String(firstString([payload.arguments, payload.input]) || '').trim();
  return /"code"\s*:/.test(rawArgs);
}

function isBrowserForceResetPayload(payload = {}) {
  const name = String(firstString([
    payload.name,
    payload.toolName,
    payload.tool,
  ]) || '').trim().toLowerCase();

  if (name === 'browserforce:reset' || name === 'mcp__browserforce__reset') return true;
  if (name !== 'reset') return false;

  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
  if (args && Object.keys(args).length > 0) return false;

  const rawArgs = String(firstString([payload.arguments, payload.input]) || '').trim();
  return !rawArgs || rawArgs === '{}' || rawArgs === 'null';
}

function normalizeToolLabel(label, payload = {}) {
  const raw = String(label || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();

  if (
    isBrowserForceExecutePayload(payload)
    && (normalized === 'execute' || normalized === 'mcp__browserforce__execute' || normalized === 'browserforce:execute')
  ) {
    return 'BrowserForce:execute';
  }

  if (
    isBrowserForceResetPayload(payload)
    && (normalized === 'reset' || normalized === 'mcp__browserforce__reset' || normalized === 'browserforce:reset')
  ) {
    return 'BrowserForce:reset';
  }

  return raw;
}

const SHELL_LC_WRAPPER_RE = /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i;

function unwrapShellLcCommand(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(SHELL_LC_WRAPPER_RE);
  if (!match) return text;
  let command = String(match[1] || '').trim();
  if (!command) return text;
  if (command.length >= 2 && command.startsWith("'") && command.endsWith("'")) {
    command = command.slice(1, -1).replace(/'"'"'/g, "'");
  } else if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) {
    command = command.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return command.trim() || text;
}

function trimStepLabel(label) {
  const text = unwrapShellLcCommand(label);
  if (!text) return '';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function trimStepKey(key) {
  const text = String(key || '').trim();
  if (!text) return '';
  return text.length > 220 ? text.slice(0, 220) : text;
}

function normalizeStepStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return 'running';
  if (normalized === 'completed' || normalized === 'success' || normalized === 'succeeded') return 'done';
  return normalized;
}

function isTerminalStepStatus(status) {
  const normalized = normalizeStepStatus(status);
  return normalized === 'done' || normalized === 'failed' || normalized === 'aborted';
}

function isGenericToolLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  return normalized === 'tool call started' || normalized === 'tool call completed' || normalized === 'working...';
}

function shouldLegacyTerminalCollapseMatch(existing, candidate) {
  if (!existing || existing.key) return false;
  if (isTerminalStepStatus(existing.status)) return false;
  if (String(existing.kind || '') !== String(candidate.kind || '')) return false;
  const wildcardLabel = candidate.kind === 'tool' && isGenericToolLabel(candidate.label);
  if (wildcardLabel) return true;
  return String(existing.label || '') === String(candidate.label || '');
}

function detailsEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function normalizeStepDetails(details, label = '', options = {}) {
  const resolvedOptions = options && typeof options === 'object' ? options : {};
  const maxLines = Number.isFinite(resolvedOptions.maxLines) && resolvedOptions.maxLines > 0
    ? Math.floor(resolvedOptions.maxLines)
    : null;
  const maxLineLength = Number.isFinite(resolvedOptions.maxLineLength) && resolvedOptions.maxLineLength > 3
    ? Math.floor(resolvedOptions.maxLineLength)
    : null;
  const preserveIndentation = resolvedOptions.preserveIndentation === true;
  const normalizedLabel = String(label || '').trim();
  const lines = [];
  const pushLine = (value) => {
    const parts = unwrapShellLcCommand(value)
      .split('\n')
      .map((part) => (preserveIndentation ? part.replace(/\s+$/g, '') : part.trim()));
    for (const rawPart of parts) {
      const part = preserveIndentation ? rawPart : rawPart.replace(/^[-*]\s+/, '').trim();
      const comparablePart = preserveIndentation ? part.trim() : part;
      if (!comparablePart) continue;
      if (normalizedLabel && comparablePart === normalizedLabel) continue;
      if (lines.includes(part)) continue;
      lines.push(maxLineLength && part.length > maxLineLength
        ? `${part.slice(0, maxLineLength - 3)}...`
        : part);
      if (maxLines && lines.length >= maxLines) return;
    }
  };
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (maxLines && lines.length >= maxLines) return;
        visit(item);
      }
      return;
    }
    if (typeof value === 'object') {
      visit(value.text);
      visit(value.message);
      visit(value.output);
      visit(value.command);
      visit(value.cmd);
      visit(value.code);
      visit(value.input);
      visit(value.args);
      visit(value.parameters);
      visit(value.params);
      visit(value.payload);
      visit(value.arguments);
      visit(value.path);
      visit(value.query);
      visit(value.pattern);
      return;
    }
    pushLine(value);
  };
  visit(details);
  return lines;
}

function stripInlineMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^>\s*/gm, '')
    .trim();
}

function clipHeadingAtClauseBoundary(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const clauseMatch = source.match(
    /^(.{24,}?)(?:\s*;\s+|\s*,\s*(?:then|so|because|while|after)\b|\s+(?:and then|and i['’]?ll|and i am|then|so that|so i can|so we can|in order to|while|after that)\b)/i,
  );
  if (!clauseMatch) return source;
  return String(clauseMatch[1] || '').trim();
}

function commentaryHeadingFromDelta(delta) {
  const source = String(delta || '').trim();
  if (!source) return '';
  const firstLine = source
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  if (!firstLine) return '';

  let heading = stripInlineMarkdown(firstLine)
    .replace(/^[\-*•\d.)\s]+/, '')
    .replace(/^\s*(?:i['’]?m|i am|i['’]?ll|i will)\s+/i, '')
    .replace(/^\s*(?:going to|about to|trying to|plan(?:ning)? to|want to)\s+/i, '')
    .replace(/^let me\s+/i, '')
    .replace(/^(?:next|now)\s*,?\s+/i, '')
    .replace(/[.?!:;,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  heading = clipHeadingAtClauseBoundary(heading);
  if (!heading) return '';
  if (/^(browserforce|recovery action|error[:\s])/i.test(heading)) return '';
  if (/^[`'"]?\//.test(heading) || /^[a-z]:\\/i.test(heading)) return '';
  if (heading.length > 72) {
    const clipped = heading.slice(0, 69).trimEnd();
    const wordBoundary = clipped.lastIndexOf(' ');
    const base = wordBoundary >= 56 ? clipped.slice(0, wordBoundary).trimEnd() : clipped;
    heading = `${base}...`;
  }
  return heading.charAt(0).toUpperCase() + heading.slice(1);
}

function normalizeRunStep(step) {
  if (!step || typeof step !== 'object') return null;
  const label = trimStepLabel(step.label);
  if (!label) return null;
  return {
    kind: String(step?.kind || '').trim() || 'reasoning',
    status: normalizeStepStatus(step?.status),
    label,
    ...(trimStepKey(step.key) ? { key: trimStepKey(step.key) } : {}),
    ...(Array.isArray(step.details) && step.details.length > 0 ? { details: step.details } : {}),
  };
}

function pushRunStep(run, step) {
  if (!run) return;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const normalized = normalizeRunStep(step);
  if (!normalized || !normalized.label) return;
  const keyedIndex = normalized.key
    ? (() => {
      for (let idx = steps.length - 1; idx >= 0; idx -= 1) {
        if (steps[idx]?.key === normalized.key) return idx;
      }
      return -1;
    })()
    : -1;
  if (keyedIndex >= 0) {
    const existing = steps[keyedIndex];
    steps[keyedIndex] = {
      ...existing,
      ...normalized,
      label: (isGenericToolLabel(normalized.label) && existing?.label) ? existing.label : normalized.label,
      details: normalized.details && normalized.details.length > 0 ? normalized.details : existing?.details,
    };
    run.steps = steps;
    return;
  }

  if (!normalized.key && isTerminalStepStatus(normalized.status)) {
    let fallbackIndex = -1;
    for (let idx = steps.length - 1; idx >= 0; idx -= 1) {
      const entry = steps[idx];
      if (shouldLegacyTerminalCollapseMatch(entry, normalized)) {
        fallbackIndex = idx;
        break;
      }
    }
    if (fallbackIndex >= 0) {
      const existing = steps[fallbackIndex];
      steps[fallbackIndex] = {
        ...existing,
        ...normalized,
        label: (isGenericToolLabel(normalized.label) && existing?.label) ? existing.label : normalized.label,
        details: normalized.details && normalized.details.length > 0 ? normalized.details : existing?.details,
      };
      run.steps = steps;
      return;
    }
  }

  const last = steps[steps.length - 1];
  if (
    last
    && last.label === normalized.label
    && last.kind === normalized.kind
    && last.status === normalized.status
    && detailsEqual(last.details, normalized.details)
  ) {
    return;
  }
  steps.push(normalized);
  if (steps.length > 100) steps.shift();
  run.steps = steps;
}

function pushRunTimelineEntry(run, entry) {
  if (!run || !entry || typeof entry !== 'object') return;
  const timeline = Array.isArray(run.timeline) ? run.timeline : [];
  if (entry.type === 'text') {
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text) return;
    const last = timeline[timeline.length - 1];
    if (last?.type === 'text') {
      last.text = `${last.text || ''}${text}`;
    } else {
      timeline.push({ type: 'text', text });
    }
  } else if (entry.type === 'step') {
    const normalized = normalizeRunStep(entry);
    if (!normalized) return;
    const next = { type: 'step', ...normalized };
    const keyedIndex = next.key
      ? (() => {
        for (let idx = timeline.length - 1; idx >= 0; idx -= 1) {
          const item = timeline[idx];
          if (item?.type === 'step' && item.key === next.key) return idx;
        }
        return -1;
      })()
      : -1;
    if (keyedIndex >= 0) {
      const existing = timeline[keyedIndex];
      timeline[keyedIndex] = {
        ...existing,
        ...next,
        label: (isGenericToolLabel(next.label) && existing?.label) ? existing.label : next.label,
        details: next.details && next.details.length > 0 ? next.details : existing?.details,
      };
    } else {
      if (!next.key && isTerminalStepStatus(next.status)) {
        let fallbackIndex = -1;
        for (let idx = timeline.length - 1; idx >= 0; idx -= 1) {
          const item = timeline[idx];
          if (item?.type === 'step' && shouldLegacyTerminalCollapseMatch(item, next)) {
            fallbackIndex = idx;
            break;
          }
        }
        if (fallbackIndex >= 0) {
          const existing = timeline[fallbackIndex];
          timeline[fallbackIndex] = {
            ...existing,
            ...next,
            label: (isGenericToolLabel(next.label) && existing?.label) ? existing.label : next.label,
            details: next.details && next.details.length > 0 ? next.details : existing?.details,
          };
          run.timeline = timeline;
          return;
        }
      }
      if (!next.key && String(next.kind || '') === 'reasoning') {
        for (let idx = timeline.length - 1; idx >= 0; idx -= 1) {
          const item = timeline[idx];
          if (!item) continue;
          if (item.type === 'text') continue;
          if (item.type !== 'step') break;
          if (String(item.kind || '') !== 'reasoning') break;
          if (String(item.label || '') !== String(next.label || '')) break;
          timeline[idx] = {
            ...item,
            ...next,
            details: next.details && next.details.length > 0 ? next.details : item.details,
          };
          run.timeline = timeline;
          return;
        }
      }
      const last = timeline[timeline.length - 1];
      if (
        last
        && last.type === 'step'
        && last.label === next.label
        && last.kind === next.kind
        && last.status === next.status
        && detailsEqual(last.details, next.details)
      ) {
        return;
      }
      timeline.push(next);
    }
  } else {
    return;
  }
  if (timeline.length > 200) timeline.shift();
  run.timeline = timeline;
}

function applyRunCommentaryDelta(run, delta) {
  if (!run || !delta) return;
  const timeline = Array.isArray(run.timeline) ? run.timeline : [];
  const hasActiveCommentary = !!run.activeCommentaryStepKey && timeline.at(-1)?.type === 'text';

  if (!hasActiveCommentary) {
    run.commentarySequence = Number.isInteger(run.commentarySequence) ? run.commentarySequence + 1 : 1;
    run.activeCommentaryStepKey = `commentary:${run.commentarySequence}`;
    const heading = commentaryHeadingFromDelta(delta);
    if (heading) {
      const step = {
        kind: 'reasoning',
        status: 'running',
        key: run.activeCommentaryStepKey,
        label: heading,
      };
      pushRunStep(run, step);
      pushRunTimelineEntry(run, { type: 'step', ...step });
    }
    pushRunTimelineEntry(run, { type: 'text', text: delta });
    return;
  }

  pushRunTimelineEntry(run, { type: 'text', text: delta });
  const mergedText = Array.isArray(run.timeline) && run.timeline.at(-1)?.type === 'text'
    ? run.timeline.at(-1)?.text || ''
    : delta;
  const heading = commentaryHeadingFromDelta(mergedText);
  if (!heading) return;
  const step = {
    kind: 'reasoning',
    status: 'running',
    key: run.activeCommentaryStepKey,
    label: heading,
  };
  pushRunStep(run, step);
  pushRunTimelineEntry(run, { type: 'step', ...step });
}

function runTimelineHasText(run) {
  return Array.isArray(run?.timeline) && run.timeline.some((entry) => entry?.type === 'text' && entry.text);
}

function syncFinalTextToRunTimeline(run, finalText) {
  if (!run) return;
  const text = String(finalText || '');
  if (!text) return;
  const assistantBuffer = String(run.assistantBuffer || '');

  if (!runTimelineHasText(run)) {
    pushRunTimelineEntry(run, { type: 'text', text });
    return;
  }
  if (assistantBuffer && text.startsWith(assistantBuffer)) {
    const suffix = text.slice(assistantBuffer.length);
    if (suffix) pushRunTimelineEntry(run, { type: 'text', text: suffix });
    return;
  }
  if (text !== assistantBuffer) {
    pushRunTimelineEntry(run, { type: 'text', text });
  }
}

function stepLabelForToolEvent(evt) {
  const payload = evt?.payload || {};
  const toolLabel = normalizeToolLabel(firstString([
    payload.command,
    payload.title,
    payload.name,
    payload.tool,
    payload.toolName,
  ]), payload);
  if (evt.event === 'tool.started') {
    return toolLabel || 'Tool call started';
  }
  if (evt.event === 'tool.final') {
    return toolLabel || 'Tool call completed';
  }
  if (evt.event === 'tool.delta') {
    if (String(payload.type || '').toLowerCase() === 'reasoning') {
      const heading = commentaryHeadingFromDelta(firstString([
        payload.text,
        payload.message,
        payload.delta,
      ]));
      return heading || 'Reasoning';
    }
    return normalizeToolLabel(firstString([
      payload.text,
      payload.message,
      payload.delta,
      payload.command,
      payload.name,
      payload.tool,
      payload.toolName,
      payload.type === 'reasoning' ? 'Reasoning' : '',
    ]), payload) || 'Working...';
  }
  return '';
}

function stepDetailsForToolEvent(evt, label) {
  const payload = evt?.payload || {};
  if (String(payload.type || '').toLowerCase() === 'reasoning') return [];
  const preserveExecuteScript = isBrowserForceExecutePayload(payload);
  return normalizeStepDetails([
    payload.details,
    payload.text,
    payload.message,
    payload.delta,
    payload.command,
    payload.cmd,
    payload.code,
    payload.arguments,
    payload.path,
    payload.query,
    payload.pattern,
    payload.args,
    payload.paths,
    payload.items,
    payload.item,
  ], label, preserveExecuteScript
    ? { maxLines: null, maxLineLength: null, preserveIndentation: true }
    : undefined);
}

function stepKeyForToolEvent(evt) {
  const payload = evt?.payload || {};
  const key = firstString([
    payload.stepKey,
    payload.step_key,
    payload.callId,
    payload.call_id,
    payload.toolCallId,
    payload.tool_call_id,
    payload.id,
  ]);
  if (!key) return '';
  return key.startsWith('tool:') ? key : `tool:${key}`;
}

function humanizeToken(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[_./-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function stepStatusForRunEvent(evt) {
  const payload = evt?.payload || {};
  const type = String(payload.type || '').toLowerCase();
  if (/error|failed|aborted/.test(type)) return 'failed';
  if (/completed|final|done|finished|succeeded|success|end/.test(type)) return 'done';
  return 'running';
}

function stepKindForRunEvent(evt) {
  const payload = evt?.payload || {};
  const itemType = String(payload?.item?.type || '').toLowerCase();
  const eventType = String(payload?.type || '').toLowerCase();
  if (/reason/.test(itemType) || /reason/.test(eventType)) return 'reasoning';
  return 'tool';
}

function stepLabelForRunEvent(evt) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  const label = firstString([
    payload.title,
    payload.message,
    payload.text,
    payload.status,
    item.summary,
    item.text,
    item.message,
    item.title,
    item.name,
    item.tool,
    item.command,
    item.type ? humanizeToken(item.type) : '',
    payload.type ? humanizeToken(payload.type) : '',
  ]);

  const normalized = normalizeToolLabel(label, {
    ...payload,
    ...item,
    name: firstString([item.name, payload.name]),
    toolName: firstString([item.toolName, payload.toolName]),
    tool: firstString([item.tool, payload.tool]),
    args: item.args || payload.args,
    arguments: firstString([item.arguments, payload.arguments]),
    input: item.input || payload.input,
    code: firstString([item.code, payload.code]),
  });
  return normalized || 'Working...';
}

function stepKeyForRunEvent(evt) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  const key = firstString([
    payload.stepKey,
    payload.step_key,
    item.stepKey,
    item.step_key,
    payload.callId,
    payload.call_id,
    item.callId,
    item.call_id,
    item.id,
    payload.id,
  ]);
  if (!key) return '';
  return key.startsWith('tool:') ? key : `tool:${key}`;
}

function stepDetailsForRunEvent(evt, label) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  const normalizedPayload = {
    ...payload,
    ...item,
    name: firstString([item.name, payload.name]),
    toolName: firstString([item.toolName, payload.toolName]),
    tool: firstString([item.tool, payload.tool]),
    args: item.args || payload.args,
    arguments: firstString([item.arguments, payload.arguments]),
    input: item.input || payload.input,
    code: firstString([item.code, payload.code]),
  };
  const preserveExecuteScript = isBrowserForceExecutePayload(normalizedPayload);
  return normalizeStepDetails([
    payload.details,
    payload.text,
    payload.message,
    payload.delta,
    payload.command,
    payload.path,
    payload.query,
    payload.pattern,
    payload.args,
    payload.paths,
    payload.items,
    payload.item,
    item?.details,
    item?.text,
    item?.message,
    item?.summary,
    item?.command,
    item?.path,
    item?.query,
    item?.pattern,
    item?.args,
    item?.paths,
    item?.input,
    item?.arguments,
    item?.code,
  ], label, preserveExecuteScript
    ? { maxLines: null, maxLineLength: null, preserveIndentation: true }
    : undefined);
}

function trackRunStep(run, evt) {
  if (!run || !evt?.event) return;

  if (evt.event === 'tool.started' || evt.event === 'tool.delta' || evt.event === 'tool.final') {
    const label = stepLabelForToolEvent(evt);
    const details = stepDetailsForToolEvent(evt, label);
    const step = {
      kind: (evt.event === 'tool.delta' && String(evt?.payload?.type || '').toLowerCase() === 'reasoning')
        ? 'reasoning'
        : 'tool',
      status: evt.event === 'tool.final' ? 'done' : 'running',
      label,
      ...(stepKeyForToolEvent(evt) ? { key: stepKeyForToolEvent(evt) } : {}),
      ...(details.length > 0 ? { details } : {}),
    };
    pushRunStep(run, step);
    pushRunTimelineEntry(run, { type: 'step', ...step });
    return;
  }

  if (evt.event === 'run.event') {
    const label = stepLabelForRunEvent(evt);
    const details = stepDetailsForRunEvent(evt, label);
    const step = {
      kind: stepKindForRunEvent(evt),
      status: stepStatusForRunEvent(evt),
      label,
      ...(stepKeyForRunEvent(evt) ? { key: stepKeyForRunEvent(evt) } : {}),
      ...(details.length > 0 ? { details } : {}),
    };
    pushRunStep(run, step);
    pushRunTimelineEntry(run, { type: 'step', ...step });
    return;
  }

  if (evt.event === 'run.error') {
    const step = {
      kind: 'status',
      status: 'failed',
      label: `Failed: ${evt.payload?.error || 'Unknown error'}`,
    };
    pushRunStep(run, step);
    pushRunTimelineEntry(run, { type: 'step', ...step });
    return;
  }

  if (evt.event === 'run.aborted') {
    const step = {
      kind: 'status',
      status: 'aborted',
      label: 'Stopped',
    };
    pushRunStep(run, step);
    pushRunTimelineEntry(run, { type: 'step', ...step });
  }
}

function buildRunPrompt({ message, browserContext, predictSessionTitle = false }) {
  if (!browserContext) {
    if (!predictSessionTitle) return message;
    return [
      buildSessionTitlePromptInstruction(),
      '',
      `User request: ${message}`,
    ].join('\n');
  }

  const lines = [
    'BrowserForce active tab context:',
  ];
  if (browserContext.tabId != null) lines.push(`- Active tab id: ${browserContext.tabId}`);
  if (browserContext.title) lines.push(`- Active tab title: ${browserContext.title}`);
  if (browserContext.url) lines.push(`- Active tab URL: ${browserContext.url}`);
  lines.push('Inspect the active page and answer directly when the user asks about what is on this tab.');
  lines.push('Do not ask for permission to inspect the active page.');
  lines.push('Assume the user is referring to this active tab unless they explicitly say otherwise.');
  lines.push('When the user asks what you can see, asks about this page/tab, or requests a summary of the current page, inspect the active page and answer directly.');
  lines.push('Use BrowserForce browser tools to read the current page content before replying in these cases.');
  lines.push('Do not ask for permission to inspect, and do not say you only have tab metadata.');
  lines.push('If BrowserForce MCP, relay, or browser tool calls fail, state the exact error message and stop.');
  lines.push('Do not infer page contents from title/URL/tab metadata, cached logs, or web search when live inspection fails.');
  lines.push('After reporting the error, provide one concrete recovery action focused on MCP/relay health.');
  lines.push('If the request is still ambiguous after inspecting, ask one focused clarifying question.');
  if (predictSessionTitle) {
    lines.push('');
    lines.push(buildSessionTitlePromptInstruction());
  }
  lines.push('');
  lines.push(`User request: ${message}`);
  return lines.join('\n');
}

async function loadAgentsInstructions(codexCwd) {
  const base = String(codexCwd || '').trim();
  if (!base) return '';
  const path = join(base, 'AGENTS.md');
  try {
    const raw = await fs.readFile(path, 'utf8');
    return String(raw || '').trim();
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function buildPromptWithAgents({
  message,
  browserContext,
  agentsInstructions,
  enabledPlugins = [],
  predictSessionTitle = false,
}) {
  const prompt = buildRunPrompt({ message, browserContext, predictSessionTitle });
  const agents = String(agentsInstructions || '').trim();
  const pluginContext = buildPluginPromptContext(enabledPlugins);
  if (!agents && !pluginContext) return prompt;
  if (!agents) {
    return [
      pluginContext,
      '',
      '---',
      '',
      prompt,
    ].join('\n');
  }
  if (!pluginContext) {
    return [
      'System instructions from AGENTS.md (highest priority):',
      '',
      agents,
      '',
      '---',
      '',
      prompt,
    ].join('\n');
  }
  return [
    'System instructions from AGENTS.md (highest priority):',
    '',
    agents,
    '',
    '---',
    '',
    pluginContext,
    '',
    '---',
    '',
    prompt,
  ].join('\n');
}

function buildPromptWithAgentsReminder({
  message,
  browserContext,
  enabledPlugins = [],
  predictSessionTitle = false,
}) {
  const prompt = buildRunPrompt({ message, browserContext, predictSessionTitle });
  const pluginContext = buildPluginPromptContext(enabledPlugins);
  if (!pluginContext) {
    return [
      'System reminder: follow the previously established system instructions for this thread.',
      '',
      prompt,
    ].join('\n');
  }
  return [
    'System reminder: follow the previously established system instructions for this thread.',
    '',
    pluginContext,
    '',
    '---',
    '',
    prompt,
  ].join('\n');
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function buildEvent({ event, runId, sessionId, payload }) {
  return {
    event,
    runId,
    sessionId,
    payload: payload || {},
    timestamp: nowIso(),
  };
}

async function writeChatdUrlFile({ port, token, writeChatdUrl = true, urlPath = CHATD_URL_PATH }) {
  if (!writeChatdUrl) return;
  await fs.mkdir(dirname(urlPath), { recursive: true });
  await fs.writeFile(urlPath, `${JSON.stringify({ port, token })}\n`, { mode: 0o600 });
}

async function clearChatdUrlFile({ writeChatdUrl = true, urlPath = CHATD_URL_PATH }) {
  if (!writeChatdUrl) return;
  try {
    await fs.unlink(urlPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function createDefaultRunExecutor({ codexCwd } = {}) {
  return ({ runId, sessionId, message, model, reasoningEffort, resumeSessionId, onEvent, onExit, onError }) => startCodexRun({
    runId,
    sessionId,
    prompt: message,
    model,
    reasoningEffort,
    resumeSessionId,
    cwd: codexCwd,
    onEvent,
    onExit,
    onError,
  });
}

export async function startChatd(opts = {}) {
  const writeChatdUrl = opts.writeChatdUrl !== false;
  const ephemeralStorageRoot = (!opts.storageRoot && !writeChatdUrl)
    ? await fs.mkdtemp(join(tmpdir(), 'bf-chatd-'))
    : null;
  const storageRoot = opts.storageRoot || ephemeralStorageRoot;
  const token = opts.token || process.env.BF_CHATD_TOKEN || randomBytes(32).toString('base64url');
  const chatdUrlPath = opts.chatdUrlPath || process.env.BF_CHATD_URL_PATH || CHATD_URL_PATH;
  const envCodexCwd = String(process.env.BF_CHATD_CODEX_CWD || '').trim();
  const codexCwd = opts.codexCwd || envCodexCwd || process.cwd();
  const runExecutor = opts.runExecutor || createDefaultRunExecutor({
    codexCwd,
  });
  const modelFetcher = opts.modelFetcher || (() => fetchCodexModelCatalog({
    command: opts.codexCommand || process.env.BF_CHATD_CODEX_COMMAND || 'codex',
    timeoutMs: Number(process.env.BF_CHATD_MODEL_LIST_TIMEOUT_MS || MODEL_LIST_TIMEOUT_MS),
  }));
  const pluginFetcher = opts.pluginFetcher || (() => listInstalledPlugins({ pluginsDir: opts.pluginsDir || BF_PLUGINS_DIR }));
  const configuredReasoningEffort = resolveEffectiveReasoningEffort(
    opts.defaultReasoningEffort,
    await resolveConfiguredReasoningEffort(),
  );

  let desiredPort = Number.isFinite(opts.port) ? Number(opts.port) : Number(process.env.BF_CHATD_PORT || 0);
  if (!Number.isInteger(desiredPort) || desiredPort < 0) desiredPort = 0;

  if (desiredPort === 0) {
    desiredPort = await pickChatdPort({
      envPort: Number(process.env.BF_CHATD_PORT || 0),
      rangeStart: 19280,
      rangeEnd: 19320,
    }).catch(() => 0);
  }

  const startedAt = Date.now();
  const sseClients = new Set();
  const runs = new Map();

  const broadcast = (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      if (client.sessionId && client.sessionId !== evt.sessionId) continue;
      try {
        client.res.write(line);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  async function persistPredictedTitle(run, predictedTitle) {
    const normalized = normalizePredictedTitle(predictedTitle);
    if (!normalized || !run?.sessionTitlePrediction || run.sessionTitlePrediction.persisted) return;
    run.sessionTitlePrediction.persisted = true;
    try {
      await updateSession({
        sessionId: run.sessionId,
        patch: { predictedTitle: normalized },
        storageRoot,
      });
    } catch {
      run.sessionTitlePrediction.persisted = false;
    }
  }

  async function finalizeRun(run, finalText) {
    if (!run || run.status !== 'running' || run.finalSent) return;
    run.finalSent = true;
    run.status = 'done';
    syncFinalTextToRunTimeline(run, finalText);
    await appendMessage({
      sessionId: run.sessionId,
      role: 'assistant',
      text: finalText,
      runId: run.runId,
      steps: run.steps,
      timeline: run.timeline,
      storageRoot,
    });
    broadcast(buildEvent({ event: 'chat.final', runId: run.runId, sessionId: run.sessionId, payload: { text: finalText } }));
    runs.delete(run.runId);
  }

  function failRun(run, errorMessage) {
    if (!run || run.status !== 'running') return;
    run.status = 'error';
    broadcast(buildEvent({
      event: 'run.error',
      runId: run.runId,
      sessionId: run.sessionId,
      payload: { error: errorMessage || 'Run failed' },
    }));
    runs.delete(run.runId);
  }

  async function persistAbortedRun(run) {
    if (!run) return;
    trackRunStep(run, { event: 'run.aborted', payload: {} });
    const partialText = String(run.assistantBuffer || '');
    syncFinalTextToRunTimeline(run, partialText);
    const hasContent = Boolean(
      partialText
      || (Array.isArray(run.timeline) && run.timeline.length > 0),
    );
    if (!hasContent) return;
    await appendMessage({
      sessionId: run.sessionId,
      role: 'assistant',
      text: partialText,
      runId: run.runId,
      steps: run.steps,
      timeline: run.timeline,
      storageRoot,
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const base = `http://${req.headers.host || '127.0.0.1'}`;
      const url = new URL(req.url || '/', base);

      if (url.pathname === '/health' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          port: server.address()?.port || desiredPort,
          uptimeMs: Date.now() - startedAt,
        });
        return;
      }

      if (url.pathname.startsWith('/v1/')) {
        const origin = req.headers.origin;
        if (!isAllowedOrigin(origin)) {
          json(res, 403, { error: 'Forbidden - invalid origin' });
          return;
        }
        if (!verifyBearer(req, token)) {
          json(res, 401, { error: 'Unauthorized' });
          return;
        }
      }

      if (url.pathname === '/v1/local-file' && req.method === 'GET') {
        const localPath = normalizeLocalFilePath(url.searchParams.get('path'));
        if (!localPath) {
          json(res, 400, { error: 'path is required' });
          return;
        }

        const contentType = localImageContentTypeForPath(localPath);
        if (!contentType) {
          json(res, 415, { error: 'Unsupported file type' });
          return;
        }

        let fileStat;
        try {
          fileStat = await fs.stat(localPath);
        } catch {
          json(res, 404, { error: 'File not found' });
          return;
        }
        if (!fileStat?.isFile?.()) {
          json(res, 404, { error: 'File not found' });
          return;
        }
        if (fileStat.size > LOCAL_FILE_MAX_BYTES) {
          json(res, 413, { error: 'File too large' });
          return;
        }

        const data = await fs.readFile(localPath);
        res.statusCode = 200;
        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-store');
        res.end(data);
        return;
      }

      if (url.pathname === '/v1/uploads/image' && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        const sessionId = String(body?.sessionId || '').trim();
        if (!sessionId || !isValidSessionId(sessionId)) {
          json(res, 400, { error: 'sessionId is invalid' });
          return;
        }
        const session = await getSession({ sessionId, storageRoot });
        if (!session) {
          json(res, 404, { error: 'Session not found' });
          return;
        }

        const contentType = normalizeUploadImageContentType(body?.contentType);
        if (!contentType) {
          json(res, 415, { error: 'Unsupported image content type' });
          return;
        }

        const data = decodeUploadImageBase64(body?.dataBase64);
        if (!data) {
          json(res, 400, { error: 'dataBase64 is required' });
          return;
        }
        if (data.length > LOCAL_FILE_MAX_BYTES) {
          json(res, 413, { error: 'File too large' });
          return;
        }

        const extension = resolveUploadImageExtension({
          filename: body?.filename,
          contentType,
        });
        if (!extension) {
          json(res, 415, { error: 'Unsupported file type' });
          return;
        }

        const stem = sanitizeUploadImageStem(body?.filename);
        const uploadDir = join(storageRoot, 'uploads', sessionId);
        await fs.mkdir(uploadDir, { recursive: true });
        const fileName = `${Date.now()}-${randomBytes(4).toString('hex')}-${stem}${extension}`;
        const localPath = join(uploadDir, fileName);
        await fs.writeFile(localPath, data, { mode: 0o600 });

        json(res, 201, {
          path: localPath,
          bytes: data.length,
          contentType,
        });
        return;
      }

      if (url.pathname === '/v1/sessions' && req.method === 'GET') {
        const sessions = await listSessions({ storageRoot });
        json(res, 200, { sessions });
        return;
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = await listModelPresets({ storageRoot, modelFetcher });
        json(res, 200, { models, defaultReasoningEffort: configuredReasoningEffort });
        return;
      }

      if (url.pathname === '/v1/plugins' && req.method === 'GET') {
        const plugins = normalizePluginCatalogRows(await pluginFetcher());
        json(res, 200, { plugins });
        return;
      }

      if (url.pathname === '/v1/sessions' && req.method === 'POST') {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        try {
          const session = await createSession({
            title: body.title || 'New chat',
            model: body.model ?? null,
            reasoningEffort: body.reasoningEffort ?? null,
            storageRoot,
          });
          json(res, 201, session);
        } catch (error) {
          json(res, 400, { error: error?.message || 'Invalid session body' });
        }
        return;
      }

      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === 'GET') {
        const decodedSessionId = safeDecodeComponent(sessionMatch[1]);
        if (!decodedSessionId || !isValidSessionId(decodedSessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }
        const session = await getSession({ sessionId: decodedSessionId, storageRoot });
        if (!session) {
          json(res, 404, { error: 'Session not found' });
          return;
        }
        json(res, 200, session);
        return;
      }

      if (sessionMatch && req.method === 'PATCH') {
        const decodedSessionId = safeDecodeComponent(sessionMatch[1]);
        if (!decodedSessionId || !isValidSessionId(decodedSessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }

        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        try {
          if (
            Object.prototype.hasOwnProperty.call(body, 'enabledPlugins')
            && hasInvalidEnabledPluginIds(body.enabledPlugins)
          ) {
            json(res, 400, { error: 'enabledPlugins must use safe plugin ids' });
            return;
          }
          const patch = {
            ...(Object.prototype.hasOwnProperty.call(body, 'title') ? { title: body.title } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'model') ? { model: body.model } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'reasoningEffort') ? { reasoningEffort: body.reasoningEffort } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'enabledPlugins')
              ? { enabledPlugins: normalizeEnabledPluginsList(body.enabledPlugins) }
              : {}),
          };
          const updated = await updateSession({
            sessionId: decodedSessionId,
            patch,
            storageRoot,
          });
          if (!updated) {
            json(res, 404, { error: 'Session not found' });
            return;
          }
          json(res, 200, updated);
        } catch (error) {
          json(res, 400, { error: error?.message || 'Invalid session patch' });
        }
        return;
      }

      if (sessionMatch && req.method === 'DELETE') {
        const decodedSessionId = safeDecodeComponent(sessionMatch[1]);
        if (!decodedSessionId || !isValidSessionId(decodedSessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }

        const deleted = await deleteSession({ sessionId: decodedSessionId, storageRoot });
        if (!deleted) {
          json(res, 404, { error: 'Session not found' });
          return;
        }

        res.statusCode = 204;
        res.end();
        return;
      }

      const messagesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && req.method === 'GET') {
        const decodedSessionId = safeDecodeComponent(messagesMatch[1]);
        if (!decodedSessionId || !isValidSessionId(decodedSessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 100);
        const messages = await readMessages({ sessionId: decodedSessionId, limit, storageRoot });
        json(res, 200, { sessionId: decodedSessionId, messages });
        return;
      }

      if (url.pathname === '/v1/events' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || null;
        if (sessionId && !isValidSessionId(sessionId)) {
          json(res, 400, { error: 'Invalid sessionId' });
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');

        const client = {
          res,
          sessionId,
          heartbeat: setInterval(() => {
            try {
              res.write(': ping\n\n');
            } catch {
              // closed socket
            }
          }, 15000),
        };
        sseClients.add(client);

        req.on('close', () => {
          clearInterval(client.heartbeat);
          sseClients.delete(client);
        });
        return;
      }

      if (url.pathname === '/v1/runs' && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        const { sessionId, message } = body || {};
        if (!sessionId || typeof sessionId !== 'string') {
          json(res, 400, { error: 'sessionId is required' });
          return;
        }
        if (!isValidSessionId(sessionId)) {
          json(res, 400, { error: 'sessionId is invalid' });
          return;
        }
        if (!message || typeof message !== 'string') {
          json(res, 400, { error: 'message is required' });
          return;
        }
        const session = await getSession({ sessionId, storageRoot });
        if (!session) {
          json(res, 404, { error: 'Session not found' });
          return;
        }
        const browserContext = normalizeBrowserContext(body?.browserContext);
        const predictSessionTitle = shouldPredictSessionTitle(session);
        const firstMessageTab = !session.firstMessageTab ? buildFirstMessageTabPatch(browserContext) : null;
        if (firstMessageTab) {
          try {
            await updateSession({
              sessionId,
              patch: { firstMessageTab },
              storageRoot,
            });
          } catch {
            // best-effort metadata only
          }
        }
        const enabledPlugins = normalizeEnabledPluginsList(session.enabledPlugins);
        const resumeSessionId = isValidSessionId(session?.providerState?.codex?.sessionId || '')
          ? session.providerState.codex.sessionId
          : null;
        const promptMessage = resumeSessionId
          ? buildPromptWithAgentsReminder({
            message,
            browserContext,
            enabledPlugins,
            predictSessionTitle,
          })
          : buildPromptWithAgents({
            message,
            browserContext,
            agentsInstructions: await loadAgentsInstructions(codexCwd),
            enabledPlugins,
            predictSessionTitle,
          });
        const runReasoningEffort = resolveEffectiveReasoningEffort(
          session.reasoningEffort,
          configuredReasoningEffort,
        );

        const runId = randomBytes(12).toString('base64url');
        const run = {
          runId,
          sessionId,
          status: 'running',
          abort: null,
          assistantBuffer: '',
          steps: [],
          timeline: [],
          finalSent: false,
          queue: Promise.resolve(),
          lastError: null,
          resumeRetryAttempted: false,
          resumeSessionId,
          reasoningEffort: runReasoningEffort,
          activeCommentaryStepKey: '',
          commentarySequence: 0,
          sessionTitlePrediction: predictSessionTitle
            ? { active: true, buffer: '', persisted: false }
            : null,
        };

        const enqueue = (fn) => {
          run.queue = run.queue.then(fn, fn);
        };

        try {
          await appendMessage({ sessionId, role: 'user', text: message, storageRoot });
          runs.set(runId, run);

          const startAttempt = (resumeSessionId) => runExecutor({
            runId,
            sessionId,
            message: promptMessage,
            model: session.model || null,
            reasoningEffort: runReasoningEffort,
            resumeSessionId,
            onEvent: (evt) => {
              enqueue(async () => {
                const active = runs.get(runId);
                if (!active || active.status !== 'running') return;

                if (evt.event === 'chat.delta') {
                  const delta = evt.payload?.delta || '';
                  if (delta) {
                    const sanitized = sanitizeRunDelta(active, delta);
                    await persistPredictedTitle(active, sanitized.predictedTitle);
                    if (!sanitized.visibleText) return;
                    active.activeCommentaryStepKey = '';
                    active.assistantBuffer += sanitized.visibleText;
                    pushRunTimelineEntry(active, { type: 'text', text: sanitized.visibleText });
                    broadcast(buildEvent({ event: 'chat.delta', runId, sessionId, payload: { delta: sanitized.visibleText } }));
                  }
                  return;
                }

                if (evt.event === 'chat.commentary') {
                  const delta = evt.payload?.delta || '';
                  if (delta) {
                    applyRunCommentaryDelta(active, delta);
                    broadcast(buildEvent({ event: 'chat.commentary', runId, sessionId, payload: { delta } }));
                  }
                  return;
                }

                if (evt.event === 'chat.final') {
                  active.activeCommentaryStepKey = '';
                  const sanitized = sanitizeRunFinalText(active, evt.payload?.text || '');
                  await persistPredictedTitle(active, sanitized.predictedTitle);
                  await finalizeRun(active, sanitized.visibleText);
                  return;
                }

                if (evt.event === 'run.provider_session') {
                  const provider = String(evt.payload?.provider || '').trim().toLowerCase();
                  const providerSessionId = String(evt.payload?.sessionId || '').trim();
                  if (provider === 'codex' && isValidSessionId(providerSessionId)) {
                    await updateSession({
                      sessionId,
                      patch: {
                        providerState: { codex: { sessionId: providerSessionId } },
                      },
                      storageRoot,
                    });
                  }
                  broadcast(buildEvent({ event: 'run.provider_session', runId, sessionId, payload: evt.payload }));
                  return;
                }

                if (evt.event === 'run.usage') {
                  const usage = normalizeUsagePayload(evt.payload);
                  if (usage) {
                    await updateSession({
                      sessionId,
                      patch: {
                        providerState: { codex: { latestUsage: usage } },
                      },
                      storageRoot,
                    });
                    broadcast(buildEvent({ event: 'run.usage', runId, sessionId, payload: usage }));
                  }
                  return;
                }

                if (evt.event === 'run.error') {
                  active.activeCommentaryStepKey = '';
                  trackRunStep(active, evt);
                  active.lastError = evt.payload?.error || 'Run failed';
                  if (!active.resumeSessionId || active.resumeRetryAttempted) {
                    failRun(active, active.lastError);
                  }
                  return;
                }

                if (evt.event === 'run.started') {
                  return;
                }

                active.activeCommentaryStepKey = '';
                trackRunStep(active, evt);
                broadcast(buildEvent({ event: evt.event, runId, sessionId, payload: evt.payload }));
              });
            },
            onExit: ({ code, signal, stderr }) => {
              enqueue(async () => {
                const active = runs.get(runId);
                if (!active || active.status !== 'running') return;

                if (signal === 'SIGTERM' || active.status === 'aborted') return;

                if (
                  active.resumeSessionId
                  && !active.resumeRetryAttempted
                  && isResumeSessionInvalidFailure({ code, error: active.lastError, stderr })
                ) {
                  active.resumeRetryAttempted = true;
                  active.resumeSessionId = null;
                  active.lastError = null;
                  try {
                    const retryHandle = startAttempt(null);
                    active.abort = retryHandle?.abort || null;
                  } catch (error) {
                    failRun(active, error?.message || 'Failed to retry codex run');
                  }
                  return;
                }

                if (active.assistantBuffer) {
                  const sanitized = sanitizeRunFinalText(active, active.assistantBuffer);
                  await persistPredictedTitle(active, sanitized.predictedTitle);
                  await finalizeRun(active, sanitized.visibleText);
                  return;
                }

                if (code === 0) {
                  const sanitized = sanitizeRunFinalText(active, '');
                  await persistPredictedTitle(active, sanitized.predictedTitle);
                  await finalizeRun(active, sanitized.visibleText);
                  return;
                }

                failRun(active, active.lastError || `codex exited with code ${code ?? 'unknown'}`);
              });
            },
            onError: (error) => {
              enqueue(() => {
                const active = runs.get(runId);
                failRun(active, error?.message || 'Failed to start codex');
              });
            },
          });

          const handle = startAttempt(run.resumeSessionId);
          run.abort = handle?.abort || null;
          broadcast(buildEvent({
            event: 'run.started',
            runId,
            sessionId,
            payload: {
              message,
              model: session.model || null,
              reasoningEffort: runReasoningEffort,
              browserContext,
            },
          }));
          json(res, 202, { ok: true, runId, sessionId });
        } catch (error) {
          runs.delete(runId);
          json(res, 500, { error: error?.message || 'Failed to start run' });
        }
        return;
      }

      const abortMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/abort$/);
      if (abortMatch && (req.method === 'DELETE' || req.method === 'POST')) {
        const decodedRunId = safeDecodeComponent(abortMatch[1]);
        if (!decodedRunId) {
          json(res, 400, { error: 'Invalid runId' });
          return;
        }

        const run = runs.get(decodedRunId);
        if (!run) {
          json(res, 404, { error: 'Run not found' });
          return;
        }

        run.status = 'aborted';
        await persistAbortedRun(run);
        run.abort?.();
        runs.delete(decodedRunId);
        broadcast(buildEvent({ event: 'run.aborted', runId: decodedRunId, sessionId: run.sessionId, payload: {} }));
        json(res, 200, { ok: true, runId: decodedRunId, aborted: true });
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 500, { error: error?.message || 'Internal server error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(desiredPort, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  await writeChatdUrlFile({ port, token, writeChatdUrl, urlPath: chatdUrlPath });

  const stop = async () => {
    for (const run of runs.values()) {
      run.status = 'aborted';
      run.abort?.();
    }
    runs.clear();

    for (const client of sseClients) {
      clearInterval(client.heartbeat);
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();

    await new Promise((resolve) => server.close(resolve));
    await clearChatdUrlFile({ writeChatdUrl, urlPath: chatdUrlPath });
    if (ephemeralStorageRoot) {
      await fs.rm(ephemeralStorageRoot, { recursive: true, force: true });
    }
  };

  return {
    token,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop,
  };
}

async function main() {
  const daemon = await startChatd({
    port: Number(process.env.BF_CHATD_PORT || 0),
    token: process.env.BF_CHATD_TOKEN,
    writeChatdUrl: true,
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[chatd] ${error.stack || error.message}`);
    process.exit(1);
  });
}

export { CHATD_URL_PATH };
