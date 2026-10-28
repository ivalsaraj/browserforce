import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildExecContext, runCode, formatResult } from '../src/exec-engine.js';
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';
import { executeBrowserforceCommand, renderBrowserforceCommandText } from '../src/browserforce-command-registry.js';

function fixture() {
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'https://dialog.test' });
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const exec = () => buildExecContext(page, context, {});
  const actions = [];
  const fire = async (type, message = 'Delete item?', { fail = false } = {}) => {
    const dialog = {
      type: () => type, message: () => message, defaultValue: () => type === 'prompt' ? 'original' : '',
      accept: async (text) => { if (fail) throw new Error('page closed'); actions.push(['accept', text]); },
      dismiss: async () => { if (fail) throw new Error('page closed'); actions.push(['dismiss']); },
    };
    await Promise.all(page.listeners('dialog').map((listener) => listener(dialog)));
  };
  page.fire = fire;
  return { page, context, exec, actions, fire };
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

test('arming on one page cannot accept another page dialog', async () => {
  const f = fixture();
  const other = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'https://other.test' });
  const exec = f.exec();
  f.context.emit('page', other);
  const actions = [];
  await runCode('armDialog({accept:true});', exec, 1000);
  await other.listeners('dialog')[0]({ type: () => 'confirm', message: () => 'Other', defaultValue: () => '', accept: async () => actions.push('accept'), dismiss: async () => actions.push('dismiss') });
  assert.deepEqual(actions, ['dismiss']);
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
  await runtime.ensureBrowser();
  await f.fire('confirm');
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

test('dialog notices survive an idle disconnect and reach a non-exec command', async () => {
  const f = fixture();
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [f.context] });
  const runtime = createBrowserSessionRuntime({ connectBrowser: async () => browser, buildExecContext, runCode, initialPageDiscoveryTimeoutMs: 0 });
  await runtime.ensureBrowser();
  await f.fire('confirm');
  browser.emit('disconnected');
  const response = await executeBrowserforceCommand({ command: 'help', runtime });
  assert.match(response.text, /Dialog \(confirm\).*dismissed/);
});

test('dialog history is bounded and returned records cannot change saved history', async () => {
  const f = fixture();
  const exec = f.exec();
  for (let i = 0; i < 105; i += 1) await f.fire('alert', `notice ${i}`);
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
  await runtime.ensureBrowser();
  await f.fire('alert');
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
