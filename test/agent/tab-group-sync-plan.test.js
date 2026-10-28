import test from 'node:test';
import assert from 'node:assert/strict';
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

test('adds new tabs to a group per owner in their existing window', () => {
  const plan = buildAgentTabGroupPlan(agentInput);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { windowId: 10, existingGroupId: 50, tabsToAdd: [2], title: 'Codex', color: plan[0].color });
  assert.equal(plan[1].existingGroupId, null);
  assert.equal(plan[1].title, 'Claude');
  assert.deepEqual(plan[1].tabsToAdd, [3]);
});

test('owner groups remain distinct when display names match', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, agentTabNames: new Map([[1, 'Agent'], [2, 'Agent'], [3, 'Agent']]) });
  assert.equal(plan[1].existingGroupId, null);
});

test('group title falls back to the owner suffix or BrowserForce', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, agentTabNames: new Map(), agentTabs: new Map([[2, 'label:abcd1234'], [3, null]]) });
  assert.equal(plan[0].title, 'Agent 1234');
  assert.equal(plan[1].title, 'BrowserForce');
});

test('group color is deterministic for an owner across windows', () => {
  const plan = buildAgentTabGroupPlan({ ...agentInput, newAgentTabIds: [1, 2], allTabs: [{ id: 1, windowId: 11, groupId: -1 }, { id: 2, windowId: 10, groupId: -1 }] });
  assert.equal(plan[0].color, plan[1].color);
  assert.ok(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(plan[0].color));
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

test('shared browserforce grouping excludes agent tabs and their groups', () => {
  const plan = buildBrowserforceTabGroupPlan({ attachedTabIds: [1, 2, 4], agentTabIds: [1, 2], agentGroupIds: [50], allTabs: [...agentInput.allTabs, { id: 4, windowId: 10, groupId: -1 }], existingGroups: [{ id: 50, windowId: 10, title: 'browserforce' }] });
  assert.equal(plan.windows[0].existingGroupId, null);
  assert.deepEqual(plan.windows[0].tabsToAdd, [4]);
  assert.deepEqual(plan.groupsToClear, []);
});
