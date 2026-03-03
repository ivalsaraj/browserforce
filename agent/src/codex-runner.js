import { spawn } from 'node:child_process';
import readline from 'node:readline';

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

function toCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function toUsagePayload(source = {}) {
  const inputTokens = toCount(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = toCount(source.cached_input_tokens ?? source.cachedInputTokens);
  const outputTokens = toCount(source.output_tokens ?? source.outputTokens);
  const reasoningOutputTokens = toCount(source.reasoning_output_tokens ?? source.reasoningOutputTokens);
  const explicitTotalTokens = toCount(source.total_tokens ?? source.totalTokens);
  const modelContextWindow = toCount(source.model_context_window ?? source.modelContextWindow);

  const totalTokens = explicitTotalTokens != null
    ? explicitTotalTokens
    : ((inputTokens != null || outputTokens != null) ? (inputTokens || 0) + (outputTokens || 0) : null);

  return {
    modelContextWindow,
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

export function normalizeCodexLine({ runId, sessionId, line }) {
  const parsed = safeParse(line);
  if (!parsed || typeof parsed !== 'object') {
    return envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: String(line || '') } });
  }

  const type = String(parsed.type || '').toLowerCase();

  if (type === 'thread.started') {
    const providerSessionId = String(parsed.thread_id || '').trim();
    if (providerSessionId) {
      return envelope({
        event: 'run.provider_session',
        runId,
        sessionId,
        payload: { provider: 'codex', sessionId: providerSessionId },
      });
    }
  }

  if (type === 'turn.completed' && parsed.usage && typeof parsed.usage === 'object') {
    return envelope({
      event: 'run.usage',
      runId,
      sessionId,
      payload: toUsagePayload(parsed.usage),
    });
  }

  if (type === 'token_count' && parsed.info && typeof parsed.info === 'object') {
    const usage = parsed.info.total_token_usage && typeof parsed.info.total_token_usage === 'object'
      ? parsed.info.total_token_usage
      : {};
    return envelope({
      event: 'run.usage',
      runId,
      sessionId,
      payload: toUsagePayload({
        ...usage,
        model_context_window: parsed.info.model_context_window,
        reasoning_output_tokens: parsed.info.reasoning_output_tokens,
      }),
    });
  }

  if (type === 'delta' || type === 'text_delta') {
    return envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: String(parsed.text || '') } });
  }

  if (type === 'final' || type === 'done' || type === 'text_final') {
    return envelope({ event: 'chat.final', runId, sessionId, payload: { text: String(parsed.text || '') } });
  }

  if (type === 'thread.started' || type === 'turn.started' || type === 'run_started') {
    return envelope({ event: 'run.started', runId, sessionId, payload: parsed });
  }

  if (type === 'item.completed') {
    const itemType = parsed.item?.type || '';
    if (itemType === 'agent_message') {
      return envelope({
        event: 'chat.delta',
        runId,
        sessionId,
        payload: { delta: String(parsed.item?.text || '') },
      });
    }
    if (itemType === 'reasoning') {
      return envelope({ event: 'tool.delta', runId, sessionId, payload: parsed.item || parsed });
    }
  }

  if (type === 'error') {
    return envelope({
      event: 'tool.delta',
      runId,
      sessionId,
      payload: { level: 'warning', message: parsed.message || parsed.error || 'unknown warning' },
    });
  }

  if (type === 'run_error' || type === 'thread.error') {
    return envelope({
      event: 'run.error',
      runId,
      sessionId,
      payload: { error: parsed.error || parsed.message || 'unknown error' },
    });
  }

  if (type === 'run_aborted' || type === 'aborted') {
    return envelope({ event: 'run.aborted', runId, sessionId, payload: parsed });
  }

  if (type === 'tool_start') {
    return envelope({ event: 'tool.started', runId, sessionId, payload: parsed });
  }

  if (type === 'tool_delta') {
    return envelope({ event: 'tool.delta', runId, sessionId, payload: parsed });
  }

  if (type === 'tool_end') {
    return envelope({ event: 'tool.final', runId, sessionId, payload: parsed });
  }

  return envelope({ event: 'run.event', runId, sessionId, payload: parsed });
}

export function buildCodexExecArgs({ prompt, model, args, resumeSessionId } = {}) {
  if (Array.isArray(args) && args.length > 0) return args;
  const resumeId = typeof resumeSessionId === 'string' ? resumeSessionId.trim() : '';
  const resolved = resumeId
    ? ['exec', 'resume', resumeId, '--json']
    : ['exec', '--json'];
  if (typeof model === 'string' && model.trim()) {
    resolved.push('--model', model.trim());
  }
  resolved.push(prompt || '');
  return resolved;
}

export function startCodexRun({
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
} = {}) {
  const cmd = command || process.env.BF_CHATD_CODEX_COMMAND || 'codex';
  const argv = buildCodexExecArgs({ prompt, model, args, resumeSessionId });

  const child = spawn(cmd, argv, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on('line', (line) => {
    try {
      const evt = normalizeCodexLine({ runId, sessionId, line });
      onEvent?.(evt);
    } catch (error) {
      onError?.(error);
    }
  });

  const stderrLines = readline.createInterface({ input: child.stderr });
  stderrLines.on('line', (line) => {
    if (!line) return;
    stderrChunks.push(String(line));
    if (stderrChunks.length > 200) stderrChunks.shift();
    onEvent?.(envelope({
      event: 'tool.delta',
      runId,
      sessionId,
      payload: { stream: 'stderr', text: line },
    }));
  });

  child.on('error', (error) => {
    onError?.(error);
  });

  child.on('close', (code, signal) => {
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
