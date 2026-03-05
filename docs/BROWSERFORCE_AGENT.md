# BrowserForce Agent

BrowserForce Agent is the local chat daemon (`chatd`) plus the Chrome extension side-panel UI.
It gives you resumable, multi-session chat backed by provider adapters (Codex by default, Claude optional), while keeping data local on loopback.

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

4. Send a message in the side panel.

Stop daemon when needed:

```bash
browserforce agent stop
```

## Runtime Flow

1. Side panel asks relay for `GET /chatd-url`.
2. Relay validates extension origin/ID and returns `{ port, token }` from `~/.browserforce/chatd-url.json`.
3. Side panel calls chatd directly on `127.0.0.1:<port>` with `Authorization: Bearer <token>`.
4. Chat events stream over SSE from `/v1/events`.

## Session Model

- Session IDs are explicit and user-selectable. There is no fixed/hardcoded chat session.
- Sessions persist under `~/.browserforce/agent/sessions/`.
- Session metadata stores provider identity in `session.provider` (defaults to `codex` when omitted).
- Continuity and usage are provider-scoped under `providerState.<providerId>`.
- Codex runs attempt `codex exec resume <sessionId> --json` when mapping exists.
- If Codex resume fails with an invalid-session signature, chatd retries once with a fresh run.
- Usage telemetry from `run.usage` is persisted at `providerState.<providerId>.latestUsage` and used to hydrate the context usage chip.

## API Surface

All `/v1/*` endpoints require `Authorization: Bearer <token>`.

- `GET /health`
  - No bearer required.
  - Returns daemon status (`ok`, `pid`, `port`, `uptimeMs`).
- `GET /v1/sessions`
  - List sessions.
- `POST /v1/sessions`
  - Create session (`title`, optional `provider`, optional `model`, optional `reasoningEffort`).
- `GET /v1/sessions/:sessionId`
  - Fetch session metadata (includes `providerState` when present).
- `PATCH /v1/sessions/:sessionId`
  - Update session `title`, `provider`, `model`, or `reasoningEffort`.
- `GET /v1/providers`
  - Returns available provider adapters and default provider.
- `GET /v1/sessions/:sessionId/messages?limit=200`
  - Read transcript messages.
- `GET /v1/models`
  - Returns provider-scoped model presets.
  - Optional query: `?provider=codex|claude`.
- `GET /v1/events?sessionId=<id>`
  - SSE stream (`chat.delta`, `chat.final`, `run.provider_session`, `run.usage`, etc.).
- `POST /v1/runs`
  - Start run for `{ sessionId, message, browserContext? }`.
  - `reasoningEffort` settings are currently applied to Codex runs. Claude runs ignore `reasoningEffort`.
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
- `BF_CHATD_CLAUDE_COMMAND`
  - Claude binary/command used by chatd when provider is `claude` (default `claude`).
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

- `agent_not_running` in side panel:
  - Run `browserforce agent start`.
- `extension_not_connected` from `/chatd-url`:
  - Ensure extension is connected to relay (`browserforce status`).
- `Unauthorized` from `/v1/*`:
  - Token mismatch/stale bootstrap. Restart daemon and reopen side panel.
- `Context: unavailable` chip:
  - No `run.usage` emitted yet for that session. Send a run and re-open session metadata.

## Screenshots (Add Later)

Placeholders for future docs updates:

- Side-panel open state
- Session switcher
- Context usage chip
- Typical error states (`agent_not_running`, `extension_not_connected`)
