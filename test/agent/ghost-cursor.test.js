import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GHOST_CURSOR_SOURCE,
  buildGhostCursorAction,
  buildGhostCursorActionExpression,
  createGhostCursorController,
  handleGhostCursorInput,
} from '../../extension/ghost-cursor.js';

const background = fs.readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const ghostCursorModule = fs.readFileSync(new URL('../../extension/ghost-cursor.js', import.meta.url), 'utf8');
const popupHtml = fs.readFileSync(new URL('../../extension/popup.html', import.meta.url), 'utf8');
const popupJs = fs.readFileSync(new URL('../../extension/popup.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function createCommandRecorder({ shouldReject = false, onCommand } = {}) {
  const calls = [];
  const sendCommand = async (tabId, method, params) => {
    calls.push({ tabId, method, params });
    onCommand?.({ tabId, method, params });
    if (shouldReject) throw new Error('cursor command failed');
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { identifier: `cursor-script-${tabId}` };
    }
    return {};
  };
  return { calls, sendCommand };
}

function createFakeRendererRuntime() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.attributes = new Map();
      this.id = '';
    }

    get firstElementChild() {
      return this.children[0] || null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      child.parentNode = null;
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
  }

  const documentElement = new FakeElement('html');
  const timers = [];
  let nextTimerId = 1;

  function findById(element, id) {
    if (element.id === id) return element;
    for (const child of element.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  }

  const document = {
    readyState: 'complete',
    documentElement,
    body: documentElement,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(documentElement, id),
    addEventListener: () => {},
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
  };

  const context = {
    document,
    window,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimerId++, callback, delay, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (timerId) => {
      const timer = timers.find((candidate) => candidate.id === timerId);
      if (timer) timer.cleared = true;
    },
  };
  context.globalThis = context;

  vm.runInNewContext(GHOST_CURSOR_SOURCE, context);

  return {
    context,
    document,
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (!timer) throw new Error('No active fake timer');
      timer.cleared = true;
      timer.callback();
    },
  };
}

test('maps supported CDP mouse events into cursor actions', () => {
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 } }),
    { type: 'move', x: 40, y: 90, button: 'none' },
  );
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mousePressed', params: { x: 40, y: 90, button: 'left' } }),
    { type: 'down', x: 40, y: 90, button: 'left' },
  );
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseReleased', params: { x: 40, y: 90, button: 'left' } }),
    { type: 'up', x: 40, y: 90, button: 'left' },
  );
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseWheel', params: { x: 40, y: 90 } }),
    { type: 'wheel', x: 40, y: 90, button: 'none' },
  );
});

test('rejects unsupported or malformed cursor events', () => {
  assert.equal(buildGhostCursorAction({ type: 'touchStart', params: { x: 1, y: 2 } }), null);
  assert.equal(buildGhostCursorAction({ type: 'mouseMoved', params: { x: '40', y: 90 } }), null);
  assert.equal(buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: Number.NaN } }), null);
});

test('builds a serialized expression for a cursor action', () => {
  const expression = buildGhostCursorActionExpression({
    type: 'move',
    x: 12,
    y: 24,
    button: 'left',
  });

  assert.match(expression, /__browserforceGhostCursor/);
  assert.match(expression, /"x":12/);
  assert.match(expression, /"y":24/);
  assert.match(expression, /"button":"left"/);
});

test('controller serializes setup, coalesces movement, and preserves presses', async () => {
  const attachedTabs = new Set([7]);
  const commandRecorder = createCommandRecorder();
  const logs = [];
  const controller = createGhostCursorController({
    isEnabled: () => true,
    isTabAttached: (tabId) => attachedTabs.has(tabId),
    sendCommand: commandRecorder.sendCommand,
    log: (error) => logs.push(error),
  });

  await controller.enable(7);
  commandRecorder.calls.length = 0;

  const firstMove = controller.queueAction(7, { type: 'move', x: 10, y: 20, button: 'none' });
  const secondMove = controller.queueAction(7, { type: 'move', x: 30, y: 40, button: 'none' });
  const press = controller.queueAction(7, { type: 'down', x: 30, y: 40, button: 'left' });
  await Promise.all([firstMove, secondMove, press]);

  const expressions = commandRecorder.calls
    .filter((call) => call.method === 'Runtime.evaluate')
    .map((call) => call.params.expression);
  assert.equal(expressions.length, 2);
  assert.match(expressions[0], /"x":30/);
  assert.match(expressions[0], /"y":40/);
  assert.match(expressions[1], /"type":"down"/);
  assert.deepEqual(logs, []);
});

test('disable bypasses the live enabled predicate and removes cursor registration', async () => {
  let isEnabled = true;
  const commandRecorder = createCommandRecorder();
  const controller = createGhostCursorController({
    isEnabled: () => isEnabled,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
    log: () => {},
  });

  await controller.enable(11);
  commandRecorder.calls.length = 0;
  isEnabled = false;
  await controller.disable(11);

  assert.deepEqual(
    commandRecorder.calls.map((call) => call.method),
    ['Runtime.evaluate', 'Page.removeScriptToEvaluateOnNewDocument'],
  );
});

test('controller contains debugger failures and keeps cleanup independent per tab', async () => {
  const logs = [];
  const commandRecorder = createCommandRecorder({ shouldReject: true });
  const controller = createGhostCursorController({
    isEnabled: () => true,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
    log: (error) => logs.push(error),
  });

  await assert.doesNotReject(() => controller.enable(1));
  await assert.doesNotReject(() => controller.enable(2));
  await assert.doesNotReject(() => controller.queueAction(1, {
    type: 'move',
    x: 1,
    y: 2,
    button: 'none',
  }));
  await assert.doesNotReject(() => controller.cleanup(1));

  assert.equal(commandRecorder.calls.some((call) => call.tabId === 1), true);
  assert.equal(commandRecorder.calls.some((call) => call.tabId === 2), true);
  assert.equal(logs.length > 0, true);
});

test('input adapter ignores child/unsupported events and contains controller throws', () => {
  const logs = [];
  const controller = {
    queueAction: () => {
      throw new Error('queue failed');
    },
  };

  assert.equal(handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    childSessionId: 'child-1',
    tabId: 1,
    params: { type: 'mouseMoved', x: 1, y: 2 },
    controller,
    log: (error) => logs.push(error),
  }), false);
  assert.equal(handleGhostCursorInput({
    method: 'Runtime.evaluate',
    tabId: 1,
    params: { type: 'mouseMoved', x: 1, y: 2 },
    controller,
    log: (error) => logs.push(error),
  }), false);
  assert.equal(handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    tabId: 1,
    params: { type: 'mouseMoved', x: '1', y: 2 },
    controller,
    log: (error) => logs.push(error),
  }), false);
  assert.doesNotThrow(() => handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    tabId: 1,
    params: { type: 'mouseMoved', x: 1, y: 2 },
    controller,
    log: (error) => logs.push(error),
  }));
  assert.equal(logs.length, 1);
});

test('renderer source mounts, animates, fades, wakes, navigates, and disables', () => {
  const runtime = createFakeRendererRuntime();
  const api = runtime.context.__browserforceGhostCursor;
  const outer = runtime.document.getElementById('__browserforce_ghost_cursor__');
  const inner = outer.firstElementChild;

  assert.ok(api);
  assert.ok(outer);
  api.applyMouseAction({ type: 'move', x: 10, y: 20, button: 'none' });
  assert.equal(outer.style.transitionDuration, '0ms');

  api.applyMouseAction({ type: 'move', x: 310, y: 420, button: 'none' });
  assert.equal(outer.style.transitionTimingFunction, 'cubic-bezier(0.65, 0, 0.35, 1)');
  assert.equal(outer.style.transitionDuration, '417ms');

  api.applyMouseAction({ type: 'down', x: 310, y: 420, button: 'left' });
  assert.equal(inner.style.transform, 'scale(0.95)');
  assert.equal(inner.style.opacity, '1');
  api.applyMouseAction({ type: 'up', x: 310, y: 420, button: 'left' });
  assert.equal(inner.style.transform, 'scale(1)');

  runtime.runNextTimer();
  assert.equal(inner.style.opacity, '0');
  api.applyMouseAction({ type: 'move', x: 500, y: 520, button: 'none' });
  assert.equal(inner.style.opacity, '1');
  assert.match(outer.style.transform, /500px/);

  const navigatedRuntime = createFakeRendererRuntime();
  assert.ok(navigatedRuntime.document.getElementById('__browserforce_ghost_cursor__'));

  api.disable();
  assert.equal(runtime.document.getElementById('__browserforce_ghost_cursor__'), null);
});

test('extension wiring keeps cursor updates cosmetic and settings default-off', () => {
  assert.match(popupHtml, /id="bf-ghost-cursor"/);
  assert.match(popupHtml, /Show ghost cursor for agent actions/);
  assert.match(popupJs, /ghostCursorEnabled/);
  assert.match(background, /handleGhostCursorInput/);
  assert.match(background, /ghostCursorController/);
  assert.match(ghostCursorModule, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(ghostCursorModule, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(packageJson.scripts.test, /test\/agent\/ghost-cursor\.test\.js/);
  assert.match(packageJson.scripts['test:agent'], /test\/agent\/ghost-cursor\.test\.js/);
});
