export function buildBrowserforceTabGroupPlan({ attachedTabIds = [], allTabs = [], existingGroups = [], agentTabIds = [], agentGroupIds = [] } = {}) {
  const agentTabIdSet = new Set(agentTabIds);
  const agentGroupIdSet = new Set(agentGroupIds);
  attachedTabIds = attachedTabIds.filter((id) => !agentTabIdSet.has(id));
  allTabs = allTabs.filter((tab) => !agentTabIdSet.has(tab.id));
  existingGroups = existingGroups.filter((group) => !agentGroupIdSet.has(group.id));
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

const AGENT_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const OWNER_TITLE_SUFFIX_LENGTH = 4;

export function buildAgentTabGroupPlan({
  agentTabs = new Map(),
  agentTabNames = new Map(),
  agentTabGroupIds = new Map(),
  newAgentTabIds = [],
  allTabs = [],
  existingGroups = [],
} = {}) {
  const tabById = new Map(allTabs.map((tab) => [tab.id, tab]));
  const groupById = new Map(existingGroups.map((group) => [group.id, group]));
  const ownersByWindow = new Map();
  // Only the create path submits new ids. Reconnects and group-change events
  // never regroup old tabs, so a user's drag/ungroup wins even after SW restart.
  for (const tabId of new Set(newAgentTabIds)) {
    const tab = tabById.get(tabId);
    if (!tab || !agentTabs.has(tabId) || !Number.isInteger(tab.windowId) || tab.groupId >= 0) continue;
    const owner = agentTabs.get(tabId);
    if (!ownersByWindow.has(tab.windowId)) ownersByWindow.set(tab.windowId, new Map());
    const owners = ownersByWindow.get(tab.windowId);
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(tabId);
  }
  const plans = [];
  for (const [windowId, owners] of ownersByWindow) {
    for (const [owner, tabsToAdd] of owners) {
      const member = allTabs.find((tab) => (
        tab.windowId === windowId && agentTabs.has(tab.id) && agentTabs.get(tab.id) === owner
        && agentTabGroupIds.get(tab.id) === tab.groupId && groupById.get(tab.groupId)?.windowId === windowId
      ));
      const namedTabId = [...tabsToAdd, ...agentTabs.keys()].find((id) => agentTabs.get(id) === owner && agentTabNames.has(id));
      const title = agentTabNames.get(namedTabId) || (owner ? owner.slice(-OWNER_TITLE_SUFFIX_LENGTH) : 'BrowserForce');
      let hash = 0;
      for (const char of owner || '') hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
      plans.push({ windowId, existingGroupId: member?.groupId ?? null, tabsToAdd, title, color: AGENT_GROUP_COLORS[hash % AGENT_GROUP_COLORS.length] });
    }
  }
  return plans;
}
