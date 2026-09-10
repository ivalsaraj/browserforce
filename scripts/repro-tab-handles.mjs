// Reproduces, then guards, handle durability across the browser idle
// disconnect. Same runtime wiring as mcp/src/index.js with the idle window
// shortened so one run spans a reconnect. Requires the relay up and the
// extension connected; exits 0 with SKIP otherwise.
import { chromium } from 'playwright-core';
import { createBrowserSessionRuntime } from '../mcp/src/browser-session-runtime.js';
import {
  ensureRelay, getCdpUrl, getRelayHttpUrl, getRelayHttpUrlFromCdpUrl,
  connectOverCdpWithBusyRetry, getExtensionStatus,
} from '../mcp/src/exec-engine.js';
import { withClientLabel } from '../mcp/src/client-label.js';

const status = await getExtensionStatus().catch(() => null);
if (!status?.connected) { console.log('SKIP: extension not connected'); process.exit(0); }

const runtime = createBrowserSessionRuntime({
  connectBrowser: async () => {
    await ensureRelay();
    const cdpUrl = withClientLabel(await getCdpUrl());
    return connectOverCdpWithBusyRetry({
      connect: (u) => chromium.connectOverCDP(u),
      cdpUrl,
      baseUrl: getRelayHttpUrlFromCdpUrl(cdpUrl),
      timeoutMs: 30000,
    });
  },
  getRelayHttpUrl,
  idleDisconnectMs: 2000,
});

const before = await runtime.listTabRows();
if (before.length === 0) { console.error('FAIL: no tabs open — this run proves nothing'); process.exit(1); }
await new Promise((r) => setTimeout(r, 7000));
if (runtime.isConnected()) { console.error('FAIL: no idle disconnect happened; the run proves nothing'); process.exit(1); }
const after = await runtime.listTabRows();

const handles = (rows) => rows.map((r) => r.handle);
const titled = (rows) => rows.filter((r) => r.title).length;
console.log(`before ${handles(before)[0]}..${handles(before).at(-1)} titled=${titled(before)}/${before.length}`);
console.log(`after  ${handles(after)[0]}..${handles(after).at(-1)} titled=${titled(after)}/${after.length}`);

let failed = false;
if (JSON.stringify(handles(before)) !== JSON.stringify(handles(after))) {
  console.error('FAIL: handles renumbered across the reconnect'); failed = true;
}
if (titled(before) === 0) {
  console.error('FAIL: every tab is untitled — the relay title source is not wired'); failed = true;
}
if (titled(after) < titled(before)) {
  console.error(`FAIL: titles lost across the reconnect (${titled(before)} -> ${titled(after)})`); failed = true;
}
if (after.length !== before.length) {
  console.error(`FAIL: row count changed (${before.length} -> ${after.length}); comparison is not like-for-like`); failed = true;
}
process.exit(failed ? 1 : 0);
