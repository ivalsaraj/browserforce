import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { isValidModelId } from '../session-store.js';

function envelope({ event, runId, sessionId, payload }) {
  return {
    event,
    runId,
    sessionId,
    payload: payload || {},
    timestamp: new Date().toISOString(),
  };
}

function safeParse(line) {
  if (typeof line !== 'string') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function toCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function toPositiveCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function messageTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = firstString([item.text, item.message, item.value]);
    if (text) parts.push(text);
  }
  return parts.join('');
}

function toUsagePayload(source = {}) {
  const inputTokens = toCount(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = toCount(
    source.cache_read_input_tokens
    ?? source.cached_input_tokens
    ?? source.cachedInputTokens,
  );
  const outputTokens = toCount(source.output_tokens ?? source.outputTokens);
  const reasoningOutputTokens = toCount(source.reasoning_output_tokens ?? source.reasoningOutputTokens);
  const explicitTotalTokens = toCount(source.total_tokens ?? source.totalTokens);
  const modelContextWindow = toPositiveCount(source.model_context_window ?? source.modelContextWindow);

  const totalTokens = explicitTotalTokens != null
    ? explicitTotalTokens
    : ((inputTokens != null || outputTokens != null) ? (inputTokens || 0) + (outputTokens || 0) : null);

  const payload = {
    modelContextWindow,
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) delete payload[key];
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

function usageFromResultPayload(payload = {}) {
  if (payload.usage && typeof payload.usage === 'object') return toUsagePayload(payload.usage);
  return toUsagePayload(payload);
}

function normalizeAssistantDelta(parsed = {}) {
  const message = parsed.message && typeof parsed.message === 'object' ? parsed.message : {};
  const text = firstString([
    parsed.delta,
    parsed.text,
    message.text,
    message.message,
    messageTextFromContent(message.content),
  ]);
  return text;
}

export function normalizeClaudeLine({ runId, sessionId, line } = {}) {
  const parsed = safeParse(line);
  if (!parsed || typeof parsed !== 'object') {
    const text = String(line || '').trim();
    return text ? [envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: text } })] : [];
  }

  const events = [];
  const type = String(parsed.type || '').trim().toLowerCase();

  if (type === 'system') {
    const providerSessionId = firstString([parsed.session_id, parsed.sessionId]);
    if (providerSessionId) {
      events.push(envelope({
        event: 'run.provider_session',
        runId,
        sessionId,
        payload: { provider: 'claude', sessionId: providerSessionId },
      }));
    }
    return events;
  }

  if (type === 'assistant' || type === 'message') {
    const text = normalizeAssistantDelta(parsed);
    if (text) {
      events.push(envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: text } }));
    }
    return events;
  }

  if (type === 'result') {
    const providerSessionId = firstString([parsed.session_id, parsed.sessionId]);
    if (providerSessionId) {
      events.push(envelope({
        event: 'run.provider_session',
        runId,
        sessionId,
        payload: { provider: 'claude', sessionId: providerSessionId },
      }));
    }

    const isError = parsed.is_error === true
      || String(parsed.subtype || '').toLowerCase() === 'error';
    if (isError) {
      events.push(envelope({
        event: 'run.error',
        runId,
        sessionId,
        payload: {
          error: firstString([parsed.error, parsed.message, parsed.result]) || 'Claude run failed',
        },
      }));
      return events;
    }

    const usage = usageFromResultPayload(parsed);
    if (usage) {
      events.push(envelope({ event: 'run.usage', runId, sessionId, payload: usage }));
    }

    const text = firstString([
      parsed.result,
      parsed.text,
      parsed.output_text,
      messageTextFromContent(parsed.message?.content),
    ]);
    if (text) {
      events.push(envelope({ event: 'chat.final', runId, sessionId, payload: { text } }));
    }
    return events;
  }

  if (type === 'error') {
    events.push(envelope({
      event: 'run.error',
      runId,
      sessionId,
      payload: {
        error: firstString([parsed.error, parsed.message]) || 'Claude run failed',
      },
    }));
    return events;
  }

  events.push(envelope({ event: 'run.event', runId, sessionId, payload: parsed }));
  return events;
}

export function buildClaudeExecArgs({ prompt, model, resumeSessionId, args } = {}) {
  if (Array.isArray(args) && args.length > 0) return args;
  const resolved = ['-p', '--output-format', 'stream-json'];
  const resumeId = typeof resumeSessionId === 'string' ? resumeSessionId.trim() : '';
  if (resumeId) {
    resolved.push('--resume', resumeId);
  }
  if (typeof model === 'string' && model.trim()) {
    resolved.push('--model', model.trim());
  }
  resolved.push(prompt || '');
  return resolved;
}

function missingCommandError(command) {
  return [
    `Claude command not found (${command}).`,
    'Set BF_CHATD_CLAUDE_COMMAND to the Claude CLI binary path and ensure it is installed on PATH.',
  ].join(' ');
}

export function startClaudeRun({
  runId,
  sessionId,
  prompt,
  cwd,
  onEvent,
  onExit,
  onError,
  command,
  args,
  model,
  resumeSessionId,
  spawnImpl = spawn,
} = {}) {
  const cmd = command || process.env.BF_CHATD_CLAUDE_COMMAND || 'claude';
  const argv = buildClaudeExecArgs({ prompt, model, resumeSessionId, args });

  const child = spawnImpl(cmd, argv, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  let closed = false;

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on('line', (line) => {
    try {
      const events = normalizeClaudeLine({ runId, sessionId, line });
      for (const evt of events) onEvent?.(evt);
    } catch (error) {
      onError?.(error);
    }
  });

  const stderrLines = readline.createInterface({ input: child.stderr });
  stderrLines.on('line', (line) => {
    if (!line) return;
    stderrChunks.push(String(line));
    if (stderrChunks.length > 200) stderrChunks.shift();
  });

  child.on('error', (error) => {
    if (error?.code === 'ENOENT') {
      onEvent?.(envelope({
        event: 'run.error',
        runId,
        sessionId,
        payload: { error: missingCommandError(cmd) },
      }));
      if (!closed) {
        closed = true;
        onExit?.({ code: 127, signal: null, stderr: stderrChunks.join('\n') });
      }
      return;
    }
    onError?.(error);
  });

  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true;
    onExit?.({ code, signal, stderr: stderrChunks.join('\n') });
  });

  return {
    pid: child.pid,
    abort() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore kill races
      }
    },
  };
}

function normalizeClaudeModelRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && !row.hidden)
    .map((row) => {
      const value = String(row.id || row.model || '').trim();
      const label = String(row.displayName || row.name || row.id || row.model || '').trim();
      if (!value || !isValidModelId(value)) return null;
      return { value, label: label || value };
    })
    .filter(Boolean);
}

export function createClaudeProvider({
  claudeCwd,
  runExecutor,
  modelFetcher,
  claudeCommand = process.env.BF_CHATD_CLAUDE_COMMAND || 'claude',
} = {}) {
  return {
    id: 'claude',
    label: 'Claude',
    async listModels() {
      if (typeof modelFetcher !== 'function') return [];
      const rows = await modelFetcher();
      return normalizeClaudeModelRows(rows);
    },
    startRun({ runId, sessionId, message, model, resumeSessionId, onEvent, onExit, onError }) {
      if (typeof runExecutor === 'function') {
        return runExecutor({
          provider: 'claude',
          runId,
          sessionId,
          message,
          model,
          resumeSessionId,
          onEvent,
          onExit,
          onError,
        });
      }
      return startClaudeRun({
        runId,
        sessionId,
        prompt: message,
        cwd: claudeCwd,
        model,
        resumeSessionId,
        command: claudeCommand,
        onEvent,
        onExit,
        onError,
      });
    },
  };
}
