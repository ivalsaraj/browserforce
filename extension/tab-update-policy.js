// extension/tab-update-policy.js — pure predicates for what the extension
// reports to the relay about tab lifecycle. Extracted so they are unit-testable
// (extension code cannot be, it needs the chrome.* APIs), following
// window-affinity.js and auto-manage-state.js.
//
// The relay caches each tab's url/title and serves them from /json/list with no
// debugger attach. That cache is only as fresh as what the extension reports,
// and reporting used to be gated on `attachedTabs.has(tabId)` — but attachment
// is LAZY, so almost no tab qualified. A user navigating an unattached tab left
// the relay serving the discovery-time URL, which breaks page-to-target
// matching and drops that tab back to a renumbering handle.

/**
 * A closed tab is always worth reporting: the relay drops ids it does not know,
 * so a message about an undiscovered tab is harmless, while withholding one
 * leaves the relay serving a target for a tab that no longer exists.
 */
export function shouldReportTabRemoval() {
  return true;
}

/** Report url/title changes for every tab; group changes only where the relay tracks the tab. */
export function shouldReportTabUpdate({ isAttached, changeInfo }) {
  if (!changeInfo) return false;
  // Property PRESENCE, not truthiness: a page that clears its title reports
  // `{ title: '' }`, and a truthiness check would drop it and leave the relay
  // serving the previous title forever.
  if ('url' in changeInfo || 'title' in changeInfo) return true;
  return isAttached === true && changeInfo.groupId !== undefined;
}
