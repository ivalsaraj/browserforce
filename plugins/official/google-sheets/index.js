import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_SCAN_MAX_ROWS = 30;
const DEFAULT_EMPTY_STREAK_STOP = 2;
const DEFAULT_EDITOR_WAIT_MS = 35;
const DEFAULT_MAX_PARALLEL_WORKERS = 4;
const DEFAULT_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_MAX_ENTRIES = 24;
const SUMMARY_CACHE_STATE_KEY = '__gsSummaryCache';
const DEFAULT_LOG_PATH = join(homedir(), '.browserforce', 'logs', 'google-sheets-issues.jsonl');
const SHEETS_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\//;
const DEFAULT_SUGGESTION_STOPWORDS = [
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with', 'without',
];

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

function normalizeWriteEntries(valuesByRef) {
  if (!valuesByRef || typeof valuesByRef !== 'object' || Array.isArray(valuesByRef)) {
    throw new Error('valuesByRef must be an object like { M2: "₹3.0L - ₹3.8L" }');
  }

  const entries = Object.entries(valuesByRef).map(([cellRef, value]) => [
    normalizeCellRef(cellRef),
    String(value ?? ''),
  ]);

  if (entries.length === 0) {
    throw new Error('valuesByRef must include at least one cell');
  }

  return entries;
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

function normalizeExecutionMode(value) {
  if (value === undefined || value === null || value === '') return 'safe';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'safe' || normalized === 'parallel') return normalized;
  throw new Error('executionMode must be one of: safe, parallel');
}

function normalizeVerifyMode(options = {}) {
  if (options.verifyMode === undefined || options.verifyMode === null || options.verifyMode === '') {
    return options.verify === false ? 'none' : 'full';
  }
  const normalized = String(options.verifyMode).trim().toLowerCase();
  if (normalized === 'full' || normalized === 'sample' || normalized === 'none') return normalized;
  throw new Error('verifyMode must be one of: full, sample, none');
}

function normalizeSuggestionStrategy(value) {
  if (value === undefined || value === null || value === '') return 'signal';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'signal' || normalized === 'existing-bold-first') return normalized;
  throw new Error('strategy must be one of: signal, existing-bold-first');
}

function normalizeStopwords(stopwords) {
  const values = Array.isArray(stopwords) && stopwords.length > 0 ? stopwords : DEFAULT_SUGGESTION_STOPWORDS;
  return new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function cleanPhraseToken(word) {
  return String(word || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}/+%↔-]+$/gu, '');
}

function trimStopwordEdges(words, stopwords) {
  const out = [...words];
  while (out.length && stopwords.has(String(out[0] || '').toLowerCase())) out.shift();
  while (out.length && stopwords.has(String(out[out.length - 1] || '').toLowerCase())) out.pop();
  return out;
}

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncatePhraseToWordLimit(text, maxWordsPerPhrase, stopwords) {
  const words = compactWhitespace(text)
    .split(/\s+/)
    .map(cleanPhraseToken)
    .filter(Boolean);
  const trimmed = trimStopwordEdges(words, stopwords);
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxWordsPerPhrase).join(' ');
}

function getTextForRange(text, range) {
  return String(text || '').slice(range.start, range.end);
}

function getSignalPhraseForLine(lineText, maxWordsPerPhrase, stopwords) {
  let segment = compactWhitespace(lineText).replace(/^[-•]\s*/, '').trim();
  if (!segment) return null;

  for (const token of [' - ', ' — ', '. ', '; ', ': ']) {
    const idx = segment.indexOf(token);
    if (idx !== -1) {
      segment = segment.slice(0, idx).trim();
      break;
    }
  }

  return truncatePhraseToWordLimit(segment, maxWordsPerPhrase, stopwords);
}

function suggestBoldPhrasesForText(text, existingRanges = [], options = {}) {
  const strategy = normalizeSuggestionStrategy(options.strategy);
  const maxPhrasesPerLine = Number.isInteger(options.maxPhrasesPerLine) && options.maxPhrasesPerLine > 0
    ? options.maxPhrasesPerLine
    : 1;
  const maxWordsPerPhrase = Number.isInteger(options.maxWordsPerPhrase) && options.maxWordsPerPhrase > 0
    ? options.maxWordsPerPhrase
    : 4;
  const stopwords = normalizeStopwords(options.stopwords);
  const lines = splitLinesWithOffsets(String(text || ''));
  const mergedExisting = mergeRanges(existingRanges || []);
  const suggestions = [];
  const seen = new Set();

  for (const line of lines) {
    const lineSuggestions = [];

    if (strategy === 'existing-bold-first') {
      for (const range of getRangesWithinLine(mergedExisting, line)) {
        const phrase = truncatePhraseToWordLimit(getTextForRange(text, range), maxWordsPerPhrase, stopwords);
        if (!phrase) continue;
        const key = phrase.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lineSuggestions.push(phrase);
        if (lineSuggestions.length >= maxPhrasesPerLine) break;
      }
    }

    if (lineSuggestions.length < maxPhrasesPerLine) {
      const phrase = getSignalPhraseForLine(line.text, maxWordsPerPhrase, stopwords);
      if (phrase) {
        const key = phrase.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          lineSuggestions.push(phrase);
        }
      }
    }

    suggestions.push(...lineSuggestions.slice(0, maxPhrasesPerLine));
  }

  return suggestions;
}

async function readCurrentSelection(page) {
  const raw = await page.evaluate(() => {
    const nameBox = document.querySelector('#t-name-box');
    const rawValue = nameBox
      ? (nameBox.value || nameBox.getAttribute('value') || nameBox.textContent || '')
      : '';
    return {
      rawValue: String(rawValue || '').trim(),
      activeSheetTitle: document.title || '',
    };
  });

  const rangeRefCandidate = raw && typeof raw === 'object' && raw.rangeRef
    ? String(raw.rangeRef || '').trim().toUpperCase()
    : String(raw?.rawValue || raw || '').trim().toUpperCase();

  if (!rangeRefCandidate || !/^([A-Z]+[1-9][0-9]*)(?::([A-Z]+[1-9][0-9]*))?$/.test(rangeRefCandidate)) {
    throw new Error('gsGetSelection() could not resolve the current Google Sheets selection');
  }

  const parsed = parseA1Range(rangeRefCandidate);
  const anchorCell = raw && typeof raw === 'object' && raw.anchorCell
    ? normalizeCellRef(raw.anchorCell)
    : `${parsed.startCol}${parsed.startRow}`;
  const activeSheetTitle = raw && typeof raw === 'object' && raw.activeSheetTitle
    ? String(raw.activeSheetTitle || '').trim()
    : '';

  return {
    anchorCell,
    rangeRef: rangeRefCandidate,
    multiCell: raw && typeof raw === 'object' && typeof raw.multiCell === 'boolean'
      ? raw.multiCell
      : rangeRefCandidate.includes(':'),
    activeSheetTitle,
  };
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

async function writeCellLiteral(page, cellRef, value, options = {}) {
  const ref = normalizeCellRef(cellRef);
  const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS;
  const dryRun = options.dryRun === true;
  const verify = options.verify !== false;

  await openEditorAtCell(page, ref, waitMs);
  const snapshot = await readEditorSnapshot(page);
  const nextText = String(value ?? '');
  const changed = snapshot.text !== nextText || snapshot.boldRanges.length > 0;

  if (!changed) {
    await closeEditor(page, false);
    return {
      ref,
      status: 'unchanged',
      changed: false,
      committed: false,
      verified: false,
      before: snapshot.text,
      after: snapshot.text,
    };
  }

  if (dryRun) {
    await closeEditor(page, false);
    return {
      ref,
      status: 'dry_run',
      changed: true,
      committed: false,
      verified: false,
      before: snapshot.text,
      after: nextText,
      clearedBoldSegments: snapshot.boldRanges.length,
    };
  }

  const write = await writeEditorWithRanges(page, nextText, [], snapshot.baseStyle);
  if (write.after !== nextText) {
    await closeEditor(page, false);
    return {
      ref,
      status: 'error',
      changed: false,
      committed: false,
      verified: false,
      before: snapshot.text,
      after: write.after,
      error: 'text_mismatch_after_write',
    };
  }

  await closeEditor(page, true);

  if (!verify) {
    return {
      ref,
      status: 'ok',
      changed: true,
      committed: true,
      verified: false,
      before: snapshot.text,
      after: nextText,
    };
  }

  await openEditorAtCell(page, ref, waitMs);
  const verifySnapshot = await readEditorSnapshot(page);
  await closeEditor(page, false);
  const verifyOk = verifySnapshot.text === nextText && verifySnapshot.boldRanges.length === 0;

  return {
    ref,
    status: verifyOk ? 'ok' : 'verify_failed',
    changed: true,
    committed: true,
    verified: true,
    before: snapshot.text,
    after: verifySnapshot.text,
    ...(verifyOk ? {} : { error: 'verify_failed' }),
  };
}

async function writeCellsLiteral(page, state, valuesByRef, options = {}) {
  const entries = normalizeWriteEntries(valuesByRef);
  const dryRun = options.dryRun === true;
  const results = [];

  for (const [ref, value] of entries) {
    try {
      results.push(await writeCellLiteral(page, ref, value, options));
    } catch (err) {
      try { await closeEditor(page, false); } catch { /* ignore */ }
      results.push({ ref, status: 'error', changed: false, committed: false, verified: false, error: String(err?.message || err) });
    }
  }

  const changedCount = results.filter((r) => r.changed).length;
  const committedCount = results.filter((r) => r.committed).length;
  const unchangedCount = results.filter((r) => r.status === 'unchanged').length;
  const okCount = results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length;
  const failedCount = results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length;

  if (!dryRun && committedCount > 0) clearSummaryCache(state);

  return {
    total: results.length,
    changed: changedCount,
    committed: committedCount,
    unchanged: unchangedCount,
    ok: okCount,
    failed: failedCount,
    results,
  };
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

async function scanContiguousRows(page, options = {}) {
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
}

async function inferColumnsFromHeaderRow(page, options = {}) {
  const startRow = Number.isInteger(options.startRow) && options.startRow > 0 ? options.startRow : 1;
  const maxColumns = Number.isInteger(options.maxColumns) && options.maxColumns > 0
    ? options.maxColumns
    : 8;
  const emptyColumnStreakStop = Number.isInteger(options.emptyColumnStreakStop) && options.emptyColumnStreakStop > 0
    ? options.emptyColumnStreakStop
    : 1;
  const fallbackColumnsCount = Number.isInteger(options.fallbackColumnsCount) && options.fallbackColumnsCount > 0
    ? options.fallbackColumnsCount
    : 2;
  const startColumn = normalizeColumns([options.startColumn || 'A'])[0];
  const startColIdx = columnToIndex(startColumn);

  const columns = [];
  let seenData = false;
  let emptyStreak = 0;

  for (let i = 0; i < maxColumns; i += 1) {
    const col = indexToColumn(startColIdx + i);
    const { value } = await readCell(page, `${col}${startRow}`, options);
    const nonEmpty = Boolean(String(value || '').trim());
    if (nonEmpty) {
      columns.push(col);
      seenData = true;
      emptyStreak = 0;
      continue;
    }
    if (seenData) {
      emptyStreak += 1;
      if (emptyStreak >= emptyColumnStreakStop) break;
    }
  }

  if (columns.length > 0) return columns;

  const fallback = [];
  const count = Math.min(Math.max(fallbackColumnsCount, 1), maxColumns);
  for (let i = 0; i < count; i += 1) {
    fallback.push(indexToColumn(startColIdx + i));
  }
  return fallback;
}

function getSummaryScanConfig(options = {}, explicitColumns = null) {
  const startRow = Number.isInteger(options.startRow) && options.startRow > 0 ? options.startRow : 1;
  const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0
    ? options.maxRows
    : DEFAULT_SCAN_MAX_ROWS;
  const emptyStreakStop = Number.isInteger(options.emptyStreakStop) && options.emptyStreakStop > 0
    ? options.emptyStreakStop
    : DEFAULT_EMPTY_STREAK_STOP;
  const trim = options.trim !== false;

  if (explicitColumns) {
    return {
      mode: 'explicit',
      columns: explicitColumns,
      startRow,
      maxRows,
      emptyStreakStop,
      trim,
    };
  }

  const maxColumns = Number.isInteger(options.maxColumns) && options.maxColumns > 0
    ? options.maxColumns
    : 8;
  const emptyColumnStreakStop = Number.isInteger(options.emptyColumnStreakStop) && options.emptyColumnStreakStop > 0
    ? options.emptyColumnStreakStop
    : 1;
  const fallbackColumnsCount = Number.isInteger(options.fallbackColumnsCount) && options.fallbackColumnsCount > 0
    ? options.fallbackColumnsCount
    : 2;
  const startColumn = normalizeColumns([options.startColumn || 'A'])[0];

  return {
    mode: 'auto',
    startRow,
    maxRows,
    emptyStreakStop,
    trim,
    startColumn,
    maxColumns,
    emptyColumnStreakStop,
    fallbackColumnsCount,
  };
}

function buildSummaryCacheKey(sheetMeta, options = {}, explicitColumns = null) {
  const identity = {
    spreadsheetId: sheetMeta?.spreadsheetId || null,
    gid: sheetMeta?.gid || null,
  };
  const config = getSummaryScanConfig(options, explicitColumns);
  return JSON.stringify({ identity, config });
}

function getSummaryCacheMap(state) {
  if (!state || typeof state !== 'object') return null;
  if (!(state[SUMMARY_CACHE_STATE_KEY] instanceof Map)) {
    state[SUMMARY_CACHE_STATE_KEY] = new Map();
  }
  return state[SUMMARY_CACHE_STATE_KEY];
}

function readSummaryCacheEntry(state, cacheKey, ttlMs) {
  const cache = getSummaryCacheMap(state);
  if (!cache) return null;

  const entry = cache.get(cacheKey);
  if (!entry) return null;

  const ageMs = Date.now() - entry.cachedAt;
  if (ttlMs >= 0 && ageMs > ttlMs) {
    cache.delete(cacheKey);
    return null;
  }

  return entry;
}

function writeSummaryCacheEntry(state, cacheKey, value) {
  const cache = getSummaryCacheMap(state);
  if (!cache) return;

  cache.delete(cacheKey);
  cache.set(cacheKey, { cachedAt: Date.now(), ...value });

  while (cache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function clearSummaryCache(state) {
  const cache = getSummaryCacheMap(state);
  if (cache) cache.clear();
}

function buildFormatRunConfig(options = {}) {
  return {
    dryRun: options.dryRun === true,
    executionMode: normalizeExecutionMode(options.executionMode),
    verifyMode: normalizeVerifyMode(options),
    waitMs: Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS,
    maxBoldPerLine: Number.isInteger(options.maxBoldPerLine) && options.maxBoldPerLine > 0 ? options.maxBoldPerLine : 1,
    keepExistingFallback: options.keepExistingFallback !== false,
    preferredGlobal: Array.isArray(options.preferredPhrases) ? options.preferredPhrases : [],
    preferredByCell: options.preferredPhrasesByCell && typeof options.preferredPhrasesByCell === 'object'
      ? options.preferredPhrasesByCell
      : {},
    maxConcurrentWorkers: Number.isInteger(options.maxConcurrentWorkers) && options.maxConcurrentWorkers > 0
      ? options.maxConcurrentWorkers
      : DEFAULT_MAX_PARALLEL_WORKERS,
  };
}

function shouldVerifyCell(runConfig, verificationState, changed) {
  if (!changed || runConfig.dryRun) return false;
  if (runConfig.verifyMode === 'none') return false;
  if (runConfig.verifyMode === 'full') return true;
  if (verificationState.sampledCount >= 1) return false;
  verificationState.sampledCount += 1;
  return true;
}

async function formatBulletsCell(page, ref, options = {}, runConfig, verificationState) {
  await openEditorAtCell(page, ref, runConfig.waitMs);
  const snapshot = await readEditorSnapshot(page);
  const transformed = splitBulletsText(snapshot.text, options);
  const postSplitBaseRanges = transformed.length === snapshot.text.length ? snapshot.boldRanges : [];
  const preferredLocal = Array.isArray(runConfig.preferredByCell[ref]) ? runConfig.preferredByCell[ref] : runConfig.preferredGlobal;
  const targetRanges = selectSparseBoldRanges(
    transformed,
    postSplitBaseRanges,
    preferredLocal,
    runConfig.maxBoldPerLine,
    runConfig.keepExistingFallback
  );

  const textChanged = transformed !== snapshot.text;
  const boldChanged = !rangesEqual(snapshot.boldRanges, targetRanges);
  const changed = textChanged || boldChanged;

  if (!changed) {
    await closeEditor(page, false);
    return { ref, status: 'unchanged', changed: false, beforeLines: snapshot.lineCount, afterLines: snapshot.lineCount };
  }

  if (runConfig.dryRun) {
    await closeEditor(page, false);
    return {
      ref,
      status: 'dry_run',
      changed: true,
      textChanged,
      boldChanged,
      beforeLines: snapshot.lineCount,
      afterLines: transformed.split('\n').length,
      beforeBoldSegments: snapshot.boldRanges.length,
      afterBoldSegments: targetRanges.length,
    };
  }

  const write = await writeEditorWithRanges(page, transformed, targetRanges, snapshot.baseStyle);
  if (write.after !== transformed) {
    await closeEditor(page, false);
    return { ref, status: 'error', changed: true, error: 'text_mismatch_after_write' };
  }

  await closeEditor(page, true);

  const shouldVerify = shouldVerifyCell(runConfig, verificationState, true);
  let verifyOk = true;
  if (shouldVerify) {
    await openEditorAtCell(page, ref, runConfig.waitMs);
    const verifySnapshot = await readEditorSnapshot(page);
    await closeEditor(page, false);
    verifyOk = verifySnapshot.text === transformed && rangesEqual(verifySnapshot.boldRanges, targetRanges);
  }

  return {
    ref,
    status: verifyOk ? 'ok' : 'verify_failed',
    changed: true,
    textChanged,
    boldChanged,
    verified: shouldVerify,
    beforeLines: snapshot.lineCount,
    afterLines: transformed.split('\n').length,
    beforeBoldSegments: snapshot.boldRanges.length,
    afterBoldSegments: targetRanges.length,
    ...(verifyOk ? {} : { error: 'verify_failed' }),
  };
}

async function runSequentialFormatting(page, cells, options, runConfig) {
  const verificationState = { sampledCount: 0 };
  const results = [];
  for (const ref of cells) {
    try {
      results.push(await formatBulletsCell(page, ref, options, runConfig, verificationState));
    } catch (err) {
      try { await closeEditor(page, false); } catch { /* ignore */ }
      results.push({ ref, status: 'error', changed: false, error: String(err?.message || err) });
    }
  }
  return {
    results,
    executionModeUsed: 'safe',
    peakConcurrentWorkers: 1,
    fallbackTriggered: false,
    fallbackReason: null,
  };
}

async function syncWorkerPage(workerPage, sourcePage) {
  if (!workerPage || workerPage === sourcePage) return;
  if (typeof workerPage.url === 'function' && typeof workerPage.goto === 'function' && workerPage.url() !== sourcePage.url()) {
    await workerPage.goto(sourcePage.url());
  }
}

async function closeWorkerPages(workerPages, sourcePage) {
  for (const workerPage of workerPages) {
    if (!workerPage || workerPage === sourcePage) continue;
    if (typeof workerPage.close === 'function') {
      try { await workerPage.close(); } catch { /* ignore */ }
    }
  }
}

async function runParallelFormatting(page, ctx, cells, options, runConfig) {
  if (!ctx || typeof ctx.newPage !== 'function' || cells.length < 2) {
    const sequential = await runSequentialFormatting(page, cells, options, { ...runConfig, executionMode: 'safe' });
    return {
      ...sequential,
      fallbackTriggered: runConfig.executionMode === 'parallel',
      fallbackReason: runConfig.executionMode === 'parallel' ? 'parallel mode unavailable' : null,
    };
  }

  const workerCount = Math.max(2, Math.min(runConfig.maxConcurrentWorkers, DEFAULT_MAX_PARALLEL_WORKERS, cells.length));
  const workerPages = [];
  for (let i = 0; i < workerCount; i += 1) {
    const workerPage = await ctx.newPage();
    await syncWorkerPage(workerPage, page);
    workerPages.push(workerPage);
  }

  let nextIndex = 0;
  let fallbackReason = null;
  const resultsByRef = new Map();
  const failedRefs = new Set();

  const workerLoops = workerPages.map(async (workerPage) => {
    const verificationState = { sampledCount: 0 };
    while (!fallbackReason) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= cells.length) return;

      const ref = cells[idx];
      let result;
      try {
        result = await formatBulletsCell(workerPage, ref, options, runConfig, verificationState);
      } catch (err) {
        result = { ref, status: 'error', changed: false, error: String(err?.message || err) };
      }
      resultsByRef.set(ref, result);

      if (result.status === 'error' || result.status === 'verify_failed') {
        fallbackReason = String(result.error || result.status);
        failedRefs.add(ref);
        return;
      }
    }
  });

  await Promise.all(workerLoops);
  await closeWorkerPages(workerPages, page);

  if (!fallbackReason) {
    return {
      results: cells.map((ref) => resultsByRef.get(ref)).filter(Boolean),
      executionModeUsed: 'parallel',
      peakConcurrentWorkers: workerCount,
      fallbackTriggered: false,
      fallbackReason: null,
    };
  }

  const rerunRefs = cells.filter((ref) => failedRefs.has(ref) || !resultsByRef.has(ref));
  const sequential = await runSequentialFormatting(page, rerunRefs, options, { ...runConfig, executionMode: 'safe' });
  for (const result of sequential.results) {
    resultsByRef.set(result.ref, result);
  }

  return {
    results: cells.map((ref) => resultsByRef.get(ref)).filter(Boolean),
    executionModeUsed: 'safe',
    peakConcurrentWorkers: workerCount,
    fallbackTriggered: true,
    fallbackReason,
  };
}

function buildSummaryResult(sheet, columns, scanResult, options = {}) {
  const includeRows = options.includeRows === true;
  const previewRows = Number.isInteger(options.previewRows) && options.previewRows > 0 ? options.previewRows : 8;
  const preview = scanResult.rows.slice(0, previewRows).map((entry) => ({ row: entry.row, cells: entry.cells }));
  const firstDataRow = scanResult.rows[0] || null;
  const headerCandidate = scanResult.rows.find((entry) => entry.row === scanResult.config.startRow) || null;

  return {
    sheet,
    columns,
    scan: {
      scannedRows: scanResult.scannedRows,
      usedRowCount: scanResult.usedRowCount,
      stopReason: scanResult.stopReason,
    },
    firstDataRow: firstDataRow ? { row: firstDataRow.row, cells: firstDataRow.cells } : null,
    headerCandidate: headerCandidate ? { row: headerCandidate.row, cells: headerCandidate.cells } : null,
    preview,
    ...(includeRows ? { rows: scanResult.rows } : {}),
  };
}

const helpers = {
    gsGetMeta: async (page) => {
      assertGoogleSheet(page, 'gsGetMeta');
      const title = await page.title();
      const meta = parseSheetMeta(page.url());
      return { ...meta, title };
    },

    gsGetSelection: async (page) => {
      assertGoogleSheet(page, 'gsGetSelection');
      const selection = await readCurrentSelection(page);
      const meta = parseSheetMeta(page.url());
      return {
        ...selection,
        spreadsheetId: meta.spreadsheetId,
        gid: meta.gid,
      };
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
      return scanContiguousRows(page, options);
    },

    gsWriteCell: async (page, ctx, state, cellRef, value, options = {}) => {
      assertGoogleSheet(page, 'gsWriteCell');
      const result = await writeCellLiteral(page, cellRef, value, options);
      if (options.dryRun !== true && result.committed) clearSummaryCache(state);
      return result;
    },

    gsWriteCells: async (page, ctx, state, valuesByRef, options = {}) => {
      assertGoogleSheet(page, 'gsWriteCells');
      return writeCellsLiteral(page, state, valuesByRef, options);
    },

    gsSuggestBoldPhrases: async (page, ctx, state, rangeRef, options = {}) => {
      assertGoogleSheet(page, 'gsSuggestBoldPhrases');
      const strategy = normalizeSuggestionStrategy(options.strategy);
      const cells = expandA1Range(rangeRef);
      const suggestionsByCell = {};

      for (const ref of cells) {
        await openEditorAtCell(page, ref, Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS);
        try {
          const snapshot = await readEditorSnapshot(page);
          suggestionsByCell[ref] = suggestBoldPhrasesForText(snapshot.text, snapshot.boldRanges, {
            ...options,
            strategy,
          });
        } finally {
          await closeEditor(page, false);
        }
      }

      return {
        rangeRef: String(rangeRef).toUpperCase(),
        total: cells.length,
        strategy,
        suggestionsByCell,
      };
    },

    gsSummarizeSheet: async (page, ctx, state, options = {}) => {
      assertGoogleSheet(page, 'gsSummarizeSheet');
      const title = await page.title();
      const sheetMeta = parseSheetMeta(page.url());
      const sheet = { ...sheetMeta, title };
      const explicitColumns = options.columns ? normalizeColumns(options.columns) : null;
      const forceRefresh = options.forceRefresh === true;
      const useCache = options.useCache !== false;
      const cacheTtlMs = Number.isInteger(options.cacheTtlMs) && options.cacheTtlMs >= 0
        ? options.cacheTtlMs
        : DEFAULT_SUMMARY_CACHE_TTL_MS;
      const cacheKey = buildSummaryCacheKey(sheetMeta, options, explicitColumns);

      if (useCache && !forceRefresh) {
        const cached = readSummaryCacheEntry(state, cacheKey, cacheTtlMs);
        if (cached) {
          return buildSummaryResult(sheet, cached.columns, cached.scanResult, options);
        }
      }

      const columns = explicitColumns || await inferColumnsFromHeaderRow(page, options);
      const scanResult = await scanContiguousRows(page, { ...options, columns });
      if (useCache) {
        writeSummaryCacheEntry(state, cacheKey, { columns, scanResult });
      }

      return buildSummaryResult(sheet, columns, scanResult, options);
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

      const changedCount = results.filter((r) => r.changed).length;
      const unchangedCount = results.filter((r) => r.status === 'unchanged').length;
      const okCount = results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length;
      const failedCount = results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length;

      if (!dryRun && changedCount > 0) clearSummaryCache(state);

      return {
        rangeRef: String(rangeRef),
        total: results.length,
        changed: changedCount,
        unchanged: unchangedCount,
        ok: okCount,
        failed: failedCount,
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

      const changedCount = results.filter((r) => r.changed).length;
      const unchangedCount = results.filter((r) => r.status === 'unchanged').length;
      const okCount = results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length;
      const failedCount = results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length;

      if (!dryRun && changedCount > 0) clearSummaryCache(state);

      return {
        rangeRef: String(rangeRef),
        total: results.length,
        changed: changedCount,
        unchanged: unchangedCount,
        ok: okCount,
        failed: failedCount,
        results,
      };
    },

    gsFormatCurrentSelection: async (page, ctx, state, options = {}) => {
      assertGoogleSheet(page, 'gsFormatCurrentSelection');
      const selection = await helpers.gsGetSelection(page, ctx, state, options);
      const result = await helpers.gsFormatBulletsInRange(page, ctx, state, selection.rangeRef, options);
      return {
        ...result,
        selection,
      };
    },

    gsWriteMultilineCell: async (page, ctx, state, cellRef, lines, options = {}) => {
      assertGoogleSheet(page, 'gsWriteMultilineCell');
      if (!Array.isArray(lines) || lines.length === 0) {
        throw new Error('gsWriteMultilineCell() requires a non-empty array of lines');
      }
      const ref = normalizeCellRef(cellRef);
      const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : DEFAULT_EDITOR_WAIT_MS;
      const verify = options.verify !== false;

      await gotoCell(page, ref);
      await page.keyboard.press('Backspace');
      await pause(page, waitMs);
      await page.keyboard.press('F2');
      await pause(page, waitMs);

      for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) {
          await page.keyboard.press('Alt+Enter');
          await pause(page, 10);
        }
        await page.keyboard.type(String(lines[i] ?? ''), { delay: 0 });
      }

      await page.keyboard.press('Enter');
      await pause(page, waitMs);
      clearSummaryCache(state);

      if (!verify) {
        return { ref, status: 'ok', verified: false, lineCount: lines.length };
      }

      const { value } = await readCell(page, ref, { trim: false, waitMs });
      const actualLines = String(value || '').split('\n');
      const expected = lines.map((l) => String(l ?? ''));
      const match = actualLines.length === expected.length
        && actualLines.every((line, i) => line === expected[i]);

      return {
        ref,
        status: match ? 'ok' : 'verify_failed',
        verified: true,
        lineCount: actualLines.length,
        expectedLineCount: expected.length,
        ...(match ? {} : { error: 'verify_failed', actual: value }),
      };
    },

    gsEditNote: async (page, ctx, state, cellRef, noteText, options = {}) => {
      assertGoogleSheet(page, 'gsEditNote');
      const ref = normalizeCellRef(cellRef);
      const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : 80;
      const verify = options.verify !== false;
      const text = String(noteText ?? '');

      await gotoCell(page, ref);
      await page.keyboard.press('Escape');
      await pause(page, waitMs);
      await page.keyboard.press('Shift+F2');
      await pause(page, waitMs * 2);

      const noteBox = page.locator('textarea[name="Note"], [role="textbox"][aria-label*="Note"]');
      await noteBox.fill(text);
      await pause(page, waitMs);
      await page.keyboard.press('Escape');
      await pause(page, waitMs);

      if (!verify) {
        return { ref, status: 'ok', verified: false };
      }

      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const found = bodyText.includes(text.slice(0, 60));
      return {
        ref,
        status: found ? 'ok' : 'verify_failed',
        verified: true,
        ...(found ? {} : { error: 'note_text_not_found_on_page' }),
      };
    },

    gsFormatBulletsInRange: async (page, ctx, state, rangeRef, options = {}) => {
      assertGoogleSheet(page, 'gsFormatBulletsInRange');
      const cells = expandA1Range(rangeRef);
      const runConfig = buildFormatRunConfig(options);
      const runResult = runConfig.executionMode === 'parallel'
        ? await runParallelFormatting(page, ctx, cells, options, runConfig)
        : await runSequentialFormatting(page, cells, options, runConfig);
      const results = runResult.results;

      const changedCount = results.filter((r) => r.changed).length;
      const unchangedCount = results.filter((r) => r.status === 'unchanged').length;
      const okCount = results.filter((r) => r.status === 'ok' || r.status === 'dry_run').length;
      const failedCount = results.filter((r) => r.status === 'error' || r.status === 'verify_failed').length;

      if (!runConfig.dryRun && changedCount > 0) clearSummaryCache(state);

      return {
        rangeRef: String(rangeRef),
        executionModeRequested: runConfig.executionMode,
        executionModeUsed: runResult.executionModeUsed,
        verifyMode: runConfig.verifyMode,
        peakConcurrentWorkers: runResult.peakConcurrentWorkers,
        fallbackTriggered: runResult.fallbackTriggered,
        fallbackReason: runResult.fallbackReason,
        total: results.length,
        changed: changedCount,
        unchanged: unchangedCount,
        ok: okCount,
        failed: failedCount,
        results,
      };
    },
};

// Canonical helper naming convention: <prefix>__<action>.
helpers.gs__getMeta = helpers.gsGetMeta;
helpers.gs__getSelection = helpers.gsGetSelection;
helpers.gs__gotoCell = helpers.gsGotoCell;
helpers.gs__readCell = helpers.gsReadCell;
helpers.gs__readContiguousRows = helpers.gsReadContiguousRows;
helpers.gs__writeCell = helpers.gsWriteCell;
helpers.gs__writeCells = helpers.gsWriteCells;
helpers.gs__suggestBoldPhrases = helpers.gsSuggestBoldPhrases;
helpers.gs__summarizeSheet = helpers.gsSummarizeSheet;
helpers.gs__splitBulletsInRange = helpers.gsSplitBulletsInRange;
helpers.gs__rebalanceBoldInRange = helpers.gsRebalanceBoldInRange;
helpers.gs__formatCurrentSelection = helpers.gsFormatCurrentSelection;
helpers.gs__formatBulletsInRange = helpers.gsFormatBulletsInRange;
helpers.gs__writeMultilineCell = helpers.gsWriteMultilineCell;
helpers.gs__editNote = helpers.gsEditNote;
helpers.gs__logIssue = helpers.gsLogIssue;
helpers.gs__issueLogPath = helpers.gsIssueLogPath;

export default {
  name: 'google-sheets',
  description: 'Google Sheets helpers for selection-aware formatting, row scanning, cell reads, and issue logging',
  version: '1.0.0',
  helpers,
};
