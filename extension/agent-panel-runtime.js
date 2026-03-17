export function getSessionRunId(currentRunBySession, sessionId) {
  if (!sessionId) return null;
  return currentRunBySession?.[sessionId] || null;
}

export function assignSessionRunId(currentRunBySession, sessionId, runId) {
  if (!sessionId || !runId) return currentRunBySession || {};
  return {
    ...(currentRunBySession || {}),
    [sessionId]: runId,
  };
}

export function clearSessionRunId(currentRunBySession, sessionId, runId) {
  if (!sessionId) return currentRunBySession || {};
  const next = { ...(currentRunBySession || {}) };
  if (!runId || next[sessionId] === runId) {
    delete next[sessionId];
  }
  return next;
}

export function shouldApplySessionSelection({ requestToken, latestRequestToken, requestedSessionId, activeSessionId }) {
  return (
    requestToken === latestRequestToken
    && requestedSessionId === activeSessionId
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchFencedBlockStart(line) {
  const match = String(line || '').match(/^\s*(`{3,}|~{3,})\s*([\w+-]+)?\s*$/);
  if (!match) return null;
  return {
    fence: match[1],
    language: String(match[2] || '').trim().toLowerCase(),
  };
}

function isFencedBlockClose(line, fence) {
  if (!fence) return false;
  const fenceChar = fence[0];
  const fenceLength = fence.length;
  const matcher = new RegExp(`^\\s*${escapeRegex(fenceChar)}{${fenceLength},}\\s*$`);
  return matcher.test(String(line || ''));
}

function isMarkdownHeading(line) {
  return /^\s{0,3}#{1,6}\s+\S/.test(String(line || ''));
}

function isMarkdownHorizontalRule(line) {
  return /^\s{0,3}(?:\*{3,}|-{3,}|_{3,})\s*$/.test(String(line || ''));
}

function isMarkdownBlockquote(line) {
  return /^\s{0,3}>\s?/.test(String(line || ''));
}

function matchMarkdownListItem(line) {
  const match = String(line || '').match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/);
  if (!match) return null;
  const marker = match[2];
  return {
    indent: match[1].length,
    ordered: /\d+\./.test(marker),
    content: String(match[3] || '').trim(),
  };
}

function isMarkdownTableSeparator(line) {
  const normalized = String(line || '').trim();
  if (!normalized.includes('|')) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(normalized);
}

function splitMarkdownTableRow(line) {
  const raw = String(line || '').trim();
  if (!raw) return [];
  const startTrimmed = raw.startsWith('|') ? raw.slice(1) : raw;
  const value = startTrimmed.endsWith('|') ? startTrimmed.slice(0, -1) : startTrimmed;
  return value.split('|').map((cell) => cell.trim());
}

function parseMarkdownTableAlignments(separatorLine) {
  const cells = splitMarkdownTableRow(separatorLine);
  return cells.map((cell) => {
    const value = String(cell || '').trim();
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
}

function looksLikeImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  const cleaned = value.split('#')[0].split('?')[0];
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(cleaned);
}

function normalizeRenderableUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return value;
}

function isLocalAbsolutePath(value) {
  return /^\/(?!\/)/.test(String(value || '').trim());
}

function isSafeRenderableUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  return (
    /^https?:\/\//i.test(value)
    || /^file:\/\//i.test(value)
    || /^blob:/i.test(value)
    || /^data:image\//i.test(value)
    || /^(?:\.{1,2}\/)/.test(value)
    || /^\/(?!\/)/.test(value)
  );
}

const GOOGLE_SHEETS_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/edit/i;
const GOOGLE_SHEETS_MAX_COLUMN_INDEX = 18278; // ZZZ
const GOOGLE_SHEETS_MAX_ROW = 1048576;
const GOOGLE_SHEETS_REF_RE = /([a-z]{1,4}\d{1,7}(?::[a-z]{1,4}\d{1,7})?|[a-z]{1,4}:[a-z]{1,4}|\d{1,7}:\d{1,7})/gi;

function columnToIndex(column) {
  let value = 0;
  for (const ch of String(column || '').toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    value = (value * 26) + (code - 64);
  }
  return value || null;
}

function isValidRowValue(value) {
  const row = Number(value);
  return Number.isInteger(row) && row >= 1 && row <= GOOGLE_SHEETS_MAX_ROW;
}

function isValidColumnValue(value) {
  const index = columnToIndex(value);
  return Number.isInteger(index) && index >= 1 && index <= GOOGLE_SHEETS_MAX_COLUMN_INDEX;
}

function normalizeGoogleSheetsRangeRef(value) {
  const ref = String(value || '').trim();
  if (!ref) return null;

  const cellRangeMatch = ref.match(/^([a-z]{1,4})(\d{1,7})(?::([a-z]{1,4})(\d{1,7}))?$/i);
  if (cellRangeMatch) {
    const startColumn = cellRangeMatch[1].toUpperCase();
    const startRow = Number(cellRangeMatch[2]);
    const endColumn = (cellRangeMatch[3] || startColumn).toUpperCase();
    const endRow = Number(cellRangeMatch[4] || startRow);
    if (!isValidColumnValue(startColumn) || !isValidColumnValue(endColumn)) return null;
    if (!isValidRowValue(startRow) || !isValidRowValue(endRow)) return null;
    return cellRangeMatch[3] ? `${startColumn}${startRow}:${endColumn}${endRow}` : `${startColumn}${startRow}`;
  }

  const columnRangeMatch = ref.match(/^([a-z]{1,4}):([a-z]{1,4})$/i);
  if (columnRangeMatch) {
    const startColumn = columnRangeMatch[1].toUpperCase();
    const endColumn = columnRangeMatch[2].toUpperCase();
    if (!isValidColumnValue(startColumn) || !isValidColumnValue(endColumn)) return null;
    return `${startColumn}:${endColumn}`;
  }

  const rowRangeMatch = ref.match(/^(\d{1,7}):(\d{1,7})$/);
  if (rowRangeMatch) {
    const startRow = Number(rowRangeMatch[1]);
    const endRow = Number(rowRangeMatch[2]);
    if (!isValidRowValue(startRow) || !isValidRowValue(endRow)) return null;
    return `${startRow}:${endRow}`;
  }

  return null;
}

function isSheetRefBoundaryChar(value) {
  return /[A-Za-z0-9_/-]/.test(String(value || ''));
}

function shouldLinkGoogleSheetsRef(text, startIndex, rawMatch) {
  const previousChar = startIndex > 0 ? text[startIndex - 1] : '';
  const nextChar = text[startIndex + rawMatch.length] || '';
  const nextNextChar = text[startIndex + rawMatch.length + 1] || '';
  if (isSheetRefBoundaryChar(previousChar) || isSheetRefBoundaryChar(nextChar)) return false;
  const normalized = normalizeGoogleSheetsRangeRef(rawMatch);
  if (!normalized) return false;
  if (/^\d+:\d+$/.test(normalized) && nextChar === ':') return false;
  if (/^[A-Z]+\d+(?::[A-Z]+\d+)?$/i.test(rawMatch) && nextChar === '.' && /\d/.test(nextNextChar)) return false;
  return true;
}

function renderInlineGoogleSheetsRefs(text, store) {
  return String(text || '').replace(GOOGLE_SHEETS_REF_RE, (rawMatch, _capture, offset, source) => {
    if (!shouldLinkGoogleSheetsRef(source, offset, rawMatch)) return rawMatch;
    const normalized = normalizeGoogleSheetsRangeRef(rawMatch);
    if (!normalized) return rawMatch;
    return store.put(
      `<a class="inline-link inline-sheet-ref" href="#" data-sheet-range-ref="${escapeHtml(normalized)}">${escapeHtml(rawMatch)}</a>`,
    );
  });
}

export function buildGoogleSheetsRangeUrl(activeTabUrl, rangeRef) {
  const normalizedRange = normalizeGoogleSheetsRangeRef(rangeRef);
  if (!normalizedRange) return null;

  let url;
  try {
    url = new URL(String(activeTabUrl || ''));
  } catch {
    return null;
  }

  if (!GOOGLE_SHEETS_URL_RE.test(url.toString())) return null;

  const currentHashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const gid = Number.parseInt(currentHashParams.get('gid') || '', 10);
  const nextHashParams = new URLSearchParams();
  nextHashParams.set('gid', Number.isInteger(gid) && gid >= 0 ? String(gid) : '0');
  nextHashParams.set('range', normalizedRange);
  url.hash = nextHashParams.toString();
  return url.toString();
}

export function splitDeltaForDisplayStreaming(
  delta,
  {
    chunkTargetChars = 24,
    chunkLookaheadChars = 14,
  } = {},
) {
  const text = String(delta || '');
  if (!text) return [];
  if (text.length <= chunkTargetChars) return [text];
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + chunkTargetChars, text.length);
    if (end < text.length) {
      const lookahead = text.slice(end, Math.min(end + chunkLookaheadChars, text.length));
      const wsIndex = lookahead.search(/\s/);
      if (wsIndex >= 0) end += wsIndex + 1;
    }
    if (end <= cursor) end = Math.min(cursor + chunkTargetChars, text.length);
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export function buildDisplayStreamEvents(
  evt,
  {
    chunkTargetChars = 24,
    chunkLookaheadChars = 14,
  } = {},
) {
  if (!evt || typeof evt !== 'object') return [];

  const eventType = String(evt.event || '');
  const isDeltaEvent = eventType === 'chat.delta' || eventType === 'chat.commentary';
  const isFinalEvent = eventType === 'chat.final';
  if (!isDeltaEvent && !isFinalEvent) return [evt];

  const sourceText = isFinalEvent
    ? String(evt.payload?.text || '')
    : String(evt.payload?.delta || '');
  const chunks = splitDeltaForDisplayStreaming(sourceText, {
    chunkTargetChars,
    chunkLookaheadChars,
  });
  if (chunks.length <= 1) return [evt];

  if (isFinalEvent) {
    return chunks.map((chunk, index) => {
      if (index === chunks.length - 1) {
        return {
          ...evt,
          payload: {
            ...(evt.payload || {}),
            text: chunk,
          },
        };
      }
      return {
        ...evt,
        event: 'chat.delta',
        payload: {
          ...(evt.payload || {}),
          delta: chunk,
        },
      };
    });
  }

  return chunks.map((chunk) => ({
    ...evt,
    payload: {
      ...(evt.payload || {}),
      delta: chunk,
    },
  }));
}

function createMarkdownTokenStore() {
  const tokens = [];
  return {
    put(html) {
      const key = `__BF_INLINE_TOKEN_${tokens.length}__`;
      tokens.push({ key, html });
      return key;
    },
    apply(text) {
      let output = text;
      for (const token of tokens) {
        output = output.replaceAll(token.key, token.html);
      }
      return output;
    },
  };
}

export function renderInlineContent(value) {
  const store = createMarkdownTokenStore();
  const source = String(value ?? '');

  const withCodeTokens = source.replace(/`([^`\n]+)`/g, (_match, codeRaw) => {
    const sheetRef = normalizeGoogleSheetsRangeRef(codeRaw.trim());
    if (sheetRef) {
      return store.put(
        `<a class="inline-link inline-sheet-ref" href="#" data-sheet-range-ref="${escapeHtml(sheetRef)}">${escapeHtml(codeRaw)}</a>`,
      );
    }
    return store.put(`<code>${escapeHtml(codeRaw)}</code>`);
  });

  const withImageAndLinks = withCodeTokens.replace(/(!)?\[([^\]]*)\]\(([^)]+)\)/g, (match, imageMark, labelRaw, urlRaw) => {
    const normalizedUrl = normalizeRenderableUrl(urlRaw);
    const localAbsolutePath = isLocalAbsolutePath(normalizedUrl);
    if (!localAbsolutePath && !isSafeRenderableUrl(normalizedUrl)) return match;

    if (imageMark || looksLikeImageUrl(urlRaw)) {
      const altText = String(labelRaw || '').trim() || 'Screenshot';
      const alt = escapeHtml(altText);
      if (localAbsolutePath) {
        const localPath = escapeHtml(normalizedUrl);
        return store.put(
          `<span class="inline-image-link local-image" data-local-path="${localPath}"><img class="inline-image inline-local-image" data-local-path="${localPath}" alt="${alt}" loading="lazy"></span>`,
        );
      }

      const href = escapeHtml(normalizedUrl);
      return store.put(
        `<a class="inline-image-link" href="${href}" target="_blank" rel="noopener noreferrer"><img class="inline-image" src="${href}" alt="${alt}" loading="lazy"></a>`,
      );
    }

    if (localAbsolutePath) return match;

    const href = escapeHtml(normalizedUrl);
    const label = escapeHtml(String(labelRaw || '').trim() || normalizedUrl);
    return store.put(`<a class="inline-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });

  const withAutolinks = withImageAndLinks.replace(/(^|[\s(>])((https?:\/\/[^\s<]+))/g, (match, prefix, urlRaw) => {
    const normalizedUrl = normalizeRenderableUrl(urlRaw);
    if (!isSafeRenderableUrl(normalizedUrl)) return match;
    const href = escapeHtml(normalizedUrl);
    const label = escapeHtml(urlRaw);
    return `${prefix}${store.put(`<a class="inline-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)}`;
  });

  const withSheetRefs = renderInlineGoogleSheetsRefs(withAutolinks, store);
  const escaped = escapeHtml(withSheetRefs);
  const withEmphasis = escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return store.apply(withEmphasis);
}

function isMarkdownBlockStarter(line, nextLine = '') {
  if (!String(line || '').trim()) return true;
  if (matchFencedBlockStart(line)) return true;
  if (isMarkdownHeading(line)) return true;
  if (isMarkdownHorizontalRule(line)) return true;
  if (isMarkdownBlockquote(line)) return true;
  if (matchMarkdownListItem(line)) return true;
  if (String(line || '').includes('|') && isMarkdownTableSeparator(nextLine)) return true;
  return false;
}

function renderMarkdownListBlock(lines, startIndex) {
  let index = startIndex;
  let html = '';
  let currentType = null;
  let items = [];

  const flush = () => {
    if (!items.length || !currentType) return;
    const tag = currentType === 'ol' ? 'ol' : 'ul';
    const itemsHtml = items.map((item) => {
      const task = String(item || '').match(/^\[( |x|X)\]\s+([\s\S]+)$/);
      if (!task) {
        return `<li>${renderInlineContent(item).replace(/\n/g, '<br>')}</li>`;
      }
      const checked = String(task[1]).toLowerCase() === 'x';
      return `
        <li class="md-task-item">
          <span class="md-task-box${checked ? ' checked' : ''}" aria-hidden="true"></span>
          <span>${renderInlineContent(task[2]).replace(/\n/g, '<br>')}</span>
        </li>
      `;
    }).join('');
    html += `<${tag} class="md-list">${itemsHtml}</${tag}>`;
    items = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!String(line || '').trim()) break;
    const item = matchMarkdownListItem(line);
    if (item) {
      const nextType = item.ordered ? 'ol' : 'ul';
      if (currentType && currentType !== nextType) {
        flush();
      }
      currentType = nextType;
      let itemText = item.content;
      index += 1;
      while (index < lines.length) {
        const continuation = lines[index];
        if (!String(continuation || '').trim()) break;
        if (matchMarkdownListItem(continuation)) break;
        if (isMarkdownBlockStarter(continuation, lines[index + 1])) break;
        if (/^\s{2,}\S/.test(continuation)) {
          itemText += `\n${continuation.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      items.push(itemText);
      continue;
    }
    break;
  }

  flush();
  return { html, nextIndex: index };
}

function renderMarkdownTableBlock(lines, startIndex) {
  const headerCells = splitMarkdownTableRow(lines[startIndex]);
  const alignments = parseMarkdownTableAlignments(lines[startIndex + 1]);
  let index = startIndex + 2;
  const bodyRows = [];

  while (index < lines.length) {
    const line = String(lines[index] || '');
    if (!line.trim() || !line.includes('|')) break;
    bodyRows.push(splitMarkdownTableRow(line));
    index += 1;
  }

  const headHtml = `<tr>${headerCells.map((cell, cellIndex) => {
    const align = alignments[cellIndex] ? ` style="text-align:${alignments[cellIndex]};"` : '';
    return `<th${align}>${renderInlineContent(cell)}</th>`;
  }).join('')}</tr>`;

  const bodyHtml = bodyRows.map((row) => (
    `<tr>${row.map((cell, cellIndex) => {
      const align = alignments[cellIndex] ? ` style="text-align:${alignments[cellIndex]};"` : '';
      return `<td${align}>${renderInlineContent(cell)}</td>`;
    }).join('')}</tr>`
  )).join('');

  return {
    html: `<div class="md-table-wrap"><table class="md-table"><thead>${headHtml}</thead>${bodyRows.length ? `<tbody>${bodyHtml}</tbody>` : ''}</table></div>`,
    nextIndex: index,
  };
}

function renderMarkdownBlocks(source) {
  const normalized = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const chunks = [];
  let index = 0;

  while (index < lines.length) {
    const line = String(lines[index] || '');
    const nextLine = String(lines[index + 1] || '');
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenced = matchFencedBlockStart(line);
    if (fenced) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !isFencedBlockClose(lines[index], fenced.fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = /^[a-z0-9_-]{1,32}$/i.test(fenced.language) ? fenced.language : '';
      const className = language ? ` class="language-${escapeHtml(language)}"` : '';
      chunks.push(`
        <div class="md-pre-wrap">
          <button type="button" class="md-copy-btn" data-md-copy-code aria-label="Copy code block" title="Copy code block">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <rect x="9" y="9" width="13" height="13" rx="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span class="sr-only">Copy code block</span>
          </button>
          <pre class="md-pre"><code${className}>${escapeHtml(codeLines.join('\n'))}</code></pre>
        </div>
      `);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      chunks.push(`<h${level} class="md-h${level}">${renderInlineContent(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isMarkdownHorizontalRule(line)) {
      chunks.push('<hr class="md-hr">');
      index += 1;
      continue;
    }

    if (isMarkdownBlockquote(line)) {
      const quoteLines = [];
      while (index < lines.length && isMarkdownBlockquote(lines[index])) {
        quoteLines.push(String(lines[index] || '').replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      const quoteInner = renderMarkdownBlocks(quoteLines.join('\n'));
      chunks.push(`<blockquote class="md-blockquote">${quoteInner || '<p></p>'}</blockquote>`);
      continue;
    }

    if (matchMarkdownListItem(line)) {
      const list = renderMarkdownListBlock(lines, index);
      if (list.html) chunks.push(list.html);
      index = list.nextIndex;
      continue;
    }

    if (line.includes('|') && isMarkdownTableSeparator(nextLine)) {
      const table = renderMarkdownTableBlock(lines, index);
      chunks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length) {
      const candidate = String(lines[index] || '');
      const candidateNext = String(lines[index + 1] || '');
      if (!candidate.trim()) break;
      if (isMarkdownBlockStarter(candidate, candidateNext)) break;
      paragraphLines.push(candidate);
      index += 1;
    }
    const paragraphText = paragraphLines.join('\n');
    chunks.push(`<p>${renderInlineContent(paragraphText).replace(/\n/g, '<br>')}</p>`);
  }

  return chunks.join('');
}

export function renderMarkdownContent(value) {
  const html = renderMarkdownBlocks(value);
  if (!html) return '';
  return `<div class="md-content">${html}</div>`;
}

export function getLatestInFlightStepIndex(run = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  if (!steps.length || run?.done) return -1;
  return steps.length - 1;
}

export function classifyRunStepIcon(step = {}) {
  const status = String(step.status || '').toLowerCase();
  if (status === 'failed') return 'failed';
  if (status === 'done' || /\bdone\b/.test(String(step.label || '').toLowerCase())) return 'done';

  const label = String(step.label || '').toLowerCase();
  const kind = String(step.kind || '').toLowerCase();

  if (kind === 'reasoning') return 'reasoning';

  if (/screenshot|screen shot|capture|image/.test(label)) return 'camera';
  if (/extract|read|open|search|scan|inspect|lookup|page text|document/.test(label)) return 'view';
  if (/plan|steps|todo|checklist/.test(label)) return 'plan';
  if (kind === 'tool') return 'tool';
  return 'reasoning';
}

function normalizeUsageValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

export function shouldShowBottomScrollFade({ scrollTop, scrollHeight, clientHeight, tolerancePx = 1 } = {}) {
  const top = Number(scrollTop);
  const height = Number(scrollHeight);
  const viewport = Number(clientHeight);
  const tolerance = Number(tolerancePx);
  const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 1;

  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(viewport)) return false;
  if ((height - viewport) <= safeTolerance) return false;
  return (top + viewport) < (height - safeTolerance);
}

export function formatMessageTimestampForHover(value, { now = Date.now(), locale, timeZone } = {}) {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;

  const reference = new Date(now);
  if (Number.isNaN(reference.getTime())) return null;

  const ageMs = Math.abs(reference.getTime() - timestamp.getTime());
  const withinDay = ageMs < 24 * 60 * 60 * 1000;
  const formatOptions = withinDay
    ? {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }
    : {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    };

  if (timeZone) formatOptions.timeZone = timeZone;
  return timestamp.toLocaleString(locale || undefined, formatOptions);
}

export function formatContextUsage({ totalTokens, modelContextWindow } = {}) {
  const total = normalizeUsageValue(totalTokens);
  if (total == null) return null;
  const windowSize = normalizeUsageValue(modelContextWindow);
  if (windowSize == null) return `${total.toLocaleString()} tokens`;
  const percent = ((total / windowSize) * 100).toFixed(1);
  return `${total.toLocaleString()} / ${windowSize.toLocaleString()} (${percent}%)`;
}

function slugifyFilePart(value, fallback = 'browserforce-response') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function formatFileTimestamp(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return 'export';
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

export function isCompletedFinalResponseActionable({
  role = 'assistant',
  done = false,
  isFinalVisibleResponse = false,
  text = '',
} = {}) {
  return (
    String(role || '').toLowerCase() === 'assistant'
    && !!done
    && !!isFinalVisibleResponse
    && String(text || '').trim().length > 0
  );
}

export function buildFinalResponseMarkdownExport({
  markdown = '',
  sessionTitle = '',
  createdAt = null,
} = {}) {
  const content = String(markdown ?? '');
  return {
    fileName: `${slugifyFilePart(sessionTitle)}-${formatFileTimestamp(createdAt)}.md`,
    content,
    mimeType: 'text/markdown;charset=utf-8',
  };
}

export function buildFinalResponsePrintDocument({
  markdown = '',
  sessionTitle = '',
  createdAt = null,
} = {}) {
  const printableTitle = String(sessionTitle || 'BrowserForce Response').trim() || 'BrowserForce Response';
  const timestamp = createdAt ? formatMessageTimestampForHover(createdAt) : null;
  const bodyHtml = renderMarkdownContent(markdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(printableTitle)}</title>
  <style>
    :root {
      color-scheme: light;
      --bf-text: #2e2419;
      --bf-muted: #6b6358;
      --bf-line: #ddd8cf;
      --bf-line-soft: #ede9e2;
      --bf-linen: #f9f7f4;
      --bf-sand: #eae6de;
      --bf-crail-dark: #a34e30;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: var(--bf-text);
      background: #fff;
    }
    .export-shell {
      max-width: 840px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .export-header {
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-bottom: 1px solid var(--bf-line);
      padding-bottom: 12px;
    }
    .export-title {
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
      margin: 0;
    }
    .export-meta {
      font-size: 12px;
      color: var(--bf-muted);
      margin: 0;
    }
    .md-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 14px;
      line-height: 1.6;
    }
    .md-content p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .md-content h1, .md-content h2, .md-content h3, .md-content h4, .md-content h5, .md-content h6 {
      margin: 0;
      line-height: 1.28;
      color: var(--bf-text);
    }
    .md-content .md-h1 { font-size: 24px; font-weight: 700; }
    .md-content .md-h2 { font-size: 20px; font-weight: 700; }
    .md-content .md-h3 { font-size: 17px; font-weight: 650; }
    .md-content .md-h4, .md-content .md-h5, .md-content .md-h6 { font-size: 15px; font-weight: 650; }
    .md-content .md-list { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
    .md-content .md-blockquote {
      margin: 0;
      padding: 8px 12px;
      border-left: 3px solid var(--bf-line);
      background: var(--bf-linen);
      border-radius: 0 8px 8px 0;
    }
    .md-content .md-pre {
      margin: 0;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid var(--bf-line);
      background: #f6f4ef;
      overflow: hidden;
      white-space: pre-wrap;
    }
    .md-content .md-pre code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .md-content .md-copy-btn { display: none !important; }
    .md-content .md-table-wrap {
      overflow-x: auto;
      max-width: 100%;
    }
    .md-content .md-table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--bf-line);
      font-size: 12px;
    }
    .md-content .md-table th,
    .md-content .md-table td {
      border: 1px solid var(--bf-line);
      padding: 6px 8px;
      vertical-align: top;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .md-content .md-table th {
      background: var(--bf-linen);
      font-weight: 600;
    }
    .md-content code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      background: var(--bf-sand);
      color: var(--bf-crail-dark);
      padding: 2px 6px;
      border-radius: 6px;
    }
    .md-content .inline-image,
    .md-content .inline-local-image {
      max-width: 100%;
      height: auto;
      border-radius: 10px;
      border: 1px solid var(--bf-line-soft);
    }
    .md-content .md-hr {
      border: 0;
      border-top: 1px solid var(--bf-line);
      margin: 4px 0;
    }
    @page { margin: 16mm; }
    @media print {
      body { padding: 0; }
      .export-shell { max-width: none; }
      .md-content .md-table-wrap { overflow: visible; }
    }
  </style>
</head>
<body>
  <main class="export-shell">
    <header class="export-header">
      <h1 class="export-title">${escapeHtml(printableTitle)}</h1>
      ${timestamp ? `<p class="export-meta">${escapeHtml(timestamp)}</p>` : ''}
    </header>
    ${bodyHtml}
  </main>
</body>
</html>`;
}
