import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSnapshot, renderRefLines, getAriaSnapshot,
  collectFrameBoundaryBackendIds, deriveIframeSelector, stitchFrameTree,
  mapTokenToBackendId, orderFramesParentFirst, buildFrameChain,
  createRefContext, buildScopedNodes, buildSnapshotLines, buildShortRefMap,
  finalizeSnapshotOutput, reconcileRefLocators, isSameOriginFrameSessionError,
  renderFrameErrors,
} from '../src/aria-snapshot-engine.js';

// ── fixture builders ─────────────────────────────────────────────────────────
const ax = (nodeId, role, name, backendDOMNodeId, childIds = []) => ({
  nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId, childIds,
});
const dom = (nodeId, backendNodeId, nodeName, attributes = [], parentId) => ({
  nodeId, parentId, backendNodeId, nodeName, attributes,
});
const axRoot = (childIds = [], nodeId = 1, backendDOMNodeId = 1) => ({
  nodeId, role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId, childIds,
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

test('isSameOriginFrameSessionError matches ONLY the same-origin "no separate CDP session" error', () => {
  // Exact message thrown by playwright-core crBrowser.js newCDPSession for an in-process frame.
  assert.equal(isSameOriginFrameSessionError(new Error("This frame does not have a separate CDP session, it is a part of the parent frame's session")), true);
  assert.equal(isSameOriginFrameSessionError('separate CDP session'), true);
  // Any other failure (OOPIF target resolution, detach) must be classified as unexpected.
  assert.equal(isSameOriginFrameSessionError(new Error('Protocol error (Target.attachToTarget): No target with given id found')), false);
  assert.equal(isSameOriginFrameSessionError(undefined), false);
  assert.equal(isSameOriginFrameSessionError(null), false);
});

test('getAriaSnapshot rethrows an UNEXPECTED OOPIF acquisition error for an explicit subframe (no silent whole-page fallback)', async () => {
  const mainFrame = { childFrames: () => [] };
  const subframe = { childFrames: () => [] }; // a Frame (has childFrames) distinct from mainFrame
  const page = {
    mainFrame: () => mainFrame,
    context: () => ({
      newCDPSession: async () => { throw new Error('Protocol error (Target.attachToTarget): No target with given id found'); },
    }),
  };
  const cdp = { send: async () => ({ nodes: [] }) };
  await assert.rejects(
    () => getAriaSnapshot({ page, frame: subframe, cdp }),
    /Failed to acquire a CDP session for the requested subframe/,
  );
});

test('renderFrameErrors surfaces a visible warning block (empty when nothing skipped)', () => {
  assert.equal(renderFrameErrors([]), '');
  assert.equal(renderFrameErrors(undefined), '');
  const out = renderFrameErrors([{ selector: '[id="ads"]', frameChain: ['[id="ads"]'], reason: 'subframe CDP session/fetch failed: boom' }]);
  assert.match(out, /⚠️ 1 subframe\(s\) not stitched/);
  assert.match(out, /\[id="ads"\]: subframe CDP session\/fetch failed: boom/);
});

// Drives the REAL full-page walk in getAriaSnapshot (not a reimplementation): a first-level OOPIF
// whose newCDPSession fails for a NON-same-origin reason must be best-effort skipped (page survives)
// AND recorded in frameErrors so the loss is visible — Codex Round-2 IMPORTANT fix.
test('getAriaSnapshot full-page walk records a failed first-level OOPIF in frameErrors (not silent, not fatal)', async () => {
  const state = {};
  const mainFrame = { parentFrame: () => null };
  const ownerHandle = { evaluate: async (_fn, tok) => { state.ownerToken = tok; } };
  const oopif = {
    parentFrame: () => mainFrame,
    frameElement: async () => ownerHandle,
    locator: () => ({ evaluate: async (_fn, tok) => { state.rootToken = tok; } }),
  };
  const page = {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, oopif],
    context: () => ({ newCDPSession: async () => { throw new Error('Protocol error: No target with given id found'); } }),
  };
  const cdp = {
    send: async (method) => {
      if (method === 'DOM.getFlattenedDocument') {
        return { nodes: [
          dom(1, 1, 'BODY'),
          dom(2, 2, 'BUTTON', ['data-testid', 'go'], 1),
          dom(3, 3, 'IFRAME', ['id', 'adframe', 'data-pw-frame-owner', state.ownerToken], 1),
        ] };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [
          axRoot(['2', '3']),
          ax('2', 'button', 'Go', 2),
          ax('3', 'Iframe', '', 3),
        ] };
      }
      return {};
    },
  };
  const result = await getAriaSnapshot({ page, cdp, interactiveOnly: true });
  // page survived (main content present) despite the OOPIF failure
  assert.match(result.snapshot, /button "Go"/);
  // the failed OOPIF is recorded, not silently dropped
  assert.equal(result.frameErrors.length, 1);
  assert.equal(result.frameErrors[0].selector, '[id="adframe"]');
  assert.match(result.frameErrors[0].reason, /subframe CDP session\/fetch failed/);
});

// ── Phase 2: frame stitching helpers (pure) ──────────────────────────────────

test('collectFrameBoundaryBackendIds finds iframe/frame elements', () => {
  const ids = collectFrameBoundaryBackendIds([
    { backendNodeId: 1, nodeName: 'DIV' }, { backendNodeId: 2, nodeName: 'IFRAME' }, { backendNodeId: 3, nodeName: 'FRAME' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [2, 3]);
});

test('deriveIframeSelector prefers stable attr, then name, then nth', () => {
  const m = (pairs) => new Map(pairs);
  assert.equal(deriveIframeSelector(m([['id', 'editor']]), 0), '[id="editor"]');
  assert.equal(deriveIframeSelector(m([['name', 'ads']]), 0), 'iframe[name="ads"]');
  assert.equal(deriveIframeSelector(m([]), 2), 'iframe >> nth=2');
});

test('stitchFrameTree appends child nodes under the iframe leaf', () => {
  const tree = [{ role: 'iframe', name: '', backendNodeId: 9, children: [] }];
  const child = [{ role: 'button', name: 'X', backendNodeId: 100, children: [], ref: 'e1', shortRef: 'e1' }];
  const out = stitchFrameTree(tree, 9, child);
  assert.equal(out[0].children.length, 1);
  assert.equal(out[0].children[0].name, 'X');
});

test('mapTokenToBackendId resolves a tagged attribute to backendNodeId + attrs', () => {
  const map = mapTokenToBackendId([
    { backendNodeId: 5, attributes: ['data-pw-frame-owner', 'tok-1', 'name', 'ads'] },
    { backendNodeId: 6, attributes: ['class', 'x'] },
  ], 'data-pw-frame-owner');
  assert.equal(map.get('tok-1').backendNodeId, 5);
  assert.equal(map.get('tok-1').attrs.get('name'), 'ads');
});

test('orderFramesParentFirst sorts parents before children by parentFrame() depth', () => {
  const main = { parentFrame: () => null };
  const a = { parentFrame: () => main };          // depth 1
  const b = { parentFrame: () => a };             // depth 2
  const ordered = orderFramesParentFirst([{ frame: b }, { frame: a }]);
  assert.deepEqual(ordered.map((m) => m.frame), [a, b]);
});

test('buildFrameChain composes precomputed iframe selectors top→target', () => {
  const main = { parentFrame: () => null };
  const a = { parentFrame: () => main };
  const b = { parentFrame: () => a };
  const metaByFrame = new Map([
    [a, { frame: a, iframeSelector: 'iframe[name="a"]' }],
    [b, { frame: b, iframeSelector: 'iframe[name="b"]' }],
  ]);
  assert.deepEqual(buildFrameChain(b, metaByFrame), ['iframe[name="a"]', 'iframe[name="b"]']);
  assert.deepEqual(buildFrameChain(a, metaByFrame), ['iframe[name="a"]']);
});

// Multi-frame path: buildScopedNodes twice into ONE shared refCtx, stitch the PRE-finalize
// nodes, then finalize ONCE — mirrors the getAriaSnapshot walk (Step 3). Must NOT call
// assembleSnapshot twice with a shared refCtx (it finalizes per-call — Codex Round-2).
test('shared refCtx + single finalize keeps eN fallbacks unique and frame-scoped', () => {
  const refCtx = createRefContext();
  // unnamed buttons (no stable attrs) → e1 (main) then e2 (in-frame) across the shared ctx
  const main = buildScopedNodes({ axNodes: [axRoot([10]), ax(10, 'button', '', 501)], domNodes: [dom(10, 501, 'BUTTON')], frameChain: [], refCtx });
  const child = buildScopedNodes({ axNodes: [axRoot([20]), ax(20, 'button', '', 502)], domNodes: [dom(20, 502, 'BUTTON')], frameChain: ['iframe >> nth=0'], refCtx });
  // stitch: put the child button under a fabricated iframe leaf in the main tree
  const stitched = [{ role: 'iframe', name: '', backendNodeId: 999, children: [] }, ...main.nodes];
  const merged = stitchFrameTree(stitched, 999, child.nodes);
  const lines = buildSnapshotLines(merged);
  const shortRefMap = buildShortRefMap({ refs: refCtx.refs });
  const { tree } = finalizeSnapshotOutput(lines, merged, shortRefMap);
  const refs = reconcileRefLocators(refCtx.refs, tree, shortRefMap);

  assert.equal(new Set(refs.map((r) => r.ref)).size, refs.length, 'no duplicate refs across frames');
  const inFrame = refs.find((r) => r.frameChain.length === 1);
  assert.deepEqual(inFrame.frameChain, ['iframe >> nth=0'], 'in-frame ref carries the frameChain');
  assert.equal(refs.filter((r) => r.frameChain.length === 0).length, 1, 'main-frame ref keeps empty frameChain');
});
