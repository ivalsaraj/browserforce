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

function braceDelta(text) {
  const source = String(text || '');
  let delta = 0;
  for (const ch of source) {
    if (ch === '{') delta += 1;
    else if (ch === '}') delta -= 1;
  }
  return delta;
}

export function shouldSuppressCodexStderrLine(line, state = {}) {
  const text = String(line || '');
  if (!text.trim()) return false;

  if (!Number.isInteger(state.authJsonDepth) || state.authJsonDepth < 0) {
    state.authJsonDepth = 0;
  }

  if (state.authJsonDepth > 0) {
    state.authJsonDepth += braceDelta(text);
    if (state.authJsonDepth < 0) state.authJsonDepth = 0;
    return true;
  }

  const lower = text.toLowerCase();
  const isAuthRefreshLine = lower.includes('codex_core::auth: failed to refresh token');
  if (!isAuthRefreshLine) return false;

  const startsJsonBlock = lower.includes('401 unauthorized') && text.includes('{');
  if (startsJsonBlock) {
    state.authJsonDepth = Math.max(0, braceDelta(text));
    return true;
  }

  return (
    lower.includes('refresh token was already used')
    || lower.includes('already been used to generate a new access token')
    || lower.includes('refresh_token_reused')
  );
}

export function buildCodexStderrStepPayload({ count, lines } = {}) {
  const normalizedLines = Array.isArray(lines)
    ? lines
      .map((line) => String(line || '').trim())
      .filter(Boolean)
      .slice(-8)
    : [];
  const numericCount = Number.isInteger(count) && count > 0
    ? count
    : normalizedLines.length;
  const suffix = numericCount === 1 ? 'line' : 'lines';
  return {
    stream: 'stderr',
    type: 'stderr',
    message: `Codex stderr (${numericCount} ${suffix})`,
    details: normalizedLines,
  };
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

function toUsagePayload(source = {}) {
  const inputTokens = toCount(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = toCount(source.cached_input_tokens ?? source.cachedInputTokens);
  const outputTokens = toCount(source.output_tokens ?? source.outputTokens);
  const reasoningOutputTokens = toCount(source.reasoning_output_tokens ?? source.reasoningOutputTokens);
  const explicitTotalTokens = toCount(source.total_tokens ?? source.totalTokens);
  const modelContextWindow = toPositiveCount(source.model_context_window ?? source.modelContextWindow);

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

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function safeParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeToolIdentity(payload = {}, fallbackCallId = '') {
  const callId = firstString([
    payload.callId,
    payload.call_id,
    payload.toolCallId,
    payload.tool_call_id,
    payload.id,
    fallbackCallId,
  ]);
  const stepKey = firstString([
    payload.stepKey,
    payload.step_key,
    callId ? `tool:${callId}` : '',
  ]);
  return {
    ...payload,
    ...(callId ? { callId } : {}),
    ...(stepKey ? { stepKey } : {}),
  };
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

function trimCommandLabel(value) {
  const command = unwrapShellLcCommand(value);
  if (!command) return '';
  return command.length > 160 ? `${command.slice(0, 157)}...` : command;
}

function toolCommandLabel({ name, parsedArgs, rawArgs }) {
  if (parsedArgs && typeof parsedArgs === 'object') {
    const cmd = firstString([
      parsedArgs.cmd,
      parsedArgs.command,
    ]);
    if (cmd) {
      return trimCommandLabel(cmd);
    }
  }

  if (typeof rawArgs === 'string' && rawArgs.trim() && rawArgs.trim().startsWith('{')) {
    const parsed = safeParseJson(rawArgs);
    if (parsed && typeof parsed === 'object') {
      const cmd = firstString([parsed.cmd, parsed.command]);
      if (cmd) return trimCommandLabel(cmd);
    }
  }

  if (name === 'exec_command' && typeof rawArgs === 'string' && rawArgs.trim()) {
    return trimCommandLabel(rawArgs);
  }
  return '';
}

function messageTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = firstString([item.text, item.message, item.delta]);
    if (text) parts.push(text);
  }
  return parts.join('');
}

function isFinalPhase(phase) {
  return String(phase || '').trim().toLowerCase() === 'final_answer';
}

function isCommentaryPhase(phase) {
  const normalized = String(phase || '').trim().toLowerCase();
  return normalized === 'commentary' || normalized === 'analysis' || normalized === 'thinking';
}

function classifyAssistantMessageEvent(phase) {
  if (isFinalPhase(phase)) return 'chat.final';
  if (isCommentaryPhase(phase)) return 'chat.commentary';
  return 'chat.commentary';
}

function normalizeResponseItem({ runId, sessionId, payload }) {
  if (!payload || typeof payload !== 'object') return null;
  const itemType = String(payload.type || '').toLowerCase();

  if (itemType === 'message') {
    const role = String(payload.role || '').toLowerCase();
    if (role !== 'assistant') return null;
    const text = firstString([
      payload.text,
      payload.message,
      messageTextFromContent(payload.content),
    ]);
    if (!text) return null;
    const phase = String(payload.phase || '').toLowerCase();
    const eventType = classifyAssistantMessageEvent(phase);
    if (eventType === 'chat.final') {
      return envelope({ event: 'chat.final', runId, sessionId, payload: { text, phase } });
    }
    if (eventType === 'chat.commentary') {
      return envelope({ event: 'chat.commentary', runId, sessionId, payload: { delta: text, phase } });
    }
    return envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: text, phase } });
  }

  if (itemType === 'function_call' || itemType === 'custom_tool_call') {
    const callId = firstString([payload.call_id, payload.callId, payload.id]);
    const parsedArgs = safeParseJson(payload.arguments);
    const command = toolCommandLabel({
      name: String(payload.name || ''),
      parsedArgs,
      rawArgs: payload.arguments,
    });
    return envelope({
      event: 'tool.started',
      runId,
      sessionId,
      payload: normalizeToolIdentity({
        ...payload,
        ...(command ? { command } : {}),
        ...(parsedArgs && typeof parsedArgs === 'object' ? { args: parsedArgs } : {}),
      }, callId),
    });
  }

  if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
    const callId = firstString([payload.call_id, payload.callId, payload.id]);
    return envelope({
      event: 'tool.final',
      runId,
      sessionId,
      payload: normalizeToolIdentity(payload, callId),
    });
  }

  if (itemType === 'reasoning') {
    const text = firstString([
      payload.text,
      payload.message,
      ...(Array.isArray(payload.summary)
        ? payload.summary
          .map((summaryItem) => summaryItem?.text || summaryItem?.summary_text || '')
          .filter(Boolean)
        : []),
    ]);
    if (!text) return null;
    return envelope({
      event: 'tool.delta',
      runId,
      sessionId,
      payload: { type: 'reasoning', text },
    });
  }

  return envelope({ event: 'run.event', runId, sessionId, payload });
}

function normalizeEventMsg({ runId, sessionId, payload }) {
  if (!payload || typeof payload !== 'object') return null;
  const payloadType = String(payload.type || '').toLowerCase();

  if (payloadType === 'token_count' && payload.info && typeof payload.info === 'object') {
    const usage = payload.info.total_token_usage && typeof payload.info.total_token_usage === 'object'
      ? payload.info.total_token_usage
      : {};
    return envelope({
      event: 'run.usage',
      runId,
      sessionId,
      payload: toUsagePayload({
        ...usage,
        model_context_window: payload.info.model_context_window,
        reasoning_output_tokens: payload.info.reasoning_output_tokens,
      }),
    });
  }

  if (payloadType === 'agent_reasoning') {
    const text = firstString([payload.text, payload.message]);
    if (!text) return null;
    return envelope({
      event: 'tool.delta',
      runId,
      sessionId,
      payload: { type: 'reasoning', text },
    });
  }

  if (payloadType === 'agent_message') {
    const text = firstString([payload.message, payload.text]);
    if (!text) return null;
    const phase = String(payload.phase || '').toLowerCase();
    const eventType = classifyAssistantMessageEvent(phase);
    if (eventType === 'chat.final') {
      return envelope({ event: 'chat.final', runId, sessionId, payload: { text, phase } });
    }
    if (eventType === 'chat.commentary') {
      return envelope({ event: 'chat.commentary', runId, sessionId, payload: { delta: text, phase } });
    }
    return envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: text, phase } });
  }

  if (payloadType === 'task_started') {
    return envelope({ event: 'run.started', runId, sessionId, payload });
  }

  if (payloadType === 'task_complete') {
    const text = firstString([payload.last_agent_message, payload.message, payload.text]);
    if (text) {
      return envelope({ event: 'chat.final', runId, sessionId, payload: { text } });
    }
    return envelope({ event: 'run.event', runId, sessionId, payload });
  }

  return envelope({ event: 'run.event', runId, sessionId, payload });
}

export function normalizeCodexLine({ runId, sessionId, line }) {
  const parsed = safeParse(line);
  if (!parsed || typeof parsed !== 'object') {
    return envelope({ event: 'chat.delta', runId, sessionId, payload: { delta: String(line || '') } });
  }

  const type = String(parsed.type || '').toLowerCase();

  if (type === 'response_item') {
    return normalizeResponseItem({ runId, sessionId, payload: parsed.payload });
  }

  if (type === 'event_msg') {
    return normalizeEventMsg({ runId, sessionId, payload: parsed.payload });
  }

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
      const text = firstString([parsed.item?.text, parsed.item?.message]);
      if (!text) return null;
      const phase = firstString([parsed.item?.phase, parsed.phase]).toLowerCase();
      const eventType = classifyAssistantMessageEvent(phase);
      if (eventType === 'chat.final') {
        return envelope({
          event: 'chat.final',
          runId,
          sessionId,
          payload: { text, phase },
        });
      }
      if (eventType === 'chat.commentary') {
        return envelope({
          event: 'chat.commentary',
          runId,
          sessionId,
          payload: { delta: text, phase },
        });
      }
      return envelope({
        event: 'chat.delta',
        runId,
        sessionId,
        payload: { delta: text, phase },
      });
    }
    if (itemType === 'reasoning') {
      const text = firstString([
        parsed.item?.text,
        parsed.item?.message,
        ...(Array.isArray(parsed.item?.summary)
          ? parsed.item.summary
            .map((summaryItem) => summaryItem?.text || summaryItem?.summary_text || '')
            .filter(Boolean)
          : []),
      ]);
      if (!text) return null;
      return envelope({
        event: 'tool.delta',
        runId,
        sessionId,
        payload: { type: 'reasoning', text },
      });
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

function normalizeReasoningEffort(reasoningEffort) {
  const normalized = String(reasoningEffort || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return null;
}

export function buildCodexExecArgs({ prompt, model, reasoningEffort, args, resumeSessionId } = {}) {
  if (Array.isArray(args) && args.length > 0) return args;
  const resumeId = typeof resumeSessionId === 'string' ? resumeSessionId.trim() : '';
  const resolved = resumeId
    ? ['exec', 'resume', resumeId, '--json']
    : ['exec', '--json'];
  resolved.push('--skip-git-repo-check');
  if (typeof model === 'string' && model.trim()) {
    resolved.push('--model', model.trim());
  }
  const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
  if (normalizedReasoningEffort) {
    resolved.push('-c', `model_reasoning_effort="${normalizedReasoningEffort}"`);
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
  reasoningEffort,
  resumeSessionId,
} = {}) {
  const cmd = command || process.env.BF_CHATD_CODEX_COMMAND || 'codex';
  const argv = buildCodexExecArgs({ prompt, model, reasoningEffort, args, resumeSessionId });

  const child = spawn(cmd, argv, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  const stderrFilterState = {};
  const stderrStepState = {
    started: false,
    count: 0,
    lines: [],
  };

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on('line', (line) => {
    try {
      const evt = normalizeCodexLine({ runId, sessionId, line });
      if (!evt) return;
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
    if (shouldSuppressCodexStderrLine(line, stderrFilterState)) return;

    if (!stderrStepState.started) {
      stderrStepState.started = true;
      onEvent?.(envelope({
        event: 'tool.started',
        runId,
        sessionId,
        payload: {
          stream: 'stderr',
          tool: 'stderr',
          stepKey: 'tool:stderr',
          title: 'Codex stderr',
        },
      }));
    }

    stderrStepState.count += 1;
    stderrStepState.lines.push(String(line));
    if (stderrStepState.lines.length > 32) stderrStepState.lines.shift();
    const payload = buildCodexStderrStepPayload({
      count: stderrStepState.count,
      lines: stderrStepState.lines,
    });

    onEvent?.(envelope({
      event: 'tool.delta',
      runId,
      sessionId,
      payload: {
        ...payload,
        tool: 'stderr',
        stepKey: 'tool:stderr',
      },
    }));
  });

  child.on('error', (error) => {
    onError?.(error);
  });

  child.on('close', (code, signal) => {
    if (stderrStepState.started) {
      const payload = buildCodexStderrStepPayload({
        count: stderrStepState.count,
        lines: stderrStepState.lines,
      });
      onEvent?.(envelope({
        event: 'tool.final',
        runId,
        sessionId,
        payload: {
          ...payload,
          tool: 'stderr',
          stepKey: 'tool:stderr',
          title: payload.message,
        },
      }));
    }
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
