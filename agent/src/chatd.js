import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickChatdPort } from './port-resolver.js';
import { isAllowedOrigin, verifyBearer } from './auth.js';
import { startCodexRun } from './codex-runner.js';
import {
  appendMessage,
  createSession,
  getSession,
  isValidModelId,
  isValidSessionId,
  listSessions,
  readMessages,
  updateSession,
} from './session-store.js';

const BF_DIR = join(homedir(), '.browserforce');
const CHATD_URL_PATH = join(BF_DIR, 'chatd-url.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const MODEL_LIST_TIMEOUT_MS = 5000;

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

function sanitizeContextText(value, maxLen = 320) {
  if (value == null) return '';
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function normalizeBrowserContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tabId = Number.isInteger(raw.tabId) ? raw.tabId : null;
  const title = sanitizeContextText(raw.title, 180);
  const url = sanitizeContextText(raw.url, 500);
  if (tabId == null && !title && !url) return null;
  return { tabId, title, url };
}

function normalizeUsageNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function normalizeUsagePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const modelContextWindow = normalizeUsageNumber(payload.modelContextWindow);
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

function normalizeStepDetails(details, label = '') {
  const lines = [];
  const pushLine = (value) => {
    const parts = unwrapShellLcCommand(value)
      .split('\n')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const rawPart of parts) {
      const part = rawPart.replace(/^[-*]\s+/, '').trim();
      if (!part) continue;
      if (part === label) continue;
      if (lines.includes(part)) continue;
      lines.push(part.length > 220 ? `${part.slice(0, 217)}...` : part);
      if (lines.length >= 8) return;
    }
  };
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (lines.length >= 8) return;
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
  ], label);
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
  ], label);
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

function buildRunPrompt({ message, browserContext }) {
  if (!browserContext) return message;

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
  lines.push('');
  lines.push(`User request: ${message}`);
  return lines.join('\n');
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
  return ({ runId, sessionId, message, model, resumeSessionId, onEvent, onExit, onError }) => startCodexRun({
    runId,
    sessionId,
    prompt: message,
    model,
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
  const runExecutor = opts.runExecutor || createDefaultRunExecutor({ codexCwd: opts.codexCwd || process.cwd() });
  const modelFetcher = opts.modelFetcher || (() => fetchCodexModelCatalog({
    command: opts.codexCommand || process.env.BF_CHATD_CODEX_COMMAND || 'codex',
    timeoutMs: Number(process.env.BF_CHATD_MODEL_LIST_TIMEOUT_MS || MODEL_LIST_TIMEOUT_MS),
  }));

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

      if (url.pathname === '/v1/sessions' && req.method === 'GET') {
        const sessions = await listSessions({ storageRoot });
        json(res, 200, { sessions });
        return;
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = await listModelPresets({ storageRoot, modelFetcher });
        json(res, 200, { models });
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
          const updated = await updateSession({
            sessionId: decodedSessionId,
            patch: {
              ...(Object.prototype.hasOwnProperty.call(body, 'title') ? { title: body.title } : {}),
              ...(Object.prototype.hasOwnProperty.call(body, 'model') ? { model: body.model } : {}),
            },
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
        const promptMessage = buildRunPrompt({ message, browserContext });

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
          resumeSessionId: isValidSessionId(session?.providerState?.codex?.sessionId || '')
            ? session.providerState.codex.sessionId
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
            resumeSessionId,
            onEvent: (evt) => {
              enqueue(async () => {
                const active = runs.get(runId);
                if (!active || active.status !== 'running') return;

                if (evt.event === 'chat.delta') {
                  const delta = evt.payload?.delta || '';
                  if (delta) {
                    active.assistantBuffer += delta;
                    pushRunTimelineEntry(active, { type: 'text', text: delta });
                    broadcast(buildEvent({ event: 'chat.delta', runId, sessionId, payload: { delta } }));
                  }
                  return;
                }

                if (evt.event === 'chat.commentary') {
                  const delta = evt.payload?.delta || '';
                  if (delta) {
                    pushRunTimelineEntry(active, { type: 'text', text: delta });
                    broadcast(buildEvent({ event: 'chat.commentary', runId, sessionId, payload: { delta } }));
                  }
                  return;
                }

                if (evt.event === 'chat.final') {
                  const text = evt.payload?.text || active.assistantBuffer || '';
                  await finalizeRun(active, text);
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
                  await finalizeRun(active, active.assistantBuffer);
                  return;
                }

                if (code === 0) {
                  await finalizeRun(active, '');
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
            payload: { message, model: session.model || null, browserContext },
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
