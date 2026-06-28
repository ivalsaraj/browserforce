import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { launchManagedBrowser, resolveManagedProfileDir } from '../src/managed-browser.js';
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';

test('managed headed uses persistent BrowserForce profile directory', async () => {
  const calls = [];
  await launchManagedBrowser({
    chromium: { launchPersistentContext: async (...args) => { calls.push(args); return { browser: () => ({}) }; } },
    headless: false,
    profileDir: '/tmp/bf-profile',
  });

  assert.equal(calls[0][0], '/tmp/bf-profile');
  assert.equal(calls[0][1].headless, false);
});

test('managed launch surfaces a clear error when the browser binary is missing', async () => {
  await assert.rejects(
    () => launchManagedBrowser({
      chromium: { launchPersistentContext: async () => { throw new Error("Executable doesn't exist"); } },
      headless: true,
      profileDir: '/tmp/bf-headless',
    }),
    /managed (headless )?Chrom|Executable doesn't exist|browserforce/i,
  );
});

test('managed profile directories are isolated from the real Chrome profile', () => {
  const base = join(homedir(), '.browserforce', 'managed');
  assert.equal(resolveManagedProfileDir({ headless: false }), join(base, 'default'));
  assert.equal(resolveManagedProfileDir({ headless: true }), join(base, 'headless'));
});

test('launchManagedBrowser defaults the profile dir from headless when none is given', async () => {
  const calls = [];
  await launchManagedBrowser({
    chromium: { launchPersistentContext: async (...args) => { calls.push(args); return { browser: () => ({}) }; } },
    headless: true,
  });
  assert.equal(calls[0][0], resolveManagedProfileDir({ headless: true }));
  assert.equal(calls[0][1].headless, true);
});

test('a managed browser can be wired as the runtime connect source', async () => {
  const fakeBrowser = {
    isConnected: () => true,
    contexts: () => [{ on() {}, pages: () => [{ on() {}, mainFrame: () => 'm' }] }],
    on() {},
    close: async () => {},
  };
  const chromium = { launchPersistentContext: async () => ({ browser: () => fakeBrowser }) };

  const runtime = createBrowserSessionRuntime({});
  runtime.setConnectBrowser(async () => {
    const { browser } = await launchManagedBrowser({ chromium, headless: true, profileDir: '/tmp/bf-int' });
    return browser;
  });

  await runtime.ensureBrowser();
  assert.equal(runtime.isConnected(), true);
});
