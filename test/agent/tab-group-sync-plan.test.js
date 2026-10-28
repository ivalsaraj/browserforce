import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildBrowserforceTabGroupPlan, buildAgentTabGroupPlan } from '../../extension/tab-group-sync-plan.js';

test('keeps attached tabs grouped within their own Chrome window', () => {
  const plan = buildBrowserforceTabGroupPlan({
    attachedTabIds: [101, 202],
    allTabs: [
      { id: 101, windowId: 1, groupId: -1 },
      { id: 102, windowId: 1, groupId: 51 },
      { id: 202, windowId: 2, groupId: -1 },
    ],
    existingGroups: [
      { id: 51, windowId: 1, title: 'browserforce' },
    ],
  });

  assert.deepEqual(plan, {
    groupsToClear: [],
    windows: [
      {
        windowId: 1,
        existingGroupId: 51,
        duplicateGroupIds: [],
        duplicateTabIdsToUngroup: [],
        tabsToAdd: [101],
        tabsToRemove: [102],
        createNewGroup: true,
      },
      {
        windowId: 2,
        existingGroupId: null,
        duplicateGroupIds: [],
        duplicateTabIdsToUngroup: [],
        tabsToAdd: [202],
        tabsToRemove: [],
        createNewGroup: false,
      },
    ],
  });
});

test('prefers the existing group that already contains attached tabs', () => {
  const plan = buildBrowserforceTabGroupPlan({
    attachedTabIds: [202],
    allTabs: [
      { id: 201, windowId: 2, groupId: 61 },
      { id: 202, windowId: 2, groupId: 62 },
    ],
    existingGroups: [
      { id: 61, windowId: 2, title: 'browserforce' },
      { id: 62, windowId: 2, title: 'browserforce' },
    ],
  });

  assert.deepEqual(plan.windows, [
    {
      windowId: 2,
      existingGroupId: 62,
      duplicateGroupIds: [61],
      duplicateTabIdsToUngroup: [201],
      tabsToAdd: [],
      tabsToRemove: [],
      createNewGroup: false,
    },
  ]);
});

test('creates a fresh group when removals would empty the existing one before adding tabs', () => {
  const plan = buildBrowserforceTabGroupPlan({
    attachedTabIds: [302],
    allTabs: [
      { id: 301, windowId: 3, groupId: 71 },
      { id: 302, windowId: 3, groupId: -1 },
    ],
    existingGroups: [
      { id: 71, windowId: 3, title: 'browserforce' },
    ],
  });

  assert.deepEqual(plan.windows, [
    {
      windowId: 3,
      existingGroupId: 71,
      duplicateGroupIds: [],
      duplicateTabIdsToUngroup: [],
      tabsToAdd: [302],
      tabsToRemove: [301],
      createNewGroup: true,
    },
  ]);
});


const agentInput = {
  agentTabs: new Map([[1, 'label:abcd1234'], [2, 'label:abcd1234'], [3, 'label:other5678']]),
  agentTabNames: new Map([[1, 'Codex'], [2, 'Codex'], [3, 'Claude']]),
  agentTabGroupIds: new Map([[1, 50]]),
  newAgentTabIds: [2, 3],
  allTabs: [
    { id: 1, windowId: 10, groupId: 50 },
    { id: 2, windowId: 10, groupId: -1 },
    { id: 3, windowId: 10, groupId: -1 },
  ],
  existingGroups: [{ id: 50, windowId: 10 }],
};

test('new tabs from different owners share an existing managed group', () => {
  const plan = buildAgentTabGroupPlan(agentInput);
  assert.deepEqual(plan, [{ windowId: 10, existingGroupId: 50, tabsToAdd: [2, 3] }]);
});

test('display names do not split the shared group', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, agentTabNames: new Map([[1, 'Agent'], [2, 'Agent'], [3, 'Agent']]) });
  assert.equal(plan.length, 1);
});

test('unnamed and unlabeled agents share the same group', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, agentTabNames: new Map(), agentTabs: new Map([[2, 'label:abcd1234'], [3, null]]) });
  assert.deepEqual(plan, [{ windowId: 10, existingGroupId: null, tabsToAdd: [2, 3] }]);
});

test('new tabs in different windows stay in separate groups', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, newAgentTabIds: [1, 2], allTabs: [{ id: 1, windowId: 11, groupId: -1 }, { id: 2, windowId: 10, groupId: -1 }] });
  assert.deepEqual(plan, [
    { windowId: 11, existingGroupId: null, tabsToAdd: [1] },
    { windowId: 10, existingGroupId: null, tabsToAdd: [2] },
  ]);
});

test('never regroups an old tab the user removed, including after restart', () => {
  assert.deepEqual(buildAgentTabGroupPlan({ ...agentInput, newAgentTabIds: [], allTabs: agentInput.allTabs.map(t => ({ ...t, groupId: -1 })) }), []);
});

test('does not adopt a group the user moved an old agent tab into', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, allTabs: agentInput.allTabs.map(t => t.id === 1 ? { ...t, groupId: 70 } : t), existingGroups: [{ id: 70, windowId: 10 }] });
  assert.equal(plan[0].existingGroupId, null);
});

test('a new window gets a new group after the previous window closed', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, newAgentTabIds: [2], allTabs: [{ id: 2, windowId: 20, groupId: -1 }] });
  assert.equal(plan[0].windowId, 20);
  assert.equal(plan[0].existingGroupId, null);
});

test('existing managed groups get rename-only plans without moving old tabs', () => {
  const plan = buildAgentTabGroupPlan({
    ...agentInput,
    newAgentTabIds: [],
    agentTabGroupIds: new Map([[1, 50], [3, 60]]),
    allTabs: agentInput.allTabs.map((tab) => tab.id === 3 ? { ...tab, groupId: 60 } : tab),
    existingGroups: [{ id: 50, windowId: 10 }, { id: 60, windowId: 10 }],
  });
  assert.deepEqual(plan, [
    { windowId: 10, existingGroupId: 50, tabsToAdd: [] },
    { windowId: 10, existingGroupId: 60, tabsToAdd: [] },
  ]);
});

test('a matching group title without an assigned live member is not adopted', () => {
  const plan = buildAgentTabGroupPlan({
    ...agentInput,
    agentTabGroupIds: new Map(),
    existingGroups: [{ id: 50, windowId: 10, title: 'browserforce' }],
  });
  assert.deepEqual(plan, [{ windowId: 10, existingGroupId: null, tabsToAdd: [2, 3] }]);
});

test('closed and already-grouped new tabs do not create another group', () => {
  assert.deepEqual(buildAgentTabGroupPlan({
    agentTabs: new Map([[1, 'owner']]), newAgentTabIds: [1, 2],
    allTabs: [{ id: 1, windowId: 10, groupId: 70 }],
  }), []);
});

const background = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const syncSource = background.slice(background.indexOf('async function syncTabGroup('), background.indexOf('function queueSyncTabGroup('));

async function runSync(input = agentInput, newIds = input.newAgentTabIds) {
  const calls = [];
  const agentTabGroupIds = new Map(input.agentTabGroupIds);
  const sync = runInNewContext(`${syncSource}; syncTabGroup`, {
    attachedTabs: new Map(input.allTabs.map((tab) => [tab.id, {}])),
    agentCreatedTabs: input.agentTabs, agentTabNames: input.agentTabNames,
    agentTabGroupIds, buildAgentTabGroupPlan, buildBrowserforceTabGroupPlan,
    TAB_GROUP_COLOR: 'orange', isSyncingTabGroup: false,
    persistAutoManageState: async () => calls.push(['persist']),
    console: { warn: (...args) => calls.push(['warn', ...args]) },
    chrome: {
      tabs: {
        query: async () => input.allTabs,
        ungroup: async (ids) => calls.push(['ungroup', ids]),
        group: async (options) => {
          calls.push(['group', options]);
          assert.ok(options.tabIds.length > 0, 'Chrome rejects an empty tabIds list');
          return options.groupId ?? 99;
        },
      },
      tabGroups: {
        query: async () => input.existingGroups,
        update: async (id, options) => calls.push(['update', id, options]),
      },
    },
  });
  await sync(newIds);
  return { calls: JSON.parse(JSON.stringify(calls)), agentTabGroupIds };
}

test('background names a shared group browserforce and checkpoints new assignments', async () => {
  const { calls, agentTabGroupIds } = await runSync();
  assert.deepEqual(calls, [
    ['group', { tabIds: [2, 3], groupId: 50 }],
    ['update', 50, { title: 'browserforce', color: 'orange' }],
    ['persist'],
  ]);
  assert.deepEqual([...agentTabGroupIds], [[1, 50], [2, 50], [3, 50]]);
});

test('background renames a restored group without regrouping any tab', async () => {
  const { calls } = await runSync(agentInput, []);
  assert.deepEqual(calls, [
    ['update', 50, { title: 'browserforce', color: 'orange' }],
  ]);
});

test('the next owner reuses the group assignment after restart', async () => {
  const first = await runSync();
  const { calls } = await runSync({
    ...agentInput,
    agentTabs: new Map([...agentInput.agentTabs, [4, 'label:new-process']]),
    agentTabGroupIds: first.agentTabGroupIds,
    allTabs: [...agentInput.allTabs.map((tab) => ({ ...tab, groupId: 50 })), { id: 4, windowId: 10, groupId: -1 }],
    newAgentTabIds: [4],
  });
  assert.deepEqual(calls[0], ['group', { tabIds: [4], groupId: 50 }]);
});

test('shared browserforce grouping excludes agent tabs and their groups', () => {
  const plan = buildBrowserforceTabGroupPlan({ attachedTabIds: [1, 2, 4], agentTabIds: [1, 2], agentGroupIds: [50], allTabs: [...agentInput.allTabs, { id: 4, windowId: 10, groupId: -1 }], existingGroups: [{ id: 50, windowId: 10, title: 'browserforce' }] });
  assert.equal(plan.windows[0].existingGroupId, null);
  assert.deepEqual(plan.windows[0].tabsToAdd, [4]);
  assert.deepEqual(plan.groupsToClear, []);
});
