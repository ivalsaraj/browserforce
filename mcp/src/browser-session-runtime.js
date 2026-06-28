// browser-session-runtime.js — shared browser/session runtime for MCP and the CLI
// session daemon. Owns the persistent browser connection + userState so both
// protocol surfaces share identical session behavior. Task 2 is the minimal
// skeleton; Task 3 moves MCP's real browser/user lifecycle in here.

export function createBrowserSessionRuntime(deps = {}) {
  let userState = {};
  let browser = null;

  return {
    get userState() { return userState; },
    get browser() { return browser; },
    async reset() {
      if (browser?.isConnected?.()) await browser.close().catch(() => {});
      browser = null;
      userState = {};
    },
  };
}
