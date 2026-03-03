# BrowserForce Development Guide

This guide is for contributors who need a fast local dev/debug loop.

## Quickstart

1. Install deps:

```bash
pnpm install
```

2. Run relay and MCP from this repo:

```bash
pnpm relay
pnpm mcp
```

3. Load extension from this repo in Chrome (`chrome://extensions` -> Load unpacked -> `extension/`).

4. In popup, ensure Relay URL is:

```text
ws://127.0.0.1:19222/extension
```

## Run on a Different Relay Port (Local Debug Hack)

Use this when another BrowserForce instance is already running or you want isolated debugging.

1. Start relay on a non-default port:

```bash
RELAY_PORT=19333 pnpm relay
```

2. In extension popup, set Relay URL to:

```text
ws://127.0.0.1:19333/extension
```

3. Make MCP use the same relay port.

If your MCP client is configured with `npx browserforce@latest mcp`, inject `RELAY_PORT=19333` in the MCP command.

Example shape:

```json
{
  "command": "env",
  "args": ["RELAY_PORT=19333", "npx", "-y", "browserforce@latest", "mcp"]
}
```

Fallback (if you cannot pass `RELAY_PORT` in MCP config): set `BF_CDP_URL` to the exact ws URL from `~/.browserforce/cdp-url`.

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
