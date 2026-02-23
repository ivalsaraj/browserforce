# BrowserForce Plugins

Extend BrowserForce with local JS files — no framework, no build step, no registry.

Plugins live in `~/.browserforce/plugins/`. Each file exports a plain object. The MCP server loads them at startup and merges their helpers, tools, and hooks into the runtime.

**Minimal plugin — 10 lines:**

```js
// ~/.browserforce/plugins/hello.js
export default {
  name: 'hello',
  helpers: {
    async greet(page) {
      const title = await page.title();
      return `Hello from: ${title}`;
    }
  }
}
```

After installing, `greet(page)` is available as a global inside every `execute()` call.

---

## How to Install a Plugin

1. Drop a `.js` file in `~/.browserforce/plugins/`
2. Restart the MCP server
3. Done — helpers are injected, tools are registered

No config changes. No manifest edits. The directory is auto-scanned on startup.

---

## For Developers

Use cases for people with browser UI access — debugging, testing, and development workflows.

---

### HAR / Network Capture

Record every network request and response during a session. Discover the private APIs powering a site's UI. Debug form submissions that silently fail.

```js
await startCapture(page);
await page.click('#submit');
const har = await stopCapture();
// har.entries → full request/response log with timings and bodies
```

---

### DOM Diff

Snapshot the page's DOM before and after an action, then diff them. Know exactly what changed after a form submit, a route transition, or an AJAX update — without guessing.

```js
await snapshotDOM('before');
await page.click('#apply-filters');
await waitForPageLoad();
const diff = await diffDOM('before', 'after');
// diff → added/removed/changed nodes
```

---

### E2E Test Recorder

Every agent action gets recorded as Playwright test code. The agent explores a workflow once — the plugin auto-generates a `.test.js` regression file. Agents leave behind test suites instead of tribal knowledge.

```js
await startRecording();
await page.click('#checkout');
await page.fill('#card-number', '4111111111111111');
await stopRecording('~/tests/checkout.test.js');
// checkout.test.js is written to disk, ready to run
```

---

### Request Interceptor / API Mocker

Return fake data for specific endpoints without touching the backend. Test error states, empty states, and edge cases against a live UI.

```js
await mockAPI(page, '**/api/products', {
  status: 200,
  body: { products: [] }   // empty state
});
await page.reload();
// UI now renders the empty state — no backend change needed
```

---

### Session State Snapshots

Capture all cookies, localStorage, and sessionStorage under a named key. Restore any state instantly. Test workflows as different user roles without logging out.

```js
await saveState('admin-logged-in');
// ... test admin workflows ...
await restoreState('free-user');
// now running as free user — zero re-authentication
```

---

### PDF Export

Export the current page as a PDF. Generate reports, invoices, or documentation directly from browser content — pixel-perfect, with real fonts and styles.

```js
const buffer = await printBuffer({ format: 'A4', printBackground: true });
// or write directly to disk:
await savePDF('~/exports/invoice-2024.pdf');
```

---

### Clipboard Bridge

Read and write the system clipboard. Bypass sites that block copy-paste. Agents can write extracted data directly to clipboard for the user to paste elsewhere.

```js
// Write a result to clipboard
await writeClipboard('Order ID: 98431-B');

// Read what the user copied
const copied = await readClipboard();
```

---

## For OpenClaw & Automated Agents

Use cases for headless and non-interactive workflows — AI agents running autonomously, no browser UI required.

---

### Zero Credential Exposure

BrowserForce agents inherit the user's real browser sessions — no passwords, no API keys, no OAuth tokens in config. An `extractBearerToken` helper watches live network traffic and plucks `Authorization` headers, giving agents API access through the existing session. Credentials never leave the browser.

This is the core differentiator vs every other agent tool.

```js
// In an automated workflow — no credentials configured anywhere
const token = await extractBearerToken(page, 'api.example.com');
// token → "Bearer eyJ..." pulled from live browser traffic
// now usable for direct API calls within the same agent run
```

---

### Download Capture

Run a callback (e.g. click "Export CSV"), intercept the file download, return the content directly — no temp files, no manual download folder management. Sites that only expose data via download buttons become fully automatable.

```js
const csv = await captureDownload(async () => {
  await page.click('#export-csv');
});
const rows = csv.split('\n').map(r => r.split(','));
// process rows directly — no file system involved
```

---

### Page Monitor

Watch a URL and fire when content changes. Price trackers, job boards, CI dashboards, stock alerts. Long-running monitoring without constant agent polling.

```js
// MCP tool: monitor_page
// Or use the helper directly:
await waitForContentChange(page, '.price-display', { timeout: 3_600_000 });
// resolves when the element's text changes — up to 1 hour wait
```

---

### Desktop & Webhook Notifications

System notifications and webhook delivery for long-running agent tasks. "When the product restocks, notify me" becomes a one-liner.

```js
// Desktop notification
await notify('Restock Alert', 'Nike Air Max 90 is back in stock');

// MCP tool: send_webhook
// Or call directly:
await sendWebhook('https://hooks.slack.com/...', {
  text: 'Job scrape complete — 47 new listings found'
});
```

---

### Multi-Tab Session Orchestration

BrowserForce sees every open tab. Plugins can extract data from one authenticated tab and inject it into another. Cross-tab RPA that no headless tool supports — because headless tools can't access existing logged-in sessions.

```js
const pages = await context.pages();
const dashboardPage = pages.find(p => p.url().includes('/dashboard'));
const data = await dashboardPage.evaluate(() => window.__APP_STATE__);

const reportPage = pages.find(p => p.url().includes('/reports'));
await reportPage.evaluate((d) => window.loadExternalData(d), data);
```

---

### File Upload Helper

Handle file inputs cleanly — from disk or from memory. Automate workflows that require uploading documents, images, or generated data without writing temp files.

```js
// Upload from disk
await uploadFromDisk(page, '#profile-photo', '~/photos/avatar.png');

// Upload generated content directly from memory
await uploadFromMemory(page, '#import-csv', csvString, 'import.csv');
```

---

## Building Your Own Plugin

Full plugin shape — all fields are optional except `name`:

```js
// ~/.browserforce/plugins/my-plugin.js
export default {
  // Required. Must be unique across all plugins.
  name: 'my-plugin',

  // Runs once when the MCP server starts.
  // Use for initializing state, opening connections, reading config.
  async setup({ browser }) {
    // browser → Playwright Browser instance
  },

  // Functions injected as globals into every execute() call.
  // Signature: async (page, ...args) → any
  helpers: {
    async myHelper(page, param) {
      return await page.evaluate((p) => window.someAPI(p), param);
    }
  },

  // Standalone MCP tools registered alongside execute/reset/screenshot_with_labels.
  // Agents can call these directly by name.
  tools: [{
    name: 'my_tool',
    description: 'What this tool does and when to use it.',
    schema: {
      param: { type: 'string', description: 'Input value' }
    },
    async handler({ param }, { browser, context }) {
      // browser → Playwright Browser
      // context → Playwright BrowserContext
      return {
        content: [{ type: 'text', text: `Result: ${param}` }]
      };
    }
  }],

  // Playwright browser lifecycle hooks.
  // Fired automatically — no agent action required.
  hooks: {
    onPage:       async (page) => {},           // new page created
    onNavigation: async (page, url) => {},      // page navigated
    onRequest:    async (request, page) => {},  // network request fired
    onResponse:   async (response, page) => {}, // network response received
  }
}
```


| Field     | Type                                              | When to use                                                     |
| --------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `setup`   | `async ({ browser }) => void`                     | One-time init — open DB connections, load config, warm caches   |
| `helpers` | `{ name: async (page, ...args) => any }`          | Reusable page utilities injected into `execute()` scope         |
| `tools`   | `[{ name, description, schema, handler }]`        | Standalone agent-callable MCP tools with their own input schema |
| `hooks`   | `{ onPage, onNavigation, onRequest, onResponse }` | Passive observers — monitoring, logging, request interception   |


---

## Plugin Ecosystem

### Contributing a Plugin

Plugins live in the BrowserForce repo under `plugins/`. To publish one:

1. Fork the repo
2. Create a folder: `plugins/community/my-plugin/`
3. Add `index.js` (the plugin code) and `SKILL.md` (AI instructions) inside it
4. Add an entry to `plugins/registry.json`
5. Open a PR — official plugins get reviewed and merged to main

That's it. No separate registry service. No npm publishing required.

---

### The Registry

A single JSON file at `plugins/registry.json` in the repo is the source of truth. The Chrome extension and CLI fetch it directly from GitHub's raw content URL — no server, no API.

**Registry entry shape:**

```json
{
  "name": "network",
  "displayName": "HAR / Network Capture",
  "description": "Record all network requests and responses during a session.",
  "author": "browserforce",
  "official": true,
  "version": "1.0.0",
  "audience": ["developer"],
  "capabilities": ["helpers", "hooks"],
  "file": "plugins/official/network/index.js",
  "skill": "plugins/official/network/SKILL.md"
}
```


| Field          | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| `official`     | `true` for BrowserForce-maintained plugins, `false` for community   |
| `audience`     | `"developer"`, `"headless"`, or both                                |
| `capabilities` | Which plugin surfaces it uses: `helpers`, `tools`, `hooks`, `setup` |
| `file`         | Path to `index.js` in the repo — fetched on install                 |
| `skill`        | Path to `SKILL.md` — fetched on install, injected into AI context   |


---

### Chrome Extension — Plugin Directory

The extension popup gains a **Plugins** tab (or opens as a fullscreen options page). It:

1. Fetches `registry.json` from GitHub on open (cached for 10 minutes)
2. Shows all plugins — official first, community below — with audience tags and capability badges
3. Marks which ones are currently installed
4. Install/remove buttons call the relay's plugin API (the extension can't write to disk directly)

**Why the relay is the bridge:**
Chrome extensions have no filesystem access. The relay runs at `127.0.0.1:19222` and can write to `~/.browserforce/plugins/`. The extension POSTs to the relay; the relay fetches the plugin file from GitHub and writes it to disk.

```
Extension UI
    │  POST /plugins/install { name: "network" }
    ▼
Relay (127.0.0.1:19222)
    │  fetches index.js + SKILL.md from GitHub
    │  writes to ~/.browserforce/plugins/network/
    ▼
~/.browserforce/plugins/
```

**Relay plugin endpoints:**


| Method   | Path               | Action                                       |
| -------- | ------------------ | -------------------------------------------- |
| `GET`    | `/plugins`         | List installed plugins + their metadata      |
| `POST`   | `/plugins/install` | Download plugin from registry, write to disk |
| `DELETE` | `/plugins/:name`   | Remove plugin file from disk                 |


Plugins take effect on next MCP server restart (the extension shows a restart prompt).

---

### CLI — For Headless Users

Users without browser UI access manage plugins through the CLI:

```bash
# List all available plugins from the registry
browserforce plugin list

# Install a plugin
browserforce plugin install network

# Install from a local file (for development)
browserforce plugin install ./my-plugin.js

# Remove a plugin
browserforce plugin remove network

# Show installed plugins
browserforce plugin status
```

`plugin install` fetches the JS directly from GitHub's raw content URL and writes it to `~/.browserforce/plugins/`. Same outcome as the extension UI, different path.

---

### Plugin Directory Structure (in repo)

```
plugins/
  registry.json           ← single source of truth
  official/
    network/
      index.js            ← HAR capture plugin code
      SKILL.md            ← AI instructions for this plugin
    session/
      index.js
      SKILL.md
    pdf/
      index.js
      SKILL.md
  community/
    salesforce/           ← community-contributed
      index.js
      SKILL.md
    linear/
      index.js
      SKILL.md
```

Official plugins are maintained by the BrowserForce team. Community plugins are reviewed for safety (no `eval`, no network calls to external servers, no credential exfiltration) before merge.

---

### Security Model

Plugins are arbitrary JS running in Node.js — they have full filesystem and network access. The safety contract is:

- **Official plugins**: reviewed and maintained by BrowserForce
- **Community plugins**: reviewed before merge (same bar as official)
- **Local plugins**: `~/.browserforce/plugins/*.js` — user's own files, not from the registry, fully trusted

The relay install endpoint only fetches from the known GitHub repo URL — no arbitrary URLs. The extension UI only shows registry plugins. Users who want to run untrusted code drop files manually into the plugins folder.

No sandboxing beyond that. Plugins are as trusted as any npm package you install.

---

