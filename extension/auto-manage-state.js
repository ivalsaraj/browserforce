// Pure helpers for agent-tab bookkeeping. Kept out of background.js so they are
// testable without Chrome APIs (same rationale as window-affinity.js).

/**
 * Rebuild the agent-tab map from persisted state.
 * `agentCreatedTabs` (bare ids) is the source of truth for membership;
 * `agentTabOwners` pairs are best-effort metadata. Malformed owner data must
 * never abort hydration — losing owners costs a close-fence, losing membership
 * costs auto-close entirely.
 * @returns {Map<number, string|null>}
 */
export function hydrateAgentTabs(saved, openTabIds) {
  const owners = new Map(
    (Array.isArray(saved?.agentTabOwners) ? saved.agentTabOwners : [])
      .filter((pair) => Array.isArray(pair) && pair.length === 2)
      .map(([tabId, ownerKey]) => [tabId, typeof ownerKey === 'string' ? ownerKey : null]),
  );
  const out = new Map();
  for (const tabId of Array.isArray(saved?.agentCreatedTabs) ? saved.agentCreatedTabs : []) {
    if (openTabIds.has(tabId)) out.set(tabId, owners.get(tabId) ?? null);
  }
  return out;
}

/**
 * Rebuild the activity clock from persisted state.
 * Entries are validated before destructuring: a malformed member (null, a bare
 * number) would otherwise throw and abort the whole hydrate, silently disabling
 * auto-close for every restored tab rather than just the bad one.
 * @returns {Map<number, number>}
 */
export function hydrateActivity(saved, openTabIds) {
  const out = new Map();
  for (const pair of Array.isArray(saved?.tabLastActivity) ? saved.tabLastActivity : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [tabId, lastActivity] = pair;
    if (!Number.isInteger(lastActivity) || !openTabIds.has(tabId)) continue;
    out.set(tabId, lastActivity);
  }
  return out;
}

/**
 * A tab with a known owner may only be closed by that owner. Unowned tabs
 * (manually attached, or hydrated from a pre-ownership session) and internal
 * callers with no identity (auto-close) may always close.
 */
export function canCloseTab({ owner, requester }) {
  if (!owner || !requester) return true;
  return owner === requester;
}
