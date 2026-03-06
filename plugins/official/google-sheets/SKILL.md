---
name: google-sheets
description: Google Sheets helpers for reading, summarizing, formatting, and issue logging in the active sheet.
when_to_use: ["Summarizing an active Google Sheet quickly", "Reading specific cells or contiguous used rows", "Applying bullet splitting and sparse bold formatting across ranges", "Logging extraction or formatting failures for follow-up"]
helper_prefix: gs
helpers: ["gs__getMeta", "gs__gotoCell", "gs__readCell", "gs__readContiguousRows", "gs__summarizeSheet", "gs__splitBulletsInRange", "gs__rebalanceBoldInRange", "gs__formatBulletsInRange", "gs__logIssue", "gs__issueLogPath"]
helper_aliases: ["gsGetMeta", "gsGotoCell", "gsReadCell", "gsReadContiguousRows", "gsSummarizeSheet", "gsSplitBulletsInRange", "gsRebalanceBoldInRange", "gsFormatBulletsInRange", "gsLogIssue", "gsIssueLogPath"]
tools: []
---

## google-sheets plugin

Use Google Sheets helpers when work involves reading, summarizing, or structuring sheet content from the active page without guesswork.

Tool naming note:
- The same browser tool may appear as `execute` or `BrowserForce:execute`.
- Treat both labels as the same BrowserForce execution path.

Available helpers:
- `gs__getMeta()` → current spreadsheet id + gid + title + URL
- `gs__gotoCell(cellRef)` → jump to a cell using the Sheets name box
- `gs__readCell(cellRef, options?)` → read cell text through the in-cell editor
- `gs__readContiguousRows(options?)` → detect used rows without hard-scanning arbitrary ranges
- `gs__summarizeSheet(options?)` → one-call summary payload (sheet meta + scan stats + preview rows)
- `gs__splitBulletsInRange(rangeRef, options?)` → replace in-cell bullet separators with real new lines
- `gs__rebalanceBoldInRange(rangeRef, options?)` → sparse bolding (default: max 1 bold segment per line)
- `gs__formatBulletsInRange(rangeRef, options?)` → split bullets + rebalance bold in one pass
- `gs__logIssue(summary, details?, options?)` → append a JSONL issue entry
- `gs__issueLogPath()` → return default issue log path

Backward-compatible aliases are still available (`gsGetMeta`, `gsSummarizeSheet`, etc.), but use the `gs__*` names for new plugin code.

## Summary-First Workflow (Default)

When the user says "summarize this page/sheet", "read this sheet", or equivalent:
- Use `gs__summarizeSheet()` first.
- Answer directly from returned `preview` rows.
- Include `scannedRows`, `usedRowCount`, and `stopReason` in the summary.
- Ask a focused follow-up only when `usedRowCount === 0` or the user asks for a wider range.

## Reliability Rules

- Never hardcode long row scans (`1..80`, `1..200`) when structure is contiguous.
- Use `gs__readContiguousRows({ columns: ['A','B'], startRow: 1, maxRows: 30, emptyStreakStop: 2 })`.
- Always report `scannedRows`, `usedRowCount`, and `stopReason` when summarizing extraction.
- For summary requests, prefer `gs__summarizeSheet()` over ad-hoc DOM probing loops.
- `gs__summarizeSheet()` reuses a recent in-session scan by default; set `forceRefresh: true` when the user asks for a guaranteed fresh pull.
- Prefer `gs__formatBulletsInRange()` for multi-cell content cleanup tasks.
- Use `dryRun: true` first for formatting helpers when changing many cells.
- Log every process failure or unexpected behavior with `gs__logIssue(...)`.

## Guardrails (Google Sheets)

- Do not switch to `/export`, `/gviz`, CSV downloads, or out-of-page fetch flows unless the user explicitly asks for export data.
- Do not open extra tabs for summary-only requests.
- Do not infer cell content from toolbar/status text when table rows are available via helpers.

## Example: One-Shot Summary

```js
const result = await gs__summarizeSheet({
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
await gs__logIssue(
  'Overscan loop on Google Sheets',
  {
    symptom: 'Looped to row 80 while table ended at row 9',
    fix: 'Use gs__readContiguousRows with emptyStreakStop=2',
    impact: 'Reduced scans and prevented wasted actions'
  }
);
```

## Example: Split + Sparse Bold in One Call

```js
const result = await gs__formatBulletsInRange('D2:D11', {
  maxBoldPerLine: 1,
  preferredPhrasesByCell: {
    D2: ['review-ready PRs', 'sprint timeline', 'Escalates blockers'],
    D3: ['Consistent quality', 'Review feedback', 'precise ETA']
  },
  verify: true
});

return result.summary || result;
```
