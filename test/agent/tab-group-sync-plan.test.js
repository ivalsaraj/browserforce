import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserforceTabGroupPlan } from '../../extension/tab-group-sync-plan.js';

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
