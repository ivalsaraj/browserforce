import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('GET /v1/plugins returns plugin catalog', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    pluginFetcher: async () => ([
      { name: 'highlight', installed: true },
    ]),
  });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/plugins`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body.plugins), true);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'requiredPlugins'), false);

    const byName = Object.fromEntries((body.plugins || []).map((row) => [row.name, row]));
    assert.equal(byName.highlight?.installed, true);
    assert.equal(typeof byName.highlight?.required, 'undefined');
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/plugins normalizes helper metadata fields', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    pluginFetcher: async () => ([
      {
        name: 'ufe-qa-plugin',
        installed: true,
        helperPrefix: 'ufe',
        helpers: ['ufe__resolveAppFrame', 'not valid'],
        helperAliases: ['resolveAppFrame', 'snapshotOrFallback'],
      },
    ]),
  });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/plugins`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const plugin = (body.plugins || []).find((row) => row.name === 'ufe-qa-plugin');
    assert.equal(plugin?.helperPrefix, 'ufe');
    assert.deepEqual(plugin?.helpers, ['ufe__resolveAppFrame']);
    assert.deepEqual(plugin?.helperAliases, ['resolveAppFrame', 'snapshotOrFallback']);
    assert.deepEqual(plugin?.helperCalls, ['ufe__resolveAppFrame', 'resolveAppFrame', 'snapshotOrFallback']);
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/plugins reads helper metadata from SKILL frontmatter on disk', async () => {
  const pluginsDir = mkdtempSync(join(tmpdir(), 'bf-chatd-plugins-'));
  const pluginDir = join(pluginsDir, 'ufe-qa-plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'SKILL.md'),
    `---
name: ufe-qa-plugin
description: Plugin frontmatter fixture
helper_prefix: ufe
helpers:
  - ufe__resolveAppFrame
  - invalid helper
helper_aliases:
  - resolveAppFrame
  - snapshotOrFallback
---
# UFE QA
Plugin body`
  );

  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    pluginsDir,
  });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/plugins`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const plugin = (body.plugins || []).find((row) => row.name === 'ufe-qa-plugin');
    assert.ok(plugin);
    assert.equal(plugin?.helperPrefix, 'ufe');
    assert.deepEqual(plugin?.helpers, ['ufe__resolveAppFrame']);
    assert.deepEqual(plugin?.helperAliases, ['resolveAppFrame', 'snapshotOrFallback']);
    assert.deepEqual(plugin?.helperCalls, ['ufe__resolveAppFrame', 'resolveAppFrame', 'snapshotOrFallback']);
  } finally {
    await daemon.stop();
    rmSync(pluginsDir, { recursive: true, force: true });
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

test('DELETE /v1/sessions/:id removes session and returns not found on reload', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Delete me' }),
    }).then((res) => res.json());

    const deleted = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(deleted.status, 204);

    const listRes = await fetch(`${daemon.baseUrl}/v1/sessions`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal((listBody.sessions || []).some((row) => row.sessionId === created.sessionId), false);

    const fetchDeleted = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(fetchDeleted.status, 404);
  } finally {
    await daemon.stop();
  }
});

test('GET /v1/local-file serves local image bytes for authenticated requests', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bf-chatd-local-image-'));
  const imagePath = join(tempDir, 'preview.png');
  writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const response = await fetch(`${daemon.baseUrl}/v1/local-file?path=${encodeURIComponent(imagePath)}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length > 0, true);
  } finally {
    await daemon.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GET /v1/local-file rejects unsupported extensions', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bf-chatd-local-text-'));
  const textPath = join(tempDir, 'note.txt');
  writeFileSync(textPath, 'not-an-image', 'utf8');

  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const response = await fetch(`${daemon.baseUrl}/v1/local-file?path=${encodeURIComponent(textPath)}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(response.status, 415);
  } finally {
    await daemon.stop();
    rmSync(tempDir, { recursive: true, force: true });
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
    defaultReasoningEffort: 'medium',
    runExecutor: ({ runId, sessionId, model, reasoningEffort, onEvent, onExit }) => {
      seenRuns.push({ runId, sessionId, model, reasoningEffort });
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
    assert.equal(seenRuns.at(-1)?.reasoningEffort, 'medium');

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

test('POST /v1/runs uses per-session reasoning effort when configured', async () => {
  const seenRuns = [];
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    defaultReasoningEffort: 'medium',
    runExecutor: ({ runId, sessionId, reasoningEffort, onEvent, onExit }) => {
      seenRuns.push({ runId, sessionId, reasoningEffort });
      setTimeout(() => onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'ok' } }), 10);
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
      body: JSON.stringify({ title: 'Effort' }),
    }).then((res) => res.json());

    const patched = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ reasoningEffort: 'high' }),
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
    assert.equal(seenRuns.at(-1)?.reasoningEffort, 'high');
  } finally {
    await daemon.stop();
  }
});

test('PATCH /v1/sessions rejects invalid reasoning effort values', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Invalid effort' }),
    }).then((res) => res.json());

    const patched = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ reasoningEffort: 'turbo' }),
    });
    assert.equal(patched.status, 400);
  } finally {
    await daemon.stop();
  }
});

test('PATCH /v1/sessions persists selected enabled plugins', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Plugins enforced' }),
    }).then((res) => res.json());

    const patched = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ enabledPlugins: ['highlight'] }),
    });
    assert.equal(patched.status, 200);
    const body = await patched.json();
    assert.deepEqual(body.enabledPlugins, ['highlight']);
  } finally {
    await daemon.stop();
  }
});

test('PATCH /v1/sessions rejects invalid enabled plugin ids', async () => {
  const daemon = await startChatd({ port: 0, writeChatdUrl: false });
  try {
    const created = await fetchWithRetry(`${daemon.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ title: 'Plugins invalid' }),
    }).then((res) => res.json());

    const patched = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ enabledPlugins: ['highlight', 'bad/id'] }),
    });
    assert.equal(patched.status, 400);
    const body = await patched.json();
    assert.equal(body.error, 'enabledPlugins must use safe plugin ids');
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs does not inject plugin context when no plugins are enabled', async () => {
  const seenRuns = [];
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, message, onEvent, onExit }) => {
      seenRuns.push({ runId, sessionId, message });
      setTimeout(() => onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'ok' } }), 10);
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
      body: JSON.stringify({ title: 'No plugins enabled' }),
    }).then((res) => res.json());

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'hello' }),
    });
    assert.equal(runRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const prompt = seenRuns.at(-1)?.message || '';
    assert.doesNotMatch(prompt, /Enabled BrowserForce plugins:/);
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
    assert.equal(Array.isArray(assistant?.timeline), true);
    assert.equal(assistant.timeline.some((item) => item?.type === 'step'), true);
    assert.equal(assistant.timeline.some((item) => item?.type === 'text' && /done/i.test(item?.text || '')), true);
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs persists one keyed reasoning step across chunked commentary deltas', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, onEvent, onExit }) => {
      setTimeout(() => {
        onEvent({
          event: 'chat.commentary',
          runId,
          sessionId,
          payload: { delta: 'I found BUCKS in your Apps nav; next I’m opening it and checking its currency settings flow s' },
        });
      }, 5);
      setTimeout(() => {
        onEvent({
          event: 'chat.commentary',
          runId,
          sessionId,
          payload: { delta: "o I can give exact steps from your store's UI." },
        });
      }, 10);
      setTimeout(() => {
        onEvent({ event: 'tool.started', runId, sessionId, payload: { tool: 'execute', callId: 'call_1', stepKey: 'tool:call_1' } });
      }, 15);
      setTimeout(() => {
        onEvent({ event: 'tool.final', runId, sessionId, payload: { callId: 'call_1', stepKey: 'tool:call_1' } });
      }, 20);
      setTimeout(() => {
        onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'done' } });
      }, 25);
      setTimeout(() => onExit({ code: 0 }), 30);
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
      body: JSON.stringify({ title: 'Commentary chunks' }),
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

    await new Promise((resolve) => setTimeout(resolve, 100));

    const messagesBody = await fetch(
      `${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
    ).then((res) => res.json());
    const assistant = (messagesBody.messages || []).at(-1);
    const timeline = assistant?.timeline || [];
    const reasoningSteps = timeline.filter((item) => item?.type === 'step' && item?.kind === 'reasoning');

    assert.equal(reasoningSteps.length, 1);
    assert.equal(reasoningSteps[0]?.key, 'commentary:1');
    assert.doesNotMatch(reasoningSteps[0]?.label || '', /\band checking\b/i);
    assert.doesNotMatch(reasoningSteps[0]?.label || '', /\bso I can\b/i);
    assert.doesNotMatch(reasoningSteps[0]?.label || '', /\b[a-z]\.\.\.$/i);
    assert.equal(timeline.some((item) => item?.type === 'text' && /give exact steps/i.test(item?.text || '')), true);
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs persists execute tool details for collapsible timeline rows', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, onEvent, onExit }) => {
      setTimeout(() => {
        onEvent({
          event: 'tool.started',
          runId,
          sessionId,
          payload: {
            name: 'execute',
            args: {
              code: "const tree = await snapshot();\nreturn tree;",
            },
          },
        });
      }, 5);
      setTimeout(() => {
        onEvent({ event: 'tool.final', runId, sessionId, payload: { name: 'execute' } });
      }, 10);
      setTimeout(() => {
        onEvent({ event: 'chat.final', runId, sessionId, payload: { text: 'done' } });
      }, 15);
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
      body: JSON.stringify({ title: 'Execute details' }),
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

    await new Promise((resolve) => setTimeout(resolve, 80));

    const messagesBody = await fetch(
      `${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
    ).then((res) => res.json());
    const assistant = (messagesBody.messages || []).at(-1);
    const executeStep = (assistant?.timeline || []).find((item) => item?.type === 'step' && /execute/i.test(item?.label || ''));

    assert.equal(executeStep?.label, 'BrowserForce:execute');
    assert.equal(Array.isArray(executeStep?.details), true);
    assert.equal(executeStep.details.some((line) => /snapshot/.test(line)), true);
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs abort persists partial assistant output for session reloads', async () => {
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    runExecutor: ({ runId, sessionId, onEvent }) => {
      setTimeout(() => {
        onEvent({ event: 'chat.delta', runId, sessionId, payload: { delta: 'Partial answer' } });
      }, 10);
      setTimeout(() => {
        onEvent({ event: 'tool.started', runId, sessionId, payload: { tool: 'snapshot' } });
      }, 15);
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
      body: JSON.stringify({ title: 'Abort persistence' }),
    }).then((res) => res.json());

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ sessionId: created.sessionId, message: 'start and stop' }),
    });
    assert.equal(runRes.status, 202);
    const runBody = await runRes.json();

    await new Promise((resolve) => setTimeout(resolve, 60));

    const abortRes = await fetch(`${daemon.baseUrl}/v1/runs/${encodeURIComponent(runBody.runId)}/abort`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(abortRes.status, 200);

    const messagesBody = await fetch(
      `${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}/messages`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
    ).then((res) => res.json());
    const assistant = (messagesBody.messages || []).at(-1);

    assert.equal(assistant?.role, 'assistant');
    assert.equal(assistant?.runId, runBody.runId);
    assert.equal(assistant?.text, 'Partial answer');
    assert.equal(Array.isArray(assistant?.timeline), true);
    assert.equal(assistant.timeline.some((item) => item?.type === 'step' && item?.status === 'aborted'), true);
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
    assert.match(prompt, /state the exact error message/i);
    assert.match(prompt, /do not infer page contents from title\/url\/tab metadata/i);
    assert.match(prompt, /User request:\s*summarize this page/i);
  } finally {
    await daemon.stop();
  }
});

test('POST /v1/runs injects AGENTS.md content as system instructions', async () => {
  const codexCwd = mkdtempSync(join(tmpdir(), 'bf-chatd-codex-cwd-'));
  writeFileSync(join(codexCwd, 'AGENTS.md'), '# Agent Rules\nAlways be explicit.', 'utf8');

  const seenRuns = [];
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    codexCwd,
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
      body: JSON.stringify({ title: 'agents-instructions' }),
    }).then((res) => res.json());

    const runRes = await fetch(`${daemon.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        sessionId: created.sessionId,
        message: 'what should we do next?',
      }),
    });
    assert.equal(runRes.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const prompt = seenRuns.at(-1)?.message || '';
    assert.match(prompt, /System instructions from AGENTS\.md/);
    assert.match(prompt, /Always be explicit\./);
    assert.match(prompt, /what should we do next\?/i);
  } finally {
    await daemon.stop();
    rmSync(codexCwd, { recursive: true, force: true });
  }
});

test('POST /v1/runs uses one-line AGENTS reminder on resume runs', async () => {
  const codexCwd = mkdtempSync(join(tmpdir(), 'bf-chatd-codex-cwd-'));
  writeFileSync(join(codexCwd, 'AGENTS.md'), '# Agent Rules\nAlways be explicit.', 'utf8');
  const providerSessionId = '019caa6f-8c63-7c81-a542-3dbcf922d065';

  const seenRuns = [];
  const daemon = await startChatd({
    port: 0,
    writeChatdUrl: false,
    codexCwd,
    runExecutor: ({ runId, sessionId, message, resumeSessionId, onEvent, onExit }) => {
      seenRuns.push({ runId, sessionId, message, resumeSessionId: resumeSessionId || null });
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
      body: JSON.stringify({ title: 'agents-reminder' }),
    }).then((res) => res.json());

    const pluginPatchRes = await fetch(`${daemon.baseUrl}/v1/sessions/${encodeURIComponent(created.sessionId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ enabledPlugins: ['highlight'] }),
    });
    assert.equal(pluginPatchRes.status, 200);

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

    assert.equal(seenRuns.length >= 2, true);
    assert.equal(seenRuns[0].resumeSessionId, null);
    assert.match(seenRuns[0].message || '', /System instructions from AGENTS\.md/);
    assert.match(seenRuns[0].message || '', /Always be explicit\./);
    assert.match(seenRuns[0].message || '', /Enabled BrowserForce plugins:/);
    assert.match(seenRuns[0].message || '', /highlight/);
    assert.match(
      seenRuns[0].message || '',
      /If this request appears to match one of these plugins, call pluginHelp\(name, section\?\) for that plugin before using its helpers\./
    );
    assert.equal(seenRuns[1].resumeSessionId, providerSessionId);
    assert.match(seenRuns[1].message || '', /System reminder: follow the previously established system instructions for this thread\./);
    assert.doesNotMatch(seenRuns[1].message || '', /Always be explicit\./);
    assert.match(seenRuns[1].message || '', /Enabled BrowserForce plugins:/);
    assert.match(seenRuns[1].message || '', /highlight/);
    assert.match(
      seenRuns[1].message || '',
      /If this request appears to match one of these plugins, call pluginHelp\(name, section\?\) for that plugin before using its helpers\./
    );
  } finally {
    await daemon.stop();
    rmSync(codexCwd, { recursive: true, force: true });
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
