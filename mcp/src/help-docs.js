const HELP_SECTIONS = Object.freeze({
  tabs: {
    title: 'Tabs',
    summary: 'Choose existing, manual, and new tabs without creating blanks by accident.',
    text: `# Tabs

- For attached/manual/current-tab work, inspect relay status terms first: manualAttachedTabs and activeManualTargets.
- For all open tabs, use context.pages(); filter and cap results unless the user explicitly asks for the full list.
- For inspect/read/check/review tasks, reuse existing pages. Do not call context.newPage() or page.goto() just to find a tab that may already be open.
- Set state.page to the chosen existing page and keep using state.page for follow-up work.
- Use intent:'open' only when the user asked to open or navigate. If the requested tab is absent, report that clearly instead of silently opening a replacement.
- In manual/no-new-tabs mode, ask the user to attach/share a tab only when context.pages() and manualAttachedTabs do not expose the requested target.`,
  },
  'page-setup': {
    title: 'Page Setup',
    summary: 'Initialize state.page and respect BrowserForce session restrictions.',
    text: `# Page Setup

- Read browserforceRestrictions and browserforceSettings before planning actions.
- Use state.page for ongoing work; the default page variable is only a fallback.
- If state.page closed, choose another non-closed page from context.pages() before creating a new tab.
- Respect readOnly, noNewTabs, mode:'manual', lockUrl, and instructions.
- For explicit open/navigation work, create a tab only when restrictions allow it, then waitForPageLoad() and verify with snapshot().`,
  },
  navigation: {
    title: 'Navigation',
    summary: 'Navigate from discovered links and verify after each action.',
    text: `# Navigation

- Do not guess deep links when the site exposes navigation. Snapshot first, inspect refs, and prefer clicking visible links/buttons or reading hrefs.
- Only construct URLs manually when no discoverable navigation path exists.
- After page.goto(), click, form submit, or history changes, call waitForPageLoad() or a deterministic wait and then observe again.
- If a guessed URL fails or shows wrong content, back up and derive the route from visible page links.`,
  },
  snapshot: {
    title: 'Snapshot And Extraction',
    summary: 'Use the cheapest page-reading surface that fits the task.',
    text: `# Snapshot And Extraction

- Prefer snapshot() for text, page structure, and interaction refs.
- Use snapshot({ search: /.../ }) to narrow large pages.
- Use snapshot({ showDiffSinceLastCall: true }) for repeated observations of the same page, and false when full output is needed.
- Use cleanHTML(selector?, opts?) for structured DOM extraction.
- Use pageMarkdown() for article-like content.
- Use screenshots only when the user requested visuals or layout evidence.`,
  },
  logs: {
    title: 'Logs And Debugging',
    summary: 'Combine page structure, console logs, and focused evaluation.',
    text: `# Logs And Debugging

- Debug JS-heavy failures with snapshot({ search }), getLogs({ count }), and focused state.page.evaluate(...).
- Do not use console.log() or console.error() inside execute snippets; return values instead.
- If console.* was already used in an execute snippet, inspect captured output with getExecConsoleLogs({ count }).
- Clear noisy logs with clearLogs() or clearExecConsoleLogs() when starting a fresh debugging pass.
- Avoid raw HTTP/curl for pages that depend on authenticated browser state or rendered DOM.`,
  },
  cdp: {
    title: 'Raw CDP',
    summary: 'Use BrowserForce-safe CDP sessions only when Playwright APIs are insufficient.',
    text: `# Raw CDP

- Prefer Playwright APIs first.
- When raw CDP is needed, call getCDPSession({ page: state.page }) or getCDPSession({ page }) from execute scope.
- Do not call page.context().newCDPSession(page) directly; BrowserForce wraps CDP to preserve relay-safe routing.
- Keep CDP commands scoped to the relevant page and report method names and failure messages when debugging protocol issues.`,
  },
  plugins: {
    title: 'Plugins',
    summary: 'Discover plugin capability from metadata, then request plugin help on demand.',
    text: `# Plugins

- Call pluginCatalog() to discover plugin names, helper names, summaries, aliases, and available sections.
- If the user request clearly matches a plugin capability, call pluginHelp(name, section?) before using that helper.
- Do not call pluginHelp blindly for every plugin.
- Plugin helpers are injected into execute scope; built-in BrowserForce helpers always win on name conflicts.`,
  },
  errors: {
    title: 'Errors And Recovery',
    summary: 'Recover from common BrowserForce and page-state failures.',
    text: `# Errors And Recovery

- Page closed: choose another page from context.pages(); create a new one only if restrictions allow it.
- Element missing: refresh snapshot output and use stable refs, roles, test IDs, or tighter search.
- Navigation failed: inspect current URL, logs, and snapshot before retrying.
- BF_NO_ATTACHED_PAGE or BF_NEW_TABS_DISABLED: manual/no-new-tabs mode needs an attached tab or relaxed restrictions.
- Connection/internal failures: call reset, then reinitialize state.page from context.pages().`,
  },
  parallel: {
    title: 'Parallel Work',
    summary: 'Run independent read-only page work concurrently without sharing one Page.',
    text: `# Parallel Work

- Read browserforceSettings.executionMode before parallelizing.
- Use parallel work only for independent read-only tasks.
- Never run Promise.all actions against the same Page object.
- Use one tab/page per task with a small concurrency cap, then aggregate results.
- Return useful telemetry for swarm runs: peakConcurrentTasks, wallClockMs, sumTaskDurationsMs, failures, and retries.`,
  },
  examples: {
    title: 'Examples',
    summary: 'Small patterns for common execute calls.',
    text: `# Examples

Inspect open tabs:
\`\`\`js
return context.pages().slice(0, 10).map((p, index) => ({ index, url: p.url() }));
\`\`\`

Use an existing page:
\`\`\`js
const pages = context.pages();
state.page = pages.find((p) => p.url().includes('example.com')) || pages[0];
return await snapshot();
\`\`\`

Open only when asked:
\`\`\`js
state.page = await context.newPage();
await state.page.goto('https://example.com');
await waitForPageLoad();
return await snapshot();
\`\`\``,
  },
});

export const HELP_SECTION_NAMES = Object.freeze([
  'tabs',
  'page-setup',
  'navigation',
  'snapshot',
  'logs',
  'cdp',
  'plugins',
  'errors',
  'parallel',
  'examples',
]);

export function listHelpSections() {
  return HELP_SECTION_NAMES.map((name) => {
    const section = HELP_SECTIONS[name];
    return {
      name,
      title: section.title,
      summary: section.summary,
    };
  });
}

export function getHelpSection(section) {
  const normalizedSection = String(section || '').trim();
  const entry = HELP_SECTIONS[normalizedSection];
  if (!entry) {
    throw new Error(`Unknown help section "${section}". Available sections: ${HELP_SECTION_NAMES.join(', ')}`);
  }

  return entry.text;
}
