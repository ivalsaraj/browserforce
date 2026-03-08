---
name: google-sheets
description: Google Sheets helpers for reading, surgical editing, writing (including multiline and notes), selection-aware formatting, summarizing, and issue logging in the active sheet.
when_to_use: ["Summarizing an active Google Sheet quickly", "Reading specific cells or contiguous used rows", "Formatting the current cell or selection without guesswork", "Applying bullet splitting and sparse bold formatting across ranges", "Editing formatted cell text without losing untouched formatting", "Writing or replacing multiline cell content reliably", "Editing cell notes (Shift+F2 workflow)", "Logging extraction or formatting failures for follow-up"]
helper_prefix: gs
helpers: ["gs__getMeta", "gs__getSelection", "gs__gotoCell", "gs__readCell", "gs__readContiguousRows", "gs__writeCell", "gs__writeCells", "gs__applyCellEdits", "gs__appendToCell", "gs__insertInCell", "gs__replaceInCell", "gs__extractFromCell", "gs__writeMultilineCell", "gs__editNote", "gs__suggestBoldPhrases", "gs__summarizeSheet", "gs__splitBulletsInRange", "gs__rebalanceBoldInRange", "gs__formatCurrentSelection", "gs__formatBulletsInRange", "gs__logIssue", "gs__issueLogPath"]
helper_aliases: ["gsGetMeta", "gsGetSelection", "gsGotoCell", "gsReadCell", "gsReadContiguousRows", "gsWriteCell", "gsWriteCells", "gsApplyCellEdits", "gsAppendToCell", "gsInsertInCell", "gsReplaceInCell", "gsExtractFromCell", "gsWriteMultilineCell", "gsEditNote", "gsSuggestBoldPhrases", "gsSummarizeSheet", "gsSplitBulletsInRange", "gsRebalanceBoldInRange", "gsFormatCurrentSelection", "gsFormatBulletsInRange", "gsLogIssue", "gsIssueLogPath"]
tools: []
---

## google-sheets plugin

Use Google Sheets helpers when work involves reading, summarizing, or structuring sheet content from the active page without guesswork.

Tool naming note:
- The same browser tool may appear as `execute` or `BrowserForce:execute`.
- Treat both labels as the same BrowserForce execution path.

Available helpers:
- `gs__getMeta()` → current spreadsheet id + gid + title + URL
- `gs__getSelection()` → active cell/range as A1 notation without DOM guessing
- `gs__gotoCell(cellRef)` → jump to a cell using the Sheets name box
- `gs__readCell(cellRef, options?)` → read cell text through the in-cell editor
- `gs__readContiguousRows(options?)` → detect used rows without hard-scanning arbitrary ranges
- `gs__writeCell(cellRef, value, options?)` → write exact literal text into one cell (single-line or simple content)
- `gs__writeCells(valuesByRef, options?)` → write exact literal text into multiple cells with per-cell verification
- `gs__applyCellEdits(cellRef, edits, options?)` → one-shot append/insert/replace/delete transaction for a single formatted cell
- `gs__appendToCell(cellRef, appendText, options?)` → append text without disturbing untouched formatting
- `gs__insertInCell(cellRef, insert, options?)` → insert text at an exact index in one pass
- `gs__replaceInCell(cellRef, match, replacement, options?)` → replace a specific match while preserving untouched formatting
- `gs__extractFromCell(cellRef, match, options?)` → preview exact substring matches without mutating the cell
- `gs__writeMultilineCell(cellRef, lines, options?)` → keyboard-based multiline write (Backspace → F2 → Alt+Enter per line) — use for replacing existing multiline/bullet cells where `gs__writeCell` flattens content
- `gs__editNote(cellRef, noteText, options?)` → edit a cell note via Shift+F2 note editor — full note replacement in one shot
- `gs__suggestBoldPhrases(rangeRef, options?)` → propose 1-2 emphasis phrases per cell without writing
- `gs__summarizeSheet(options?)` → one-call summary payload (sheet meta + scan stats + preview rows)
- `gs__splitBulletsInRange(rangeRef, options?)` → replace in-cell bullet separators with real new lines
- `gs__rebalanceBoldInRange(rangeRef, options?)` → sparse bolding (default: max 1 bold segment per line)
- `gs__formatCurrentSelection(options?)` → format the current selection using the existing range formatter
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

## One-Shot Edit Protocol (Mandatory)

Every cell edit follows one-shot discipline: read current content, compose full final content, write once, format once, verify once.

- Never patch the same cell repeatedly in fragments.
- If verification fails, restart from the original cell content — do not stack more partial edits.
- For cells with leading special characters (₹, $, etc.), test one cell first and verify immediately before batching.

### Choosing the Right Write Helper

| Situation | Helper | Why |
|-----------|--------|-----|
| Single-line or simple text | `gs__writeCell` | DOM-based write, fast and reliable for single-line |
| Surgical inline edit inside formatted content | `gs__applyCellEdits` | Preserves untouched rich-text formatting in one verified pass |
| Replacing existing multiline/bullet content | `gs__writeMultilineCell` | Keyboard-based (Backspace → F2 → Alt+Enter), avoids flattening |
| Multiple single-line cells | `gs__writeCells` | Batched `gs__writeCell` with per-cell verification |
| Cell note | `gs__editNote` | Shift+F2 note editor, full note replacement |

### Multiline Cell Replacement

`gs__writeCell` manipulates the DOM editor directly — this can flatten or append content when replacing existing multiline cells. Use `gs__writeMultilineCell` instead:

```js
await gs__writeMultilineCell('F2', [
  '- Ships review-ready PRs on time',
  '- Follows sprint timeline with clear ownership',
  '- Escalates blockers proactively',
], { verify: true });
```

### Surgical Inline Edits

Use `gs__applyCellEdits()` when the cell already contains formatting you need to preserve.

```js
await gs__applyCellEdits('D4', [
  { type: 'replace', match: { text: 'with', occurrence: 1 }, replacement: 'by' },
  { type: 'append', text: '\n- Added follow-up note' },
], { verify: true });
```

For simpler one-off cases, use the thin wrappers:

```js
await gs__appendToCell('D4', ' Gamma', { verify: true });
await gs__replaceInCell('D4', { text: 'Beta', occurrence: 2 }, 'Delta', { verify: true });
const preview = await gs__extractFromCell('D4', { text: 'Beta' });
```

### Note Editing

Notes are stable clarification for future readers (prefer notes over comments for durable guidance). Use `gs__editNote` for the Shift+F2 note editor flow:

```js
await gs__editNote('K2', 'AI-AUTO: Fully automated by AI.\n\nAI-LED: AI does primary work, dev reviews.\n\nDEV-LED: Dev does primary work, AI assists.', { verify: true });
```

Leave one blank line between each definition or paragraph block in notes for scanability.

### Scratch-Cell Testing Rule

If the same write/edit roadblock occurs twice on live cells, stop and move to a scratch area (e.g., Z50+) to isolate the problem, make sure these scratch pad will not affect working cells. Only return to live cells after validating a working method on scratch cells, clean the scratch cells after use as it's a critical doc.

## Reliability Rules

- Never hardcode long row scans (`1..80`, `1..200`) when structure is contiguous.
- Use `gs__readContiguousRows({ columns: ['A','B'], startRow: 1, maxRows: 30, emptyStreakStop: 2 })`.
- Always report `scannedRows`, `usedRowCount`, and `stopReason` when summarizing extraction.
- For summary requests, prefer `gs__summarizeSheet()` over ad-hoc DOM probing loops.
- `gs__summarizeSheet()` reuses a recent in-session scan by default; set `forceRefresh: true` when the user asks for a guaranteed fresh pull.
- Use `gs__getSelection()` or `gs__formatCurrentSelection()` when the user refers to "this cell" or "current selection".
- Use `gs__writeCell()` or `gs__writeCells()` for plain-text cell updates.
- Use `gs__applyCellEdits()` for append/insert/replace/delete changes inside already-formatted cells.
- Use `gs__suggestBoldPhrases()` when phrase choice matters and you want a preview before writing.
- Prefer `gs__formatBulletsInRange()` for multi-cell content cleanup tasks.
- Use `dryRun: true` first for formatting helpers when changing many cells.
- Formatting defaults to `executionMode: 'safe'` and `verifyMode: 'full'`.
- Use `executionMode: 'parallel'` only when the user explicitly asks for speed or parallel execution.
- Log every process failure or unexpected behavior with `gs__logIssue(...)`.
- Literal writes replace rich-text styling in the target cell; use `gs__applyCellEdits()` when existing inline formatting must survive the edit.

## Guardrails (Google Sheets)

- Do not switch to `/export`, `/gviz`, CSV downloads, or out-of-page fetch flows unless the user explicitly asks for export data.
- Do not open extra tabs for summary-only requests.
- Do not infer cell content from toolbar/status text when table rows are available via helpers.
- Do not write through `#t-formula-bar-input` with `fill`, `page.evaluate`, `innerHTML`, or `textContent` hacks when a literal cell update is needed.
- If a literal write fails verification, log the issue and stop. Do not retry with `UNICHAR`, invisible prefix characters, or alternate spellings like `Rs.` unless the user explicitly wants that fallback.

## Anti-Patterns (Do NOT Do These)

- **Partial patching**: Editing the same cell repeatedly in fragments instead of composing full content first.
- **Using `gs__writeCell` for multiline replacement**: DOM-based write flattens/appends existing multiline content. Use `gs__writeMultilineCell`.
- **Stacking retries on live cells**: After second failure on the same cell, switch to scratch-cell testing.
- **Updating note and cell in separate logical passes**: Compose final state for both, write each once.
- **Claiming success before visible verification**: Always verify the final cell/note state matches expected output.
- **Using comments for durable clarification**: Comments collapse behind show-more flows. Use notes for persistent guidance.
- **Dense notes without blank lines**: Leave one blank line between sections/paragraphs in notes for readability.

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

## Example: Safe Literal Cell Writes

```js
const result = await gs__writeCells({
  M1: 'Package (₹ LPA)',
  M2: '₹3.0L - ₹3.8L',
  M3: '₹3.8L - ₹5.0L'
}, {
  verify: true
});

return result;
```

## Example: Follow the Current Selection

```js
const selection = await gs__getSelection();
const suggestions = await gs__suggestBoldPhrases(selection.rangeRef, {
  maxPhrasesPerLine: 1,
  strategy: 'signal'
});

return { selection, suggestions };
```

## Example: Explicit Parallel Formatting

```js
const result = await gs__formatBulletsInRange('D2:D20', {
  executionMode: 'parallel',
  verifyMode: 'sample',
  maxConcurrentWorkers: 3
});

return {
  executionModeRequested: result.executionModeRequested,
  executionModeUsed: result.executionModeUsed,
  fallbackTriggered: result.fallbackTriggered,
  peakConcurrentWorkers: result.peakConcurrentWorkers
};
```
