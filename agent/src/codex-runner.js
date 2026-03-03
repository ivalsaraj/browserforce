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

export function normalizeCodexLine({ runId, sessionId, line }) {
  const parsed = safeParse(line);
  if (!parsed || typeof parsed !== 'object') {
    return envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: String(line || '') } });
  }

  const type = String(parsed.type || '').toLowerCase();

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

export function buildCodexExecArgs({ prompt, model, args } = {}) {
  if (Array.isArray(args) && args.length > 0) return args;
  const resolved = ['exec', '--json'];
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
} = {}) {
  const cmd = command || process.env.BF_CHATD_CODEX_COMMAND || 'codex';
  const argv = buildCodexExecArgs({ prompt, model, args });

  const child = spawn(cmd, argv, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    onExit?.({ code, signal });
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
