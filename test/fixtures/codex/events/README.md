# Codex JSONL Fixture Contracts

Captured with `scripts/capture-codex-jsonl.sh` on 2026-03-03 using `codex-cli 0.106.0`.

## Provider Session ID Extraction

Use only this path:

- Event: `type === "thread.started"`
- Field: `thread_id`

Normalized contract:

- `run.provider_session.payload.provider = "codex"`
- `run.provider_session.payload.sessionId = <thread_id>`

## Usage Telemetry Extraction

Use only this path in current fixtures:

- Event: `type === "turn.completed"`
- Field object: `usage`
- Fields: `usage.input_tokens`, `usage.cached_input_tokens`, `usage.output_tokens`

Normalization contract:

- `inputTokens = usage.input_tokens`
- `cachedInputTokens = usage.cached_input_tokens`
- `outputTokens = usage.output_tokens`
- `totalTokens = inputTokens + outputTokens`
- `modelContextWindow = null` (not emitted in these fixtures)

## Failed Resume Signature

Fixture command:

- `codex exec resume "00000000-0000-0000-0000-000000000000" --json "..."`

Observed behavior in this environment:

- Exit code is zero (`failed-resume-exit-code.txt` contains `0`)
- No failure JSON event is emitted
- A normal `thread.started` event appears, but with a **new** `thread_id` (fresh session)
- `stderr` may contain shell snapshot warnings; this text is non-deterministic and is **not** used as a retry signature

Implication for retry logic:

- Invalid/stale resume IDs are currently soft-fallbacked by Codex itself to a fresh thread
- `isResumeSessionInvalidFailure(...)` should only trigger on explicit hard-failure signatures (none observed in these fixtures)
