# BrowserForce command reference

Every command, flag, and environment variable. For the workflow overview see
the parent `SKILL.md` (`browserforce skills get core`).

## Output envelope

Session-backed verbs print a JSON envelope with `--json`:

```json
{ "success": true, "data": { }, "error": null, "warning": null }
```

`success: false` sets a non-zero exit code so the verbs are scriptable. Without
`--json`, `data` is printed in a human-readable form and `warning` goes to
stderr.

## Status and lifecycle

| Command | Description |
|---|---|
| `browserforce status` | Relay + extension connection status. |
| `browserforce serve` | Start the relay server (foreground). |
| `browserforce mcp` | Start the MCP server (stdio). |
| `browserforce tabs` | List open browser tabs. |
| `browserforce navigate <url>` | Open a URL in a new tab. |
| `browserforce screenshot [n]` | PNG of tab `n` (default 0) to stdout. |
| `browserforce install-extension` | Copy the extension into a local dir to load unpacked. |
| `browserforce update` | Check for / install a newer BrowserForce. |

## Session daemon

The daemon (`sessiond`) holds one persistent browser session. It is auto-started
on the first session-backed verb and idles out after 5 minutes.

| Command | Description |
|---|---|
| `browserforce session start` | Start the session daemon explicitly. |
| `browserforce session status` | Report the daemon pid/port/backend, or "not running". |
| `browserforce session stop` | Stop the daemon and release the browser. |

### Backend selection

The daemon negotiates a browser backend at startup:

- **Real Chrome (default `auto`)** — connects through the relay + extension to
  the user's real browser when the extension is connected.
- **Managed fallback** — if the real bridge is unavailable, `auto` falls back to
  a managed headed Chrome and prints a warning.
- Force a backend with `BF_BROWSER_BACKEND=real|managed|headless`. `real` fails
  loudly (non-zero exit, no daemon) when the bridge is unavailable.

`browserforce session status --json` reports `{ backend, requestedBackend, fallbackReason, warning }`.

## Atomic verbs

All verbs route through the daemon's guarded execution boundary (the same
`runCode()` vm used by MCP `execute` and one-shot `-e`).

| Command | Description |
|---|---|
| `browserforce snapshot --sessiond` | Accessibility tree + `@eN` refs from the session page. |
| `browserforce click <@ref>` | Click the element behind a ref. |
| `browserforce fill <@ref> <text>` | Clear, then type into a field. |
| `browserforce type <@ref> <text>` | Type without clearing. |
| `browserforce press <key>` | Press a key at the current focus (`Enter`, `Control+a`). |
| `browserforce wait --text <s>` | Wait until text appears on the page. |
| `browserforce wait --url <glob>` | Wait until the URL matches a glob. |
| `browserforce wait --load <state>` | Wait for a load state (`load`, `domcontentloaded`, `networkidle`). |
| `browserforce wait --fn <expr>` | Wait until a JS predicate is truthy. |
| `browserforce get url` | Current URL. |
| `browserforce get title` | Page title. |
| `browserforce get text <@ref>` | Text content of a ref. |
| `browserforce eval --stdin` | Run piped Playwright JS in the session (or `eval "<code>"`). |

### snapshot flags

| Flag | Description |
|---|---|
| `--sessiond` | Use the persistent session (required for the atomic-verb workflow). |
| `--selector <css>` | Scope the snapshot to a CSS selector. |
| `--search <text>` | Only include nodes whose accessible name matches. |
| `--interactive-only` | Only interactive elements (buttons, links, inputs). |
| `--json` | Machine-readable envelope. |

### Ref aliases

`@e1`, `e1`, and `ref=e1` all resolve to the same element. Refs are assigned
fresh on every snapshot and go stale as soon as the page changes.

## One-shot execution

| Command | Description |
|---|---|
| `browserforce -e "<code>"` | Run a Playwright snippet once (no persisted state). |
| `--timeout <ms>` | Execution timeout (default 30000). |

Exec-context helpers available to both `-e` and `eval --stdin`: `page`,
`context`, `state`, `snapshot()`, `snapshotData()`, `locatorForRef()`,
`refToLocator()`, `waitForPageLoad()`, `getLogs()`, `screenshotWithAccessibilityLabels()`,
`pageMarkdown()`, `cleanHTML()`, and installed plugin helpers.

## Skills

| Command | Description |
|---|---|
| `browserforce skills list` | List available skills. |
| `browserforce skills get <name>` | Print a skill's `SKILL.md`. |
| `browserforce skills get <name> --full` | Also include `references/` and `templates/`. |
| `browserforce skills path [name]` | Print a skill's directory, or all search roots. |

## Environment variables

| Variable | Description |
|---|---|
| `BF_BROWSER_BACKEND` | Force the backend: `auto` (default), `real`, `managed`, `headless`. |
| `BF_CDP_URL` | Connect to a specific relay CDP URL. |
| `BF_SKILLS_DIR` | Override the skills search directory. |
| `BF_SESSIOND_IDLE_MS` | Daemon idle-timeout in ms (default 300000). |
| `BF_SESSIOND_PORT` | Pin the daemon to a port (default: first free in 19340-19380). |

## Security model

- The relay and session daemon bind `127.0.0.1` only — never `0.0.0.0`.
- Every daemon state route requires an `Authorization: Bearer <token>`; the
  token lives in a `0o600` lock file. `/health` is the only unauthenticated route
  and leaks no secret.
- `eval`/`-e` snippets run inside a guarded `node:vm` boundary with an execution
  timeout; a timed-out run is aborted and cannot keep driving Chrome.
