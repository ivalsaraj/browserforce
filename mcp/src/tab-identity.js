// mcp/src/tab-identity.js — pure tab-identity helpers. No imports by design:
// browser-session-runtime.js is import-free and this is the rule it consumes.
//
// Playwright rebuilds every Page object when the CDP connection drops, so a
// Page-keyed handle or name map silently renumbers on each idle reconnect.
// Relay target ids survive that. Pairing pages to targets is what lets handles
// and names be keyed by target id instead.

/**
 * Pair pages with relay targets, index-aligned to `pageUrls`.
 *
 * A URL identifies a tab only when it is UNIQUE on both sides — exactly one
 * page and exactly one target carry it. Everything else matches nothing.
 *
 * No positional tie-breaking. Pairing the k-th duplicate page with the k-th
 * duplicate target would rely on ctx.pages() and the relay target list sharing
 * an insertion order, which is plausible but unproven; if it is ever false, two
 * tabs showing the same page swap handles with no error, which is precisely the
 * wrong-tab action this module exists to prevent. Duplicate-URL tabs are
 * instead resolved exactly by the caller (Target.getTargetInfo over the small
 * unmatched set), or fall back to per-connection identity — visible, honest
 * degradation instead of a silent mis-bind.
 *
 * An unmatched page yields `targetId: null`; the caller falls back to
 * per-connection identity, which is also what a relay-less managed backend gets.
 */
export function matchPagesToTargets(pageUrls, targets) {
  const urls = Array.isArray(pageUrls) ? pageUrls : [];

  // Reject malformed entries instead of coercing them to ''. Coercion let a
  // target with a missing URL collide with a page whose url() read threw (also
  // ''), handing a real handle to an unrelated target — a wrong-tab action.
  // A malformed entry POISONS its URL group rather than being dropped. Dropping
  // it left a valid same-URL sibling looking unique, so a page could take a
  // handle for a tab that may not be the one it is showing.
  const targetsByUrl = new Map();
  const poisonedUrls = new Set();
  const seenIds = new Set();
  let globallyAmbiguous = false;
  for (const target of Array.isArray(targets) ? targets : []) {
    const url = typeof target?.url === 'string' && target.url ? target.url : null;
    const id = typeof target?.id === 'string' && target.id ? target.id : null;
    if (!url || !id) {
      // A malformed entry with no usable URL cannot be scoped to a group, so it
      // could belong to any of them. Global ambiguity beats letting some other
      // group look unique and hand out a handle on a guess.
      if (url) poisonedUrls.add(url); else globallyAmbiguous = true;
      continue;
    }
    if (seenIds.has(id)) { globallyAmbiguous = true; continue; }
    seenIds.add(id);
    if (!targetsByUrl.has(url)) targetsByUrl.set(url, []);
    targetsByUrl.get(url).push(target);
  }

  // An empty page URL means the read failed; it can never identify a tab.
  const pageIndicesByUrl = new Map();
  urls.forEach((pageUrl, i) => {
    if (typeof pageUrl !== 'string' || !pageUrl) return;
    if (!pageIndicesByUrl.has(pageUrl)) pageIndicesByUrl.set(pageUrl, []);
    pageIndicesByUrl.get(pageUrl).push(i);
  });

  const out = urls.map(() => ({ targetId: null, title: '' }));
  if (globallyAmbiguous) return out;
  for (const [url, indices] of pageIndicesByUrl) {
    if (poisonedUrls.has(url)) continue; // ambiguous: a malformed sibling exists
    const group = targetsByUrl.get(url);
    // FAIL CLOSED on any duplicate. Only a 1:1 URL identifies a tab.
    if (!group || group.length !== 1 || indices.length !== 1) continue;
    const target = group[0];
    out[indices[0]] = {
      targetId: target.id,
      title: typeof target.title === 'string' ? target.title : '',
    };
  }
  return out;
}
