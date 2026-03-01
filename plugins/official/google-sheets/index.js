import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_SCAN_MAX_ROWS = 30;
const DEFAULT_EMPTY_STREAK_STOP = 2;
const DEFAULT_EDITOR_WAIT_MS = 35;
const DEFAULT_LOG_PATH = join(homedir(), '.browserforce', 'logs', 'google-sheets-issues.jsonl');
const SHEETS_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\//;

function assertPage(page, helperName) {
  if (!page || typeof page.url !== 'function') {
    throw new Error(`${helperName}() requires an active page`);
  }
}

function assertGoogleSheet(page, helperName) {
  assertPage(page, helperName);
  const url = String(page.url() || '');
  if (!SHEETS_URL_RE.test(url)) {
    throw new Error(`${helperName}() requires a Google Sheets page, got: ${url || 'unknown URL'}`);
  }
}

function normalizeCellRef(cellRef) {
  const ref = String(cellRef || '').toUpperCase().trim();
  if (!/^[A-Z]+[1-9][0-9]*$/.test(ref)) {
    throw new Error(`Invalid cell reference: "${cellRef}"`);
  }
  return ref;
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('columns must be a non-empty array like ["A", "B"]');
  }
  return columns.map((value) => {
    const col = String(value || '').toUpperCase().trim();
    if (!/^[A-Z]+$/.test(col)) {
      throw new Error(`Invalid column value: "${value}"`);
    }
    return col;
  });
}

function columnToIndex(column) {
  let value = 0;
  for (const ch of String(column || '')) {
    value = value * 26 + (ch.charCodeAt(0) - 64);
  }
  return value;
}

function indexToColumn(index) {
  let n = Number(index);
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseA1Range(rangeRef) {
  const ref = String(rangeRef || '').toUpperCase().trim();
  const m = ref.match(/^([A-Z]+)([1-9][0-9]*)(?::([A-Z]+)([1-9][0-9]*))?$/);
  if (!m) throw new Error(`Invalid A1 range: "${rangeRef}"`);

  const startCol = m[1];
  const startRow = Number(m[2]);
  const endCol = m[3] || startCol;
  const endRow = m[4] ? Number(m[4]) : startRow;

  const startColIdx = columnToIndex(startCol);
  const endColIdx = columnToIndex(endCol);
  const colMin = Math.min(startColIdx, endColIdx);
  const colMax = Math.max(startColIdx, endColIdx);
  const rowMin = Math.min(startRow, endRow);
  const rowMax = Math.max(startRow, endRow);

  return {
    startCol: indexToColumn(colMin),
    endCol: indexToColumn(colMax),
    startColIdx: colMin,
    endColIdx: colMax,
    startRow: rowMin,
    endRow: rowMax,
  };
}

function expandA1Range(rangeRef) {
  const parsed = parseA1Range(rangeRef);
  const refs = [];
  for (let r = parsed.startRow; r <= parsed.endRow; r += 1) {
    for (let c = parsed.startColIdx; c <= parsed.endColIdx; c += 1) {
      refs.push(`${indexToColumn(c)}${r}`);
    }
  }
  return refs;
}

function parseSheetMeta(urlRaw) {
  const fallback = {
    spreadsheetId: null,
    gid: null,
    url: String(urlRaw || ''),
  };
  try {
    const url = new URL(String(urlRaw || ''));
    const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    const gidFromQuery = url.searchParams.get('gid');
    const gidFromHash = (url.hash.match(/gid=(\d+)/) || [])[1] || null;
    return {
      spreadsheetId: match ? match[1] : null,
      gid: gidFromQuery || gidFromHash || null,
      url: url.toString(),
    };
  } catch {
    return fallback;
  }
}

async function pause(page, ms = DEFAULT_EDITOR_WAIT_MS) {
  if (!ms || ms < 1) return;
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function gotoCell(page, cellRef) {
  const ref = normalizeCellRef(cellRef);
  const box = page.locator('#t-name-box');
  await box.click();
  await box.fill(ref);
  await page.keyboard.press('Enter');
  return ref;
}

async function openEditorAtCell(page, cellRef, waitMs = DEFAULT_EDITOR_WAIT_MS) {
  const ref = await gotoCell(page, cellRef);
  await page.keyboard.press('F2');
  await pause(page, waitMs);
  return ref;
}

async function closeEditor(page, commit = false) {
  await page.keyboard.press(commit ? 'Enter' : 'Escape');
}

function mergeRanges(ranges = []) {
  const normalized = ranges
    .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const r of normalized) {
    if (!merged.length || r.start > merged[merged.length - 1].end) {
      merged.push({ ...r });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    }
  }
  return merged;
}

function rangesEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  }
  return true;
}

function overlapsAny(range, ranges) {
  return ranges.some((r) => !(range.end <= r.start || range.start >= r.end));
}

function findNonOverlappingRanges(text, phrases = []) {
  if (!Array.isArray(phrases) || phrases.length === 0) return [];
  const occ = [];
  for (const rawPhrase of phrases) {
    const phrase = String(rawPhrase || '');
    if (!phrase) continue;
    let idx = 0;
    while (idx <= text.length) {
      const found = text.indexOf(phrase, idx);
      if (found === -1) break;
      occ.push({ start: found, end: found + phrase.length });
      idx = found + phrase.length;
    }
  }
  occ.sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen = [];
  for (const r of occ) {
    if (!overlapsAny(r, chosen)) chosen.push(r);
  }
  return mergeRanges(chosen);
}

function splitLinesWithOffsets(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const end = start + line.length;
    out.push({ index: i, text: line, start, end });
    start = end + 1; // account for newline
  }
  return out;
}

function getRangesWithinLine(ranges, line) {
  return ranges.filter((r) => r.start >= line.start && r.end <= line.end);
}

function selectSparseBoldRanges(text, existingRanges, preferredPhrases, maxBoldPerLine, keepExistingFallback = true) {
  const maxPerLine = Number.isInteger(maxBoldPerLine) && maxBoldPerLine > 0 ? maxBoldPerLine : 1;
  const preferredRanges = findNonOverlappingRanges(text, preferredPhrases || []);
  const existingMerged = mergeRanges(existingRanges || []);
  const lines = splitLinesWithOffsets(text);

  const chosen = [];
  for (const line of lines) {
    const picks = [];

    const fromPreferred = getRangesWithinLine(preferredRanges, line);
    for (const r of fromPreferred) {
      if (picks.length >= maxPerLine) break;
      if (!overlapsAny(r, picks)) picks.push(r);
    }

    if (keepExistingFallback && picks.length < maxPerLine) {
      const fromExisting = getRangesWithinLine(existingMerged, line);
      for (const r of fromExisting) {
        if (picks.length >= maxPerLine) break;
        if (!overlapsAny(r, picks)) picks.push(r);
      }
    }

    chosen.push(...picks);
  }

  return mergeRanges(chosen);
}

function splitBulletsText(text, options = {}) {
  const pattern = options.separatorPattern || '\\s-\\s';
  const flags = options.separatorFlags || 'g';
  const replacement = options.replacement || '\n- ';
  const re = new RegExp(pattern, flags);
  return String(text || '').replace(re, replacement);
}

function defaultStyle() {
  return "font-size:13px;color:#000000;font-weight:normal;text-decoration:none;font-family:'Arial';font-style:normal;text-decoration-skip-ink:none;";
}

async function readEditorText(page, { trim = true } = {}) {
  const raw = await page.evaluate(() => {
    const editor = document.querySelector('#waffle-rich-text-editor');
    if (!editor) return null;
    return editor.innerText.replace(/\n+$/g, '');
  });
  if (raw === null) {
    throw new Error('Cannot read Google Sheets editor (#waffle-rich-text-editor not found)');
  }
  return trim ? raw.trim() : raw;
}

async function readEditorSnapshot(page) {
  const data = await page.evaluate(() => {
    const editor = document.querySelector('#waffle-rich-text-editor');
    if (!editor) return null;

    const text = editor.innerText.replace(/\n+$/g, '');
    const firstSpan = editor.querySelector('span');
    const baseStyle = firstSpan?.getAttribute('style') || '';

    const isBoldElement = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === 'B' || el.tagName === 'STRONG') return true;
      const fw = getComputedStyle(el).fontWeight;
      return fw === 'bold' || Number(fw) >= 600;
    };

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const ranges = [];
    let node;
    let offset = 0;
    while ((node = walker.nextNode())) {
      const t = node.textContent || '';
      const start = offset;
      const end = offset + t.length;
      let p = node.parentElement;
      let bold = false;
      while (p && p !== editor) {
        if (isBoldElement(p)) {
          bold = true;
          break;
        }
        p = p.parentElement;
      }
      if (bold && t.length) ranges.push({ start, end });
      offset = end;
    }

    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const r of ranges) {
      if (!merged.length || r.start > merged[merged.length - 1].end) {
        merged.push({ start: r.start, end: r.end });
      } else {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
      }
    }

    return {
      text,
      baseStyle,
      boldRanges: merged,
      lineCount: text.split('\n').length,
    };
  });

  if (!data) throw new Error('Cannot read Google Sheets editor snapshot');
  return {
    text: data.text,
    baseStyle: data.baseStyle || defaultStyle(),
    boldRanges: mergeRanges(data.boldRanges),
    lineCount: data.lineCount,
  };
}

async function writeEditorWithRanges(page, text, boldRanges, baseStyle) {
  const result = await page.evaluate(({ textValue, ranges, style }) => {
    const editor = document.querySelector('#waffle-rich-text-editor');
    if (!editor) return null;

    const normalizedStyle = style || "font-size:13px;color:#000000;font-weight:normal;text-decoration:none;font-family:'Arial';font-style:normal;text-decoration-skip-ink:none;";
    const boldStyle = /font-weight\s*:/i.test(normalizedStyle)
      ? normalizedStyle.replace(/font-weight\s*:\s*[^;]+/i, 'font-weight:bold')
      : `${normalizedStyle};font-weight:bold`;

    const merged = [];
    const sorted = (ranges || [])
      .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const r of sorted) {
      const start = Math.max(0, Math.min(textValue.length, r.start));
      const end = Math.max(0, Math.min(textValue.length, r.end));
      if (end <= start) continue;
      if (!merged.length || start > merged[merged.length - 1].end) {
        merged.push({ start, end });
      } else {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, end);
      }
    }

    while (editor.firstChild) editor.removeChild(editor.firstChild);

    const appendChunk = (chunk, useBold) => {
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].length > 0) {
          const span = document.createElement('span');
          span.setAttribute('style', useBold ? boldStyle : normalizedStyle);
          span.appendChild(document.createTextNode(lines[i]));
          editor.appendChild(span);
        }
        if (i < lines.length - 1) editor.appendChild(document.createElement('br'));
      }
    };

    let pos = 0;
    for (const r of merged) {
      if (r.start > pos) appendChunk(textValue.slice(pos, r.start), false);
      appendChunk(textValue.slice(r.start, r.end), true);
      pos = r.end;
    }
    if (pos < textValue.length) appendChunk(textValue.slice(pos), false);
    editor.appendChild(document.createElement('br'));

    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const after = editor.innerText.replace(/\n+$/g, '');
    return { after, lineCount: after.split('\n').length };
  }, { textValue: text, ranges: boldRanges, style: baseStyle });

  if (!result) throw new Error('Failed to write Google Sheets editor content');
  return result;
}

async function readCell(page, cellRef, options = {}) {
  const { trim = true, waitMs = DEFAULT_EDITOR_WAIT_MS } = options;
  const ref = await gotoCell(page, cellRef);
  await page.keyboard.press('F2');
  await pause(page, waitMs);
  let value;
  try {
    value = await readEditorText(page, { trim });
  } finally {
    await page.keyboard.press('Escape');
  }
  return { ref, value };
}

async function readRow(page, row, columns, options) {
  const cells = {};
  for (const col of columns) {
    const { value } = await readCell(page, `${col}${row}`, options);
    cells[col] = value;
  }
  return cells;
}

function hasData(cells) {
  return Object.values(cells).some((value) => Boolean(String(value || '').trim()));
}

export default {
  name: 'google-sheets',
  description: 'Google Sheets helpers for reliable row scanning, cell reads, and issue logging',
  version: '1.0.0',
  helpers: {
    gsGetMeta: async (page) => {
      assertGoogleSheet(page, 'gsGetMeta');
      const title = await page.title();
      const meta = parseSheetMeta(page.url());
      return { ...meta, title };
    },

    gsGotoCell: async (page, ctx, state, cellRef) => {
      assertGoogleSheet(page, 'gsGotoCell');
      const ref = await gotoCell(page, cellRef);
      return { ok: true, ref };
    },

    gsReadCell: async (page, ctx, state, cellRef, options = {}) => {
      assertGoogleSheet(page, 'gsReadCell');
      const { ref, value } = await readCell(page, cellRef, options);
      return { ref, value };
    },

    gsReadContiguousRows: async (page, ctx, state, options = {}) => {
      assertGoogleSheet(page, 'gsReadContiguousRows');

      const columns = normalizeColumns(options.columns || ['A', 'B']);
      const startRow = Number.isInteger(options.startRow) && options.startRow > 0 ? options.startRow : 1;
      const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0
        ? options.maxRows
        : DEFAULT_SCAN_MAX_ROWS;
      const emptyStreakStop = Number.isInteger(options.emptyStreakStop) && options.emptyStreakStop > 0
        ? options.emptyStreakStop
        : DEFAULT_EMPTY_STREAK_STOP;

      const rows = [];
      let scannedRows = 0;
      let seenData = false;
      let emptyStreak = 0;
      let stopReason = 'max_rows_reached';

      for (let i = 0; i < maxRows; i += 1) {
        const row = startRow + i;
        const cells = await readRow(page, row, columns, options);
        scannedRows += 1;

        if (hasData(cells)) {
          rows.push({ row, cells });
          seenData = true;
          emptyStreak = 0;
          continue;
        }

        if (seenData) {
          emptyStreak += 1;
          if (emptyStreak >= emptyStreakStop) {
            stopReason = 'empty_streak_stop';
            break;
          }
        }
      }

      return {
        rows,
        scannedRows,
        usedRowCount: rows.length,
        stopReason,
        config: { columns, startRow, maxRows, emptyStreakStop },
      };
    },

    gsLogIssue: async (page, ctx, state, summary, details = {}, options = {}) => {
      const text = String(summary || '').trim();
      if (!text) throw new Error('gsLogIssue() requires a non-empty summary');

      const logPath = String(options.logPath || DEFAULT_LOG_PATH);
      const entry = {
        ts: new Date().toISOString(),
        summary: text,
        details: details && typeof details === 'object' ? details : { note: String(details) },
        pageUrl: page && typeof page.url === 'function' ? page.url() : null,
        pageTitle: page && typeof page.title === 'function' ? await page.title() : null,
      };

      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
      return { ok: true, logPath, entry };
    },

    gsIssueLogPath: async () => ({ logPath: DEFAULT_LOG_PATH }),

    gsSplitBulletsInRange: async (page, ctx, state, rangeRef, options = {}) => {
      assertGoogleSheet(page, 'gsSplitBulletsInRange');
      const cells = expandA1Range(rangeRef);
      const dryRun = options.dryRun === true;
      const verify = options.verify !== false;
      const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS;

      const results = [];
      for (const ref of cells) {
        try {
          await openEditorAtCell(page, ref, waitMs);
          const snapshot = await readEditorSnapshot(page);
          const transformed = splitBulletsText(snapshot.text, options);
          const changed = transformed !== snapshot.text;

          if (!changed) {
            await closeEditor(page, false);
            results.push({ ref, status: 'unchanged', changed: false, beforeLines: snapshot.lineCount, afterLines: snapshot.lineCount });
            continue;
          }

          const preservedRanges = transformed.length === snapshot.text.length ? snapshot.boldRanges : [];
          if (dryRun) {
            await closeEditor(page, false);
            results.push({
              ref,
              status: 'dry_run',
              changed: true,
              beforeLines: snapshot.lineCount,
              afterLines: transformed.split('\n').length,
              droppedBoldRanges: transformed.length !== snapshot.text.length,
            });
            continue;
          }

          const write = await writeEditorWithRanges(page, transformed, preservedRanges, snapshot.baseStyle);
          if (write.after !== transformed) {
            await closeEditor(page, false);
            results.push({ ref, status: 'error', changed: true, error: 'text_mismatch_after_write' });
            continue;
          }

          await closeEditor(page, true);

          let verifyOk = true;
          if (verify) {
            await openEditorAtCell(page, ref, waitMs);
            const verifySnapshot = await readEditorSnapshot(page);
            await closeEditor(page, false);
            verifyOk = verifySnapshot.text === transformed;
          }

          results.push({
            ref,
            status: verifyOk ? 'ok' : 'verify_failed',
            changed: true,
            beforeLines: snapshot.lineCount,
            afterLines: transformed.split('\n').length,
          });
        } catch (err) {
          try { await closeEditor(page, false); } catch { /* ignore */ }
          results.push({ ref, status: 'error', changed: false, error: String(err?.message || err) });
        }
      }

      return {
        rangeRef: String(rangeRef),
        total: results.length,
        changed: results.filter((r) => r.changed).length,
        unchanged: results.filter((r) => r.status === 'unchanged').length,
        ok: results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length,
        failed: results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length,
        results,
      };
    },

    gsRebalanceBoldInRange: async (page, ctx, state, rangeRef, options = {}) => {
      assertGoogleSheet(page, 'gsRebalanceBoldInRange');
      const cells = expandA1Range(rangeRef);
      const dryRun = options.dryRun === true;
      const verify = options.verify !== false;
      const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS;
      const maxBoldPerLine = Number.isInteger(options.maxBoldPerLine) && options.maxBoldPerLine > 0 ? options.maxBoldPerLine : 1;
      const keepExistingFallback = options.keepExistingFallback !== false;
      const preferredGlobal = Array.isArray(options.preferredPhrases) ? options.preferredPhrases : [];
      const preferredByCell = options.preferredPhrasesByCell && typeof options.preferredPhrasesByCell === 'object'
        ? options.preferredPhrasesByCell
        : {};

      const results = [];
      for (const ref of cells) {
        try {
          await openEditorAtCell(page, ref, waitMs);
          const snapshot = await readEditorSnapshot(page);
          const preferredLocal = Array.isArray(preferredByCell[ref]) ? preferredByCell[ref] : preferredGlobal;
          const targetRanges = selectSparseBoldRanges(
            snapshot.text,
            snapshot.boldRanges,
            preferredLocal,
            maxBoldPerLine,
            keepExistingFallback
          );

          const changed = !rangesEqual(snapshot.boldRanges, targetRanges);
          if (!changed) {
            await closeEditor(page, false);
            results.push({ ref, status: 'unchanged', changed: false, lineCount: snapshot.lineCount, boldSegments: targetRanges.length });
            continue;
          }

          if (dryRun) {
            await closeEditor(page, false);
            results.push({
              ref,
              status: 'dry_run',
              changed: true,
              lineCount: snapshot.lineCount,
              beforeBoldSegments: snapshot.boldRanges.length,
              afterBoldSegments: targetRanges.length,
            });
            continue;
          }

          const write = await writeEditorWithRanges(page, snapshot.text, targetRanges, snapshot.baseStyle);
          if (write.after !== snapshot.text) {
            await closeEditor(page, false);
            results.push({ ref, status: 'error', changed: true, error: 'text_changed_while_rebalancing' });
            continue;
          }

          await closeEditor(page, true);

          let verifyOk = true;
          if (verify) {
            await openEditorAtCell(page, ref, waitMs);
            const verifySnapshot = await readEditorSnapshot(page);
            await closeEditor(page, false);
            verifyOk = verifySnapshot.text === snapshot.text && rangesEqual(verifySnapshot.boldRanges, targetRanges);
          }

          results.push({
            ref,
            status: verifyOk ? 'ok' : 'verify_failed',
            changed: true,
            lineCount: snapshot.lineCount,
            beforeBoldSegments: snapshot.boldRanges.length,
            afterBoldSegments: targetRanges.length,
          });
        } catch (err) {
          try { await closeEditor(page, false); } catch { /* ignore */ }
          results.push({ ref, status: 'error', changed: false, error: String(err?.message || err) });
        }
      }

      return {
        rangeRef: String(rangeRef),
        total: results.length,
        changed: results.filter((r) => r.changed).length,
        unchanged: results.filter((r) => r.status === 'unchanged').length,
        ok: results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length,
        failed: results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length,
        results,
      };
    },

    gsFormatBulletsInRange: async (page, ctx, state, rangeRef, options = {}) => {
      assertGoogleSheet(page, 'gsFormatBulletsInRange');
      const cells = expandA1Range(rangeRef);
      const dryRun = options.dryRun === true;
      const verify = options.verify !== false;
      const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS;
      const maxBoldPerLine = Number.isInteger(options.maxBoldPerLine) && options.maxBoldPerLine > 0 ? options.maxBoldPerLine : 1;
      const keepExistingFallback = options.keepExistingFallback !== false;
      const preferredGlobal = Array.isArray(options.preferredPhrases) ? options.preferredPhrases : [];
      const preferredByCell = options.preferredPhrasesByCell && typeof options.preferredPhrasesByCell === 'object'
        ? options.preferredPhrasesByCell
        : {};

      const results = [];
      for (const ref of cells) {
        try {
          await openEditorAtCell(page, ref, waitMs);
          const snapshot = await readEditorSnapshot(page);
          const transformed = splitBulletsText(snapshot.text, options);
          const postSplitBaseRanges = transformed.length === snapshot.text.length ? snapshot.boldRanges : [];
          const preferredLocal = Array.isArray(preferredByCell[ref]) ? preferredByCell[ref] : preferredGlobal;
          const targetRanges = selectSparseBoldRanges(
            transformed,
            postSplitBaseRanges,
            preferredLocal,
            maxBoldPerLine,
            keepExistingFallback
          );

          const textChanged = transformed !== snapshot.text;
          const boldChanged = !rangesEqual(snapshot.boldRanges, targetRanges);
          const changed = textChanged || boldChanged;

          if (!changed) {
            await closeEditor(page, false);
            results.push({ ref, status: 'unchanged', changed: false, beforeLines: snapshot.lineCount, afterLines: snapshot.lineCount });
            continue;
          }

          if (dryRun) {
            await closeEditor(page, false);
            results.push({
              ref,
              status: 'dry_run',
              changed: true,
              textChanged,
              boldChanged,
              beforeLines: snapshot.lineCount,
              afterLines: transformed.split('\n').length,
              beforeBoldSegments: snapshot.boldRanges.length,
              afterBoldSegments: targetRanges.length,
            });
            continue;
          }

          const write = await writeEditorWithRanges(page, transformed, targetRanges, snapshot.baseStyle);
          if (write.after !== transformed) {
            await closeEditor(page, false);
            results.push({ ref, status: 'error', changed: true, error: 'text_mismatch_after_write' });
            continue;
          }

          await closeEditor(page, true);

          let verifyOk = true;
          if (verify) {
            await openEditorAtCell(page, ref, waitMs);
            const verifySnapshot = await readEditorSnapshot(page);
            await closeEditor(page, false);
            verifyOk = verifySnapshot.text === transformed && rangesEqual(verifySnapshot.boldRanges, targetRanges);
          }

          results.push({
            ref,
            status: verifyOk ? 'ok' : 'verify_failed',
            changed: true,
            textChanged,
            boldChanged,
            beforeLines: snapshot.lineCount,
            afterLines: transformed.split('\n').length,
            beforeBoldSegments: snapshot.boldRanges.length,
            afterBoldSegments: targetRanges.length,
          });
        } catch (err) {
          try { await closeEditor(page, false); } catch { /* ignore */ }
          results.push({ ref, status: 'error', changed: false, error: String(err?.message || err) });
        }
      }

      return {
        rangeRef: String(rangeRef),
        total: results.length,
        changed: results.filter((r) => r.changed).length,
        unchanged: results.filter((r) => r.status === 'unchanged').length,
        ok: results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length,
        failed: results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length,
        results,
      };
    },
  },
};
