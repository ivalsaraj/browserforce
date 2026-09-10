import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const bg = fs.readFileSync('extension/background.js', 'utf8');

test('createTab imports and uses the plan resolver', () => {
  assert.match(bg, /import \{ resolveCreateWindowPlan \} from '\.\/window-affinity\.js'/);
  assert.match(bg, /resolveCreateTabWindowPlan\(params, resolveDedicatedWindow\(settings\)\)/);
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
  assert.match(bg, /origin === 'agent-created'\) \{[\s\S]{0,300}agentCreatedTabs\.set\(tabId, ownerKey\)/);
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

test('dedicated windows are tracked and consulted by the resolver', () => {
  assert.match(bg, /const dedicatedWindowIds = new Set\(\)/);
  assert.match(bg, /dedicatedWindowIds\.add\(win\.id\)/);
  assert.match(bg, /isRequestedWindowDedicated: dedicatedWindowIds\.has\(requestedWindowId\)/);
});

test('dedicated windows survive a service-worker restart and are pruned', () => {
  assert.match(bg, /dedicatedWindowIds: \[\.\.\.dedicatedWindowIds\]/);
  assert.match(bg, /saved\.dedicatedWindowIds/);
  assert.match(bg, /chrome\.windows\.getAll\(\)/);
  assert.match(bg, /openWindowIds\.has\(windowId\)/);
  assert.match(bg, /chrome\.windows\.onRemoved\.addListener/);
});

test('agent setting defaults come from the shared resolvers, never `|| 0`', () => {
  assert.match(bg, /import \{ resolveAutoCloseMinutes, resolveDedicatedWindow \} from '\.\/agent-defaults\.js'/);
  // `|| 0` cannot tell "never chosen" from an explicit Off, so it must be gone.
  assert.doesNotMatch(bg, /settings\.autoCloseMinutes \|\| 0/);
  assert.doesNotMatch(bg, /!!settings\.dedicatedWindow/);
});

test('agent-created tabs are tracked with their owning agent', () => {
  assert.match(bg, /const agentCreatedTabs = new Map\(\)/);
  assert.match(bg, /attachTab\(tab\.id, params\.sessionId, \{ origin: 'agent-created', ownerKey \}\)/);
  // No post-attach resurrection: onTabRemoved may have cleared it mid-await.
  assert.doesNotMatch(bg, /agentCreatedTabs\.set\(tab\.id, ownerKey\)/);
});

test('agent membership and its activity clock are checkpointed before the attach can throw', () => {
  const registration = bg.indexOf("origin === 'agent-created'");
  const activity = bg.indexOf('tabLastActivity.set(tabId, Date.now())', registration);
  const checkpoint = bg.indexOf('await persistAutoManageState()', registration);
  const attach = bg.indexOf('chrome.debugger.attach(', registration);
  assert.ok([registration, activity, checkpoint, attach].every((i) => i !== -1));
  assert.ok(activity < checkpoint, 'activity clock must be seeded before the checkpoint');
  assert.ok(checkpoint < attach, 'persist must happen before chrome.debugger.attach');
});

test('persisted auto-manage state stays rollback-readable', () => {
  assert.match(bg, /agentCreatedTabs: \[\.\.\.agentCreatedTabs\.keys\(\)\]/);
  assert.match(bg, /agentTabOwners: \[\.\.\.agentCreatedTabs\]/);
  assert.match(bg, /dedicatedWindowIds: \[\.\.\.dedicatedWindowIds\]/);
});

test('background delegates hydration and the close fence to the pure helpers', () => {
  assert.match(bg, /import \{ hydrateAgentTabs, hydrateActivity, canCloseTab \} from '\.\/auto-manage-state\.js'/);
  assert.match(bg, /hydrateAgentTabs\(saved, openTabIds\)/);
  assert.match(bg, /hydrateActivity\(saved, openTabIds\)/);
  assert.match(bg, /canCloseTab\(\{ owner: agentCreatedTabs\.get\(tabId\), requester \}\)/);
});

test('closing an unattached tab still clears its agent bookkeeping', () => {
  // Two ordered facts rather than one long window: the bookkeeping delete
  // happens, and it happens BEFORE the attached-only work is skipped.
  const body = bg.slice(bg.indexOf('function onTabRemoved'), bg.indexOf('function onTabUpdated'));
  assert.match(body, /agentCreatedTabs\.delete\(tabId\)/);
  assert.ok(body.indexOf('agentCreatedTabs.delete(tabId)') < body.indexOf('if (!isAttached) return;'),
    'bookkeeping must be cleared for tabs that were never attached');
});

test('closing an unattached tab is reported to the relay before the attached gate', () => {
  // The relay serves url/title from /json/list with no debugger attach, so a
  // close it never hears about leaves a target — and every handle and name
  // derived from it — pointing at a tab that no longer exists.
  const body = bg.slice(bg.indexOf('function onTabRemoved'), bg.indexOf('function onTabUpdated'));
  assert.ok(body.indexOf("method: 'tabDetached'") < body.indexOf('if (!isAttached) return;'),
    'tabDetached must be sent for every tab, not only attached ones');
});
