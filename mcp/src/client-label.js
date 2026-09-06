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
