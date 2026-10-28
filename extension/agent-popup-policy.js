export const AGENT_POPUP_ACTIVITY_MS = 5000;

export function resolveAgentPopupPlan({
  tab, opener, isAgentCreated = false, isAttached = false, lastRealCommandAt,
  now = Date.now(), ownerKey, agentName, selectedTabId,
} = {}) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.openerTabId)
    || opener?.id !== tab.openerTabId || !Number.isInteger(opener.windowId)) return null;
  const isRecentlyDriven = isAttached && Number.isFinite(lastRealCommandAt)
    && now >= lastRealCommandAt && now - lastRealCommandAt <= AGENT_POPUP_ACTIVITY_MS;
  if (!isAgentCreated && !isRecentlyDriven) return null;
  return {
    windowId: opener.windowId,
    groupId: Number.isInteger(opener.groupId) && opener.groupId >= 0 ? opener.groupId : null,
    ownerKey: typeof ownerKey === 'string' ? ownerKey : null,
    agentName,
    shouldMove: tab.windowId !== opener.windowId,
    restoreTabId: Number.isInteger(selectedTabId) && selectedTabId !== tab.id ? selectedTabId : null,
  };
}
