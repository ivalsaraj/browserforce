import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { withClientLabel, PROCESS_CLIENT_LABEL } from '../src/client-label.js';

const readLabelFromSubprocess = (env) => execFileSync(process.execPath, [
  '--input-type=module', '-e',
  "import{PROCESS_CLIENT_LABEL}from'./mcp/src/client-label.js';process.stdout.write(PROCESS_CLIENT_LABEL)",
], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('applies one stable label for the lifetime of the process', () => {
  const a = new URL(withClientLabel('ws://127.0.0.1:19222/cdp?token=t')).searchParams.get('label');
  const b = new URL(withClientLabel('ws://127.0.0.1:19222/cdp?token=t')).searchParams.get('label');
  assert.equal(a, b, 'label must be stable within a process (survives idle reconnect)');
  assert.equal(a, PROCESS_CLIENT_LABEL);
});

test('keeps an explicit label already present on the URL', () => {
  const out = withClientLabel('ws://127.0.0.1:19222/cdp?token=t&label=mine');
  assert.equal(new URL(out).searchParams.get('label'), 'mine');
});

test('returns the input unchanged when it is not a valid URL', () => {
  assert.equal(withClientLabel('not a url'), 'not a url');
});

test('honours BROWSERFORCE_CDP_CLIENT_LABEL from the environment', () => {
  assert.equal(
    readLabelFromSubprocess({ BROWSERFORCE_CDP_CLIENT_LABEL: 'shared-team-window' }),
    'shared-team-window');
});

test('default labels differ across processes so concurrent agents get separate windows', () => {
  // Empty string is deliberate: `||` treats '' as unset, so this exercises the
  // generated default even when the developer has the override exported.
  const env = { BROWSERFORCE_CDP_CLIENT_LABEL: '' };
  const a = readLabelFromSubprocess(env);
  const b = readLabelFromSubprocess(env);
  assert.match(a, /^browserforce-mcp-[0-9a-f]{8}$/);
  assert.match(b, /^browserforce-mcp-[0-9a-f]{8}$/);
  assert.notEqual(a, b, 'a shared constant would make every agent share one window');
});
