import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChatd } from '../../agent/src/chatd.js';

async function fetchWithRetry(url, init, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

test('GET /health returns daemon metadata', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const res = await fetch(`${daemon.baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.port === 'number');
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/models returns Codex live model list from model fetcher', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    modelFetcher: async () => ([
      { model: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', isDefault: true, hidden: false },
      { model: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', isDefault: false, hidden: false },
    ]),
  });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.models[0], { value: null, label: 'Default' });
    assert.deepEqual(body.models[1], { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' });
    assert.deepEqual(body.models[2], { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' });
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/models falls back to configured model when model fetcher fails', async () => {
  const previous = process.env.BF_CHATD_DEFAULT_MODEL;
  process.env.BF_CHATD_DEFAULT_MODEL = 'gpt-5.3-codex';
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    modelFetcher: async () => {
      throw new Error('model list unavailable');
    },
  });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.models.some((row) => row.value === 'gpt-5.3-codex'), true);
  } finally {
    await daemon.stop();
    if (previous == null) delete process.env.BF_CHATD_DEFAULT_MODEL;
    else process.env.BF_CHATD_DEFAULT_MODEL = previous;
  }
});

test('POST /v1/runs requires explicit sessionId', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/sessions/:id/messages rejects malformed encoded id', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/sessions/%E0/messages`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 400);
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs rejects unsafe sessionId', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: '../escape', message: 'hello' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await daemon.stop();
  }
});

test('stop removes chatd-url metadata file when enabled', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bf-chatd-url-'));
  const urlPath = join(tempDir, 'chatd-url.json');
  const daemon = await startChatd({ port: 0, writeChatdUrl: true, chatdUrlPath: urlPath });
  assert.equal(existsSync(urlPath), true);
  await daemon.stop();
  assert.equal(existsSync(urlPath), false);
  rmSync(tempDir, { recursive: true, force: true });
});

test('daemon honors BF_CHATD_URL_PATH when no explicit path option is provided', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bf-chatd-env-url-'));
  const envUrlPath = join(tempDir, 'chatd-env-url.json');
  const previous = process.env.BF_CHATD_URL_PATH;
  process.env.BF_CHATD_URL_PATH = envUrlPath;

  const daemon = await startChatd({ port: 0, writeChatdUrl: true });
  try {
    assert.equal(existsSync(envUrlPath), true);
  } finally {
    await daemon.stop();
    if (previous == null) delete process.env.BF_CHATD_URL_PATH;
    else process.env.BF_CHATD_URL_PATH = previous;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /v1/runs uses injected run executor and persists assistant output', async () => {
  const seenRuns = [];
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, model, onEvent, onExit }) => {
      seenRuns.push({ runId, sessionId, model });
      setTimeout(() => {
        onEvent({ event: 'chat.delta', runId, sessionId, payload: { delta: 'hel' } });
      }, 10);
      setTimeout(() => {
        onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'hello' } });
      }, 20);
      setTimeout(() => onExit({ code: 0 }), 25);
      return { abort() {} };
    },
  });
  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'T' }),
    }).then((res) => res.json());

    const patched = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ model: 'gpt-5' }),
    });
    assert.equal(patched.status, 200);

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'hi' }),
    });
    assert.equal(runRes.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(seenRuns.at(-1)?.model, 'gpt-5');

    const messagesBody = await fetch(
      `${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
    ).then((res) => res.json());
    const messages = messagesBody.messages || [];
    assert.equal(messages.at(-1).text, 'hello');
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs persists run steps so reopened sessions can render them', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, onEvent, onExit }) => {
      setTimeout(() => {
        onEvent({ event: 'tool.started', runId, sessionId, payload: { tool: 'snapshot' } });
      }, 5);
      setTimeout(() => {
        onEvent({
          event: 'tool.delta',
          runId,
          sessionId,
          payload: { type: 'reasoning', text: 'Inspecting active tab' },
        });
      }, 10);
      setTimeout(() => {
        onEvent({ event: 'tool.final', runId, sessionId, payload: { tool: 'snapshot' } });
      }, 15);
      setTimeout(() => {
        onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'done' } });
      }, 20);
      setTimeout(() => onExit({ code: 0 }), 25);
      return { abort() {} };
    },
  });

  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Steps' }),
    }).then((res) => res.json());

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'hi' }),
    });
    assert.equal(runRes.status, 202);
    const runBody = await runRes.json();

    await new Promise((resolve) => setTimeout(resolve, 80));

    const messagesBody = await fetch(
      `${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
    ).then((res) => res.json());
    const assistant = (messagesBody.messages || []).at(-1);

    assert.equal(assistant?.role, 'assistant');
    assert.equal(assistant?.runId, runBody.runId);
    assert.equal(Array.isArray(assistant?.steps), true);
    assert.equal(assistant.steps.length >= 1, true);
    assert.equal(assistant.steps.some((step) => /Inspecting active tab/.test(step?.label || '')), true);
  } finally {
    await daemon.stop();
  }
});

test('runExecutor synchronous failure does not leak abortable run', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'bf-chatd-run-fail-'));
  let attemptedRunId = null;
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    storageRoot,
    runExecutor: ({ runId }) => {
      attemptedRunId = runId;
      throw new Error('runner boot failed');
    },
  });

  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'T' }),
    }).then((res) => res.json());

    const runRes = await fetchWithRetry(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'hi' }),
    });
    assert.equal(runRes.status, 500);
    assert.equal(typeof attemptedRunId, 'string');

    const abortRes = await fetch(`${daemon.baseUrl}/v1/runs/${encodeURIComponent(attemptedRunId)}/abort`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(abortRes.status, 404);
  } finally {
    await daemon.stop();
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('POST /v1/runs includes active tab context in runExecutor prompt', async () => {
  const seenRuns = [];
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, message, onExit }) => {
      seenRuns.push({ runId, sessionId, message });
      setTimeout(() => onExit({ code: 0 }), 5);
      return { abort() {} };
    },
  });
  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'context' }),
    }).then((res) => res.json());

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        sessionId: created.sessionId,
        message: 'summarize this page',
        browserContext: {
          tabId: 42,
          title: 'Pricing',
          url: 'https://example.com/pricing',
        },
      }),
    });
    assert.equal(runRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompt = seenRuns.at(-1)?.message || '';
    assert.match(prompt, /Active tab title: Pricing/);
    assert.match(prompt, /Active tab URL: https:\/\/example\.com\/pricing/);
    assert.match(prompt, /inspect the active page and answer directly/i);
    assert.match(prompt, /do not ask for permission to inspect/i);
    assert.match(prompt, /User request:\s*summarize this page/i);
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs reuses codex provider session id on second turn', async () => {
  const observed = [];
  const providerSessionId = '019caa6f-8c63-7c81-a542-3dbcf922d065';

  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, resumeSessionId, onEvent, onExit }) => {
      observed.push({ runId, sessionId, resumeSessionId: resumeSessionId || null });
      setTimeout(() => {
        onEvent({
          event: 'run.provider_session',
          runId,
          sessionId,
          payload: { provider: 'codex', sessionId: providerSessionId },
        });
      }, 5);
      setTimeout(() => {
        onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'ok' } });
      }, 10);
      setTimeout(() => onExit({ code: 0 }), 15);
      return { abort() {} };
    },
  });

  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Continuity' }),
    }).then((res) => res.json());

    const runOneRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'first' }),
    });
    assert.equal(runOneRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const runTwoRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'second' }),
    });
    assert.equal(runTwoRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(observed.length >= 2, true);
    assert.equal(observed[0].resumeSessionId, null);
    assert.equal(observed[1].resumeSessionId, providerSessionId);
  } finally {
    await daemon.stop();
  }
});

test('stale resume failures retry once as fresh run when failure signature matches', async () => {
  const observed = [];
  const staleProviderSessionId = '019caa6f-8c63-7c81-a542-3dbcf922d065';
  const recoveredProviderSessionId = '019caa6f-8c63-7c81-a542-3dbcf922d999';

  let callCount = 0;
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, resumeSessionId, onEvent, onExit }) => {
      callCount += 1;
      observed.push({ callCount, runId, sessionId, resumeSessionId: resumeSessionId || null });

      if (callCount === 1) {
        setTimeout(() => {
          onEvent({
            event: 'run.provider_session',
            runId,
            sessionId,
            payload: { provider: 'codex', sessionId: staleProviderSessionId },
          });
        }, 5);
        setTimeout(() => onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'seeded' } }), 10);
        setTimeout(() => onExit({ code: 0 }), 15);
        return { abort() {} };
      }

      if (callCount === 2) {
        setTimeout(() => onEvent({ event: 'run.error', runId, sessionId, payload: { error: 'Resume session not found' } }), 5);
        setTimeout(() => onExit({ code: 1, stderr: 'session not found' }), 10);
        return { abort() {} };
      }

      setTimeout(() => {
        onEvent({
          event: 'run.provider_session',
          runId,
          sessionId,
          payload: { provider: 'codex', sessionId: recoveredProviderSessionId },
        });
      }, 5);
      setTimeout(() => onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'recovered' } }), 10);
      setTimeout(() => onExit({ code: 0 }), 15);
      return { abort() {} };
    },
  });

  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Retry' }),
    }).then((res) => res.json());

    const seedRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'seed' }),
    });
    assert.equal(seedRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 70));

    const retryRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'retry' }),
    });
    assert.equal(retryRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(observed.length, 3);
    assert.equal(observed[1].resumeSessionId, staleProviderSessionId);
    assert.equal(observed[2].resumeSessionId, null);

    const sessionRes = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(sessionRes.status, 200);
    const sessionBody = await sessionRes.json();
    assert.equal(sessionBody.providerState?.codex?.sessionId, recoveredProviderSessionId);
  } finally {
    await daemon.stop();
  }
});

test('non-resume failures do not clear codex provider session mapping', async () => {
  const observed = [];
  const providerSessionId = '019caa6f-8c63-7c81-a542-3dbcf922d065';
  let callCount = 0;

  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, resumeSessionId, onEvent, onExit }) => {
      callCount += 1;
      observed.push({ callCount, runId, sessionId, resumeSessionId: resumeSessionId || null });

      if (callCount === 1) {
        setTimeout(() => {
          onEvent({
            event: 'run.provider_session',
            runId,
            sessionId,
            payload: { provider: 'codex', sessionId: providerSessionId },
          });
        }, 5);
        setTimeout(() => onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'seeded' } }), 10);
        setTimeout(() => onExit({ code: 0 }), 15);
        return { abort() {} };
      }

      setTimeout(() => onEvent({ event: 'run.error', runId, sessionId, payload: { error: 'tool crashed' } }), 5);
      setTimeout(() => onExit({ code: 1, stderr: 'tool crashed' }), 10);
      return { abort() {} };
    },
  });

  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Preserve mapping' }),
    }).then((res) => res.json());

    await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'seed' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 70));

    const failed = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'fail' }),
    });
    assert.equal(failed.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(observed.length, 2);
    assert.equal(observed[1].resumeSessionId, providerSessionId);

    const sessionRes = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(sessionRes.status, 200);
    const sessionBody = await sessionRes.json();
    assert.equal(sessionBody.providerState?.codex?.sessionId, providerSessionId);
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/sessions/:id exposes providerState metadata for side-panel hydration', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, onEvent, onExit }) => {
      setTimeout(() => {
        onEvent({
          event: 'run.provider_session',
          runId,
          sessionId,
          payload: { provider: 'codex', sessionId: '019caa6f-8c63-7c81-a542-3dbcf922d065' },
        });
      }, 5);
      setTimeout(() => {
        onEvent({
          event: 'run.usage',
          runId,
          sessionId,
          payload: {
            modelContextWindow: 258400,
            totalTokens: 1120,
            inputTokens: 1000,
            cachedInputTokens: 700,
            outputTokens: 120,
          },
        });
      }, 10);
      setTimeout(() => onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'done' } }), 15);
      setTimeout(() => onExit({ code: 0 }), 20);
      return { abort() {} };
    },
  });

  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Metadata' }),
    }).then((res) => res.json());

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'collect usage' }),
    });
    assert.equal(runRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 90));

    const sessionRes = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(sessionRes.status, 200);
    const sessionBody = await sessionRes.json();
    assert.equal(sessionBody.sessionId, created.sessionId);
    assert.equal(sessionBody.providerState?.codex?.sessionId, '019caa6f-8c63-7c81-a542-3dbcf922d065');
    assert.equal(sessionBody.providerState?.codex?.latestUsage?.modelContextWindow, 258400);
  } finally {
    await daemon.stop();
  }
});
