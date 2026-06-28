import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Static contract test (mirrors background-window-plan.test.js): the extension
// service worker can't be loaded outside Chrome, so we assert the source
// contract. Carryover of agent-browser's Chrome 144+ fix (#1133): targets
// paused waiting for the debugger after attach must be resumed with
// Runtime.runIfWaitingForDebugger, best-effort (no-op on versions that don't
// pause), inside attachTab's fresh-attach path.
const bg = fs.readFileSync('extension/background.js', 'utf8');

test('attachTab sends Runtime.runIfWaitingForDebugger', () => {
  assert.match(bg, /Runtime\.runIfWaitingForDebugger/);
});

test('runIfWaitingForDebugger is sent AFTER chrome.debugger.attach and before the entry is stored', () => {
  const attachIdx = bg.indexOf('chrome.debugger.attach({ tabId }, CDP_VERSION)');
  const resumeIdx = bg.indexOf('Runtime.runIfWaitingForDebugger');
  const storeIdx = bg.indexOf('attachedTabs.set(tabId, entry)');
  assert.ok(attachIdx > 0, 'attach call present');
  assert.ok(resumeIdx > attachIdx, 'resume must be sent after the debugger attaches');
  assert.ok(storeIdx > resumeIdx, 'resume must run inside attachTab, before the entry is stored');
});

test('the resume send is best-effort (wrapped to swallow unsupported/no-op errors)', () => {
  const window = bg.slice(
    bg.indexOf("'Page.enable'"),
    bg.indexOf('attachedTabs.set(tabId, entry)'),
  );
  assert.match(window, /try\s*\{[\s\S]*runIfWaitingForDebugger[\s\S]*\}\s*catch/);
});
