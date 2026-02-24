# Playwriter Parity Diffing + CDP Logging Design

## Goal
Implement two P0 features in BrowserForce with playwriter behavior parity:
- Diff-aware extraction helpers (`snapshot`, `cleanHTML`, `pageMarkdown`) with `showDiffSinceLastCall`
- Relay-side JSONL CDP traffic logging queryable with `jq`

## Scope Decisions (Approved)
- `showDiffSinceLastCall` default: `true` (playwriter parity)
- Relay CDP log lifecycle: recreate/truncate on each relay start
- Execution model: subagent-driven implementation after plan creation

## Non-Goals
- Reworking extension protocol
- Changing CDP routing semantics
- Adding non-essential relay dependencies

## Current State
- `mcp/src/snapshot.js` already has `createSmartDiff(oldText, newText)` but helper wiring is missing.
- `mcp/src/exec-engine.js` exposes `snapshot({ selector, search })`, `cleanHTML(selector, opts)`, and `pageMarkdown()` without diff mode state.
- `relay/src/index.js` has operational console logging but no structured CDP JSONL log.

## Proposed Design

### 1) MCP Diffing Parity

#### `snapshot`
- Extend helper signature to `snapshot({ selector?, search?, showDiffSinceLastCall? } = {})`.
- Keep existing snapshot build pipeline and ref table unchanged.
- Cache last snapshot text per page (only for full-page snapshot, same practical behavior as playwriter page-scoped caching).
- If `showDiffSinceLastCall` is `true` and a previous snapshot exists:
  - `createSmartDiff` result `no-change` => return a clear no-change message with guidance to set `false` for full output.
  - `diff` => return diff text.
  - `full` => return full snapshot text.
- If no previous snapshot or `showDiffSinceLastCall: false`, return full snapshot text.

#### `cleanHTML`
- Add option `showDiffSinceLastCall` to `getCleanHTML(page, selector, opts)`.
- Maintain per-page/per-selector snapshot cache via `WeakMap<Page, Map<string, string>>`.
- Preserve existing HTML cleaning output and current options (`maxAttrLen`, `maxContentLen`).
- Diff behavior mirrors `snapshot` no-change/full/diff handling.

#### `pageMarkdown`
- Update to `getPageMarkdown(page, opts = {})` with `showDiffSinceLastCall` and optional `search`.
- Maintain per-page snapshot cache via `WeakMap<Page, string>`.
- Preserve current readability extraction and markdown structure.
- Diff behavior mirrors `cleanHTML`.

### 2) Relay JSONL CDP Logging

#### Logging module
- Add `relay/src/cdp-log.js` to encapsulate JSONL writing:
  - file path default: `~/.browserforce/cdp.jsonl`
  - env overrides:
    - `BROWSERFORCE_CDP_LOG_FILE_PATH`
    - `BROWSERFORCE_CDP_LOG_MAX_STRING_LENGTH`
  - truncating replacer for large strings + circular safety
  - async append queue to preserve ordering
  - truncate file on relay startup (approved behavior)

#### Relay integration points (`relay/src/index.js`)
- Instantiate logger once in `RelayServer` lifecycle.
- Log entries with shape `{ timestamp, direction, message, clientId?, source? }`.
- Directions:
  - `from-playwright`: inbound CDP client commands
  - `to-extension`: forwarded `cdpCommand` payloads
  - `from-extension`: inbound extension `cdpEvent`
  - `to-playwright`: outbound events/responses sent to CDP clients
- Hook points:
  - `_handleCdpClientMessage`
  - `_forwardToTab` / `_sendToExt` path for `cdpCommand`
  - `_handleCdpEventFromExt`
  - `_broadcastCdp` and direct response send paths

### 3) Test Strategy

#### MCP tests
- Extend `mcp/test/exec-engine-plugins.test.js` (integration surface for `buildExecContext` helpers):
  - snapshot returns no-change message on repeated identical calls
  - snapshot returns diff on small change
  - `cleanHTML`/`pageMarkdown` support `showDiffSinceLastCall: false` full output fallback
- Keep existing pure diff unit tests in `mcp/test/mcp-tools.test.js` intact.

#### Relay tests
- Extend `relay/test/relay-server.test.js` with `CDP Logging` suite:
  - log file created/truncated on startup
  - command forward and event forward paths produce JSONL entries with expected directions/methods
  - entries are valid JSON per line and queryable with `jq`-style field access

### 4) Documentation
- Update user-facing docs (likely `README.md`/`GUIDE.md`) to include:
  - new helper parameters and defaults
  - no-change messaging semantics
  - CDP JSONL path and example `jq` command

## Risks and Mitigations
- Behavior shift from full outputs to diff-by-default may surprise existing flows.
  - Mitigation: explicit docs + clear no-change/full fallback message.
- High-volume CDP logs can grow quickly.
  - Mitigation: per-start truncation plus string length truncation controls.
- Logging must not affect CDP routing correctness.
  - Mitigation: append queue is fire-and-forget and never blocks forwarding decisions.

## Acceptance Criteria
- Repeated helper calls default to diff behavior with playwriter-like semantics.
- `showDiffSinceLastCall: false` reliably returns full output.
- Relay writes `~/.browserforce/cdp.jsonl` with structured entries for command/event/response traffic.
- New/updated tests pass in `mcp` and `relay` packages.
- Docs explain feature usage and debugging workflow.
