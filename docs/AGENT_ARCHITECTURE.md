# BrowserForce Agent — Internal Architecture Reference

> Comprehensive map of how the agent layer works: session flow, Codex integration, provider abstraction, and extension-side rendering.

## Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Side Panel (Extension)                                           │
│   agent-panel.js        — session UI, sendMessage(), SSE        │
│   agent-panel-state.js  — reducer for events (chat.delta, etc.) │
│   agent-panel-runtime.js — rendering, step icons, timeline      │
└──────────────┬──────────────────────────────────────────────────┘
               │  HTTP (POST /v1/runs, GET /v1/events)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Chatd (agent/src/chatd.js)                                       │
│   - HTTP daemon: sessions, runs, SSE broadcast                   │
│   - runExecutor() → startCodexRun()                              │
│   - modelFetcher() → fetchCodexModelCatalog()                    │
│   - Session CRUD, message append, run lifecycle                  │
└──────────────┬──────────────────────────────────────────────────┘
               │  Subprocess (codex exec --json)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Codex Runner (agent/src/codex-runner.js)                         │
│   - Spawns `codex exec` / `codex exec resume`                   │
│   - Parses JSONL stdout events                                   │
│   - Normalizes events → onEvent() callbacks                      │
└──────────────┬──────────────────────────────────────────────────┘
               │  Codex uses MCP tools via its own config
               ▼
┌─────────────────────────────────────────────────────────────────┐
│ MCP Server (mcp/src/index.js)                                    │
│   - execute + help + reset tools                                 │
│   - Playwright-core CDP client                                   │
│   - Connects to relay for real Chrome access                     │
└──────────────┬──────────────────────────────────────────────────┘
               │  CDP over WebSocket
               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Relay (relay/src/index.js)                                       │
│   - CDP proxy, /chatd-url bootstrap, agent-preferences           │
│   - Shared by both chatd (for /chatd-url) and MCP (for CDP)     │
└─────────────────────────────────────────────────────────────────┘
```

## File Map

| File | Purpose |
|------|---------|
| `agent/src/chatd.js` | HTTP daemon — sessions, runs, SSE, Codex orchestration |
| `agent/src/codex-runner.js` | Spawns `codex exec` / `codex exec resume`, parses JSONL |
| `agent/src/session-store.js` | Sessions, messages, providerState persistence |
| `agent/src/auth.js` | Bearer token / origin validation |
| `agent/src/lockfile.js` | Daemon lock (pid, port, token) for agent start/stop |
| `agent/src/port-resolver.js` | Port allocation (19280-19320) |
| `extension/agent-panel.js` | Side-panel UI: sessions, messages, SSE, sendMessage |
| `extension/agent-panel-state.js` | Reducer for SSE events (chat.delta, run.provider_session, etc.) |
| `extension/agent-panel-runtime.js` | Rendering, step icons, timeline |

## Message Flow (End-to-End)

```
1. User types message in side panel
     ↓
2. agent-panel.js: sendMessage()
     ↓
3. POST /v1/runs { sessionId, message, browserContext }
     ↓
4. chatd.js: getSession() → appendMessage(user) → runExecutor()
     ↓
5. codex-runner.js: spawn(codex, ['exec', '--json', prompt])
     ↓
6. Codex stdout (JSONL) → normalizeCodexLine() → onEvent()
     ↓
7. chatd.js: broadcast() to SSE clients
     ↓
8. Extension: consumeEventStream() → applyEvent() → reduceState()
     ↓
9. UI updates (chat.delta, run.provider_session, run.usage, chat.final)
```

## Codex Integration

### How Codex Is Invoked

Codex runs as a subprocess. The runner builds args and spawns:

```javascript
// Fresh run
['exec', '--json', '--skip-git-repo-check', '--model', model, prompt]

// Resume existing session
['exec', 'resume', resumeSessionId, '--json', '--skip-git-repo-check', prompt]
```

Key parameters:
- `--json` — emit JSONL events on stdout
- `--skip-git-repo-check` — agent CWD is not a git repo
- `--model` — model selection per session
- `-c model_reasoning_effort="..."` — reasoning effort (low/medium/high/xhigh)

### Provider State

Codex session continuity is tracked in `providerState.codex`:

```json
{
  "providerState": {
    "codex": {
      "sessionId": "codex-thread-id-for-resume",
      "latestUsage": {
        "inputTokens": 12345,
        "outputTokens": 678,
        "totalTokens": 13023
      }
    }
  }
}
```

- `sessionId` — passed as `resumeSessionId` on next run for `codex exec resume`
- `latestUsage` — hydrates the context usage chip in the side panel

### Event Normalization

Codex emits JSONL events. The runner normalizes them into a common envelope:

```javascript
{ event, runId, sessionId, payload, timestamp }
```

Event types:
- `chat.delta` — streaming assistant text
- `chat.final` — assistant message complete
- `chat.commentary` — reasoning/commentary output
- `run.provider_session` — Codex session ID for resume
- `run.usage` — token usage telemetry
- `run.event` — tool calls, file edits, etc.
- `run.error` — error during run
- `run.aborted` — run was cancelled

### Run Lifecycle

```javascript
const run = {
  runId,
  sessionId,
  status: 'running',     // → 'completed' | 'error' | 'aborted'
  assistantBuffer: '',    // accumulated assistant text
  steps: [],              // tool calls, reasoning steps
  timeline: [],           // ordered events for UI
  finalSent: false,
  resumeSessionId,
  reasoningEffort,
};
```

Steps are tracked via `trackRunStep(run, evt)` which maps events to step kinds:
- `reasoning` — commentary/thinking output
- `tool` — tool invocations (file reads, shell commands, etc.)

## Session Architecture

### Storage

- `~/.browserforce/agent/sessions/index.json` — session index
- `~/.browserforce/agent/sessions/<sessionId>.jsonl` — per-session message log

### Session Object

```javascript
{
  sessionId,
  title,
  model,
  reasoningEffort,
  providerState: { codex: { sessionId, latestUsage } },
  enabledPlugins, // user-selected plugins merged with agent defaults in API responses
  createdAt,
  updatedAt,
}
```

### Default Agent Plugins

BrowserForce Agent defaults `google-sheets` into each session's effective plugin
list. Session create/list/get/patch responses and run prompts merge this default
with user-selected `enabledPlugins`, so a fresh side-panel chat can use Sheets
helpers without manual plugin selection. The plugin picker keeps the current UI
contract: there is no restored `requiredPlugins` API, required badge, or disabled
plugin row.

When the active tab URL is a Google Sheets document and `google-sheets` is
enabled, run prompts add a sheet-specific routing hint. Summary/read/edit
requests should use BrowserForce `execute`, call `pluginHelp('google-sheets')`,
and prefer `gs__summarizeSheet()` or the relevant `gs__*` helper before Drive,
CSV/export, web search, or other fallback paths.

### Messages

```javascript
{
  role: 'user' | 'assistant',
  text,
  runId,
  steps,      // tool calls within this message
  timeline,   // ordered events
  timestamp,
}
```

## Injectable Abstractions

### runExecutor

The run executor is injectable via `startChatd({ runExecutor })`:

```javascript
function createDefaultRunExecutor({ codexCwd } = {}) {
  return ({ runId, sessionId, message, model, reasoningEffort,
            resumeSessionId, onEvent, onExit, onError }) =>
    startCodexRun({ ... });
}
```

Tests swap this for mock executors. This is the primary extension point for alternative providers.

### modelFetcher

Model catalog is injectable via `startChatd({ modelFetcher })`:

```javascript
async function fetchCodexModelCatalog({ command, timeoutMs }) {
  // Spawns codex app-server --listen stdio://
  // JSON-RPC: initialize → model/list
}
```

### What's Missing for Multi-Provider

Currently there is no generic provider abstraction:
- No shared `Provider` or `RunExecutor` interface
- No registry for multiple providers
- Model selection is per-session and passed into Codex
- `providerState` is structured for Codex only (`providerState.codex`)
- Event normalization is Codex-specific

## Reasoning (Current State)

"Reasoning" is a **step kind** for commentary/thinking output, not a separate planning layer:

```javascript
function classifyAssistantMessageEvent(phase) {
  if (isFinalPhase(phase)) return 'chat.final';
  if (isCommentaryPhase(phase)) return 'chat.commentary';
  return 'chat.commentary';
}
```

- `reasoningEffort` (`low|medium|high|xhigh`) is a Codex parameter
- No dedicated planning phase or plan-then-act loop
- Planning is implicit in Codex's behavior, not a structural layer

## MCP ↔ Agent Relationship

MCP and chatd are **separate processes** that share the relay:

```
Extension → relay /chatd-url → chatd URL + token
Extension → chatd HTTP API (sessions, runs, SSE)
MCP → relay CDP (Playwright connectOverCDP)
Codex → MCP (via ~/.codex/config.toml mcp_servers)
```

Codex discovers MCP tools through its own config. The agent (chatd) does not directly invoke MCP — it orchestrates Codex, which in turn uses MCP tools.

## Extension-Side Rendering

### SSE Event Consumption

```javascript
// agent-panel.js
consumeEventStream(sessionId) → EventSource(/v1/events?sessionId=...)
  → applyEvent(event) → reduceState(state, event)
```

### State Reducer

`agent-panel-state.js` processes events into renderable state:

| Event | State Update |
|-------|-------------|
| `chat.delta` | Append to assistant message buffer |
| `chat.final` | Mark message complete, clear buffer |
| `chat.commentary` | Add reasoning step |
| `run.provider_session` | Store Codex session ID |
| `run.usage` | Update context usage chip |
| `run.event` | Add tool step to timeline |
| `run.error` | Show error state |
| `run.aborted` | Show aborted state |

### Timeline Rendering

`agent-panel-runtime.js` renders steps with icons:
- Reasoning steps → thinking icon
- Tool steps → tool-specific icon (file, shell, browser, etc.)
- Errors → error icon with message
