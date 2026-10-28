export const AGENT_POPUP_ACTIVITY_MS = 5000;
const NEW_TAB_PAGE = /^chrome:\/\/(newtab|new-tab-page)\//;

// Chrome records the selected tab as opener for Cmd-T too, so opener identity
// alone cannot tell a page popup from a tab the user opened. Only a real agent
// command in the last few seconds can, for agent-created openers as well: an
// agent tab the user is merely looking at must not capture their new tabs.
export function isAgentPopupCandidate({ tab, isAttached = false, lastRealCommandAt, now = Date.now() } = {}) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.openerTabId)) return false;
  if (NEW_TAB_PAGE.test(tab.pendingUrl || tab.url || '')) return false;
  return isAttached && Number.isFinite(lastRealCommandAt)
    && now >= lastRealCommandAt && now - lastRealCommandAt <= AGENT_POPUP_ACTIVITY_MS;
}

export function resolveAgentPopupPlan({
  tab, opener, isAttached = false, lastRealCommandAt,
  now = Date.now(), ownerKey, agentName, selectedTabId,
} = {}) {
  if (!isAgentPopupCandidate({ tab, isAttached, lastRealCommandAt, now })
    || opener?.id !== tab.openerTabId || !Number.isInteger(opener.windowId)) return null;
  return {
    windowId: opener.windowId,
    groupId: Number.isInteger(opener.groupId) && opener.groupId >= 0 ? opener.groupId : null,
    ownerKey: typeof ownerKey === 'string' ? ownerKey : null,
    agentName,
    shouldMove: tab.windowId !== opener.windowId,
    restoreTabId: Number.isInteger(selectedTabId) && selectedTabId !== tab.id ? selectedTabId : null,
  };
}
