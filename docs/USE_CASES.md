# BrowserForce Use Cases (Actionable)

This page is for real-world execution, not theory. Each section includes:

- What role this is for
- What you are trying to achieve
- Which BrowserForce switches/helpers to use
- A copy-paste example
- What success looks like

## Quick Switch Guide

| Switch / Helper | Use it when | Typical outcome |
|---|---|---|
| `snapshot({ showDiffSinceLastCall: true })` | You are in a multi-step flow and want only changes | Faster loops, lower token usage, less noise |
| `snapshot({ showDiffSinceLastCall: false })` | You need full context right now | Full tree and refs for reliable decisions |
| `cleanHTML(selector, { showDiffSinceLastCall: true })` | You monitor DOM changes over time | Detect only meaningful structural changes |
| `cleanHTML(selector, { showDiffSinceLastCall: false })` | You need full HTML snapshot for parsing | Complete cleaned HTML for extraction |
| `pageMarkdown({ showDiffSinceLastCall: true })` | You monitor long-form content/pages | Alert only on content changes |
| `pageMarkdown({ search: /.../ })` | You need targeted text checks | Focused findings with context lines |
| `refToLocator({ ref: 'eN' })` | You got a ref from `snapshot()` and need a stable locator | Reliable interaction without brittle selectors |
| `getCDPSession({ page })` | You need low-level CDP commands in relay environment | Raw CDP access with relay-safe session creation |

## Feature-by-Feature Use Cases (High Impact First)

This section maps each newly added capability to practical scenarios by user type.

### 1) `snapshot({ showDiffSinceLastCall })` (Most Impactful)

**Why this is high impact:** It cuts repeated context noise in long flows and makes automation loops faster.

- **OpenClaw user scenario:** Checkout flow monitoring from chat
  - Run a full baseline once, then diff mode on each step.
  - You see only changed controls/messages after each action.
- **Developer scenario:** Flaky UI reproduction loop
  - Keep one stable script: `observe -> act -> observe diff`.
  - Faster diagnosis when UI mutates between attempts.
- **Other scenario (Ops / Monitoring):** Status page drift detection
  - Poll snapshot diff on dashboards.
  - Alert only when visible state changes, not every poll.

**Example execute pattern:**

```javascript
await snapshot({ showDiffSinceLastCall: false }); // baseline once
// ... perform one action
return await snapshot({ showDiffSinceLastCall: true }); // concise change output
```

### 2) `refToLocator({ ref })`

**Why this is high impact:** It converts snapshot refs into actionable selectors without brittle locator guessing.

- **OpenClaw user scenario:** “Click the third approve button” from messaging app
  - Agent inspects snapshot refs and resolves exact target with `refToLocator`.
- **Developer scenario:** Remove flaky `nth()` selectors in tests
  - Replace deep CSS chains with snapshot-ref resolution per step.
- **Other scenario (Support):** Guided incident triage
  - Agent can target the exact control visible in the current UI state.

**Example execute pattern:**

```javascript
await snapshot({ showDiffSinceLastCall: false });
const locator = refToLocator({ ref: 'e3' });
if (!locator) throw new Error('ref e3 not available');
await state.page.locator(locator).click();
```

### 3) `getCDPSession({ page })`

**Why this is high impact:** It gives relay-safe low-level browser access for cases Playwright APIs do not cover cleanly.

- **OpenClaw user scenario:** Advanced site diagnostics on authenticated pages
  - Run protocol-level checks while still using real logged-in Chrome sessions.
- **Developer scenario:** Deep debugging in relay environments
  - Enable CDP domains (`Network`, `Runtime`, `Performance`) safely.
- **Other scenario (QA):** Protocol verification in test workflows
  - Validate low-level page/runtime conditions before/after critical actions.

**Example execute pattern:**

```javascript
const cdp = await getCDPSession({ page: state.page });
await cdp.send('Network.enable');
return await cdp.send('Runtime.evaluate', { expression: 'document.readyState' });
```

### 4) Tactical Execute Playbook (Prompt Guidance)

**Why this is high impact:** Better default agent behavior reduces dead-end runs on real websites.

- **OpenClaw user scenario:** Cookie/consent/login blockers handled automatically
  - Agent is guided to clear blockers before continuing.
- **Developer scenario:** Correct extraction tool choice per task
  - Guidance for `snapshot vs cleanHTML vs pageMarkdown` reduces wrong-tool usage.
- **Other scenario (QA / Incident):** Faster root-cause loops
  - “Combine snapshot + logs” guidance standardizes debugging flow.

**Example prompt-to-agent outcomes:**

- More reliable form/task completion on consent-heavy sites.
- Fewer retries caused by stale locators after page updates.
- Better extraction quality on article/news pages using `pageMarkdown`.

### 5) Prompt/Test Regression Guards (Team Safety)

**Why this is high impact:** Prevents silent drift between documented helper surface and runtime behavior.

- **OpenClaw user scenario:** Stable agent behavior across updates
  - Key guidance phrases remain enforced by tests.
- **Developer scenario:** Safer refactors of MCP prompt/runtime
  - Failing tests catch missing helper mentions or diff contract changes.
- **Other scenario (Maintainers):** Predictable release quality
  - Prompt contracts and helper exposure stay synchronized.

**Operational check:**

```bash
node --test mcp/test/mcp-tools.test.js
node --test mcp/test/exec-engine-plugins.test.js
```

## OpenClaw User (High Impact)

### 1) Fast Checkout / Form Completion With Less Noise

**Goal:** Complete long forms without re-reading the whole page every step.

**Use:**
- `snapshot({ showDiffSinceLastCall: true })`
- `refToLocator({ ref })`

**Example execute flow:**

```javascript
await snapshot({ showDiffSinceLastCall: false }); // baseline full view
// ... fill step 1
const delta = await snapshot({ showDiffSinceLastCall: true });
return delta;
```

**Success looks like:** You only see what changed after each action, and fewer wrong clicks happen.

### 2) Watch Your Competitor Pricing Page

**Goal:** Detect only meaningful pricing-card changes.

**Use:**
- `cleanHTML('.pricing', { showDiffSinceLastCall: true })`

**Example execute flow:**

```javascript
const first = await cleanHTML('.pricing', { showDiffSinceLastCall: true });
const second = await cleanHTML('.pricing', { showDiffSinceLastCall: true });
return { firstPreview: first.slice(0, 300), secondPreview: second.slice(0, 300) };
```

**Success looks like:** Second run returns either a compact diff or no-change guidance instead of full repeated markup.

### 3) Track Policy/Terms Changes On Services You Use

**Goal:** Be notified when legal/terms wording changes.

**Use:**
- `pageMarkdown({ showDiffSinceLastCall: true })`

**Example execute flow:**

```javascript
await state.page.goto('https://example.com/terms');
await waitForPageLoad();
const baseline = await pageMarkdown({ showDiffSinceLastCall: true });
const next = await pageMarkdown({ showDiffSinceLastCall: true });
return { baselineLen: baseline.length, next };
```

**Success looks like:** You get concise change output only when terms changed.

## Developer (High Impact)

### 1) Debug “Action Sent But Nothing Happened”

**Goal:** Find where command flow failed.

**Use:**
- CDP JSONL log (`~/.browserforce/cdp.jsonl`)

**Run:**

```bash
jq -r '.direction + "\t" + (.message.method // "response")' ~/.browserforce/cdp.jsonl | uniq -c
```

**Success looks like:** You can confirm whether the command reached extension and whether response/event returned to Playwright.

### 2) Reproduce Flaky Interaction Deterministically

**Goal:** Replace brittle selectors and stale refs.

**Use:**
- `snapshot({ showDiffSinceLastCall: false })`
- `refToLocator({ ref })`

**Example execute flow:**

```javascript
const snap = await snapshot({ showDiffSinceLastCall: false });
const locator = refToLocator({ ref: 'e3' });
if (!locator) throw new Error('ref e3 not available');
await state.page.locator(locator).click();
return await snapshot({ showDiffSinceLastCall: true });
```

**Success looks like:** Fewer flaky failures from stale `nth()`/deep CSS paths.

### 3) Raw CDP Verification In Relay Context

**Goal:** Inspect browser/network behavior beyond normal locator APIs.

**Use:**
- `getCDPSession({ page })`

**Example execute flow:**

```javascript
const cdp = await getCDPSession({ page: state.page });
await cdp.send('Network.enable');
const result = await cdp.send('Runtime.evaluate', { expression: 'document.readyState' });
return result;
```

**Success looks like:** You can run low-level checks without breaking relay compatibility.

## QA / Automation Engineer

### 1) Regression Diff Between Test Steps

**Goal:** Catch unexpected UI changes early.

**Use:**
- `snapshot({ showDiffSinceLastCall: true })`

**Example:** Run snapshot diff after each core step (`login -> cart -> checkout -> confirmation`) and fail test if unexpected controls appear/disappear.

**Success looks like:** Smaller, reviewable diffs in CI logs.

### 2) Validate Article/Release Notes Updates

**Goal:** Verify content releases actually changed required sections.

**Use:**
- `pageMarkdown({ search: /feature-x|deprecation|breaking/i })`

**Example execute flow:**

```javascript
await state.page.goto('https://example.com/changelog');
await waitForPageLoad();
return await pageMarkdown({ search: /feature-x|deprecation|breaking/i });
```

**Success looks like:** You immediately see whether required terms exist in published content.

## Support / Incident Response

### 1) Triaging User Reports Quickly

**Goal:** Determine whether issue is UI, extension, or relay routing.

**Use:**
- `snapshot({ showDiffSinceLastCall: false })`
- `getLogs({ count: 30 })`
- `~/.browserforce/cdp.jsonl`

**Flow:**
1. Capture full snapshot.
2. Capture console logs.
3. Check CDP direction flow in JSONL.

**Success looks like:** Clear fault domain in minutes, not guesswork.

### 2) Verify Page-Load Deadlocks

**Goal:** Confirm whether page is stuck vs automation issue.

**Use:**
- `waitForPageLoad({ timeout: ... })`
- `snapshot({ showDiffSinceLastCall: true })`

**Success looks like:** You can prove if the page state is unchanged over time and isolate blocker overlays quickly.

## Compliance / Risk

### 1) Continuous Monitoring Of Disclosures

**Goal:** Alert on modifications in legal disclosures/policy text.

**Use:**
- `cleanHTML('main', { showDiffSinceLastCall: true })`
- `pageMarkdown({ showDiffSinceLastCall: true })`

**Success looks like:** Only meaningful textual/structural changes trigger review tickets.

### 2) Local Audit Trail For Automation

**Goal:** Keep evidence of what automation asked and what browser returned.

**Use:**
- `~/.browserforce/cdp.jsonl`

**Run:**

```bash
tail -n 200 ~/.browserforce/cdp.jsonl
```

**Success looks like:** Actionable timeline for audits and postmortems.

## Rollout Pattern For Teams

1. Start with one workflow in `diff` mode (`showDiffSinceLastCall: true`).
2. Keep one “escape hatch” call in full mode (`showDiffSinceLastCall: false`) for debugging.
3. Add JSONL checks to incident runbooks.
4. Standardize around `snapshot -> refToLocator -> action -> snapshot diff`.
