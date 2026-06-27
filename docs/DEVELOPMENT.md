# BrowserForce Development Guide

This guide is for contributors who need a fast local dev/debug loop.

## Quickstart

1. Install deps:

```bash
pnpm install
```

2. Run MCP from this repo. MCP starts or verifies the relay automatically:

```bash
pnpm mcp
```

Run `pnpm relay` separately only when you intentionally want to debug the relay
process in its own terminal.

3. Load extension from this repo in Chrome (`chrome://extensions` -> Load unpacked -> `extension/`).

4. In popup, ensure Relay URL is:

```text
ws://127.0.0.1:19222/extension
```

## MCP Help Gate

The MCP `execute` tool prompt is intentionally small: it keeps the help gate and
tab rules visible for tool search, then points agents to `help(section)` for
detailed guidance. Help sections are cached per MCP session, require no
BrowserForce skill, and do not open Chrome or connect to CDP.

## Run on a Different Relay Port (Local Debug Hack)

Use this when another BrowserForce instance is already running or you want isolated debugging.

1. In extension popup, set Relay URL to:

```text
ws://127.0.0.1:19333/extension
```

2. Make MCP use the same relay port. MCP starts or verifies the relay on that port.

If your MCP client is configured with `npx browserforce@latest mcp`, inject `RELAY_PORT=19333` in the MCP command.

Example shape:

```json
{
  "command": "env",
  "args": ["RELAY_PORT=19333", "npx", "-y", "browserforce@latest", "mcp"]
}
```

Fallback (if you cannot pass `RELAY_PORT` in MCP config): set `BF_CDP_URL` to the exact ws URL from `~/.browserforce/cdp-url`.

## Manual Tab Attach During Relay Reconnects

When a user manually attaches a tab from the extension popup, the extension
re-announces that tab after reconnecting to the relay. The relay treats repeated
manual attach announcements for the same tab as updates to the existing target,
not as new targets. This keeps attached tabs visible to MCP after Codex or the
relay process restarts.

If the extension still has a local attached-tab entry but relay state was lost,
pressing **Attach current tab** again replays the existing attachment to the
relay instead of returning an "already attached" error.

## Agent Window Affinity

Agent-created tabs are pinned to the Chrome **window** where the agent first did
real work, not the user's currently focused window. The relay remembers the
first window per CDP client (seeded from the first non-init command), and sends
that `windowId` to the extension's `createTab`. If the user switches to another
Chrome window before the agent opens its next tab, the new tab still appears in
the original window. BrowserForce only falls back to the current focused window
when the pinned window has been closed, and then re-pins to that fallback window.

Tab `windowId` is surfaced in `listTabs`, `/extension/status`, and
`/attached-tabs` whenever it is known.

**Dedicated window (opt-in):** With the **Open agent tabs in a dedicated window**
popup setting ON, a create with no valid pinned window opens a fresh **background**
(`focused: false`) Chrome window for the agent's tabs instead of using the user's
current window; affinity then pins to it. If that window is closed mid-session, the
next create spawns a **new** dedicated window rather than falling back to the user's
window. Scope is agent-**created** tabs only; manually attached tabs are never moved.
Default is OFF.

## Relay Status & Introspection Endpoints

The relay exposes localhost-only status endpoints that read existing relay state
without opening a Playwright CDP connection:

```bash
curl -s http://127.0.0.1:19222/extension/status | jq
curl -s http://127.0.0.1:19222/attached-tabs | jq
```

- `GET /extension/status` → `{ connected, activeTargets, activeManualTargets, attachedTabs, manualAttachedTabs, clients, startedAt }`.
- `GET /attached-tabs` → `{ tabs: [{ tabId, sessionId, targetId, title, url, debuggerAttached, origin, windowId? }] }`. `windowId` is present only when the relay knows the tab's Chrome window.
- Auto-mode CDP discovery registers eligible open Chrome tabs as `relay-discovered` targets without debugger-attaching them or creating blank tabs.
- `manualAttachedTabs` / `activeManualTargets` identify user-attached tabs (`origin: 'manual'`). Use them to confirm attached-only/manual mode is ready.
- `attachedTabs` can also include `relay-discovered`, `agent-created`, and `relay-attached` tabs. These targets are visible to MCP, but only debugger-attach lazily when the agent interacts with one.
- These differ from `/json/list` (CDP-discovery shape for Playwright) — the status endpoints carry relay-owned provenance.

**Host header validation:** all HTTP routes reject non-local `Host` headers (`localhost`, `127.0.0.1`, `[::1]`, `::1` only) before URL parsing, blocking DNS-rebinding attacks. A missing `Host` header is allowed for local non-browser clients.

**CORS:** `/extension/status` and `/attached-tabs` intentionally omit `Access-Control-Allow-Origin` because they expose local browsing metadata (tab URLs/titles); arbitrary websites must not read them.

## Debug Side-Panel Streaming Events

The side-panel receives SSE from chatd (`/v1/events`). You can inspect the same stream directly.

1. Start agent daemon:

```bash
browserforce agent start
```

2. Load auth data:

```bash
PORT=$(jq -r '.port' ~/.browserforce/chatd-url.json)
TOKEN=$(jq -r '.token' ~/.browserforce/chatd-url.json)
BASE="http://127.0.0.1:$PORT"
```

3. Create a test session:

```bash
SESSION_ID=$(curl -sS "$BASE/v1/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"debug-stream"}' | jq -r '.sessionId')
echo "$SESSION_ID"
```

4. Terminal A: watch stream:

```bash
curl -N -sS "$BASE/v1/events?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN" \
| awk '/^data: /{sub(/^data: /,""); print}' \
| jq -c '{event, runId, sessionId, payload}'
```

5. Terminal B: trigger a run:

```bash
curl -sS "$BASE/v1/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"message\":\"say hello and stop\"}" | jq
```

Useful filters:

```bash
# only assistant deltas
... | jq -c 'select(.event=="chat.delta")'

# continuity + telemetry
... | jq -c 'select(.event=="run.provider_session" or .event=="run.usage")'
```

## Debug CDP Traffic

Relay writes CDP traffic to:

```text
~/.browserforce/cdp.jsonl
```

Tail live:

```bash
tail -f ~/.browserforce/cdp.jsonl | jq -c '{ts, direction, method: (.message.method // "response")}'
```

Method summary:

```bash
jq -r '.direction + "\t" + (.message.method // "response")' ~/.browserforce/cdp.jsonl | uniq -c
```

## Test Commands (Common While Developing)

```bash
pnpm test
node --test test/agent/chatd-api.test.js
node --test test/agent/codex-runner.test.js
node --test test/agent/session-store.test.js
node --test test/agent/agent-panel-contract.test.js test/agent/agent-panel-send-contract.test.js
```

## Shared Agent/Panel Normalizers

The agent daemon and extension side panel both normalize run timeline events. Keep shared, browser-safe helpers in `extension/agent-timeline-labels.js` and plugin helper metadata normalization in `extension/plugin-helper-normalization.js`. The daemon can import these modules directly because the published package includes `extension/`.
