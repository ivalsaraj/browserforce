// managed-browser.js — launch a managed Chrome/Chromium for BrowserForce when the
// real Chrome bridge (relay + extension) is unavailable or explicitly opted out.
//
// Managed browsers use BrowserForce-owned persistent profiles, NEVER the user's
// real Chrome profile, so automation never touches the user's logged-in state:
//   headed   -> ~/.browserforce/managed/default
//   headless -> ~/.browserforce/managed/headless

import { join } from 'node:path';
import { homedir } from 'node:os';
import { chromium as defaultChromium } from 'playwright-core';

export function resolveManagedProfileDir({ headless = false, baseDir } = {}) {
  const root = baseDir || join(homedir(), '.browserforce', 'managed');
  return join(root, headless ? 'headless' : 'default');
}

/**
 * Launch a managed persistent-context browser. `chromium` is injectable for
 * tests; in production it resolves to playwright-core's chromium (the same
 * module the MCP server connects with). Returns
 * `{ context, browser, profileDir, headless }`. Launch failures are surfaced
 * with a clear, actionable error (never swallowed) per the design.
 */
export async function launchManagedBrowser({ chromium, headless = false, profileDir, args = [] } = {}) {
  const pw = chromium || defaultChromium;
  const dir = profileDir || resolveManagedProfileDir({ headless });

  let context;
  try {
    context = await pw.launchPersistentContext(dir, { headless, args });
  } catch (err) {
    throw new Error(
      `Failed to launch managed ${headless ? 'headless ' : ''}Chrome for BrowserForce (profile: ${dir}). `
      + `Ensure a Chromium build is installed (e.g. \`npx playwright install chromium\`). Cause: ${err.message}`,
    );
  }

  const browser = typeof context.browser === 'function' ? context.browser() : null;
  return { context, browser, profileDir: dir, headless };
}
