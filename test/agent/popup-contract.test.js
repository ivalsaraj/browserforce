import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/popup.html', 'utf8');
const optionsJs = fs.readFileSync('extension/options.js', 'utf8');
const popupJs = fs.readFileSync('extension/popup.js', 'utf8');
const popupCss = fs.readFileSync('extension/popup.css', 'utf8');

test('popup includes Open BrowserForce Agent button', () => {
  assert.match(html, /Open BrowserForce Agent/);
});

test('logs viewer requests include extension identity header', () => {
  assert.match(optionsJs, /chrome\?\.runtime\?\.id/);
  assert.match(optionsJs, /'x-browserforce-extension-id'/);
});

test('open agent action opens side panel and closes popup', () => {
  assert.match(popupJs, /BROWSERFORCE_AGENT_OPEN_REQUEST_KEY/);
  assert.match(popupJs, /chrome\.storage\.local\.set\(/);
  assert.match(popupJs, /source:\s*'popup-open-agent'/);
  assert.match(popupJs, /await chrome\.storage\.local\.set\([\s\S]*await chrome\.sidePanel\.open\(/);
  assert.match(popupJs, /chrome\.sidePanel\.open\(/);
  assert.match(popupJs, /window\.close\(\)/);
});

test('auto mode uses bottom note instead of dotted popup border', () => {
  assert.match(html, /id="bf-auto-mode-note"/);
  assert.match(html, /class="auto-mode-note-text"/);
  assert.match(html, /NOTE:\s*Auto mode is on\./);
  assert.match(popupCss, /\.auto-mode-note\s*\{/);
  assert.match(popupCss, /\.auto-mode-note-text\s*\{/);
  assert.match(popupCss, /\.auto-mode-note-text[\s\S]*width:\s*100%/);
  assert.match(popupCss, /\.auto-mode-note-text[\s\S]*white-space:\s*nowrap/);
  assert.equal(/\.auto-mode-note-text[\s\S]*text-overflow:\s*ellipsis/.test(popupCss), false);
  assert.match(popupJs, /function\s+fitAutoModeNoteText\(/);
  assert.match(popupJs, /scrollWidth\s*>\s*autoModeNoteTextEl\.clientWidth/);
  assert.match(popupJs, /requestAnimationFrame\(fitAutoModeNoteText\)/);
  assert.match(popupCss, /margin:\s*10px\s+-16px\s+-16px/);
  assert.match(popupCss, /\.auto-mode-note::before[\s\S]*background:\s*var\(--bf-danger-fg\)/);
  assert.match(popupCss, /\.auto-mode-note::after[\s\S]*background:\s*var\(--bf-accent\)/);
  assert.equal(/\.bf-popup\.auto-mode\s*\{[\s\S]*dotted/.test(popupCss), false);
});

test('popup exposes a dedicated-window toggle wired to storage', () => {
  assert.match(html, /id="bf-dedicated-window"/);
  assert.match(html, /Open agent tabs in a separate window/);
  assert.match(popupJs, /'dedicatedWindow'/);
  assert.match(popupJs, /dedicatedWindowCb/);
  assert.match(popupJs, /chrome\.storage\.local\.set\(\{\s*dedicatedWindow:/);
});

test('popup exposes a default-off ghost-cursor toggle wired to storage', () => {
  assert.match(html, /id="bf-ghost-cursor"/);
  assert.match(html, /Show ghost cursor for agent actions/);
  assert.match(popupJs, /'ghostCursorEnabled'/);
  assert.match(popupJs, /ghostCursorCb\.checked\s*=\s*!!s\.ghostCursorEnabled/);
  assert.match(popupJs, /chrome\.storage\.local\.set\(\{\s*ghostCursorEnabled:/);
});


test('dedicated window copy explains full-screen Spaces and defaults off', () => {
  assert.match(html, /new Space.*full.screen/i);
  assert.match(popupJs, /dedicatedWindowCb\.checked = s\.dedicatedWindow === true/);
});

// Any property not set explicitly is a no-op function returning another stub,
// so popup.js top-level DOM/Chrome wiring runs without a browser.
function stub(base = {}) {
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === Symbol.toPrimitive || key === 'then') return undefined;
      return target[key] = stub(function () { return stub(); });
    },
  });
}

function element() {
  const listeners = {};
  return stub({
    value: '', checked: false, hidden: false, disabled: false, textContent: '',
    listeners,
    addEventListener(type, fn) { listeners[type] = fn; },
  });
}

function loadPopup(settings) {
  const elements = new Map();
  const writes = [];
  const document = stub({
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
  });
  const chrome = stub({
    storage: stub({
      local: stub({
        get(keys, cb) { if (typeof cb === 'function') cb({ ...settings }); return Promise.resolve({ ...settings }); },
        set(value) { writes.push(value); return Promise.resolve(); },
      }),
    }),
  });
  vm.runInNewContext(popupJs, {
    document, chrome, window: stub(), console, setTimeout: () => 0, setInterval: () => 0,
    clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0,
    URL, Number, String, Promise,
  });
  return { el: (id) => document.getElementById(id), writes };
}

test('click sync is hidden and disabled while the ghost cursor is off', () => {
  const { el } = loadPopup({ ghostCursorEnabled: false, userInstructions: 'keep me' });
  assert.equal(el('bf-ghost-cursor-click-sync-row').hidden, true);
  assert.equal(el('bf-ghost-cursor-click-sync').disabled, true);
  assert.equal(el('bf-instructions').value, 'keep me', 'settings after the toggle must still load');
});

test('click sync is shown, enabled and saved while the ghost cursor is on', () => {
  const { el, writes } = loadPopup({ ghostCursorEnabled: true, ghostCursorClickSync: false });
  const sync = el('bf-ghost-cursor-click-sync');
  assert.equal(el('bf-ghost-cursor-click-sync-row').hidden, false);
  assert.equal(sync.disabled, false);
  sync.checked = true;
  sync.listeners.change();
  assert.equal(JSON.stringify(writes.at(-1)), '{"ghostCursorClickSync":true}');
});

test('turning the ghost cursor on and off updates the click sync row', () => {
  const { el } = loadPopup({ ghostCursorEnabled: false });
  const cursor = el('bf-ghost-cursor');
  cursor.checked = true;
  cursor.listeners.change();
  assert.equal(el('bf-ghost-cursor-click-sync').disabled, false);
  assert.equal(el('bf-ghost-cursor-click-sync-row').hidden, false);
  cursor.checked = false;
  cursor.listeners.change();
  assert.equal(el('bf-ghost-cursor-click-sync').disabled, true);
  assert.equal(el('bf-ghost-cursor-click-sync-row').hidden, true);
});

test('a hidden checkbox row is not displayed', () => {
  assert.match(popupCss, /\.checkbox-row\[hidden\]\s*\{\s*display:\s*none;/);
});
