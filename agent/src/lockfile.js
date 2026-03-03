import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CHATD_LOCK_PATH = join(homedir(), '.browserforce', 'chatd-lock.json');

function resolveLockPath(lockPath) {
  return lockPath || DEFAULT_CHATD_LOCK_PATH;
}

export async function isLockAlive({ lock } = {}) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeLock({ pid, port, token, lockPath } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('writeLock requires a positive integer pid');
  if (!Number.isInteger(port) || port <= 0) throw new Error('writeLock requires a positive integer port');
  if (!token || typeof token !== 'string') throw new Error('writeLock requires token');

  const finalPath = resolveLockPath(lockPath);
  await fs.mkdir(dirname(finalPath), { recursive: true });
  const payload = { pid, port, token };
  await fs.writeFile(finalPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return payload;
}

export async function readLock({ lockPath } = {}) {
  const finalPath = resolveLockPath(lockPath);
  let raw;
  try {
    raw = await fs.readFile(finalPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Number.isInteger(data.pid) || !Number.isInteger(data.port) || typeof data.token !== 'string') {
    return null;
  }

  if (!await isLockAlive({ lock: data })) {
    return null;
  }

  return data;
}

export async function clearLock({ lockPath } = {}) {
  const finalPath = resolveLockPath(lockPath);
  try {
    await fs.unlink(finalPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}
