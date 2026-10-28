import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

const policy = await import('../../extension/agent-popup-policy.js');
const decide = (options) => policy.resolveAgentPopupPlan(options);
const base = {
  tab: { id: 3, openerTabId: 2, windowId: 10 },
  opener: { id: 2, windowId: 10, groupId: 7 },
  isAgentCreated: true, ownerKey: 'label:agent', agentName: 'Agent',
  now: 10000, selectedTabId: 1,
};

test('agent popup inherits placement, group, and owner', () => {
  assert.deepEqual(decide(base), { windowId: 10, groupId: 7, ownerKey: 'label:agent', agentName: 'Agent', shouldMove: false, restoreTabId: 1 });
});

test('popup windows move into the opener window', () => {
  assert.equal(decide({ ...base, tab: { ...base.tab, windowId: 20 } })?.shouldMove, true);
});

test('user-only openers and missing opener identity are untouched', () => {
  assert.equal(decide({ ...base, isAgentCreated: false }), null);
  assert.equal(decide({ ...base, opener: null }), null);
  assert.equal(decide({ ...base, tab: { id: 3, windowId: 10 } }), null);
});

test('attached openers qualify only for five seconds after a real command', () => {
  assert.ok(decide({ ...base, isAgentCreated: false, isAttached: true, lastRealCommandAt: 5000 }));
  assert.equal(decide({ ...base, isAgentCreated: false, isAttached: true, lastRealCommandAt: 4999 }), null);
  assert.equal(decide({ ...base, isAgentCreated: false, isAttached: false, lastRealCommandAt: 9999 }), null);
  assert.equal(decide({ ...base, isAgentCreated: false, isAttached: true }), null);
});

test('never restores the popup itself or invents an owner', () => {
  assert.equal(decide({ ...base, selectedTabId: 3, ownerKey: undefined })?.restoreTabId, null);
  assert.equal(decide({ ...base, ownerKey: undefined })?.ownerKey, null);
});

async function runPopup({ openerIsAgent = true, crossWindow = false, failMove = false, recentlyDriven = false, commandAgeMs = 0 } = {}) {
  const source = fs.readFileSync('extension/background.js', 'utf8');
  const start = source.indexOf('async function onTabCreated(');
  assert.ok(start >= 0, 'background handles tab creation');
  const body = source.slice(start, source.indexOf('function onTabRemoved', start));
  const calls = [];
  const pendingAgentPopups = new Set();
  const pendingAtOpenerRead = [];
  const agentCreatedTabs = new Map(openerIsAgent ? [[2, 'label:agent']] : []);
  const agentTabNames = new Map([[2, 'Agent']]);
  const agentTabGroupIds = new Map(openerIsAgent ? [[2, 7]] : []);
  const tabLastActivity = new Map();
  const tabs = new Map([[1, { id: 1, windowId: 10, active: crossWindow }], [2, base.opener], [3, { ...base.tab, windowId: crossWindow ? 20 : 10, active: true }]]);
  const chrome = { tabs: {
    get: async (id) => { pendingAtOpenerRead.push(pendingAgentPopups.has(3)); return tabs.get(id); },
    query: async ({ windowId }) => [...tabs.values()].filter((t) => t.windowId === windowId && t.active),
    update: async (id, options) => { calls.push(['update', id, options]); for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = tab.id === id; },
    move: async (id, options) => { calls.push(['move', id, options]); if (failMove) throw new Error('move failed'); for (const tab of tabs.values()) if (tab.windowId === options.windowId) tab.active = false; tabs.get(id).windowId = options.windowId; },
    group: async (options) => { calls.push(['group', options]); return 7; },
  } };
  const handler = runInNewContext(`${body}; onTabCreated`, {
    chrome, resolveAgentPopupPlan: policy.resolveAgentPopupPlan, AGENT_POPUP_ACTIVITY_MS: policy.AGENT_POPUP_ACTIVITY_MS, agentCreatedTabs, agentTabNames, agentTabGroupIds,
    tabLastActivity, pendingAgentPopups, lastRealCommandByTab: new Map(recentlyDriven ? [[2, {at: Date.now() - commandAgeMs}]] : []), attachedTabs: new Map(recentlyDriven ? [[2, {}]] : []),
    activeTabByWindow: new Map([[10, 1]]), previousActiveTabByWindow: new Map(),
    persistAutoManageState: async () => { calls.push(['persist']); },
    queueSyncTabGroup: async () => {}, tabGroupQueue: Promise.resolve(),
    attachTab: async (id, sessionId, options) => { calls.push(['attach', id, options]); return { tabId: id, sessionId, targetInfo: { openerId: 'chrome-opener' }, origin: 'agent-created' }; },
    notifyRelayManualTabAttached: (_id, entry) => calls.push(['notify', entry]), console,
  });
  await handler(tabs.get(3));
  return { calls: JSON.parse(JSON.stringify(calls)), agentCreatedTabs, agentTabGroupIds, tabLastActivity, pendingAtOpenerRead };
}

test('background restores selection before debugger attachment and registers cleanup ownership', async () => {
  const { calls, agentCreatedTabs, tabLastActivity } = await runPopup();
  assert.equal(agentCreatedTabs.get(3), 'label:agent');
  assert.ok(tabLastActivity.has(3));
  assert.ok(calls.findIndex(([kind]) => kind === 'update') < calls.findIndex(([kind]) => kind === 'attach'));
  assert.ok(calls.some(([kind, options]) => kind === 'group' && options.groupId === 7));
  assert.ok(calls.some(([kind]) => kind === 'notify'));
});

test('background moves a popup tab without recreating or focusing a window', async () => {
  const { calls } = await runPopup({ crossWindow: true });
  assert.ok(calls.some(([kind, id, options]) => kind === 'move' && id === 3 && options.windowId === 10));
  assert.ok(calls.some(([kind, id]) => kind === 'update' && id === 1));
});

test('background leaves user-only popups unchanged', async () => {
  assert.deepEqual((await runPopup({ openerIsAgent: false })).calls, []);
});

test('failed popup move still preserves cleanup membership', async () => {
  const { agentCreatedTabs } = await runPopup({ crossWindow: true, failMove: true });
  assert.equal(agentCreatedTabs.get(3), 'label:agent');
});

test('eligibility boundaries hold for seeded activity times (seed 63620)', () => {
  let seed = 63620;
  for (let i = 0; i < 200; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const age = seed % 12000 - 1000;
    const plan = decide({ ...base, isAgentCreated: false, isAttached: true, lastRealCommandAt: base.now - age });
    assert.equal(plan !== null, age >= 0 && age <= 5000, `age=${age}`);
  }
});

test('passive initialization never qualifies a manually attached opener', async () => {
  const source = fs.readFileSync('extension/background.js', 'utf8');
  const body = source.slice(source.indexOf('async function executeCommand'), source.indexOf('// ─── Tab Operations'));
  const lastRealCommandByTab = new Map();
  const command = runInNewContext(`${body}; executeCommand`, { lastRealCommandByTab, tabLastActivity: new Map(), cdpCommand: async () => ({}) });
  await command({ method: 'cdpCommand', params: { tabId: 2, passive: true, method: 'Page.enable' } });
  assert.equal(lastRealCommandByTab.has(2), false);
  await command({ method: 'cdpCommand', params: { tabId: 2, method: 'Input.dispatchMouseEvent', agentName: 'Agent' } });
  assert.ok(lastRealCommandByTab.get(2).at > 0);
});


test('a popup in a user-attached opener group does not turn that group into an agent-only group', async () => {
  const { buildBrowserforceTabGroupPlan } = await import('../../extension/tab-group-sync-plan.js');
  const { agentCreatedTabs, agentTabGroupIds } = await runPopup({ openerIsAgent: false, recentlyDriven: true });
  const plan = buildBrowserforceTabGroupPlan({
    attachedTabIds: [2, 3], agentTabIds: [...agentCreatedTabs.keys()], agentGroupIds: [...agentTabGroupIds.values()],
    allTabs: [{ id: 2, windowId: 10, groupId: 7 }, { id: 3, windowId: 10, groupId: 7 }],
    existingGroups: [{ id: 7, windowId: 10, title: 'browserforce' }],
  });
  assert.equal(plan.windows.some((window) => window.tabsToAdd.includes(2)), false, 'later reconciliation must leave the opener in its current group');
});


test('stale manual-tab activity does not suppress user popup activation tracking', async () => {
  const { calls, pendingAtOpenerRead } = await runPopup({ openerIsAgent: false, recentlyDriven: true, commandAgeMs: 6000 });
  assert.deepEqual(calls, []);
  assert.ok(pendingAtOpenerRead.every((pending) => pending === false));
});
