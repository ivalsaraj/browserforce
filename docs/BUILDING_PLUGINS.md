# Building BrowserForce Plugins

Adding a plugin extends BrowserForce for yourself or the whole community. Personal plugins stay in `~/.browserforce/plugins/` and are never shared unless you choose to. Public plugins get reviewed and merged into the repo, appearing in the plugin directory for anyone to install.

This guide walks through everything: building, testing, and submitting a plugin.

---

## 1. Build Your First Plugin

### Step 1 — Create the folder

```bash
mkdir -p ~/.browserforce/plugins/highlight
touch ~/.browserforce/plugins/highlight/index.js
touch ~/.browserforce/plugins/highlight/SKILL.md
```

### Step 2 — Write the export

Start with just `name` and one helper. Here is a complete `highlight.js` plugin that visually highlights any element on the page:

```js
// ~/.browserforce/plugins/highlight/index.js

export default {
  name: 'highlight',

  helpers: {
    /**
     * Visually highlight a DOM element by selector.
     *
     * @param {import('playwright').Page} page
     * @param {string} selector  - CSS selector for the element to highlight
     * @param {string} [color]   - CSS color value (default: '#ff0' — yellow)
     * @param {number} [duration] - ms to hold the highlight (0 = permanent, default: 2000)
     * @returns {Promise<{ found: boolean, selector: string }>}
     */
    async highlight(page, selector, color = '#ff0', duration = 2000) {
      const found = await page.evaluate(
        ({ sel, col, dur }) => {
          const el = document.querySelector(sel);
          if (!el) return false;

          const prev = el.style.cssText;
          el.style.outline = `3px solid ${col}`;
          el.style.backgroundColor = col;
          el.style.transition = 'outline 0.1s, background-color 0.1s';
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });

          if (dur > 0) {
            setTimeout(() => {
              el.style.cssText = prev;
            }, dur);
          }

          return true;
        },
        { sel: selector, col: color, dur: duration }
      );

      return { found, selector };
    },

    /**
     * Clear all highlights applied by this plugin.
     *
     * @param {import('playwright').Page} page
     */
    async clearHighlights(page) {
      await page.evaluate(() => {
        document.querySelectorAll('[data-bf-highlighted]').forEach(el => {
          el.removeAttribute('style');
          el.removeAttribute('data-bf-highlighted');
        });
      });
    }
  }
};
```

### Step 3 — Restart the MCP server

Plugins are loaded at startup. Kill and restart the MCP server after dropping a new file:

```bash
# If using Claude Desktop, restart it.
# If running manually:
pnpm mcp
```

### Step 4 — Call the helper from execute

Once loaded, `highlight` and `clearHighlights` are available as globals inside every `execute()` call:

```js
// In an execute() block:
const result = await highlight(page, 'button[type="submit"]', '#f90', 3000);
if (!result.found) return 'Element not found';
return `Highlighted: ${result.selector}`;
```

```js
// Highlight multiple elements:
await highlight(page, 'h1', '#0ff', 0);          // permanent cyan on heading
await highlight(page, '.price', '#f0f', 0);       // permanent magenta on price
```

### Step 5 — Write a SKILL.md companion

See [Section 4](#4-the-skillmd-companion) for what to include.

### Step 6 — Submit as a PR (optional)

See [Section 8](#8-submitting-a-plugin-pr-checklist) for the full checklist.

---

## 2. Choosing the Right Surface

Every plugin capability maps to one of four surfaces. Pick the one that matches how the capability will be used.

### `helpers` — page utilities called from `execute()`

Use when the capability needs to compose with other execute code inline — extracting data, manipulating the DOM, reading state. The agent writes a script that calls your helper as a function and uses the return value immediately.

```js
helpers: {
  async extractTableData(page, tableSelector) {
    return page.evaluate((sel) => {
      const rows = [...document.querySelectorAll(`${sel} tr`)];
      return rows.map(row =>
        [...row.querySelectorAll('td,th')].map(cell => cell.innerText.trim())
      );
    }, tableSelector);
  }
}
```

Called from execute:
```js
const data = await extractTableData(page, '#results-table');
return JSON.stringify(data);
```

### `tools` — standalone MCP tools with their own schema

Use when the capability stands alone and the AI should invoke it directly by name, not compose it inside a script. PDF export, sending a notification, or fetching data from an external system are good fits. Tools return the MCP content format directly.

```js
tools: [{
  name: 'export_pdf',
  description: 'Export the current page as a PDF file. Use when the user wants to save or share a page.',
  schema: {
    path: { type: 'string', description: 'Output file path, e.g. ~/exports/report.pdf' }
  },
  async handler({ path }, { browser, context }) {
    const pages = context.pages();
    const page = pages[pages.length - 1];
    const resolvedPath = path.replace('~', process.env.HOME);
    await page.pdf({ path: resolvedPath, format: 'A4', printBackground: true });
    return { content: [{ type: 'text', text: `PDF saved to ${resolvedPath}` }] };
  }
}]
```

### `hooks` — passive browser lifecycle observers

Use when you need to react to browser events without any agent action triggering them. Logging all navigations, capturing every network request, or building a HAR store automatically are hook use cases.

```js
hooks: {
  onNavigation: async (page, url) => {
    console.error(`[nav] ${url}`);
  },
  onRequest: async (request, page) => {
    // fires for every network request — keep processing minimal
    if (request.url().includes('/api/')) {
      store.push({ url: request.url(), method: request.method() });
    }
  }
}
```

> `onRequest` and `onResponse` fire for every network event on every page. Keep hook handlers fast. Anything slow here slows the whole browser.

### `setup` — one-time init at MCP server startup

Use when multiple helpers share state that needs to be initialized before any of them run: opening a database connection, creating an in-memory HAR store, loading a config file.

```js
let harStore = null;

export default {
  name: 'network',
  async setup({ browser }) {
    harStore = { entries: [], startedAt: Date.now() };
  },
  helpers: {
    async startCapture(page) { harStore.capturing = true; },
    async stopCapture(page) {
      harStore.capturing = false;
      return harStore;
    }
  }
};
```

---

## 3. The SKILL.md Companion

Every plugin should ship a `SKILL.md` alongside the `.js` file. This file is read by the AI agent at startup. It tells the agent when to use the plugin, when not to, and how to call it correctly. Without it, the agent has no context for the plugin's capabilities.

**Required sections:**

```markdown
# highlight plugin

Use `highlight(page, selector, color, duration)` / `clearHighlights(page)` when you need to:
- Visually mark an element for debugging or demonstration
- Show a user which element the agent is about to interact with
- Annotate a screenshot for reporting

## When NOT to use this
- Don't highlight before taking a screenshot if you need the original unmodified view
- Don't leave permanent highlights (duration: 0) unless intentional — they persist across agent turns

## Parameters
- `selector` — any valid CSS selector
- `color` — any CSS color value: `'#f90'`, `'red'`, `'rgba(255,0,0,0.3)'`
- `duration` — milliseconds to hold the highlight; `0` = permanent until `clearHighlights()`

## Example
\`\`\`js
// Highlight the submit button in orange for 3 seconds
const { found } = await highlight(page, 'button[type="submit"]', '#f90', 3000);
if (!found) return 'Submit button not found on this page';
\`\`\`

## Common mistakes
- Calling `highlight` on a selector that matches zero elements — always check `result.found`
- Forgetting to `clearHighlights()` before capturing a clean screenshot
```

---

## 4. Rules — What's Not Allowed

The following will cause a PR to be rejected without review.

### Code quality

- No obfuscated code — all plugin code must be readable line by line
- No minified code — even if it's a build output, submit the readable source
- No transpiled-only output — submit the original source, not compiled JS
- No code that requires a build step to understand or modify

### Security

- No network requests to external servers — plugins run locally and must stay local
- No `eval()`, `new Function(string)`, or any dynamic execution of remotely sourced strings
- No credential harvesting — never read, log, store, or transmit passwords, tokens, session cookies, or API keys to anything outside the browser context
- No shell execution (`child_process.exec`, `execSync`, `spawn`) unless the plugin is explicitly a local system integration and the shell command is hardcoded and clearly documented
- No writing to paths outside `~/.browserforce/` without explicit user configuration

### Behavior

- No modifying BrowserForce's own runtime state or files
- No overriding built-in helpers: `snapshot`, `waitForPageLoad`, `getLogs`, `clearLogs`
- No relying on undocumented BrowserForce internals — only use the API surfaces defined in this guide

---

## 5. Best Practices

**Single responsibility.** One plugin, one concern. Don't bundle 10 unrelated helpers into one file. If it needs its own README section, it needs its own plugin.

**Name helpers specifically.** Helper names become globals in `execute()`. Use descriptive names that won't collide with built-ins or other plugins:

| Bad | Good |
|-----|------|
| `capture` | `captureHAR` |
| `save` | `saveSessionState` |
| `extract` | `extractTableData` |

**Handle errors and return useful values.** Wrap page interactions in try/catch. Return a summary the agent can act on — don't return `undefined` when you could return `{ found: false, reason: 'selector matched 0 elements' }`.

```js
// Bad
async highlight(page, selector) {
  await page.evaluate((sel) => {
    document.querySelector(sel).style.outline = '3px solid red';
  }, selector);
}

// Good
async highlight(page, selector) {
  try {
    const found = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.style.outline = '3px solid red';
      return true;
    }, selector);
    return { found, selector };
  } catch (err) {
    return { found: false, selector, error: err.message };
  }
}
```

**Write MCP tool descriptions the AI can understand.** Vague descriptions produce wrong tool calls.

| Bad | Good |
|-----|------|
| `"Exports the page"` | `"Export the current page as a PDF. Use when the user asks to save or share the page as a document."` |

**Keep hooks lightweight.** `onRequest` and `onResponse` fire for every network event. Do not run async calls, DOM access, or heavy processing inside them. Accumulate to an in-memory array; process it in a helper when the agent asks.

**Use `setup()` for shared state.** If multiple helpers share a data store, initialize it once in `setup()` and close over it. Module-level mutable globals can leak state across tool invocations.

**Test against a real browser.** Plugins interact with a live Chrome session. Integration test on real pages, not mocks.

---

## 6. Testing Your Plugin

Three levels before submitting.

### Level 1 — Smoke test (required)

Install locally, restart the MCP server, run a minimal `execute()` call:

```js
// Minimal smoke test
return await highlight(page, 'body', '#ff0', 1000);
```

Verify: no crash, no uncaught exception, return value looks correct.

### Level 2 — Real-world test (required)

Run against at least one real website for each helper and tool the plugin exposes. Document what you ran and what came back in your PR description under `## Test Results`.

Example test results entry:

```
highlight(page, 'h1', '#f90', 2000) on https://example.com
→ { found: true, selector: 'h1' }
Element glowed orange for 2s, reverted cleanly.

highlight(page, '.nonexistent', '#f90') on https://example.com
→ { found: false, selector: '.nonexistent' }
No crash, correct not-found response.
```

### Level 3 — Data correctness (for helpers that extract or transform data)

If your plugin extracts or transforms data, verify 2-3 representative cases: input page state → expected helper output. These can be manual — you are not required to write automated tests, but you must have confirmed the output is correct and stable before submitting.

---

## 7. Submitting a Plugin (PR Checklist)

Before opening a PR, verify all of the following:

- [ ] Plugin folder created at `plugins/community/your-plugin/`
- [ ] `index.js` and `SKILL.md` both present inside that folder
- [ ] Code is readable — no minification, no obfuscation
- [ ] `registry.json` entry added with all required fields (see format below)
- [ ] Plugin tested against at least one real website per helper/tool
- [ ] No external network calls
- [ ] No `eval()` or dynamic code execution
- [ ] No credentials or secrets in code or comments
- [ ] Helper names are specific enough to avoid collisions
- [ ] PR description includes a `## Test Results` section with actual output

### registry.json entry format

```json
{
  "name": "highlight",
  "displayName": "Element Highlighter",
  "description": "Visually highlight DOM elements with a colored outline. Useful for debugging, demonstration, and annotated screenshots.",
  "author": "your-github-handle",
  "official": false,
  "version": "1.0.0",
  "audience": ["developer"],
  "capabilities": ["helpers"],
  "file": "plugins/community/highlight.js",
  "readme": "plugins/community/highlight.md"
}
```

---

## 8. Plugin Versioning

The registry references versioned releases, not the `main` branch directly.

When updating an existing plugin:

1. Bump `version` in `registry.json` (follow semver)
2. Existing installs do not auto-update — users re-install to get the new version
3. Breaking changes to helper signatures (renamed params, changed return shape) warrant a **major version bump**
4. Add a `## Migration` section to `SKILL.md` for any breaking change

```markdown
## Migration — v1 → v2

`highlight(page, selector, color)` now returns `{ found, selector }` instead of a boolean.

Before:
\`\`\`js
const ok = await highlight(page, 'h1', '#f90');
\`\`\`

After:
\`\`\`js
const { found } = await highlight(page, 'h1', '#f90');
\`\`\`
```

---

## Full Plugin Shape Reference

```js
// ~/.browserforce/plugins/my-plugin.js

export default {
  // Required. Unique across all plugins.
  name: 'my-plugin',

  // One-time init when the MCP server starts.
  async setup({ browser }) {
    // browser → Playwright Browser instance
  },

  // Page utilities injected as globals into every execute() call.
  // First argument is always `page`. Return values are available to the agent.
  helpers: {
    async myHelper(page, param) {
      return await page.evaluate((p) => window.someAPI(p), param);
    }
  },

  // Standalone MCP tools. Agents call these by name, not from execute().
  tools: [{
    name: 'my_tool',
    description: 'What this tool does and when the agent should call it.',
    schema: {
      param: { type: 'string', description: 'Input value' }
    },
    async handler({ param }, { browser, context }) {
      // Must return MCP content format.
      return { content: [{ type: 'text', text: `Result: ${param}` }] };
    }
  }],

  // Passive browser lifecycle observers. No agent trigger required.
  hooks: {
    onPage:       async (page) => {},            // new page created
    onNavigation: async (page, url) => {},       // page navigated
    onRequest:    async (request, page) => {},   // network request sent
    onResponse:   async (response, page) => {},  // network response received
  }
};
```

| Surface | Receives | Returns | When to use |
|---------|----------|---------|-------------|
| `setup` | `{ browser }` | void | One-time init: open connections, warm state |
| `helpers` | `(page, ...args)` | any | Inline page utilities composed inside `execute()` |
| `tools` | `(params, { browser, context })` | MCP content | Standalone agent-callable actions with own schema |
| `hooks` | varies by hook | void | Passive observers — logging, monitoring, interception |
