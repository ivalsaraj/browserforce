import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, buildBoxFromQuad } from '../src/a11y-labels.js';

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
