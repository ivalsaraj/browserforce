import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { pickChatdPort } from '../../agent/src/port-resolver.js';

async function bindPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function getEphemeralPort() {
  const server = await bindPort(0);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function findConsecutiveFreeRange(size = 3) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const start = await getEphemeralPort();
    const blockers = [];
    let ok = true;
    for (let i = 1; i < size; i += 1) {
      try {
        blockers.push(await bindPort(start + i));
      } catch {
        ok = false;
        break;
      }
    }
    await Promise.all(blockers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (ok) return start;
  }
  throw new Error('unable to find a consecutive free port range for test');
}

test('prefers BF_CHATD_PORT when free', async () => {
  const port = await pickChatdPort({ envPort: 19301, rangeStart: 19280, rangeEnd: 19320 });
  assert.equal(port, 19301);
});

test('falls back to first free range port when env port unavailable', async () => {
  const rangeStart = await findConsecutiveFreeRange(3);
  const blocker = await bindPort(rangeStart);
  try {
    const port = await pickChatdPort({ envPort: rangeStart, rangeStart, rangeEnd: rangeStart + 2 });
    assert.equal(port, rangeStart + 1);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
