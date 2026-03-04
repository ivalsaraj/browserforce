import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSessionRunId,
  classifyRunStepIcon,
  clearSessionRunId,
  formatContextUsage,
  getLatestInFlightStepIndex,
  getSessionRunId,
  renderMarkdownContent,
  renderInlineContent,
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

test('does not render unsafe markdown link protocols as HTML anchors', () => {
  const rendered = renderInlineContent('[bad](javascript:alert(1))');
  assert.equal(rendered, '[bad](javascript:alert(1))');
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
  assert.match(rendered, /language-js/);
  assert.match(rendered, /const ok = true;/);
  assert.match(rendered, /class="md-table"/);
  assert.match(rendered, /<th style="text-align:left;">Name<\/th>/);
  assert.match(rendered, /<th style="text-align:right;">Value<\/th>/);
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
