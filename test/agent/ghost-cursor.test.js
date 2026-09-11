import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GHOST_CURSOR_SOURCE,
  buildGhostCursorSource,
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
const manifest = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));

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

function createFakeRendererRuntime(source = GHOST_CURSOR_SOURCE, { hasRoot = true, legacyCursor = false } = {}) {
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
  const listeners = [];
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
    // Deferred mount only happens when BOTH roots are absent — the renderer
    // roots at `documentElement || body`.
    documentElement: hasRoot ? documentElement : null,
    body: hasRoot ? documentElement : null,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(documentElement, id),
    addEventListener: (type, handler) => { listeners.push({ type, handler }); },
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

  if (legacyCursor) {
    // What a pre-label build leaves in the page: the outer element carrying the
    // id, with only the arrow inside. ensureCursorElement() reuses it by id.
    const outer = new FakeElement('div');
    outer.id = '__browserforce_ghost_cursor__';
    outer.appendChild(new FakeElement('div'));
    documentElement.appendChild(outer);
  }

  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    context,
    document,
    documentElement,
    dispatch(action) {
      context.globalThis.__browserforceGhostCursor.applyMouseAction(action);
    },
    chip() {
      return findById(documentElement, '__browserforce_ghost_cursor_label__');
    },
    agentSpan() {
      return findById(documentElement, '__browserforce_ghost_cursor_agent__');
    },
    inner() {
      const outer = findById(documentElement, '__browserforce_ghost_cursor__');
      return outer ? outer.children[0] : null;
    },
    // Fires exactly one DOMContentLoaded handler. The renderer registers one per
    // deferred ensureCursorElement() call, and firing them all would let a later
    // handler's reuse branch cover for a broken mount branch.
    mountRoots() {
      document.documentElement = documentElement;
      document.body = documentElement;
      listeners.find((entry) => entry.type === 'DOMContentLoaded').handler();
    },
    reinject() {
      vm.runInContext(source, context);
    },
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (!timer) throw new Error('No active fake timer');
      timer.cleared = true;
      timer.callback();
    },
  };
}

test('packages the PNG and resolves its extension URL in the injected renderer', () => {
  const imageUrl = 'chrome-extension://test-extension/assets/ghost-cursor.png';
  const source = buildGhostCursorSource(imageUrl);
  const runtime = createFakeRendererRuntime(source);
  const inner = runtime.document.getElementById('__browserforce_ghost_cursor__').firstElementChild;

  assert.ok(source.includes(imageUrl));
  assert.ok(!source.includes('__browserforce_ghost_cursor_image_url__'));
  assert.equal(inner.style.backgroundImage, `url("${imageUrl}")`);
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ['assets/ghost-cursor.png'],
    matches: ['<all_urls>'],
  }]);
});

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

test('enable does not inject when the live setting is disabled', async () => {
  const commandRecorder = createCommandRecorder();
  const controller = createGhostCursorController({
    isEnabled: () => false,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
  });

  await controller.enable(7);

  assert.deepEqual(commandRecorder.calls, []);
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
  assert.match(background, /chrome\.runtime\.getURL\(['"]assets\/ghost-cursor\.png['"]\)/);
  assert.match(ghostCursorModule, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(ghostCursorModule, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(packageJson.scripts.test, /test\/agent\/ghost-cursor\.test\.js/);
  assert.match(packageJson.scripts['test:agent'], /test\/agent\/ghost-cursor\.test\.js/);
});

// ─── Agent label chip ────────────────────────────────────────────────────────

const CHIP_ID = '__browserforce_ghost_cursor_label__';
const AGENT_ID = '__browserforce_ghost_cursor_agent__';
const CHIP_PREFIX_TEXT = 'BrowserForce ·';

const move = (label) => ({ type: 'move', x: 40, y: 90, button: 'none', ...(label ? { label } : {}) });

test('renders no chip element at all when no client ever sends a name', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move());
  assert.equal(runtime.chip(), null);
});

test('renders the agent name behind a renderer-owned BrowserForce prefix', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  const chip = runtime.chip();
  assert.ok(chip);
  assert.equal(runtime.agentSpan().textContent, 'Claude');
  assert.equal(chip.children[0].textContent, CHIP_PREFIX_TEXT);
  // A margin, not a trailing space: `all: initial` resets white-space, so a
  // trailing space could collapse and render 'BrowserForce ·Claude'.
  assert.equal(chip.children[0].style.marginRight, '4px');
});

test('updates the name in place when a different agent takes over the tab', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  const firstChip = runtime.chip();

  runtime.dispatch(move('Codex'));

  assert.equal(runtime.agentSpan().textContent, 'Codex');
  assert.equal(runtime.chip(), firstChip);
  assert.equal(runtime.documentElement.children[0].children.filter((c) => c.id === CHIP_ID).length, 1);
});

test('removes the chip when an unlabelled client dispatches the next event', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  assert.ok(runtime.chip());

  runtime.dispatch(move());

  assert.equal(runtime.chip(), null);
});

test('does not rebuild the chip when the same name repeats', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  const chip = runtime.chip();

  runtime.dispatch(move('Claude'));

  assert.equal(runtime.chip(), chip);
});

test('adds a chip to a cursor element mounted by a build that had none', () => {
  // Upgrade in place: the page already holds a pre-label cursor, so
  // ensureCursorElement() takes its reuse-by-id branch and never runs the
  // create path where the chip refs would otherwise be established.
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { legacyCursor: true });
  assert.equal(runtime.documentElement.children.length, 1);
  assert.equal(runtime.chip(), null);

  runtime.dispatch(move('Claude'));

  assert.equal(runtime.agentSpan().textContent, 'Claude');
  assert.equal(runtime.documentElement.children.length, 1);
});

test('does not duplicate the chip when the renderer is re-injected', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  // Re-evaluating the source resets module state but not the page DOM, so the
  // chip refs must be rebound from the live DOM rather than recreated.
  runtime.reinject();
  runtime.dispatch(move('Codex'));

  const outer = runtime.documentElement.children[0];
  assert.equal(outer.children.filter((child) => child.id === CHIP_ID).length, 1);
  assert.equal(runtime.agentSpan().textContent, 'Codex');
});

test('replays a label that arrived before the document had a root', () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { hasRoot: false });
  runtime.dispatch(move('Claude'));
  assert.equal(runtime.chip(), null);

  runtime.mountRoots();

  assert.equal(runtime.agentSpan().textContent, 'Claude');
});

test('isolates the chip from page CSS without breaking its inline layout', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  const chip = runtime.chip();

  for (const element of [chip, chip.children[0], chip.children[1]]) {
    assert.equal(element.style.all, 'initial');
    assert.equal(element.style.direction, 'ltr');
    assert.equal(element.style.unicodeBidi, 'isolate');
    assert.equal(element.style.boxSizing, 'border-box');
    // `all: initial` restores pointer-events: auto, and an auto child inside a
    // none parent is hit-testable — it would swallow clicks under the label.
    assert.equal(element.style.pointerEvents, 'none');
    // A name with a space must not wrap out of the one-line chip.
    assert.equal(element.style.whiteSpace, 'nowrap');
  }
  assert.equal(chip.style.position, 'absolute');
  assert.equal(chip.style.display, 'block');
  // Spans stay inline, or the prefix stacks above the name.
  assert.equal(chip.children[0].style.display, 'inline');
  assert.equal(chip.children[1].style.display, 'inline');
  assert.equal(chip.children[0].style.position, undefined);
  assert.equal(chip.children[1].style.position, undefined);
});

test('fades the chip with the arrow when the cursor goes idle', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  runtime.runNextTimer();

  assert.equal(runtime.inner().style.opacity, '0');
  assert.equal(runtime.chip().style.opacity, '0');
});

test('wakes the chip and the arrow together on a press after idle', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  runtime.runNextTimer();

  runtime.dispatch({ type: 'down', x: 41, y: 91, button: 'left', label: 'Claude' });

  assert.equal(runtime.inner().style.opacity, '1');
  assert.equal(runtime.chip().style.opacity, '1');
});

test('scales only the arrow on press, never the chip', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch({ type: 'down', x: 40, y: 90, button: 'left', label: 'Claude' });

  assert.equal(runtime.inner().style.transform, 'scale(0.95)');
  assert.equal(runtime.chip().style.transform, undefined);
});

test('leaves no chip anywhere in the document after disable', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  runtime.context.globalThis.__browserforceGhostCursor.disable();

  assert.equal(runtime.chip(), null);
  assert.equal(runtime.agentSpan(), null);
});

test('carries the agent name on a cursor action and omits the key without one', () => {
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 }, agentName: 'Claude' }),
    { type: 'move', x: 40, y: 90, button: 'none', label: 'Claude' },
  );
  // Omitted, not empty: an unnamed client's payload stays byte-identical to
  // what it was before labels existed.
  assert.equal('label' in buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 } }), false);
  assert.equal('label' in buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 }, agentName: '' }), false);
  assert.equal('label' in buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 }, agentName: 42 }), false);
});

test('does not re-apply the relay length policy to the agent name', () => {
  const longName = 'x'.repeat(40);
  assert.equal(
    buildGhostCursorAction({ type: 'mouseMoved', params: { x: 1, y: 2 }, agentName: longName }).label,
    longName,
  );
});

test('forwards the agent name from the debugger bridge to the cursor action', () => {
  const actions = [];
  const controller = { queueAction: (tabId, action) => { actions.push(action); return Promise.resolve(true); } };

  handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    tabId: 7,
    params: { type: 'mouseMoved', x: 5, y: 6 },
    agentName: 'Codex',
    controller,
  });

  assert.equal(actions[0].label, 'Codex');
});
