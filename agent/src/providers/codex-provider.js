import { spawn } from 'node:child_process';

import { startCodexRun } from '../codex-runner.js';
import { isValidModelId } from '../session-store.js';

function safeParseJsonLine(line) {
  if (typeof line !== 'string') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function normalizeCodexModelRows(models) {
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

export async function fetchCodexModelCatalog({
  command = process.env.BF_CHATD_CODEX_COMMAND || 'codex',
  timeoutMs = 5000,
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

export function createCodexProvider({
  codexCwd,
  runExecutor,
  modelFetcher,
  codexCommand = process.env.BF_CHATD_CODEX_COMMAND || 'codex',
  modelListTimeoutMs = Number(process.env.BF_CHATD_MODEL_LIST_TIMEOUT_MS || 5000),
} = {}) {
  return {
    id: 'codex',
    label: 'Codex',
    async listModels() {
      if (typeof modelFetcher === 'function') {
        const rows = await modelFetcher();
        return normalizeCodexModelRows(rows);
      }
      const rows = await fetchCodexModelCatalog({ command: codexCommand, timeoutMs: modelListTimeoutMs });
      return normalizeCodexModelRows(rows);
    },
    startRun({ runId, sessionId, message, model, reasoningEffort, resumeSessionId, onEvent, onExit, onError }) {
      if (typeof runExecutor === 'function') {
        return runExecutor({
          provider: 'codex',
          runId,
          sessionId,
          message,
          model,
          reasoningEffort,
          resumeSessionId,
          onEvent,
          onExit,
          onError,
        });
      }

      return startCodexRun({
        runId,
        sessionId,
        prompt: message,
        model,
        reasoningEffort,
        resumeSessionId,
        cwd: codexCwd,
        command: codexCommand,
        onEvent,
        onExit,
        onError,
      });
    },
  };
}
