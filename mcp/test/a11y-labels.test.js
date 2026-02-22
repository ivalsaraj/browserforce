import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, buildBoxFromQuad, buildSnapshotFromCdpNodes } from '../src/a11y-labels.js';

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions', async () => {
    const sema = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = async () => {
      await sema.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 50));
      running--;
      sema.release();
    };

    await Promise.all([task(), task(), task(), task()]);
    assert.equal(maxRunning, 2);
  });

  it('resolves immediately when under limit', async () => {
    const sema = new Semaphore(3);
    await sema.acquire(); // should not hang
    await sema.acquire();
    sema.release();
    sema.release();
  });
});

describe('buildBoxFromQuad', () => {
  it('computes bounding box from border quad points', () => {
    // quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    const quad = [10, 20, 110, 20, 110, 70, 10, 70];
    const box = buildBoxFromQuad(quad);
    assert.deepEqual(box, { x: 10, y: 20, width: 100, height: 50 });
  });

  it('handles rotated quads (non-axis-aligned)', () => {
    const quad = [50, 0, 100, 50, 50, 100, 0, 50];
    const box = buildBoxFromQuad(quad);
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    assert.equal(box.width, 100);
    assert.equal(box.height, 100);
  });

  it('returns zero-size box for degenerate quad', () => {
    const quad = [5, 5, 5, 5, 5, 5, 5, 5];
    const box = buildBoxFromQuad(quad);
    assert.equal(box.width, 0);
    assert.equal(box.height, 0);
  });
});

describe('buildSnapshotFromCdpNodes', () => {
  it('builds snapshot text with refs from CDP AX nodes', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test' }, childIds: ['2', '3'], ignored: false },
      { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Main' }, parentId: '1', childIds: ['4'], ignored: false, backendDOMNodeId: 10 },
      { nodeId: '3', role: { value: 'main' }, name: { value: '' }, parentId: '1', childIds: ['5', '6'], ignored: false, backendDOMNodeId: 11 },
      { nodeId: '4', role: { value: 'link' }, name: { value: 'Home' }, parentId: '2', childIds: [], ignored: false, backendDOMNodeId: 12 },
      { nodeId: '5', role: { value: 'heading' }, name: { value: 'Welcome' }, parentId: '3', childIds: [], ignored: false, backendDOMNodeId: 13 },
      { nodeId: '6', role: { value: 'button' }, name: { value: 'Submit' }, parentId: '3', childIds: [], ignored: false, backendDOMNodeId: 14 },
    ];

    const { text, refs } = buildSnapshotFromCdpNodes(nodes);
    assert.ok(text.includes('- navigation "Main"'));
    assert.ok(text.includes('- link "Home" [ref=e1]'));
    assert.ok(text.includes('- heading "Welcome"'));
    assert.ok(text.includes('- button "Submit" [ref=e2]'));
    assert.equal(refs.length, 2);
    assert.equal(refs[0].ref, 'e1');
    assert.equal(refs[0].role, 'link');
    assert.equal(refs[0].backendNodeId, 12);
    assert.equal(refs[1].ref, 'e2');
    assert.equal(refs[1].backendNodeId, 14);
  });

  it('skips ignored nodes', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2', '3'], ignored: false },
      { nodeId: '2', role: { value: 'main' }, name: { value: '' }, parentId: '1', childIds: ['3'], ignored: false, backendDOMNodeId: 10 },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'OK' }, parentId: '2', childIds: [], ignored: true, backendDOMNodeId: 11 },
    ];

    const { refs } = buildSnapshotFromCdpNodes(nodes);
    assert.equal(refs.length, 0);
  });

  it('skips generic/none/presentation roles', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'], ignored: false },
      { nodeId: '2', role: { value: 'generic' }, name: { value: '' }, parentId: '1', childIds: ['3'], ignored: false, backendDOMNodeId: 10 },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'Go' }, parentId: '2', childIds: [], ignored: false, backendDOMNodeId: 11 },
    ];

    const { text, refs } = buildSnapshotFromCdpNodes(nodes);
    assert.ok(!text.includes('generic'));
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref, 'e1');
  });

  it('filters to subtree when scopeBackendNodeId provided', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2', '3'], ignored: false },
      { nodeId: '2', role: { value: 'navigation' }, name: { value: '' }, parentId: '1', childIds: ['4'], ignored: false, backendDOMNodeId: 20 },
      { nodeId: '3', role: { value: 'main' }, name: { value: '' }, parentId: '1', childIds: ['5'], ignored: false, backendDOMNodeId: 30 },
      { nodeId: '4', role: { value: 'link' }, name: { value: 'Nav Link' }, parentId: '2', childIds: [], ignored: false, backendDOMNodeId: 21 },
      { nodeId: '5', role: { value: 'button' }, name: { value: 'Main Btn' }, parentId: '3', childIds: [], ignored: false, backendDOMNodeId: 31 },
    ];

    const { text, refs } = buildSnapshotFromCdpNodes(nodes, 30);
    assert.ok(!text.includes('Nav Link'));
    assert.ok(text.includes('Main Btn'));
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'Main Btn');
  });

  it('throws when scopeBackendNodeId has no AX match', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: [], ignored: false },
    ];

    assert.throws(
      () => buildSnapshotFromCdpNodes(nodes, 999),
      /no matching accessibility node/
    );
  });

  it('builds locators using role and name', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'], ignored: false },
      { nodeId: '2', role: { value: 'main' }, name: { value: '' }, parentId: '1', childIds: ['3'], ignored: false, backendDOMNodeId: 10 },
      { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, parentId: '2', childIds: [], ignored: false, backendDOMNodeId: 11 },
    ];

    const { refs } = buildSnapshotFromCdpNodes(nodes);
    assert.equal(refs[0].locator, 'role=textbox[name="Email"]');
  });
});
