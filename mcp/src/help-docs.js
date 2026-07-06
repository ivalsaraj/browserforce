const HELP_SECTIONS = Object.freeze({
  commands: {
    title: 'BrowserForce Commands',
    summary: 'The primary workflow: high-level commands first, exec only as the escape hatch.',
    text: `# BrowserForce Commands

Use browserforce first:
browserforce "tabs"
browserforce "use t1"
browserforce "snapshot"
browserforce "click @e2"

Use exec only when the command layer cannot express the task.
Use reset only for real connection/session corruption.

Multi-tab work — open named tabs, then target them without switching:
browserforce "open https://example.com --as docs"
browserforce "open https://app.heymantle.com --as app"
browserforce "snapshot --tab app"
browserforce "snapshot --tab docs"
browserforce "click @e2 --tab app"

- tabs lists stable t<N> handles, names, and the active marker. Handles never shift when other tabs close — target tabs by handle or name, never by list position.
- use <t handle|name|text> soft-matches names, handles, and title/url text; ambiguity fails with candidates instead of guessing.
- Name conflicts fail by default. Use --replace only when you intentionally want to move a name to another tab.
- Refs (@e1, @e2, ...) come from the latest snapshot of that tab and go stale when the page changes — re-run "snapshot" after navigation or UI changes.
- Command failures teach the next step (re-snapshot, run "tabs", pass --replace). They are not connection failures: fix and retry, do not reset.
- Run browserforce "help" to list every command and flag.`,
  },
  tabs: {
    title: 'Tabs',
    summary: 'Choose existing, manual, and new tabs without creating blanks by accident.',
    text: `# Tabs

- Prefer the command surface for tab work: browserforce "tabs" (stable t<N> handles + names), "use <handle|name|text>", "open <url> --as <name>". The rules below cover exec-scope tab work.
- For attached/manual/current-tab listing, call getBrowserforceStatus() first; use status.manualAttachedTabs and status.activeManualTargets.
- Fast path: const status = await getBrowserforceStatus(); return status.manualAttachedTabs;
- To inspect the attached tab, use: state.page = await getBrowserforcePageForTab();
- For all open tabs, use context.pages(); filter and cap results unless the user explicitly asks for the full list.
- For inspect/read/check/review tasks, reuse existing pages. Do not call context.newPage() or page.goto() just to find a tab that may already be open.
- Set state.page to the chosen existing page and keep using state.page for follow-up work.
- Use intent:'open' only when the user asked to open or navigate. If the requested tab is absent, report that clearly instead of silently opening a replacement.
- In manual/no-new-tabs mode, ask the user to attach/share a tab only when status.manualAttachedTabs is empty and no matching existing page is available.`,
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

- Prefer snapshot() for text, page structure, and interaction refs ([ref=eN]).
- Act on a ref with locatorForRef({ ref }) — returns a Playwright Locator that also reaches into iframes (same-origin and cross-origin). refToLocator({ ref }) still returns the locator string for the top frame.
- Scope with snapshot({ locator }) (a Playwright Locator) or snapshot({ frame }) (a Frame/FrameLocator) to read one region/iframe.
- Use snapshot({ interactiveOnly: true }) to list only actionable elements; omit for full structure.
- Use snapshot({ search: /.../ }) to narrow which interactive elements are reffed on large pages.
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
- Do not use console.log() or console.error() inside exec snippets; return values instead.
- If console.* was already used in an exec snippet, inspect captured output with getExecConsoleLogs({ count }).
- Clear noisy logs with clearLogs() or clearExecConsoleLogs() when starting a fresh debugging pass.
- Avoid raw HTTP/curl for pages that depend on authenticated browser state or rendered DOM.`,
  },
  cdp: {
    title: 'Raw CDP',
    summary: 'Use BrowserForce-safe CDP sessions only when Playwright APIs are insufficient.',
    text: `# Raw CDP

- Prefer Playwright APIs first.
- When raw CDP is needed, call getCDPSession({ page: state.page }) or getCDPSession({ page }) from exec scope.
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
- Plugin helpers are injected into exec scope; built-in BrowserForce helpers always win on name conflicts.`,
  },
  errors: {
    title: 'Errors And Recovery',
    summary: 'Recover from common BrowserForce and page-state failures.',
    text: `# Errors And Recovery

- Command errors teach their own recovery: stale/unknown ref → run browserforce "snapshot" again; unknown tab → run "tabs"; ambiguous tab → use a t<N> handle or name; duplicate name → --replace or another name. These are normal failures — fix and retry, never reset.
- Page closed: choose another page from context.pages(); create a new one only if restrictions allow it.
- Element missing: refresh snapshot output and use stable refs, roles, test IDs, or tighter search.
- Navigation failed: inspect current URL, logs, and snapshot before retrying.
- BF_NO_ATTACHED_PAGE or BF_NEW_TABS_DISABLED: manual/no-new-tabs mode needs an attached tab or relaxed restrictions.
- Connection/internal failures (relay disconnect, browser/context closed) are the ONLY reset cases: call reset, then reinitialize state.page from context.pages().
- Execute timeout is a cancellation boundary, not just a late error: it aborts BrowserForce-controlled continuations (run timers, guarded helpers, state) so a timed-out snippet cannot mutate state or issue new guarded calls — re-observe the page (snapshot/url) before retrying. Two limits by design: a continuation resuming after awaiting a raw top-level page/context op can still issue one more Chrome command, and a CPU loop after an await may not be interruptible. Do not call reset for ordinary timeouts.`,
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
  'cli-session': {
    title: 'CLI Session Daemon',
    summary: 'Persistent CLI browser session + session commands vs one-shot -e.',
    text: `# CLI Session Daemon

- The BrowserForce CLI has two execution paths: a persistent session daemon (sessiond) and one-shot \`-e\`.
- Session commands — \`open\` / \`tabs\` / \`use\` / \`snapshot\` / \`click\` / \`hover\` / \`fill\` / \`type\` / \`press\` / \`wait\` / \`get\` / \`eval\` / \`rename\` / \`forget\` — share one browser session and the snapshot refs across separate CLI invocations. \`browserforce run "<command>"\` runs any command string verbatim (same language as the MCP browserforce tool).
- Refs (\`@e1\`, \`e1\`, \`ref=e1\` all normalize to \`e1\`) come from the latest \`snapshot\`; they go stale on any page change — re-snapshot before the next ref interaction.
- Every command routes through the same guarded runCode() boundary as MCP exec. \`eval --stdin\` runs piped Playwright JS in the session with persistent \`state\` (and \`page\`, \`context\`, \`snapshot()\`, \`locatorForRef()\`).
- One-shot \`-e\` stays independent — no persisted state — for self-contained scripts.
- Add \`--json\` for a { success, data, error, warning } envelope; commands exit non-zero on failure (\`tabs --json\` prints the rows array directly).
- Lifecycle: \`browserforce session start | status | stop\`. The daemon auto-starts on the first command and idles out after 5 minutes.`,
  },
  backends: {
    title: 'Browser Backends',
    summary: 'Real-Chrome-first selection, mandatory managed fallback warning, doctor.',
    text: `# Browser Backends

- Backend selection is real-Chrome-first. \`auto\` (default) connects to the user's real Chrome via relay + extension when the extension is connected.
- If the real bridge is unavailable, \`auto\` falls back to a managed headed Chrome and emits a MANDATORY warning (never silent).
- \`BF_BROWSER_BACKEND=real\` forces the real bridge and fails loud (non-zero exit, no daemon) when it is unavailable — it NEVER falls back.
- \`BF_BROWSER_BACKEND=managed\` or \`headless\` launch a managed Chrome directly.
- \`browserforce session status --json\` reports { backend, requestedBackend, fallbackReason, warning }.
- \`browserforce doctor\` diagnoses relay / extension / stale cdp-url / secret perms / active backend; \`--fix\` removes only stale sidecars, never secrets.`,
  },
  examples: {
    title: 'Examples',
    summary: 'Small patterns for common exec calls.',
    text: `# Examples

Prefer commands for these when possible: browserforce "tabs" / "use t2" /
"open <url> --as <name>". The exec patterns below are for work the command
layer cannot express.

Inspect open tabs:
\`\`\`js
return context.pages().slice(0, 10).map((p, index) => ({ index, url: p.url() }));
\`\`\`

Inspect manually attached tabs:
\`\`\`js
const status = await getBrowserforceStatus();
return status.manualAttachedTabs;
\`\`\`

Use the manually attached page:
\`\`\`js
state.page = await getBrowserforcePageForTab();
return { url: state.page.url() };
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
  'commands',
  'tabs',
  'page-setup',
  'navigation',
  'snapshot',
  'logs',
  'cdp',
  'plugins',
  'errors',
  'parallel',
  'cli-session',
  'backends',
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
