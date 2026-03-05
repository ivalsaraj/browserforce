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

  const withCodeTokens = source.replace(/`([^`\n]+)`/g, (_match, codeRaw) => (
    store.put(`<code>${escapeHtml(codeRaw)}</code>`)
  ));

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

  const escaped = escapeHtml(withAutolinks);
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
    html: `<table class="md-table"><thead>${headHtml}</thead>${bodyRows.length ? `<tbody>${bodyHtml}</tbody>` : ''}</table>`,
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
      chunks.push(`<pre class="md-pre"><code${className}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
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

export function formatContextUsage({ totalTokens, modelContextWindow } = {}) {
  const total = normalizeUsageValue(totalTokens);
  const windowSize = normalizeUsageValue(modelContextWindow);
  if (total == null || windowSize == null) return null;
  const percent = ((total / windowSize) * 100).toFixed(1);
  return `${total.toLocaleString()} / ${windowSize.toLocaleString()} (${percent}%)`;
}
