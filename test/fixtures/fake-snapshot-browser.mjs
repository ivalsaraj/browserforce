// test/fixtures/fake-snapshot-browser.mjs
//
// A fake Playwright Browser injected into sessiond BELOW buildExecContext via
// the BF_SESSIOND_CONNECT_MODULE test seam. This lets the cli-sessiond
// real-path test exercise the entire CLI → session-client → sessiond →
// runtime.runCommand() → runCode() → snapshotData() chain against a fake
// page/CDP (the only way to fake a subprocess daemon's browser) WITHOUT a real
// Chrome or relay/extension. The snapshot engine + execution boundary run for
// real; only the page/CDP/DOM are faked.
//
// Fixture page: <button data-testid="submit">Submit</button>
//
// Interaction methods (click/fill/type/press) append a JSONL event to the file
// at BF_SESSIOND_FAKE_EVENTS so a separate test process can prove the call ran
// inside the daemon (cross-process side channel).

import { appendFileSync } from 'node:fs';

const EVENTS_PATH = process.env.BF_SESSIOND_FAKE_EVENTS || null;
function record(event) {
  if (!EVENTS_PATH) return;
  try { appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`); } catch { /* best effort */ }
}

const domNodes = [
  { nodeId: 1, backendNodeId: 1, nodeName: 'HTML', attributes: [] },
  { nodeId: 2, parentId: 1, backendNodeId: 20, nodeName: 'BUTTON', attributes: ['data-testid', 'submit'] },
];
const axNodes = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId: 1, childIds: ['2'] },
  { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 20, childIds: [] },
];

function makeFakeCdp() {
  return {
    calls: [],
    detached: false,
    async send(method) {
      this.calls.push(method);
      if (method === 'DOM.getFlattenedDocument') return { nodes: domNodes };
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
      return {};
    },
    async detach() { this.detached = true; },
  };
}

function makeFakeLocator(selector, frameChain = []) {
  return {
    selector, frameChain,
    first() { return this; },
    frameLocator(sel) { return { locator: (s) => makeFakeLocator(s, [...frameChain, sel]) }; },
    async evaluate() {},
    async click() { record({ action: 'click', selector }); },
    async fill(value) { record({ action: 'fill', selector, value }); },
    async type(value) { record({ action: 'type', selector, value }); },
    async pressSequentially(value) { record({ action: 'type', selector, value }); },
    async press(key) { record({ action: 'press', selector, key }); },
    async textContent() { return 'Submit'; },
    async innerText() { return 'Submit'; },
  };
}

function makeFakePage(ctx) {
  const page = {
    isClosed: () => false,
    url: () => 'https://fake.test/',
    title: async () => 'Fake',
    locator: (sel) => makeFakeLocator(sel),
    frameLocator: (sel) => ({ locator: (s) => makeFakeLocator(s, [sel]) }),
    context: () => ctx,
    keyboard: { press: async (key) => record({ action: 'keypress', key }) },
    on: () => {},
    off: () => {},
  };
  page.mainFrame = () => page;
  page.frames = () => [page];
  return page;
}

function makeFakeContext() {
  const ctx = {
    on: () => {},
    off: () => {},
    newCDPSession: async () => makeFakeCdp(),
  };
  const page = makeFakePage(ctx);
  ctx.pages = () => [page];
  return ctx;
}

function makeFakeBrowser() {
  const ctx = makeFakeContext();
  return {
    isConnected: () => true,
    on: () => {},
    off: () => {},
    contexts: () => [ctx],
    async close() {},
  };
}

export default async function connect() {
  return makeFakeBrowser();
}
