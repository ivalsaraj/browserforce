# BrowserForce Agent

BrowserForce Agent is the local chat daemon (`chatd`) plus the Chrome extension side-panel UI.
It gives you resumable, multi-session chat backed by Codex, while keeping data local on loopback.

## What This Covers

- Side-panel chat flow and session model
- Daemon lifecycle commands
- Agent HTTP API (`/v1/*`)
- Config files and environment variables
- Security boundaries and common troubleshooting

## Quick Start

1. Start relay:

```bash
browserforce serve
```

2. Start agent daemon:

```bash
browserforce agent start
browserforce agent status
```

3. In the extension popup, click `Open BrowserForce Agent`.

4. Attach the current tab only when you want the agent to control that tab.

5. Send a message in the side panel.

Stop daemon when needed:

```bash
browserforce agent stop
```

## Runtime Flow

1. Side panel asks relay for `GET /chatd-url`.
2. Relay validates extension origin/ID and returns `{ port, token }` from `~/.browserforce/chatd-url.json`.
3. Side panel calls chatd directly on `127.0.0.1:<port>` with `Authorization: Bearer <token>`.
4. Chat events stream over SSE from `/v1/events`.

## Current Tab Attachment

- Opening the BrowserForce side panel does not auto-attach the active tab.
- Sending a message does not auto-attach the active tab.
- Use `Attach current tab` only when you want the agent to drive that tab through Chrome DevTools.
- This keeps fragile pages from being debugger-attached implicitly and reduces surprise automation on the tab you are viewing.
- When you ask the agent to `check`, `inspect`, `look at`, `review`, or `read` an attached page, it should start with `context.pages()` and reuse the matching existing tab.
- In that flow, it should not call `context.newPage()` or `page.goto()` just to find a page that is already open.
- If the page you want is not present in `context.pages()`, the agent should tell you instead of opening a fresh copy.
- BrowserForce now defers tab-group reconciliation briefly after attach and suppresses self-triggered regroup loops while a group sync is already in progress. This reduces attach-time Chrome churn for manually attached tabs.

## Session Model

- Session IDs are explicit and user-selectable. There is no fixed/hardcoded chat session.
- Sessions persist under `~/.browserforce/agent/sessions/`.
- BrowserForce stores Codex continuity under `providerState.codex.sessionId`.
- New runs attempt `codex exec resume <sessionId> --json` when mapping exists.
- If resume fails with an invalid-session signature, chatd retries once with a fresh run.
- Usage telemetry from `run.usage` is persisted at `providerState.codex.latestUsage` and used to hydrate the context usage chip.

## API Surface

All `/v1/*` endpoints require `Authorization: Bearer <token>`.

- `GET /health`
  - No bearer required.
  - Returns daemon status (`ok`, `pid`, `port`, `uptimeMs`).
- `GET /v1/sessions`
  - List sessions.
- `POST /v1/sessions`
  - Create session (`title`, optional `model`, optional `reasoningEffort`).
- `GET /v1/sessions/:sessionId`
  - Fetch session metadata (includes `providerState` when present).
- `PATCH /v1/sessions/:sessionId`
  - Update session `title`, `model`, or `reasoningEffort`.
- `GET /v1/sessions/:sessionId/messages?limit=200`
  - Read transcript messages.
- `GET /v1/models`
  - Returns available model presets and default reasoning effort.
- `GET /v1/events?sessionId=<id>`
  - SSE stream (`chat.delta`, `chat.final`, `run.provider_session`, `run.usage`, etc.).
- `POST /v1/runs`
  - Start run for `{ sessionId, message, browserContext? }`.
- `POST /v1/runs/:runId/abort` or `DELETE /v1/runs/:runId/abort`
  - Abort active run.

## Config Files and Storage

Generated and runtime files:

- `~/.browserforce/chatd-url.json`
  - Shape: `{ "port": <number>, "token": "<bearer>" }`
  - Written with mode `0600`.
  - Used by relay `/chatd-url` bootstrap.
- `~/.browserforce/chatd-lock.json`
  - Daemon lock/state (`pid`, `port`, `token`), mode `0600`.
- `~/.browserforce/agent/sessions/index.json`
  - Session index metadata.
- `~/.browserforce/agent/sessions/<sessionId>.jsonl`
  - Message/event history per session.

Optional external config:

- `~/.codex/config.toml`
  - If present, chatd reads top-level:
    - `model`
    - `model_reasoning_effort`

## Environment Variables

- `BF_CHATD_PORT`
  - Preferred daemon port. If unavailable or unset, fallback scans `19280-19320`.
- `BF_CHATD_TOKEN`
  - Forces bearer token instead of generated random token.
- `BF_CHATD_URL_PATH`
  - Overrides `chatd-url.json` path.
- `BF_CHATD_LOCK_PATH`
  - Overrides lock file path used by `browserforce agent start|status|stop`.
- `BF_CHATD_CODEX_CWD`
  - Working directory for `codex exec --json` runs. Defaults to `~/.browserforce/agent-cwd` when started via `browserforce agent start`.
  - `agent start` syncs a managed BrowserForce `AGENTS.md` into this directory (unless a custom unmanaged `AGENTS.md` is already present).
- `BF_CHATD_CODEX_COMMAND`
  - Codex binary/command used by chatd (default `codex`).
- `BF_CHATD_MODEL_LIST_TIMEOUT_MS`
  - Timeout when querying model catalog from Codex app-server.
- `BF_CHATD_DEFAULT_MODEL`
  - Default model override if valid.
- `BF_CHATD_DEFAULT_REASONING_EFFORT`
  - Default reasoning effort override (`low|medium|high|xhigh`).

## Security Model

- chatd binds to `127.0.0.1` only.
- `/v1/*` requires bearer auth.
- Origin checks:
  - `chrome-extension://*` is allowed.
  - localhost origins are allowed for local tooling.
- Relay `GET /chatd-url` is extension-gated (trusted extension origin/ID must match connected extension).

## Troubleshooting

- MCP guidance:
  - `execute` keeps a small prompt so tab rules remain visible to agents.
  - Call `help(section)` for detailed BrowserForce guidance; sections are cached per MCP session and do not require Chrome/CDP.
  - No BrowserForce skill is required for the help gate.
- `agent_not_running` in side panel:
  - Run `browserforce agent start`.
- `extension_not_connected` from `/chatd-url`:
  - Ensure extension is connected to relay (`browserforce status`).
- `Unauthorized` from `/v1/*`:
  - Token mismatch/stale bootstrap. Restart daemon and reopen side panel.
- `Context: unavailable` chip:
  - No `run.usage` emitted yet for that session. Send a run and re-open session metadata.
- "MCP shows zero / no attached page" (BF_NO_ATTACHED_PAGE):
  - In auto mode, BrowserForce should discover existing open tabs after MCP connects; it should not need a blank page bootstrap.
  - In manual/no-new-tabs mode, attach a tab with the BrowserForce extension popup, then retry. Confirm attached-tab readiness directly:
    ```bash
    curl -s http://127.0.0.1:19222/extension/status | jq '.activeManualTargets, .manualAttachedTabs'
    curl -s http://127.0.0.1:19222/attached-tabs | jq '.tabs'
    ```
  - If the extension UI already shows the tab as attached but relay status is empty, click **Attach current tab** again to replay the existing attachment to the relay.
  - `activeTargets > 0` means MCP has visible targets. `activeManualTargets > 0` / `manualAttachedTabs` non-empty means attached-only/current-tab flows are ready.
- BF_NEW_TABS_DISABLED from execute({ intent: 'open' }):
  - The session is attached-only. Ask the user to relax restrictions in the extension popup, or call `execute` without `intent: 'open'`. Set `BF_ALLOW_IMPLICIT_STARTUP_PAGE=1` on the MCP process to restore the legacy auto-bootstrap.
- BF_RESTRICTIONS_UNAVAILABLE from execute/reset preflight:
  - The MCP could not read restrictions from the extension/relay. Ensure the relay is running, the BrowserForce extension is connected, and retry. CDP startup is intentionally blocked when the active policy is unknown.

## Screenshots (Add Later)

Placeholders for future docs updates:

- Side-panel open state
- Session switcher
- Context usage chip
- Typical error states (`agent_not_running`, `extension_not_connected`)
