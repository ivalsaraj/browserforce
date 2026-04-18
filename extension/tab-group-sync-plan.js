export function buildBrowserforceTabGroupPlan({ attachedTabIds = [], allTabs = [], existingGroups = [] } = {}) {
  const attachedTabIdSet = new Set(
    attachedTabIds
      .map((tabId) => Number(tabId))
      .filter((tabId) => Number.isInteger(tabId)),
  );
  const normalizedTabs = allTabs
    .map((tab) => ({
      id: Number(tab?.id),
      windowId: Number(tab?.windowId),
      groupId: Number(tab?.groupId),
    }))
    .filter((tab) => Number.isInteger(tab.id) && Number.isInteger(tab.windowId));
  const tabById = new Map(normalizedTabs.map((tab) => [tab.id, tab]));
  const attachedByWindow = new Map();

  for (const tabId of attachedTabIdSet) {
    const tab = tabById.get(tabId);
    if (!tab) continue;
    const bucket = attachedByWindow.get(tab.windowId) || [];
    bucket.push(tab.id);
    attachedByWindow.set(tab.windowId, bucket);
  }

  const groupsByWindow = new Map();
  for (const group of existingGroups) {
    const groupId = Number(group?.id);
    const windowId = Number(group?.windowId);
    if (!Number.isInteger(groupId) || !Number.isInteger(windowId)) continue;
    const bucket = groupsByWindow.get(windowId) || [];
    bucket.push({ id: groupId, windowId });
    groupsByWindow.set(windowId, bucket);
  }

  const windowIds = new Set([
    ...attachedByWindow.keys(),
    ...groupsByWindow.keys(),
  ]);
  const groupsToClear = [];
  const windows = [];

  for (const windowId of Array.from(windowIds).sort((a, b) => a - b)) {
    const attachedInWindow = (attachedByWindow.get(windowId) || []).sort((a, b) => a - b);
    const groupsInWindow = groupsByWindow.get(windowId) || [];

    if (attachedInWindow.length === 0) {
      for (const group of groupsInWindow) {
        const tabIdsToUngroup = normalizedTabs
          .filter((tab) => tab.windowId === windowId && tab.groupId === group.id)
          .map((tab) => tab.id)
          .sort((a, b) => a - b);
        groupsToClear.push({
          windowId,
          groupId: group.id,
          tabIdsToUngroup,
        });
      }
      continue;
    }

    const groupsWithOverlap = groupsInWindow.map((group) => {
      const tabIds = normalizedTabs
        .filter((tab) => tab.windowId === windowId && tab.groupId === group.id)
        .map((tab) => tab.id);
      const attachedOverlap = tabIds.filter((tabId) => attachedTabIdSet.has(tabId)).length;
      return { ...group, tabIds, attachedOverlap };
    });
    groupsWithOverlap.sort((left, right) => (
      right.attachedOverlap - left.attachedOverlap
      || left.id - right.id
    ));

    const [keepGroup, ...duplicateGroups] = groupsWithOverlap;
    const duplicateGroupIds = duplicateGroups.map((group) => group.id).sort((a, b) => a - b);
    const duplicateGroupIdSet = new Set(duplicateGroupIds);
    const duplicateTabIdsToUngroup = normalizedTabs
      .filter((tab) => tab.windowId === windowId && duplicateGroupIdSet.has(tab.groupId))
      .map((tab) => tab.id)
      .sort((a, b) => a - b);
    const tabIdsInKeptGroup = keepGroup?.tabIds || [];
    const tabIdsInKeptGroupSet = new Set(tabIdsInKeptGroup);
    const tabsToAdd = attachedInWindow
      .filter((tabId) => !tabIdsInKeptGroupSet.has(tabId))
      .sort((a, b) => a - b);
    const tabsToRemove = tabIdsInKeptGroup
      .filter((tabId) => !attachedTabIdSet.has(tabId))
      .sort((a, b) => a - b);
    const createNewGroup = (
      keepGroup != null
      && tabsToAdd.length > 0
      && tabIdsInKeptGroup.length > 0
      && tabsToRemove.length === tabIdsInKeptGroup.length
    );

    windows.push({
      windowId,
      existingGroupId: keepGroup?.id ?? null,
      duplicateGroupIds,
      duplicateTabIdsToUngroup,
      tabsToAdd,
      tabsToRemove,
      createNewGroup,
    });
  }

  return { groupsToClear, windows };
}
