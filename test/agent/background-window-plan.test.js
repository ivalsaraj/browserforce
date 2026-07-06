import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const bg = fs.readFileSync('extension/background.js', 'utf8');

test('createTab imports and uses the plan resolver', () => {
  assert.match(bg, /import \{ resolveCreateWindowPlan \} from '\.\/window-affinity\.js'/);
  assert.match(bg, /resolveCreateTabWindowPlan\(params, !!settings\.dedicatedWindow\)/);
});

test('createTab reads the dedicatedWindow setting from storage', () => {
  assert.match(bg, /'dedicatedWindow'/);
});

test('new-window plan opens a background window via chrome.windows.create', () => {
  assert.match(bg, /plan\.action === 'new-window'/);
  assert.match(bg, /chrome\.windows\.create\(/);
  assert.match(bg, /focused:\s*false/);
});

test('auto-manage state is persisted to chrome.storage.session and hydrated on start', () => {
  assert.match(bg, /chrome\.storage\.session\.set\(/);
  assert.match(bg, /chrome\.storage\.session\.get\(/);
  assert.match(bg, /hydrateAutoManageState\(\)/);
  assert.match(bg, /persistAutoManageState\(\)/);
});

test('attachTab re-registers agent-created tabs for auto-close', () => {
  assert.match(bg, /origin === 'agent-created'\) \{\s*agentCreatedTabs\.add\(tabId\)/);
});

test('attachTab never demotes agent-created provenance to relay-attached', () => {
  assert.match(bg, /existing\.origin === 'agent-created' && origin === 'relay-attached'/);
});

test('the bf-reconnect alarm also sweeps inactive tabs', () => {
  assert.match(bg, /alarm\.name === 'bf-reconnect'[\s\S]{0,200}checkInactiveTabs\(\)/);
});

test('listTabs surfaces agent-created provenance for hydrated tabs', () => {
  assert.match(bg, /origin: agentCreatedTabs\.has\(t\.id\) \? 'agent-created' : undefined/);
});

test('passive cdpCommands do not bump tabLastActivity', () => {
  assert.match(bg, /if \(!msg\.params\.passive\) tabLastActivity\.set\(msg\.params\.tabId, Date\.now\(\)\)/);
});
