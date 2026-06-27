import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSnapshot, renderRefLines, getAriaSnapshot,
} from '../src/aria-snapshot-engine.js';

// ── fixture builders ─────────────────────────────────────────────────────────
const ax = (nodeId, role, name, backendDOMNodeId, childIds = []) => ({
  nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId, childIds,
});
const dom = (nodeId, backendNodeId, nodeName, attributes = [], parentId) => ({
  nodeId, parentId, backendNodeId, nodeName, attributes,
});

test('stable-id interactive node yields data-attr locator + e1 short ref', () => {
  const axNodes = [ax('1', 'RootWebArea', 'T', 1, ['2']), ax('2', 'button', 'Submit', 2)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'BUTTON', ['data-testid', 'submit-btn'], 1)];
  const { snapshot, refs } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, 'submit-btn');
  assert.equal(refs[0].locator, '[data-testid="submit-btn"]');
  assert.equal(refs[0].shortRef, 'e1');
  assert.match(snapshot, /button "Submit"/);
  assert.match(snapshot, /\[data-testid="submit-btn"\]/);
});

test('duplicate locators get >> nth=N disambiguation', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2', '3']), ax('2', 'button', 'Go', 2), ax('3', 'button', 'Go', 3)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'BUTTON', [], 1), dom(3, 3, 'BUTTON', [], 1)];
  const { refs } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.equal(refs.length, 2);
  assert.ok(refs[0].locator.endsWith('nth=0'), refs[0].locator);
  assert.ok(refs[1].locator.endsWith('nth=1'), refs[1].locator);
});

test('full mode keeps text; interactive mode drops non-label text', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2']), ax('2', 'paragraph', '', 2, ['3']), ax('3', 'StaticText', 'Hello world', 3)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'P', [], 1), dom(3, 3, '#text', [], 2)];
  const full = assembleSnapshot({ axNodes, domNodes, interactiveOnly: false });
  const interactive = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.match(full.snapshot, /Hello world/);
  assert.doesNotMatch(interactive.snapshot, /Hello world/);
  assert.equal(interactive.refs.length, 0);
});

test('bare contenteditable is promoted to textbox with [contenteditable] locator', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2']), ax('2', 'generic', '', 2)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'DIV', ['contenteditable', 'true'], 1)];
  const { refs } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, 'textbox');
  assert.equal(refs[0].locator, '[contenteditable="true"]');
});

test('locator scope restricts refs to the scoped subtree', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2', '3']), ax('2', 'button', 'Inside', 2), ax('3', 'button', 'Outside', 3)];
  const domNodes = [
    dom(1, 1, 'BODY'), dom(10, 10, 'DIV', ['id', 'scope'], 1),
    dom(2, 2, 'BUTTON', ['data-testid', 'inside'], 10),
    dom(3, 3, 'BUTTON', ['data-testid', 'outside'], 1),
  ];
  const { snapshot, refs } = assembleSnapshot({ axNodes, domNodes, scopeBackendId: 10, interactiveOnly: true });
  assert.match(snapshot, /Inside/);
  assert.doesNotMatch(snapshot, /Outside/);
  assert.deepEqual(refs.map((r) => r.ref), ['inside']);
});

test('renderRefLines emits [ref=eN] markers from the tree', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2']), ax('2', 'button', 'Save', 2)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'BUTTON', [], 1)];
  const { tree } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  const text = renderRefLines(tree);
  assert.match(text, /- button "Save" \[ref=e1\]/);
});

test('getAriaSnapshot throws without a CDP session', async () => {
  await assert.rejects(() => getAriaSnapshot({ page: {} }), /requires a page CDP session/);
});

test('getAriaSnapshot throws on empty AX tree after one retry', async () => {
  const fakeCdp = { send: async (method) => (method.startsWith('DOM.getFlattenedDocument') || method.startsWith('Accessibility.getFullAXTree') ? { nodes: [] } : {}) };
  await assert.rejects(() => getAriaSnapshot({ page: {}, cdp: fakeCdp }), /empty after retry/);
});
