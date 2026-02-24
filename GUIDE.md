# BrowserForce - Advanced Guide

This guide is an extension of README, not a duplicate.

Use README for onboarding and baseline usage:
- Install and extension setup: [README Setup](README.md#setup)
- Agent connection and MCP snippets: [README Connect Your Agent](README.md#connect-your-agent)
- CLI commands: [README CLI](README.md#cli)
- Core examples: [README Examples](README.md#examples)
- Security model: [README Security](README.md#security)

Use this guide for operator workflows, strict tab control, parallel extraction strategy, and production diagnostics.

## Controlled Tabs Playbook

Use this when you need hard boundaries on what an agent can touch.

### 1) Manual attach (single trusted page)

1. Open the exact target tab.
2. Click the BrowserForce extension icon.
3. Click `+ Attach Current Tab`.
4. Confirm it appears in `Controlled Tabs`.

This is the safest default for logged-in or sensitive pages.

### 2) Locked single-tab workflow

For admin, billing, or production dashboards:

1. Set `Mode = Manual`.
2. Attach only one tab.
3. Enable `No new tabs`.
4. Optionally enable `Lock URL` and `Read-only`.

Result: one-tab sandbox with no lateral movement.

### 3) Controlled multi-tab workflow

For tasks that need a small trusted set:

1. Keep `Mode = Manual`.
2. Attach each required tab explicitly.
3. Keep `No new tabs` enabled to prevent expansion.

Result: the agent can operate only in your approved set.

### 4) Restriction presets

- Audit preset: `Manual + No new tabs + Read-only`
- Form-test preset: `Manual + No new tabs`
- Pinned-page preset: `Manual + Lock URL + No new tabs`

### 5) Cleanup and session hygiene

- `Auto-detach inactive tabs`: remove debugger from stale tabs (recommended `10-15 min`).
- `Auto-close agent tabs`: close exploration tabs after runs.

Use both in long-running sessions to limit drift and memory growth.

## BrowserForce Tab Swarms // Parallel Tabs Processing

This is the operating policy for independent read-only extraction at scale.

### When to use a swarm

Use parallel tabs when each task is independent:
- count/list/extract over many pages
- date sweeps
- item matrices (SKU x store, company x source, domain x surface)

Avoid swarms for stateful flows (checkout, purchases, sends, profile changes).

### Parallel-first policy

1. Start with `Promise.all` and concurrency cap `3-8` (default start: `5`).
2. On `429`, anti-bot pages, or repeated timeouts: retry with reduced concurrency.
3. If still unstable: fall back to sequential.
4. Always return telemetry:
- `peakConcurrentTasks`
- `wallClockMs`
- `sumTaskDurationsMs`
- `failures`
- `retries`

### Minimal swarm template

```javascript
const items = state.items ?? [];
const startedAt = Date.now();
let peakConcurrentTasks = 0;
let sumTaskDurationsMs = 0;
let retries = 0;

async function runTask(item, page) {
  const t0 = Date.now();
  try {
    await page.goto(item.url);
    await waitForPageLoad({ timeout: 15000 });
    const value = await page.locator(item.selector).first().textContent();
    return { ok: true, item, value };
  } catch (error) {
    const msg = String(error?.message || error);
    return { ok: false, item, retryable: /429|timeout|captcha|challenge|blocked/i.test(msg), error: msg };
  } finally {
    sumTaskDurationsMs += Date.now() - t0;
  }
}

async function runWithCap(targetItems, cap) {
  const out = [];
  for (let i = 0; i < targetItems.length; i += cap) {
    const batch = targetItems.slice(i, i + cap);
    peakConcurrentTasks = Math.max(peakConcurrentTasks, batch.length);
    const pages = await Promise.all(batch.map(() => context.newPage()));
    const results = await Promise.all(batch.map((item, idx) => runTask(item, pages[idx])));
    await Promise.all(pages.map((p) => p.close().catch(() => {})));
    out.push(...results);
  }
  return out;
}

let results = await runWithCap(items, 5);
let retryable = results.filter((r) => !r.ok && r.retryable).map((r) => r.item);

if (retryable.length) {
  retries += 1;
  const retried = await runWithCap(retryable, 2);
  results = [...results.filter((r) => r.ok), ...retried];
  retryable = results.filter((r) => !r.ok && r.retryable).map((r) => r.item);
}

if (retryable.length) {
  retries += 1;
  for (const item of retryable) {
    const p = await context.newPage();
    results.push(await runTask(item, p));
    await p.close().catch(() => {});
  }
}

return {
  results,
  telemetry: {
    peakConcurrentTasks,
    wallClockMs: Date.now() - startedAt,
    sumTaskDurationsMs,
    failures: results.filter((r) => !r.ok).length,
    retries,
  },
};
```

## MCP Execution Patterns

Use this split to reduce flakiness and context bloat:

- One execute call: one meaningful action plus verification.
- Exception: multi-step is allowed for read-only independent bulk extraction (swarm runs).
- Prefer `snapshot()` over screenshots for text/structure extraction.
- Use `showDiffSinceLastCall: false` when you need full tree output.
- Use `reset` on connection/page lifecycle failures, not for normal task errors.

## Examples

These are advanced examples that complement (not repeat) README examples.

<details>
<summary><b>Example A: Retail price swarm (SKU x store)</b></summary>

**Prompt to AI:**
> For these 25 SKUs, check Amazon, Walmart, Target, and Best Buy in parallel tabs. Return best price, in-stock status, and fastest delivery ETA per SKU, with swarm telemetry.

**Expected output:**
- Per-SKU normalized comparison table
- Cheapest source per SKU
- Swarm telemetry block

</details>

<details>
<summary><b>Example B: Competitor launch radar (company x source)</b></summary>

**Prompt to AI:**
> For these 30 competitors, scan release notes, changelogs, docs, and blogs for the last 7 days. Group launches by category and include links.

**Expected output:**
- Deduped launch digest
- Category breakdown
- Swarm telemetry block

</details>

<details>
<summary><b>Example C: Security surface triage (domain x surface)</b></summary>

**Prompt to AI:**
> For these domains, inspect login pages, robots.txt, status pages, public docs, and likely staging links. Return prioritized findings with evidence links.

**Expected output:**
- Risk-prioritized findings list
- Evidence URLs
- Swarm telemetry block

</details>

Need broader persona workflows? See [Actionable Use Cases](docs/USE_CASES.md).

## Troubleshooting and Diagnostics

| Problem | Fix |
|---|---|
| Extension stays gray | Start relay: `browserforce serve` |
| `Another debugger is attached` | Close DevTools for that tab |
| Agent sees 0 pages | Open at least one normal webpage (not `chrome://`) |
| Frequent disconnections | MV3 worker churn is expected; relay keepalive should reconnect |
| Port collision on `19222` | `lsof -ti:19222 | xargs kill -9` |

CDP traffic log: `~/.browserforce/cdp.jsonl` (recreated each relay start).

Summarize CDP traffic by direction + method:

```bash
jq -r '.direction + "\t" + (.message.method // "response")' ~/.browserforce/cdp.jsonl | uniq -c
```

If MCP startup fails with `connection closed: initialize response`:

1. Ensure args include `"mcp"`.
2. If running from local clone, run `pnpm install`.
3. Validate manually: `npx -y browserforce@latest mcp`.
