import { randomBytes } from 'node:crypto';

// One affinity label per MCP process: unique across concurrent agents (so each
// gets its own Chrome window) but constant within this process, so the 15s
// idle-disconnect/reconnect cycle reuses the same window instead of spawning a
// new one. An explicit BROWSERFORCE_CDP_CLIENT_LABEL still wins, which is how
// two agents deliberately share one window.
//
// This lives outside index.js on purpose: index.js calls main() at import time
// (no direct-run guard), so importing it from a test would boot the server.
export const PROCESS_CLIENT_LABEL =
  process.env.BROWSERFORCE_CDP_CLIENT_LABEL ||
  `browserforce-mcp-${randomBytes(4).toString('hex')}`;

export function withClientLabel(cdpUrl) {
  try {
    const url = new URL(cdpUrl);
    if (!url.searchParams.get('label')) {
      url.searchParams.set('label', PROCESS_CLIENT_LABEL);
    }
    return url.toString();
  } catch {
    return cdpUrl;
  }
}

// Display name shown on the ghost cursor so a user with several agents driving
// one Chrome can tell which one is moving. Passed raw — the relay owns the
// length and character policy (its sanitizeAgentName is the single authority).
export function withAgentName(cdpUrl) {
  const agentName = process.env.BROWSERFORCE_AGENT_NAME;
  if (!agentName) return cdpUrl;
  try {
    const url = new URL(cdpUrl);
    if (!url.searchParams.get('agentName')) url.searchParams.set('agentName', agentName);
    return url.toString();
  } catch {
    return cdpUrl;
  }
}

// The one place that decides which wrappers a connect URL gets. Hand-composing
// the two wrappers at each call site gave three places the composition could
// drift, and nothing a test could check there beyond the presence of some text.
//
// durableLabel: false is for bin.js's one-shot path, which deliberately sends no
// affinity label — adding one would change which Chrome window one-shot commands
// open tabs in. agentName is display-only and never keys affinity, so it is safe
// on every path.
export function agentCdpUrl(cdpUrl, { durableLabel = true } = {}) {
  return withAgentName(durableLabel ? withClientLabel(cdpUrl) : cdpUrl);
}
