import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDialogState } from '../src/dialogs.js';
import { buildExecContext, runCode, formatResult } from '../src/exec-engine.js';
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';
import { executeBrowserforceCommand, renderBrowserforceCommandText } from '../src/browserforce-command-registry.js';

async function fireDialog(page, actions, type = 'confirm', message = 'Delete item?', { fail = false } = {}) {
  const dialog = {
    type: () => type, message: () => message, defaultValue: () => type === 'prompt' ? 'original' : '',
    accept: async (text) => { if (fail) throw new Error('page closed'); actions.push(['accept', text]); },
    dismiss: async () => { if (fail) throw new Error('page closed'); actions.push(['dismiss']); },
  };
  await Promise.all(page.listeners('dialog').map((listener) => listener(dialog)));
}

function fixture() {
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'https://dialog.test' });
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const connection = { sendMessageToServer: async () => {} };
  context._connection = connection;
  page._type = 'Page';
  page._connection = connection;
  const addPage = () => {
    const other = Object.assign(new EventEmitter(), { _type: 'Page', _connection: connection, isClosed: () => false, url: () => 'https://other.test' });
    context.pages = () => [page, other];
    context.emit('page', other);
    return other;
  };
  context.newPage = async () => addPage();
  const exec = () => buildExecContext(page, context, {});
  const actions = [];
  const fire = (...args) => fireDialog(page, actions, ...args);
  page.fire = fire;
  return { page, context, exec, actions, fire, addPage };
}

for (const type of ['alert', 'beforeunload', 'confirm', 'prompt']) {
  test(`records and safely handles ${type} without an agent listener`, async () => {
    const f = fixture();
    const result = await runCode(`await page.fire('${type}'); return getDialogs();`, f.exec(), 1000);
    assert.deepEqual(f.actions[0], type === 'alert' || type === 'beforeunload' ? ['accept', undefined] : ['dismiss']);
    assert.equal(result.result[0].type, type);
    assert.equal(result.result[0].message, 'Delete item?');
    assert.equal(result.result[0].defaultValue, type === 'prompt' ? 'original' : '');
    assert.equal(result.result[0].url, 'https://dialog.test');
    assert.ok(Number.isFinite(Date.parse(result.result[0].at)));
    assert.match(formatResult(result).text, new RegExp(`Dialog \\(${type}\\)`));
  });
}

test('armDialog accepts a prompt once with text and then falls back to dismissal', async () => {
  const f = fixture();
  await runCode("armDialog({accept:true,promptText:'answer'}); await page.fire('prompt'); await page.fire('confirm');", f.exec(), 1000);
  assert.deepEqual(f.actions, [['accept', 'answer'], ['dismiss']]);
});

test('an explicit page arm accepts that page without affecting another driven page', async () => {
  const f = fixture();
  const other = f.addPage();
  other.fire = () => fireDialog(other, f.actions);
  const exec = f.exec();
  exec.other = other;
  await runCode("armDialog({accept:true, page:other}); await page.fire('confirm'); await other.fire();", exec, 1000);
  assert.deepEqual(f.actions, [['dismiss'], ['accept', undefined]]);
});

test('unused arms expire when an exec finishes', async () => {
  const f = fixture();
  await runCode('armDialog({accept:true});', f.exec(), 1000);
  await runCode("await page.fire('confirm');", f.exec(), 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('timeout cancels an already armed response', async () => {
  const f = fixture();
  await assert.rejects(runCode('armDialog({accept:true}); await new Promise(() => {});', f.exec(), 20), /timed out/);
  await f.fire('confirm');
  assert.deepEqual(f.actions, []);
  await runCode('return 1;', f.exec(), 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('late continuation cannot arm a response after timeout', async () => {
  const f = fixture();
  let release;
  const exec = { ...f.exec(), releaseGate: new Promise((resolve) => { release = resolve; }) };
  // Use raw page promise so the continuation actually resumes after cancellation.
  f.page.gate = () => exec.releaseGate;
  await assert.rejects(runCode("await page.gate(); try { armDialog({accept:true}); } catch (e) { page.late = e.message; }", exec, 20), /timed out/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.page.late, /timed out/);
  await f.fire('confirm');
  assert.deepEqual(f.actions, []);
  await runCode('return 1;', f.exec(), 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('invalid dialog responses fail before arming', async () => {
  const f = fixture();
  for (const code of ['armDialog({})', 'armDialog({accept:"yes"})', 'armDialog({accept:true,promptText:4})']) {
    await assert.rejects(runCode(code, f.exec(), 1000), /accept|promptText/);
  }
});

test('dialog failures are reported without an unhandled rejection', async () => {
  const f = fixture();
  const result = await runCode("await page.fire('confirm', 'Question', {fail:true}); return 'done';", f.exec(), 1000);
  assert.match(formatResult(result).text, /could not be handled.*page closed/);
});

test('notices append to screenshot results without changing their bytes', async () => {
  const f = fixture();
  const result = await runCode("await page.fire('alert'); return Buffer.from('image');", f.exec(), 1000);
  const content = formatResult(result, { multiContent: true });
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].data, Buffer.from('image').toString('base64'));
  assert.match(content[1].text, /Dialog \(alert\)/);
});

test('dialogs between runs surface once on the next browserforce result', async () => {
  const f = fixture();
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [f.context] });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser, buildExecContext, runCode, initialPageDiscoveryTimeoutMs: 0 });
  await runtime.runCommand({ code: 'return 1;' });
  await f.fire('confirm');
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.exec().getDialogs(), []);
  const response = await executeBrowserforceCommand({ command: 'eval return 42', runtime });
  assert.match(response.text, /42[\s\S]*Dialog \(confirm\).*dismissed/);
  const next = await executeBrowserforceCommand({ command: 'eval return 43', runtime });
  assert.equal(next.text, '43');
});

test('runtime installs one listener on existing pages and on newly opened pages', async () => {
  const f = fixture();
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [f.context] });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser, initialPageDiscoveryTimeoutMs: 0 });
  await runtime.ensureBrowser();
  runtime.ensureAllPagesCapture();
  runtime.ensureAllPagesCapture();
  assert.equal(f.page.listenerCount('dialog'), 1);
  const popup = Object.assign(new EventEmitter(), { url: () => 'https://popup.test' });
  f.context.emit('page', popup);
  assert.equal(popup.listenerCount('dialog'), 1);
});

test('browserforce renderer includes dialog warnings beside structured results', () => {
  const text = renderBrowserforceCommandText('get', { _bf_type: 'dialog_result', result: { url: 'https://dialog.test' }, dialogs: [{ type: 'confirm', message: 'Delete?', action: 'dismissed' }] });
  assert.match(text, /Dialog \(confirm\).*dismissed.*armDialog/);
});

test('one-shot CLI text formatting retains the result plus dialog notice', async () => {
  const f = fixture();
  const result = await runCode("await page.fire('confirm'); return 'answer';", f.exec(), 1000);
  const formatted = formatResult(result);
  assert.equal(formatted.type, 'text');
  assert.match(formatted.text, /^answer\n⚠️ Dialog/);
});

test('a command failure still includes the handled dialog notice', async () => {
  const f = fixture();
  await assert.rejects(runCode("await page.fire('confirm'); throw new Error('action failed');", f.exec(), 1000), /action failed[\s\S]*Dialog \(confirm\).*dismissed/);
});

test('an idle pending dialog is not reported by a non-exec command', async () => {
  const f = fixture();
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [f.context] });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser, buildExecContext, runCode, initialPageDiscoveryTimeoutMs: 0 });
  await runtime.runCommand({ code: 'return 1;' });
  await f.fire('confirm');
  const response = await executeBrowserforceCommand({ command: 'help', runtime });
  assert.doesNotMatch(response.text, /Dialog \(confirm\)/);
  assert.deepEqual(f.actions, []);
});

test('dialog history is bounded and returned records cannot change saved history', async () => {
  const f = fixture();
  const exec = f.exec();
  await runCode("for (let i = 0; i < 105; i += 1) await page.fire('alert', `notice ${i}`);", exec, 1000);
  const history = exec.getDialogs();
  assert.equal(history.length, 100);
  assert.equal(history[0].message, 'notice 5');
  history[0].message = 'changed';
  assert.equal(exec.getDialogs()[0].message, 'notice 5');
});

test('a new runtime connection retains records and reset clears them', async () => {
  const f = fixture();
  let currentContext = f.context;
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [currentContext], close: async () => browser.emit('disconnected') });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser, buildExecContext, runCode, initialPageDiscoveryTimeoutMs: 0 });
  await runtime.runCommand({ code: "await page.fire('alert');" });
  browser.emit('disconnected');
  const next = fixture();
  currentContext = next.context;
  await runtime.ensureBrowser();
  assert.equal(next.exec().getDialogs().length, 1);
  await runtime.reset();
  assert.deepEqual(next.exec().getDialogs(), []);
});

test('a dialog arm in one active run does not affect a second page in another run', async () => {
  const f = fixture();
  const exec = f.exec();
  const other = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'https://other.test' });
  f.context.emit('page', other);
  const actions = [];
  let release;
  f.page.gate = () => new Promise((resolve) => { release = resolve; });
  const firstRun = runCode("armDialog({accept:true}); await page.gate(); await page.fire('confirm');", exec, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  other.fire = async () => {
    await other.listeners('dialog')[0]({ type: () => 'confirm', message: () => 'Other', defaultValue: () => '', accept: async () => actions.push('accept'), dismiss: async () => actions.push('dismiss') });
  };
  const otherExec = buildExecContext(other, f.context, {}, { pinnedPage: other });
  await runCode('await page.fire();', otherExec, 1000);
  release();
  await firstRun;
  assert.deepEqual(actions, ['dismiss']);
  assert.deepEqual(f.actions, [['accept', undefined]]);
});

test('only the client with an active run driving the page handles a broadcast dialog', async () => {
  const f = fixture();
  const owner = createDialogState();
  const foreign = createDialogState();
  owner.setupPage(f.page);
  foreign.setupPage(f.page);
  const signal = new AbortController().signal;
  await foreign.withRun(signal, { page: f.addPage() }, () =>
    owner.withRun(signal, { page: f.page }, () => f.fire('confirm')));
  assert.deepEqual(f.actions, [['dismiss']]);
  assert.equal(owner.getDialogs().length, 1);
  assert.deepEqual(foreign.getDialogs(), []);
  assert.deepEqual(foreign.takeNotices(), []);
});

test('a user page never driven by the run is left alone without history', async () => {
  const f = fixture();
  const exec = f.exec();
  exec.userPage = f.addPage();
  // Fire on the original user page while the run is pinned to another tab.
  const pinned = buildExecContext(exec.userPage, f.context, {}, { pinnedPage: exec.userPage });
  pinned.fireUserDialog = f.fire;
  await runCode("await fireUserDialog('confirm');", pinned, 1000);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(exec.getDialogs(), []);
});

test('a run-created page is driven without changing the active page', async () => {
  const f = fixture();
  const newPage = f.addPage();
  f.context.newPage = async () => newPage;
  newPage.fire = () => fireDialog(newPage, f.actions);
  await runCode('const p = await context.newPage(); await p.fire();', f.exec(), 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('an action on a non-active page claims it for the current run', async () => {
  const f = fixture();
  const other = f.addPage();
  f.context._connection.sendMessageToServer = () => fireDialog(other, f.actions);
  const exec = f.exec();
  exec.other = other;
  await fireDialog(other, f.actions);
  assert.deepEqual(f.actions, []);
  await runCode("await other._connection.sendMessageToServer({_page:other}, 'evaluateExpression', {});", exec, 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('an idle client observing the same page does not handle or record the owner dialog', async () => {
  const f = fixture();
  const foreign = createDialogState();
  foreign.setupPage(f.page);
  await runCode("armDialog({accept:true}); await page.fire('confirm');", f.exec(), 1000);
  assert.deepEqual(f.actions, [['accept', undefined]]);
  assert.deepEqual(foreign.getDialogs(), []);
  assert.deepEqual(foreign.takeNotices(), []);
});

test('a pending dialog waits for a run driving its own page', async () => {
  const f = fixture();
  await runCode('return 1;', f.exec(), 1000);
  await f.fire('confirm');
  const other = f.addPage();
  await runCode('return 2;', buildExecContext(other, f.context, {}, { pinnedPage: other }), 1000);
  assert.deepEqual(f.actions, []);
  const result = await runCode('armDialog({accept:true}); return 3;', f.exec(), 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
  assert.equal(result.dialogs.length, 1);
});

test('error completion releases page ownership and unused arms', async () => {
  const f = fixture();
  await assert.rejects(runCode("armDialog({accept:true}); throw new Error('stop');", f.exec(), 1000), /stop/);
  await f.fire('confirm');
  assert.deepEqual(f.actions, []);
  await runCode('return 1;', f.exec(), 1000);
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('alert and beforeunload do not consume a confirm arm', async () => {
  const f = fixture();
  await runCode("armDialog({accept:true}); await page.fire('alert'); await page.fire('beforeunload'); await page.fire('confirm');", f.exec(), 1000);
  assert.deepEqual(f.actions, [['accept', undefined], ['accept', undefined], ['accept', undefined]]);
});

test('pending dialogs are bounded to the latest 100 previously driven pages', async () => {
  const state = createDialogState();
  const pages = Array.from({ length: 101 }, () => Object.assign(new EventEmitter(), { url: () => 'https://pending.test' }));
  const actions = [];
  for (const page of pages) {
    state.setupPage(page);
    await state.withRun(new AbortController().signal, { page }, () => {});
    await fireDialog(page, actions);
  }
  assert.deepEqual(actions, []);
  await state.withRun(new AbortController().signal, { page: pages[0] }, () => {});
  assert.deepEqual(actions, []);
  await state.withRun(new AbortController().signal, { page: pages[1] }, () => {});
  assert.deepEqual(actions, [['dismiss']]);
});

test('closed pages discard pending dialogs', async () => {
  const f = fixture();
  const exec = f.exec();
  await runCode('return 1;', exec, 1000);
  await f.fire('confirm');
  f.page.emit('close');
  await runCode('return 2;', exec, 1000);
  assert.deepEqual(f.actions, []);
});

test('an explicit arm accepts a guarded Page saved in state', async () => {
  const f = fixture();
  const other = f.addPage();
  other.fire = () => fireDialog(other, f.actions);
  const exec = buildExecContext(f.page, f.context, { other });
  await runCode('armDialog({accept:true,page:state.other}); await state.other.fire();', exec, 1000);
  assert.deepEqual(f.actions, [['accept', undefined]]);
});

test('invalid explicit page targets fail before arming', async () => {
  const f = fixture();
  for (const page of [null, {}, { on() {}, isClosed: () => true }]) {
    const exec = f.exec();
    exec.target = page;
    await assert.rejects(runCode('armDialog({accept:true,page:target});', exec, 1000), /open Page/);
  }
});

test('the open command owns the page while navigating', async () => {
  const f = fixture();
  const created = f.addPage();
  created.goto = () => fireDialog(created, f.actions);
  f.context.newPage = async () => created;
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [f.context] });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser, initialPageDiscoveryTimeoutMs: 0 });
  await runtime.openNewPage({ url: 'https://created.test' });
  assert.deepEqual(f.actions, [['dismiss']]);
});

test('previously driven idle client discards a dialog another client already handled', async () => {
  const f = fixture();
  const idle = createDialogState();
  idle.setupPage(f.page);
  await idle.withRun(new AbortController().signal, { page: f.page }, () => {});
  let handled = false;
  const dialog = {
    type: () => 'confirm', message: () => 'Continue?', defaultValue: () => '',
    accept: async () => { handled = true; },
    dismiss: async () => { if (handled) throw new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing'); handled = true; },
  };
  const owner = createDialogState();
  owner.setupPage(f.page);
  const signal = new AbortController().signal;
  await owner.withRun(signal, { page: f.page }, async () => {
    owner.armDialog(f.page, { accept: true }, signal);
    await Promise.all(f.page.listeners('dialog').map((listener) => listener(dialog)));
  });
  assert.equal(handled, true);
  await idle.withRun(new AbortController().signal, { page: f.page }, () => {});
  assert.deepEqual(idle.getDialogs(), []);
  assert.deepEqual(idle.takeNotices(), []);
});

test('queued dialogs still report genuine handling failures', async () => {
  const f = fixture();
  const state = createDialogState();
  state.setupPage(f.page);
  await state.withRun(new AbortController().signal, { page: f.page }, () => {});
  await f.fire('confirm', 'Continue?', { fail: true });
  await state.withRun(new AbortController().signal, { page: f.page }, () => {});
  assert.equal(state.takeNotices()[0].error, 'page closed');
});
