import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecContext } from '../src/exec-engine.js';

function makeFakeCdp(domNodes, axNodes) {
  const calls = [];
  return {
    calls,
    detached: false,
    async send(method) {
      calls.push(method);
      if (method === 'DOM.getFlattenedDocument') return { nodes: domNodes };
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
      return {};
    },
    async detach() { this.detached = true; },
  };
}

// Minimal fake Locator/FrameLocator: records the selector/frameChain so we can assert
// locatorForRef built the right thing.
function makeFakeLocator(selector, frameChain = []) {
  return {
    selector, frameChain,
    first() { return this; },
    frameLocator(sel) { return { locator: (s) => makeFakeLocator(s, [...frameChain, sel]) }; },
    async evaluate() {},
  };
}

function makeFakePage(cdp) {
  const page = {
    isClosed: () => false,
    url: () => 'https://fake.test/',
    title: async () => 'Fake',
    locator: (sel) => makeFakeLocator(sel),
    frameLocator: (sel) => ({ locator: (s) => makeFakeLocator(s, [sel]) }),
    context: () => ({ newCDPSession: async () => cdp }),
  };
  page.mainFrame = () => page;       // no subframes in this fixture
  page.frames = () => [page];
  return page;
}

// Fixture: <button data-testid="submit">Submit</button>
const domNodes = [
  { nodeId: 1, backendNodeId: 1, nodeName: 'HTML', attributes: [] },
  { nodeId: 2, parentId: 1, backendNodeId: 20, nodeName: 'BUTTON', attributes: ['data-testid', 'submit'] },
];
const axNodes = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId: 1, childIds: ['2'] },
  { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 20, childIds: [] },
];

test('snapshot() wires the engine: text, refs, locatorForRef, CDP order + detach', async () => {
  const cdp = makeFakeCdp(domNodes, axNodes);
  const page = makeFakePage(cdp);
  const exec = buildExecContext(page, {}, {});

  assert.equal(typeof exec.locatorForRef, 'function', 'buildExecContext exposes locatorForRef');

  const text = await exec.snapshot();
  assert.match(text, /button "Submit"/, 'renders the interactive node');
  assert.match(text, /\[ref=e1\]/, 'keeps the [ref=eN] contract (Reconciliation 8)');
  assert.match(text, /\[data-testid="submit"\]/, 'ref table carries the CDP-built locator');

  // Back-compat string accessor + new Locator accessor both resolve the stored ref.
  assert.equal(exec.refToLocator({ ref: 'e1' }), '[data-testid="submit"]');
  const loc = exec.locatorForRef({ ref: 'e1' });
  assert.equal(loc.selector, '[data-testid="submit"]');
  assert.deepEqual(loc.frameChain, [], 'main-frame ref has empty frameChain');

  // CDP contract: Accessibility.enable BEFORE DOM.enable (Reconciliation 5), and detach ran.
  assert.ok(cdp.calls.indexOf('Accessibility.enable') < cdp.calls.indexOf('DOM.enable'), 'AX enabled before DOM');
  assert.ok(cdp.calls.includes('Accessibility.getFullAXTree') && cdp.calls.includes('DOM.getFlattenedDocument'));
  assert.equal(cdp.detached, true, 'snapshot detaches the CDP session it created');
});

test('snapshot() throws (no silent fallback) on an empty AX tree', async () => {
  const cdp = makeFakeCdp(domNodes, [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId: 1, childIds: [] }]);
  const exec = buildExecContext(makeFakePage(cdp), {}, {});
  await assert.rejects(() => exec.snapshot(), /Accessibility tree is empty after retry/);
  assert.equal(cdp.detached, true, 'session detached even on throw');
});
