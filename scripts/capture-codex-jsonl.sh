#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-test/fixtures/codex/events}"
PROMPT="${2:-Reply with one short sentence and stop.}"

mkdir -p "$OUT_DIR"

codex exec --json "$PROMPT" > "$OUT_DIR/exec-sample.jsonl"

SESSION_ID="$(node - "$OUT_DIR/exec-sample.jsonl" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split(/\n+/).filter(Boolean);
for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  if (parsed && parsed.type === 'thread.started' && typeof parsed.thread_id === 'string' && parsed.thread_id.trim()) {
    process.stdout.write(parsed.thread_id.trim());
    process.exit(0);
  }
}
process.exit(1);
NODE
)"

codex exec resume "$SESSION_ID" --json "$PROMPT" > "$OUT_DIR/resume-sample.jsonl"

INVALID_SESSION_ID="00000000-0000-0000-0000-000000000000"
set +e
codex exec resume "$INVALID_SESSION_ID" --json "$PROMPT" > "$OUT_DIR/failed-resume-sample.jsonl" 2> "$OUT_DIR/failed-resume-stderr.txt"
EXIT_CODE=$?
set -e

printf '%s\n' "$EXIT_CODE" > "$OUT_DIR/failed-resume-exit-code.txt"

echo "Captured fixtures in $OUT_DIR"
