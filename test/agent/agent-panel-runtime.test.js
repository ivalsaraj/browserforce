import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSessionRunId,
  buildGoogleSheetsRangeUrl,
  buildFinalResponseMarkdownExport,
  buildFinalResponsePrintDocument,
  classifyRunStepIcon,
  formatMessageTimestampForHover,
  clearSessionRunId,
  formatContextUsage,
  getLatestInFlightStepIndex,
  isCompletedFinalResponseActionable,
  getSessionRunId,
  renderMarkdownContent,
  renderInlineContent,
  shouldShowBottomScrollFade,
  shouldApplySessionSelection,
} from '../../extension/agent-panel-runtime.js';

test('run ids are scoped per session', () => {
  let mapping = {};
  mapping = assignSessionRunId(mapping, 's1', 'r1');
  mapping = assignSessionRunId(mapping, 's2', 'r2');

  assert.equal(getSessionRunId(mapping, 's1'), 'r1');
  assert.equal(getSessionRunId(mapping, 's2'), 'r2');
  assert.equal(getSessionRunId(mapping, 's3'), null);

  mapping = clearSessionRunId(mapping, 's1', 'r1');
  assert.equal(getSessionRunId(mapping, 's1'), null);
  assert.equal(getSessionRunId(mapping, 's2'), 'r2');
});

test('stale selection requests are rejected after async load', () => {
  const stale = shouldApplySessionSelection({
    requestToken: 1,
    latestRequestToken: 2,
    requestedSessionId: 's1',
    activeSessionId: 's2',
  });
  assert.equal(stale, false);

  const current = shouldApplySessionSelection({
    requestToken: 2,
    latestRequestToken: 2,
    requestedSessionId: 's2',
    activeSessionId: 's2',
  });
  assert.equal(current, true);
});

test('classifies step icons from reasoning/tool labels', () => {
  assert.equal(classifyRunStepIcon({ kind: 'reasoning', label: 'Let me create a plan first' }), 'reasoning');
  assert.equal(classifyRunStepIcon({ kind: 'tool', label: 'Extract page text' }), 'view');
  assert.equal(classifyRunStepIcon({ kind: 'tool', label: 'Take screenshot' }), 'camera');
  assert.equal(classifyRunStepIcon({ kind: 'tool', label: 'Created a plan' }), 'plan');
  assert.equal(classifyRunStepIcon({ kind: 'status', status: 'done', label: 'Done' }), 'done');
  assert.equal(classifyRunStepIcon({ kind: 'status', status: 'failed', label: 'Failed' }), 'failed');
});

test('renders safe inline markdown for bold and code spans', () => {
  assert.equal(renderInlineContent('**Inspect active tab**'), '<strong>Inspect active tab</strong>');
  assert.equal(renderInlineContent('Use `snapshot()` now'), 'Use <code>snapshot()</code> now');
  assert.equal(
    renderInlineContent('**<script>alert(1)</script>**'),
    '<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>',
  );
});

test('renders screenshot markdown links as image previews', () => {
  const rendered = renderInlineContent('- Screenshot saved: [shopify-direct-1772647808095.png](/tmp/shopify-direct-1772647808095.png)');
  assert.match(rendered, /Screenshot saved:/);
  assert.match(rendered, /class="inline-image-link local-image"/);
  assert.match(rendered, /inline-local-image/);
  assert.match(rendered, /data-local-path="\/tmp\/shopify-direct-1772647808095\.png"/);
  assert.doesNotMatch(rendered, /file:\/\/\/tmp\//);
});

test('renders non-image markdown links as clickable anchors', () => {
  const rendered = renderInlineContent('Open [BrowserForce](https://github.com/ivalsaraj/browserforce)');
  assert.match(rendered, /class="inline-link"/);
  assert.match(rendered, /href="https:\/\/github\.com\/ivalsaraj\/browserforce"/);
});

test('renders standalone google sheets refs as clickable anchors', () => {
  const rendered = renderInlineContent('Check D4, d5, F2:L11, A:A, and 1:1 next.');
  assert.match(rendered, /data-sheet-range-ref="D4"[^>]*>D4<\/a>/);
  assert.match(rendered, /data-sheet-range-ref="D5"[^>]*>d5<\/a>/);
  assert.match(rendered, /data-sheet-range-ref="F2:L11"[^>]*>F2:L11<\/a>/);
  assert.match(rendered, /data-sheet-range-ref="A:A"[^>]*>A:A<\/a>/);
  assert.match(rendered, /data-sheet-range-ref="1:1"[^>]*>1:1<\/a>/);
});

test('does not render google sheets refs inside markdown links, code spans, or fenced code blocks', () => {
  const inlineRendered = renderInlineContent('Keep [D4](https://example.com) plain and `F2:L11` literal.');
  assert.doesNotMatch(inlineRendered, /data-sheet-range-ref="D4"/);
  assert.doesNotMatch(inlineRendered, /data-sheet-range-ref="F2:L11"/);

  const blockRendered = renderMarkdownContent([
    '```txt',
    'D4',
    '2:11',
    '```',
  ].join('\n'));
  assert.doesNotMatch(blockRendered, /data-sheet-range-ref=/);
});

test('avoids false positives for google sheets refs inside technical tokens and timestamps', () => {
  const rendered = renderInlineContent('I18N B2B E2E API-D4 v2.11 fooA1bar 2:11:30 should stay plain.');
  assert.doesNotMatch(rendered, /data-sheet-range-ref=/);
});

test('rejects out-of-bounds google sheets refs', () => {
  const rendered = renderInlineContent('Ignore AAAA1 and 1048577:1048577, but keep ZZZ1048576.');
  assert.doesNotMatch(rendered, /data-sheet-range-ref="AAAA1"/);
  assert.doesNotMatch(rendered, /data-sheet-range-ref="1048577:1048577"/);
  assert.match(rendered, /data-sheet-range-ref="ZZZ1048576"[^>]*>ZZZ1048576<\/a>/);
});

test('does not render unsafe markdown link protocols as HTML anchors', () => {
  const rendered = renderInlineContent('[bad](javascript:alert(1))');
  assert.equal(rendered, '[bad](javascript:alert(1))');
});

test('buildGoogleSheetsRangeUrl rewrites google sheets fragments safely', () => {
  assert.equal(
    buildGoogleSheetsRangeUrl('https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=123', 'd4'),
    'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=123&range=D4',
  );
  assert.equal(
    buildGoogleSheetsRangeUrl('https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=123&range=A1', 'F2:L11'),
    'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=123&range=F2%3AL11',
  );
  assert.equal(
    buildGoogleSheetsRangeUrl('https://docs.google.com/spreadsheets/d/test-sheet/edit#range=A1', 'A:A'),
    'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0&range=A%3AA',
  );
});

test('buildGoogleSheetsRangeUrl defaults invalid gid values and rejects invalid inputs', () => {
  assert.equal(
    buildGoogleSheetsRangeUrl('https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=foo', '1:1'),
    'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0&range=1%3A1',
  );
  assert.equal(buildGoogleSheetsRangeUrl('https://example.com/not-a-sheet', 'D4'), null);
  assert.equal(buildGoogleSheetsRangeUrl('https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=1', 'AAAA1'), null);
  assert.equal(buildGoogleSheetsRangeUrl('https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=1', '1048577:1048577'), null);
});

test('renders markdown blocks for headings, emphasis, list, quote, and hr', () => {
  const rendered = renderMarkdownContent([
    '# Heading',
    '',
    'Paragraph with *italic*, **bold**, and ~~strike~~.',
    '',
    '- Item one',
    '- [x] Done task',
    '',
    '> quoted line',
    '',
    '---',
  ].join('\n'));
  assert.match(rendered, /class="md-content"/);
  assert.match(rendered, /class="md-h1"/);
  assert.match(rendered, /<em>italic<\/em>/);
  assert.match(rendered, /<strong>bold<\/strong>/);
  assert.match(rendered, /<del>strike<\/del>/);
  assert.match(rendered, /class="md-list"/);
  assert.match(rendered, /class="md-task-item"/);
  assert.match(rendered, /class="md-blockquote"/);
  assert.match(rendered, /class="md-hr"/);
});

test('renders fenced code blocks and table markdown', () => {
  const rendered = renderMarkdownContent([
    '```js',
    'const ok = true;',
    '```',
    '',
    '| Name | Value |',
    '| :--- | ---: |',
    '| foo | 42 |',
  ].join('\n'));
  assert.match(rendered, /class="md-pre"/);
  assert.match(rendered, /class="md-copy-btn"/);
  assert.match(rendered, /data-md-copy-code/);
  assert.match(rendered, /language-js/);
  assert.match(rendered, /const ok = true;/);
  assert.match(rendered, /class="md-table-wrap"/);
  assert.match(rendered, /class="md-table"/);
  assert.match(rendered, /<th style="text-align:left;">Name<\/th>/);
  assert.match(rendered, /<th style="text-align:right;">Value<\/th>/);
});

test('identifies actionable completed final responses only', () => {
  assert.equal(
    isCompletedFinalResponseActionable({ role: 'assistant', done: true, isFinalVisibleResponse: true, text: '# Final' }),
    true,
  );
  assert.equal(
    isCompletedFinalResponseActionable({ role: 'assistant', done: false, isFinalVisibleResponse: true, text: '# Final' }),
    false,
  );
  assert.equal(
    isCompletedFinalResponseActionable({ role: 'assistant', done: true, isFinalVisibleResponse: false, text: '# Interim' }),
    false,
  );
  assert.equal(
    isCompletedFinalResponseActionable({ role: 'user', done: true, isFinalVisibleResponse: true, text: 'hi' }),
    false,
  );
});

test('builds markdown export payload from raw final response text', () => {
  const payload = buildFinalResponseMarkdownExport({
    markdown: '# Report\n\n- item',
    sessionTitle: 'Bucks Review',
    createdAt: '2026-03-06T12:30:00.000Z',
  });
  assert.equal(payload.content, '# Report\n\n- item');
  assert.match(payload.fileName, /bucks-review/i);
  assert.match(payload.fileName, /\.md$/);
  assert.equal(payload.mimeType, 'text/markdown;charset=utf-8');
});

test('builds printable html document for final response export', () => {
  const html = buildFinalResponsePrintDocument({
    markdown: '# Heading\n\n| Name | Value |\n| --- | --- |\n| foo | 42 |',
    sessionTitle: 'Bucks Review',
    createdAt: '2026-03-06T12:30:00.000Z',
  });
  assert.match(html, /<title>Bucks Review/);
  assert.match(html, /class="md-content"/);
  assert.match(html, /class="md-table-wrap"/);
  assert.match(html, /class="md-table"/);
  assert.match(html, /@media print/);
});

test('escapes raw html inside markdown blocks', () => {
  const rendered = renderMarkdownContent('Text <script>alert(1)</script>');
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
});

test('tracks latest step index for active runs only', () => {
  assert.equal(getLatestInFlightStepIndex({ done: false, steps: [{}, {}, {}] }), 2);
  assert.equal(getLatestInFlightStepIndex({ done: true, steps: [{}, {}] }), -1);
  assert.equal(getLatestInFlightStepIndex({ done: false, steps: [] }), -1);
});

test('formats context usage with percentage when context window is present', () => {
  assert.equal(
    formatContextUsage({ totalTokens: 12345, modelContextWindow: 258400 }),
    '12,345 / 258,400 (4.8%)',
  );
});

test('returns null for context usage formatting when values are incomplete', () => {
  assert.equal(formatContextUsage({ totalTokens: 12345 }), null);
  assert.equal(formatContextUsage({ modelContextWindow: 258400 }), null);
  assert.equal(formatContextUsage({ totalTokens: 0, modelContextWindow: 258400 }), null);
});

test('formats message hover timestamp as time under 24h and date+time over 24h', () => {
  assert.equal(
    formatMessageTimestampForHover('2026-03-05T12:30:00.000Z', {
      now: '2026-03-05T18:00:00.000Z',
      locale: 'en-US',
      timeZone: 'UTC',
    }),
    '12:30 PM',
  );
  assert.equal(
    formatMessageTimestampForHover('2026-03-04T12:30:00.000Z', {
      now: '2026-03-05T18:00:00.000Z',
      locale: 'en-US',
      timeZone: 'UTC',
    }),
    'Mar 4, 12:30 PM',
  );
  assert.equal(formatMessageTimestampForHover('not-a-date'), null);
});

test('shows bottom fade only when content is scrollable and not yet at bottom', () => {
  assert.equal(
    shouldShowBottomScrollFade({ scrollTop: 0, scrollHeight: 120, clientHeight: 74 }),
    true,
  );
  assert.equal(
    shouldShowBottomScrollFade({ scrollTop: 46, scrollHeight: 120, clientHeight: 74 }),
    false,
  );
  assert.equal(
    shouldShowBottomScrollFade({ scrollTop: 0, scrollHeight: 74, clientHeight: 74 }),
    false,
  );
  assert.equal(
    shouldShowBottomScrollFade({ scrollTop: 45.5, scrollHeight: 120, clientHeight: 74 }),
    false,
  );
});
