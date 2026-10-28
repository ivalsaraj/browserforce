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

export function withClientLabel(cdpUrl, label = PROCESS_CLIENT_LABEL) {
  try {
    const url = new URL(cdpUrl);
    if (!url.searchParams.get('label')) {
      url.searchParams.set('label', label);
    }
    return url.toString();
  } catch {
    return cdpUrl;
  }
}

// Match the relay's explicit-label normalization, including custom labels.
export function ownerKeyForLabel(label) {
  if (typeof label !== 'string') return null;
  const cleaned = label.trim().replace(/[^\w .:@/-]/g, '').slice(0, 80);
  return cleaned ? `label:${cleaned}` : null;
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

// The CLI's identity. A named agent gets the same label on every one-shot call
// and on its session daemon, so all of them own the same tabs and share one
// window pin. Unnamed one-shot calls stay unlabeled: each call is its own owner
// and the window it opens tabs in is unchanged. The name is the identity, so two
// agents sharing a name share ownership and window.
export function cliClientLabel(env = process.env) {
  if (env.BROWSERFORCE_CDP_CLIENT_LABEL) return env.BROWSERFORCE_CDP_CLIENT_LABEL;
  const name = env.BROWSERFORCE_AGENT_NAME?.trim();
  return name ? `browserforce-cli-${name}` : null;
}

// The one place that decides which wrappers a connect URL gets. Hand-composing
// the two wrappers at each call site gave three places the composition could
// drift, and nothing a test could check there beyond the presence of some text.
//
// label: null sends no affinity label (bin.js's unnamed one-shot path). agentName
// is display-only and never keys affinity, so it is safe on every path.
export function agentCdpUrl(cdpUrl, { label = PROCESS_CLIENT_LABEL } = {}) {
  return withAgentName(label ? withClientLabel(cdpUrl, label) : cdpUrl);
}
