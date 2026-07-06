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
    async hover() { record({ action: 'hover', selector }); },
    async fill(value) { record({ action: 'fill', selector, value }); },
    async type(value) { record({ action: 'type', selector, value }); },
    async pressSequentially(value) { record({ action: 'type', selector, value }); },
    async press(key) { record({ action: 'press', selector, key }); },
    async textContent() { return 'Submit'; },
    async innerText() { return 'Submit'; },
    async innerHTML() { return '<span>Submit</span>'; },
  };
}

function makeFakePage(ctx, { url = 'https://fake.test/', title = 'Fake' } = {}) {
  let currentUrl = url;
  let currentTitle = title;
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    title: async () => currentTitle,
    // `open` navigates new pages; title tracks the hostname so `tabs` rows are
    // distinguishable in many-tab CLI stress tests.
    goto: async (next) => {
      currentUrl = next;
      try { currentTitle = `Fake ${new URL(next).hostname}`; } catch { /* keep title */ }
      record({ action: 'goto', url: next });
    },
    locator: (sel) => makeFakeLocator(sel),
    frameLocator: (sel) => ({ locator: (s) => makeFakeLocator(s, [sel]) }),
    context: () => ctx,
    keyboard: { press: async (key) => record({ action: 'keypress', key }) },
    // Fake waiters resolve immediately (record so tests can assert the call).
    waitForFunction: async (fn, arg) => {
      const source = String(fn);
      record({ action: 'waitForFunction', source, arg });
      if (
        source.includes('innerText') &&
        arg === 'saved' &&
        !source.includes('toLocaleLowerCase') &&
        !source.includes('toLowerCase')
      ) {
        throw new Error('fake waitForFunction did not match uppercase page text');
      }
      return true;
    },
    waitForURL: async () => { record({ action: 'waitForURL' }); },
    waitForLoadState: async (state) => { record({ action: 'waitForLoadState', state }); },
    on: () => {},
    off: () => {},
  };
  page.mainFrame = () => page;
  page.frames = () => [page];
  return page;
}

function makeFakeContext() {
  const pages = [];
  const ctx = {
    on: () => {},
    off: () => {},
    newCDPSession: async () => makeFakeCdp(),
    pages: () => pages,
    // `open` support: new pages start blank and take their URL from goto().
    newPage: async () => {
      const page = makeFakePage(ctx, { url: 'about:blank', title: 'New Tab' });
      pages.push(page);
      record({ action: 'newPage' });
      return page;
    },
  };
  pages.push(makeFakePage(ctx));
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
