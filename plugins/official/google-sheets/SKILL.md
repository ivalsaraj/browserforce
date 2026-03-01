## google-sheets plugin

Use Google Sheets helpers when work involves reading or structuring sheet content reliably without guesswork.

Available helpers:
- `gsGetMeta()` → current spreadsheet id + gid + title + URL
- `gsGotoCell(cellRef)` → jump to a cell using the Sheets name box
- `gsReadCell(cellRef, options?)` → read cell text through the in-cell editor
- `gsReadContiguousRows(options?)` → detect used rows without hard-scanning arbitrary ranges
- `gsSplitBulletsInRange(rangeRef, options?)` → replace in-cell bullet separators with real new lines
- `gsRebalanceBoldInRange(rangeRef, options?)` → sparse bolding (default: max 1 bold segment per line)
- `gsFormatBulletsInRange(rangeRef, options?)` → split bullets + rebalance bold in one pass
- `gsLogIssue(summary, details?, options?)` → append a JSONL issue entry
- `gsIssueLogPath()` → return default issue log path

## Reliability Rules

- Never hardcode long row scans (`1..80`, `1..200`) when structure is contiguous.
- Use `gsReadContiguousRows({ columns: ['A','B'], startRow: 1, maxRows: 30, emptyStreakStop: 2 })`.
- Always report `scannedRows`, `usedRowCount`, and `stopReason` when summarizing extraction.
- Prefer `gsFormatBulletsInRange()` for multi-cell content cleanup tasks.
- Use `dryRun: true` first for formatting helpers when changing many cells.
- Log every process failure or unexpected behavior with `gsLogIssue(...)`.

## Example: Read Guidelines Table

```js
const meta = await gsGetMeta();
const result = await gsReadContiguousRows({
  columns: ['A', 'B'],
  startRow: 1,
  maxRows: 30,
  emptyStreakStop: 2
});

return {
  sheet: meta,
  scan: {
    scannedRows: result.scannedRows,
    usedRowCount: result.usedRowCount,
    stopReason: result.stopReason
  },
  rows: result.rows
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
