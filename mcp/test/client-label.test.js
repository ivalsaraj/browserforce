import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { withClientLabel, withAgentName, PROCESS_CLIENT_LABEL } from '../src/client-label.js';

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

// ─── Agent display name (ghost cursor label) ─────────────────────────────────

const paramsFromSubprocess = (env, expr) => JSON.parse(execFileSync(process.execPath, [
  '--input-type=module', '-e',
  "import{withAgentName,agentCdpUrl}from'./mcp/src/client-label.js';"
  + `const out=${expr};`
  + "const u=new URL(out);"
  + "process.stdout.write(JSON.stringify({agentName:u.searchParams.get('agentName'),label:u.searchParams.get('label')}))",
], { env: { ...process.env, ...env }, encoding: 'utf8' }));

const URL_IN = "'ws://127.0.0.1:19222/cdp?token=t'";

test('adds no agentName when the agent did not name itself', () => {
  assert.equal(
    paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: '' }, `withAgentName(${URL_IN})`).agentName,
    null);
});

test('carries BROWSERFORCE_AGENT_NAME onto the connect URL', () => {
  assert.equal(
    paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: 'Claude' }, `withAgentName(${URL_IN})`).agentName,
    'Claude');
});

test('passes the name raw, leaving the length and character policy to the relay', () => {
  const raw = 'Claude!!' + 'x'.repeat(40);
  assert.equal(
    paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: raw }, `withAgentName(${URL_IN})`).agentName,
    raw);
});

test('keeps an explicit agentName already present on the URL', () => {
  assert.equal(
    paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: 'Claude' },
      "withAgentName('ws://127.0.0.1:19222/cdp?token=t&agentName=mine')").agentName,
    'mine');
});

test('returns the input unchanged when it is not a valid URL', () => {
  assert.equal(withAgentName('not a url'), 'not a url');
});

test('agentCdpUrl applies both the affinity label and the agent name by default', () => {
  const out = paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: 'Claude' }, `agentCdpUrl(${URL_IN})`);
  assert.equal(out.agentName, 'Claude');
  assert.match(out.label, /^browserforce-mcp-[0-9a-f]{8}$/,
    'dropping withClientLabel here would delete the durable window affinity key');
});

test('agentCdpUrl with durableLabel false adds the name but no affinity label', () => {
  const out = paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: 'Claude' },
    `agentCdpUrl(${URL_IN}, { durableLabel: false })`);
  assert.equal(out.agentName, 'Claude');
  assert.equal(out.label, null,
    'the one-shot CLI path must not start pinning a window');
});

test('agentCdpUrl still applies the affinity label when the agent is unnamed', () => {
  const out = paramsFromSubprocess({ BROWSERFORCE_AGENT_NAME: '' }, `agentCdpUrl(${URL_IN})`);
  assert.equal(out.agentName, null);
  assert.match(out.label, /^browserforce-mcp-[0-9a-f]{8}$/);
});

// Every CDP connect factory must route through agentCdpUrl. Composition itself
// is covered behaviourally above; what a source assertion can genuinely prove is
// that each entrypoint still calls it. scripts/repro-tab-handles.mjs is
// deliberately excluded — a developer repro script, not a user entrypoint.
test('every connect factory routes its CDP URL through agentCdpUrl', () => {
  const factories = [
    ['mcp/src/index.js', '../src/index.js', true],
    ['cli/sessiond.js', '../../cli/sessiond.js', true],
    ['bin.js', '../../bin.js', false],
  ];
  for (const [name, relative, durableLabel] of factories) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /agentCdpUrl\(/, `${name} must build its connect URL with agentCdpUrl`);
    assert.doesNotMatch(source, /withClientLabel\(/,
      `${name} must not hand-compose the wrappers; agentCdpUrl owns that`);
    if (durableLabel) {
      assert.doesNotMatch(source, /durableLabel:\s*false/,
        `${name} needs the durable affinity label — dropping it respawns a window per reconnect`);
    } else {
      assert.match(source, /durableLabel:\s*false/,
        `${name} is the one-shot path and must not start pinning a window`);
    }
  }
});
