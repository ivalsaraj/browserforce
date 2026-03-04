## google-sheets plugin

Use Google Sheets helpers when work involves reading, summarizing, or structuring sheet content from the active page without guesswork.

Tool naming note:
- The same browser tool may appear as `execute` or `BrowserForce:execute`.
- Treat both labels as the same BrowserForce execution path.

Available helpers:
- `gsGetMeta()` → current spreadsheet id + gid + title + URL
- `gsGotoCell(cellRef)` → jump to a cell using the Sheets name box
- `gsReadCell(cellRef, options?)` → read cell text through the in-cell editor
- `gsReadContiguousRows(options?)` → detect used rows without hard-scanning arbitrary ranges
- `gsSummarizeSheet(options?)` → one-call summary payload (sheet meta + scan stats + preview rows)
- `gsSplitBulletsInRange(rangeRef, options?)` → replace in-cell bullet separators with real new lines
- `gsRebalanceBoldInRange(rangeRef, options?)` → sparse bolding (default: max 1 bold segment per line)
- `gsFormatBulletsInRange(rangeRef, options?)` → split bullets + rebalance bold in one pass
- `gsLogIssue(summary, details?, options?)` → append a JSONL issue entry
- `gsIssueLogPath()` → return default issue log path

## Summary-First Workflow (Default)

When the user says "summarize this page/sheet", "read this sheet", or equivalent:
- Use `gsSummarizeSheet()` first.
- Answer directly from returned `preview` rows.
- Include `scannedRows`, `usedRowCount`, and `stopReason` in the summary.
- Ask a focused follow-up only when `usedRowCount === 0` or the user asks for a wider range.

## Reliability Rules

- Never hardcode long row scans (`1..80`, `1..200`) when structure is contiguous.
- Use `gsReadContiguousRows({ columns: ['A','B'], startRow: 1, maxRows: 30, emptyStreakStop: 2 })`.
- Always report `scannedRows`, `usedRowCount`, and `stopReason` when summarizing extraction.
- For summary requests, prefer `gsSummarizeSheet()` over ad-hoc DOM probing loops.
- Prefer `gsFormatBulletsInRange()` for multi-cell content cleanup tasks.
- Use `dryRun: true` first for formatting helpers when changing many cells.
- Log every process failure or unexpected behavior with `gsLogIssue(...)`.

## Guardrails (Google Sheets)

- Do not switch to `/export`, `/gviz`, CSV downloads, or out-of-page fetch flows unless the user explicitly asks for export data.
- Do not open extra tabs for summary-only requests.
- Do not infer cell content from toolbar/status text when table rows are available via helpers.

## Example: One-Shot Summary

```js
const result = await gsSummarizeSheet({
  startRow: 1,
  maxRows: 30,
  previewRows: 8
});

return {
  sheet: result.sheet,
  scan: {
    scannedRows: result.scan.scannedRows,
    usedRowCount: result.scan.usedRowCount,
    stopReason: result.scan.stopReason
  },
  preview: result.preview
};
```

## Example: Log a Failure Pattern

```js
await gsLogIssue(
  'Overscan loop on Google Sheets',
  {
    symptom: 'Looped to row 80 while table ended at row 9',
    fix: 'Use gsReadContiguousRows with emptyStreakStop=2',
    impact: 'Reduced scans and prevented wasted actions'
  }
);
```

## Example: Split + Sparse Bold in One Call

```js
const result = await gsFormatBulletsInRange('D2:D11', {
  maxBoldPerLine: 1,
  preferredPhrasesByCell: {
    D2: ['review-ready PRs', 'sprint timeline', 'Escalates blockers'],
    D3: ['Consistent quality', 'Review feedback', 'precise ETA']
  },
  verify: true
});

return result.summary || result;
```
