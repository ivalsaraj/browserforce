# Agent Discoverability & Tab Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh BrowserForce install needs no babysitting — an agent asked for any browser work picks BrowserForce unprompted, and the tab handles it acts on name the tab it meant.

**Architecture:** Two independent arcs. The *discoverability* arc is text-only: the skill description and the three MCP tool descriptions claim browser work outright and say why a fresh-profile driver cannot substitute, and `browserforce doctor` fails loudly when a deployed copy of the skill has drifted from the shipped one. The *tab identity* arc replaces Playwright-`Page`-keyed identity with relay-target-keyed identity: one unauthenticated `GET /json/list` returns `{ id, title, url }` for every tab with no debugger attach, which fixes renumbering handles, evaporating names and `(untitled)` rows from a single source.

**Tech Stack:** Node 22 ESM (`mcp/`, `cli/`, `bin.js`), CommonJS (`relay/`), `node:test`, `playwright-core` 1.60.0, `ws`. No new dependencies.

**Spec:** `docs/superpowers/plans/2026-09-08-agent-discoverability-spec.md` — read it first. It carries the reproductions, the verified root causes and three corrections to the original brief.

## Global Constraints

- **No new dependencies.** The relay is intentionally `ws`-only.
- **Prose standard, binding on every string this plan adds** — skill description, `read_when`, MCP tool descriptions, help-docs text, agent-facing error messages, code comments: high signal, low noise. The useful thing in the fewest clear words. No filler, no jargon, no obvious explanations. Concise but never lose detail — brevity comes from cutting filler, never from dropping a fact the reader cannot recover from the code.
- **Security invariants unchanged:** relay binds `127.0.0.1` only; `Origin: chrome-extension://` checked on the extension WS; CDP token random 32 bytes; token file `0o600`; single extension slot.
- **Every `relay.start()` in a test passes `{ writeCdpUrl: false }`** or it overwrites the production `~/.browserforce/cdp-url`.
- **Command semantics live only in `mcp/src/browserforce-command-registry.js`.** CLI direct verbs, sessiond HTTP verbs and the MCP `browserforce` tool are thin transports over it.
- **Every new test file is registered in `package.json`** in both `test` and its sub-script (`test:mcp` or `test:relay`).
- **No unrequested back-compat.** Nothing here has a prior external consumer; do not add migration paths, dual-format readers or rename shims.
- `mcp/src/browser-session-runtime.js` is **import-free by design**. New pure helpers go in their own module and are injected or imported only if they are equally import-free.

## Already solved — do not rebuild

- `ensureRelay()` (`mcp/src/exec-engine.js:305`) already spawns a down relay detached, called at MCP startup (`mcp/src/index.js:66`).
- `runDoctor()` (`mcp/src/doctor.js:89`) already separates relay-unreachable from extension-not-connected.
- `assertBrowserforceCoreSkill` (`test/browserforce-skill-contract.js`) already holds the shipped skill and the `npx skills add` installed copy to one contract.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `mcp/src/tab-identity.js` *(new)* | Pure, import-free page↔relay-target pairing. No Playwright, no fetch. | 3 |
| `mcp/test/tab-identity.test.js` *(new)* | Matching rules incl. duplicate URLs and unmatched pages. | 3 |
| `skills/browserforce/SKILL.md` | Skill description, `read_when`, the "rendered page is not proof" caveat. | 2 |
| `mcp/src/index.js` | Three MCP tool descriptions (`:135`, `:161`, `:261`). | 2 |
| `mcp/src/browser-session-runtime.js` | Relay target fetch, target-keyed handles and names, relay-sourced titles. | 5, 6, 7 |
| `mcp/src/browserforce-command-registry.js` | `tabs` flags, listing cap, unknown-subcommand rejection. | 8, 9 |
| `mcp/src/help-docs.js` | Tabs section: correct the stability claim, document the new flags. | 6, 8 |
| `mcp/src/doctor.js` | Deployed-skill drift check; four-state connection detail. | 1, 10 |
| `mcp/src/exec-engine.js` | `assertExtensionConnected` messages name their fix. | 10 |
| `relay/src/index.js` | `/json/list` + `/json` out of wildcard CORS. | 4 |
| `test/browserforce-skill-contract.js` | Assert the new description claims. | 2 |
| `docs/knowledge/timeline2.md`, `AGENTS.md`, `README.md` | Durable record and conventions. | per-task + 11 |

---

### Task 1: Doctor fails on a drifted deployed skill

The repo ships `skills/browserforce/SKILL.md`. Agents read whatever `npx skills add` deployed. On this machine those forked in July and every text fix would otherwise have to be made twice. Nothing in the repo can police another machine's home directory at CI time, so the check runs where it can see the truth: `browserforce doctor`.

**Files:**
- Modify: `mcp/src/doctor.js` (imports; `defaultPaths()` ~`:74-82`; new check after the extension check ~`:122`)
- Test: `test/doctor.test.js`

**Interfaces:**
- Consumes: existing `runDoctor({ readText, paths })` injection points.
- Produces: check id `skill`, statuses `OK`/`FAIL`; `paths.shippedSkillFile: string` and `paths.deployedSkillFiles: string[]`.

- [ ] **Step 1: Write the failing tests**

```js
// test/doctor.test.js
test('doctor fails when a deployed skill has drifted from the shipped one', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readText: (p) => (p.includes('deployed') ? 'stale copy' : 'shipped copy'),
    readRawLock: () => null,
    paths: { ...basePaths, shippedSkillFile: '/repo/shipped/SKILL.md', deployedSkillFiles: ['/home/deployed/SKILL.md'] },
  });
  const skill = checks.find((c) => c.id === 'skill');
  assert.equal(skill.status, 'fail');
  assert.match(skill.detail, /\/home\/deployed\/SKILL\.md/);
  assert.match(skill.detail, /npx -y skills add ivalsaraj\/browserforce/);
});

test('doctor passes when the deployed skill matches, ignoring trailing whitespace', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readText: (p) => (p.includes('deployed') ? 'same\n\n' : 'same'),
    readRawLock: () => null,
    paths: { ...basePaths, shippedSkillFile: '/repo/shipped/SKILL.md', deployedSkillFiles: ['/home/deployed/SKILL.md'] },
  });
  assert.equal(checks.find((c) => c.id === 'skill').status, 'ok');
});

test('doctor reports no deployed skill without failing', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readText: (p) => (p.includes('deployed') ? null : 'shipped copy'),
    readRawLock: () => null,
    paths: { ...basePaths, shippedSkillFile: '/repo/shipped/SKILL.md', deployedSkillFiles: ['/home/deployed/SKILL.md'] },
  });
  const skill = checks.find((c) => c.id === 'skill');
  assert.equal(skill.status, 'ok');
  assert.match(skill.detail, /not installed/i);
});
```

Define `basePaths` in the test file as the existing four sidecar paths so the other checks stay inert.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/doctor.test.js`
Expected: FAIL — no check with id `skill`, so `.status` reads on `undefined`.

- [ ] **Step 3: Implement**

Add to the imports in `mcp/src/doctor.js`:

```js
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
```

Add above `defaultPaths()`:

```js
// The skill an agent reads is the DEPLOYED copy, not the repo's. They forked
// silently once already (July → September), so every text fix had to be made
// twice. CI cannot see another machine's home directory; this check can.
const SKILL_INSTALL_HINT = 'npx -y skills add ivalsaraj/browserforce';
const SHIPPED_SKILL_FILE = fileURLToPath(new URL('../../skills/browserforce/SKILL.md', import.meta.url));

function defaultDeployedSkillFiles() {
  const home = homedir();
  return [
    join(home, '.claude', 'skills', 'browserforce', 'SKILL.md'),
    join(home, '.config', 'opencode', 'skills', 'browserforce', 'SKILL.md'),
    join(home, '.agents', 'skills', 'browserforce', 'SKILL.md'),
  ];
}
```

Extend the object `defaultPaths()` returns with:

```js
    shippedSkillFile: SHIPPED_SKILL_FILE,
    deployedSkillFiles: defaultDeployedSkillFiles(),
```

Insert this check immediately after the `extension` check pushes:

```js
  // 2b. Deployed skill matches the shipped guide.
  const shippedSkill = readText(paths.shippedSkillFile);
  const deployed = (paths.deployedSkillFiles || [])
    .map((p) => ({ path: p, text: readText(p) }))
    .filter((d) => d.text !== null);
  const drifted = shippedSkill
    ? deployed.filter((d) => d.text.trimEnd() !== shippedSkill.trimEnd())
    : [];
  if (!shippedSkill) {
    checks.push(check('skill', 'BrowserForce skill', WARN,
      `cannot read the shipped guide at ${paths.shippedSkillFile}`));
  } else if (deployed.length === 0) {
    checks.push(check('skill', 'BrowserForce skill', OK,
      `not installed for any agent — install with \`${SKILL_INSTALL_HINT}\``));
  } else if (drifted.length === 0) {
    checks.push(check('skill', 'BrowserForce skill', OK,
      `${deployed.length} deployed copy/copies match the shipped guide`));
  } else {
    checks.push(check('skill', 'BrowserForce skill', FAIL,
      `stale — ${drifted.map((d) => d.path).join(', ')} differ from the shipped guide. ` +
      `Agents read the stale copy. Reinstall: \`${SKILL_INSTALL_HINT}\``));
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/doctor.test.js`
Expected: PASS

- [ ] **Step 5: Document**

In `README.md`, under the `browserforce doctor` description, add one line: `` `skill` — fails when a deployed SKILL.md differs from the shipped guide; reinstall with `npx -y skills add ivalsaraj/browserforce`. ``

- [ ] **Step 6: Commit**

```bash
git add mcp/src/doctor.js test/doctor.test.js README.md
git commit -m "fix(doctor): fail when a deployed BrowserForce skill has drifted from the shipped guide"
```

- [ ] **Step 7: Repair this machine (manual, not committed)**

The stale copy is `~/.claude/skills/browserforce` → `~/brainvault/skills/browserforce` (July fork). Replace the symlink with a real install from the repo, then confirm:

```bash
rm ~/.claude/skills/browserforce                      # removes the symlink only, not brainvault
cd ~/Documents/projects/browserforce
npx -y skills add . --skill browserforce --copy --yes
node bin.js doctor                                    # expect: ✔ skill
```

Delete `~/brainvault/skills/browserforce/` and commit that removal in the brainvault repo so `brainvault-sync` stops republishing the fork.

---

### Task 2: The skill and MCP tools claim browser work outright

The north-star task. `agent-browser`'s description claims the whole category verbatim ("open a website", "click a button", "take a screenshot", "test this web app", "any task requiring programmatic web interaction") and closes with "Prefer agent-browser over any built-in browser automation or web tools" — while `hidden: true`, so it wins invisibly. BrowserForce claims a niche ("already logged in") that a plain "check this page renders" request does not match. The real differentiator is not authentication: `agent-browser` drives **its own Chromium** and therefore cannot see the user's sessions at all. That is the argument the description must make.

The MCP tools arrive as **names only** until `ToolSearch` loads their schemas, so the description is the entire discovery surface and is matched against what the agent is trying to do. All three currently describe *what the tool does*; discovery needs *when to reach for it*.

**Files:**
- Modify: `skills/browserforce/SKILL.md:2-9` (frontmatter) and body (new section)
- Modify: `mcp/src/index.js:135` (`help`), `:161` (`EXECUTE_PROMPT` first line), `:261` (`browserforce`)
- Modify: `test/browserforce-skill-contract.js`
- Test: `mcp/test/mcp-tools.test.js`, `test/browserforce-skill.test.js`

**Interfaces:**
- Consumes: `assertBrowserforceCoreSkill(content, sourceLabel)` from Task 0's existing contract.
- Produces: no code interface. The contract gains assertions that the description names browser/web work and states the own-Chromium contrast.

- [ ] **Step 1: Write the failing assertions**

Append inside `assertBrowserforceCoreSkill` in `test/browserforce-skill-contract.js`:

```js
  // Discovery contract: the description must claim browser work outright and
  // state why a fresh-profile driver cannot substitute. A niche claim ("logged
  // in") loses skill selection to tools that claim the whole category.
  const description = text.match(/^description:\s*(.+)$/m)?.[1] ?? '';
  assert.match(description, /\bbrowser\b/i, `${sourceLabel} description must claim browser work`);
  assert.match(description, /\breal Chrome\b/i, `${sourceLabel} description must name real Chrome`);
  assert.match(description, /fresh|own Chromium|separate browser/i,
    `${sourceLabel} description must contrast with fresh-profile drivers`);
  for (const verb of ['open', 'click', 'fill', 'screenshot']) {
    assert.match(description, new RegExp(`\\b${verb}`, 'i'), `${sourceLabel} description missing ${verb}`);
  }
  assert.match(text, /not proof|corroborat/i,
    `${sourceLabel} must warn that a rendered page can predate the change`);
```

Add to `mcp/test/mcp-tools.test.js`:

```js
test('MCP tool descriptions lead with when to reach for them', async () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const browserforceDesc = src.match(/'browserforce',\n\s*'([^']+)'/)?.[1] ?? '';
  assert.match(browserforceDesc, /browser/i);
  assert.match(browserforceDesc, /real Chrome/i);
  assert.match(browserforceDesc, /web page|page/i);
  const helpDesc = src.match(/'help',\n\s*'([^']+)'/)?.[1] ?? '';
  assert.match(helpDesc, /browser/i);
  assert.match(src.match(/const EXECUTE_PROMPT = `([^\n]+)/)?.[1] ?? '', /browser/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/browserforce-skill.test.js mcp/test/mcp-tools.test.js`
Expected: FAIL — current description has no `open`/`click`/`fill`/`screenshot`, no fresh-profile contrast; `help` description has no "browser".

- [ ] **Step 3: Rewrite the skill frontmatter**

Replace lines 2-9 of `skills/browserforce/SKILL.md`:

```yaml
description: Drive the user's real Chrome — their tabs, their logins, their cookies, their extensions. Use for any browser or web-page work: open a page, click, fill, screenshot, scrape, sign in, verify what a page renders, QA a flow. Other browser tools launch a fresh Chromium and cannot see the user's sessions; this is the user's actual browser.
read_when:
  - Any browser, web page, or web app task
  - Opening, clicking, filling, or screenshotting a page
  - Checking what a page actually renders
  - Reaching a site behind the user's existing login
  - Reading a page the user is signed in to
```

- [ ] **Step 4: Add the corroboration caveat to the skill body**

Append before the Troubleshooting section:

```markdown
## A rendered page is not proof

The tab you read may have been open, and logged in, before your change — the page
can render correctly for reasons that have nothing to do with it. Corroborate a
browser result against independent evidence (a fresh navigation, a server log, a
test) before calling a flow verified.
```

- [ ] **Step 5: Rewrite the three MCP tool descriptions**

`mcp/src/index.js:135` (`help`):

```js
  'BrowserForce docs by section — browser commands, tabs, snapshots, recovery. Needs no Chrome connection. First read returns docs; repeats return a receipt unless force:true.',
```

`mcp/src/index.js:161`, first line of `EXECUTE_PROMPT`:

```js
const EXECUTE_PROMPT = `Run Playwright JS in the user's real Chrome. Escape hatch for browser work the browserforce command tool cannot express.
```

`mcp/src/index.js:261` (`browserforce`):

```js
    'Control the browser — the user\'s real Chrome, with their tabs, logins and cookies. Use for any web page work: open, click, fill, press, wait, get, snapshot, tabs, use, eval. Start here; reach for exec only when a command cannot express the task.',
```

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/browserforce-skill.test.js mcp/test/mcp-tools.test.js && pnpm test:skill-install`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add skills/browserforce/SKILL.md mcp/src/index.js test/browserforce-skill-contract.js mcp/test/mcp-tools.test.js
git commit -m "fix(skill,mcp): claim browser work outright so agents pick BrowserForce unprompted"
```

- [ ] **Step 8: Prove it the way the defect was found**

No test can prove skill selection. In a **fresh** session with no tool named, give an agent a plain browser task ("open example.com and tell me what the heading says") and record which tool it reaches for. Run it before and after this commit. If you cannot tell the difference, the edit did not work — revisit the description rather than moving on.

---

### Task 3: Pure page↔target matcher

Playwright rebuilds every `Page` object when the CDP connection drops, so any `Page`-keyed identity dies on the idle reconnect. Relay target ids survive it. This module is the pairing rule, kept pure so it is testable without Playwright or a live relay — the same reason `extension/window-affinity.js` and `extension/auto-manage-state.js` are separate modules.

**Files:**
- Create: `mcp/src/tab-identity.js`
- Create: `mcp/test/tab-identity.test.js`
- Modify: `package.json` (`test`, `test:mcp`)

**Interfaces:**
- Produces: `matchPagesToTargets(pageUrls: string[], targets: Array<{id, url, title}>): Array<{targetId: string|null, title: string}>` — index-aligned to `pageUrls`. Tasks 5, 6 and 7 consume it.

- [ ] **Step 1: Write the failing tests**

```js
// mcp/test/tab-identity.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPagesToTargets } from '../src/tab-identity.js';

test('pairs unique URLs to their target id and title', () => {
  const out = matchPagesToTargets(
    ['https://a.test/', 'https://b.test/'],
    [{ id: 'T2', url: 'https://b.test/', title: 'B' }, { id: 'T1', url: 'https://a.test/', title: 'A' }],
  );
  assert.deepEqual(out, [{ targetId: 'T1', title: 'A' }, { targetId: 'T2', title: 'B' }]);
});

test('pairs duplicate URLs positionally within their group', () => {
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank'],
    [{ id: 'T1', url: 'about:blank', title: 'first' }, { id: 'T2', url: 'about:blank', title: 'second' }],
  );
  assert.deepEqual(out, [{ targetId: 'T1', title: 'first' }, { targetId: 'T2', title: 'second' }]);
});

test('a page with no matching target yields a null targetId rather than a guess', () => {
  const out = matchPagesToTargets(['https://a.test/'], [{ id: 'T1', url: 'https://other.test/', title: 'X' }]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('an exhausted duplicate group yields null for the surplus page', () => {
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank'],
    [{ id: 'T1', url: 'about:blank', title: 'only' }],
  );
  assert.deepEqual(out, [{ targetId: 'T1', title: 'only' }, { targetId: null, title: '' }]);
});

test('ignores targets with no id and tolerates missing fields', () => {
  assert.deepEqual(matchPagesToTargets(['u'], [{ url: 'u', title: 'no id' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 'T1', url: 'u' }]), [{ targetId: 'T1', title: '' }]);
});

test('empty and non-array inputs return an empty array', () => {
  assert.deepEqual(matchPagesToTargets([], [{ id: 'T1', url: 'u', title: 't' }]), []);
  assert.deepEqual(matchPagesToTargets(undefined, undefined), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test mcp/test/tab-identity.test.js`
Expected: FAIL — `Cannot find module '../src/tab-identity.js'`

- [ ] **Step 3: Implement**

```js
// mcp/src/tab-identity.js — pure tab-identity helpers. No imports by design:
// browser-session-runtime.js is import-free and this is the rule it consumes.
//
// Playwright rebuilds every Page object when the CDP connection drops, so a
// Page-keyed handle or name map silently renumbers on each idle reconnect.
// Relay target ids survive that. Pairing pages to targets is what lets handles
// and names be keyed by target id instead.

/**
 * Pair pages with relay targets, index-aligned to `pageUrls`.
 *
 * Both lists derive from the relay's own target map in insertion order, so
 * duplicate URLs (several about:blank, the same doc open twice) are paired
 * positionally within their URL group. A page with no matching target yields
 * `targetId: null` — the caller falls back to per-connection identity rather
 * than guessing, which is what a managed/headless backend with no relay gets.
 */
export function matchPagesToTargets(pageUrls, targets) {
  const byUrl = new Map();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target?.id) continue;
    const url = typeof target.url === 'string' ? target.url : '';
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(target);
  }

  return (Array.isArray(pageUrls) ? pageUrls : []).map((pageUrl) => {
    const target = byUrl.get(typeof pageUrl === 'string' ? pageUrl : '')?.shift();
    if (!target) return { targetId: null, title: '' };
    return { targetId: target.id, title: typeof target.title === 'string' ? target.title : '' };
  });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/tab-identity.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Register the test file**

In `package.json`, add `node --test mcp/test/tab-identity.test.js` to the `test` chain and the `test:mcp` chain, immediately after `mcp/test/browser-session-runtime.test.js`.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/tab-identity.js mcp/test/tab-identity.test.js package.json
git commit -m "feat(mcp): add pure page-to-relay-target matcher for durable tab identity"
```

---

### Task 4: Take `/json/list` out of wildcard CORS

`relay/src/index.js:80-83` states that introspection endpoints carrying tab URLs and titles must not be readable cross-origin, then lists only `/extension/status` and `/attached-tabs`. `/json/list` serves every tab's URL and title *and* a `webSocketDebuggerUrl` with the auth token embedded, under `Access-Control-Allow-Origin: *`. Any web page can read it. Task 5 makes this endpoint load-bearing, so it is fixed first.

**Files:**
- Modify: `relay/src/index.js:83`
- Test: `relay/test/relay-server.test.js`

**Interfaces:**
- Consumes: nothing. Produces: nothing. Behavior-only change to a response header.

- [ ] **Step 1: Write the failing test**

```js
test('/json/list is not readable cross-origin', async () => {
  const relay = new RelayServer({ port: 0 });
  await relay.start({ writeCdpUrl: false });
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/json/list`);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.status, 200);
  } finally {
    await relay.stop();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test relay/test/relay-server.test.js`
Expected: FAIL — header is `*`.

- [ ] **Step 3: Implement**

```js
// /json and /json/list carry every tab's URL and title AND embed the CDP auth
// token in webSocketDebuggerUrl. Wildcard CORS stays for the health route only.
const NO_WILDCARD_CORS_PATHS = new Set(['/extension/status', '/attached-tabs', '/json', '/json/list']);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test relay/test/relay-server.test.js`
Expected: PASS. Then `pnpm test:mcp` — same-origin `fetch` from Node ignores CORS, so nothing else moves.

- [ ] **Step 5: Document**

Add to `AGENTS.md` under **Security Rules**: `- Introspection routes carrying tab URLs/titles or the auth token (`/extension/status`, `/attached-tabs`, `/json`, `/json/list`) are excluded from wildcard CORS. Only the health route is wildcard.`

- [ ] **Step 6: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js AGENTS.md
git commit -m "fix(relay): stop serving /json/list cross-origin — it leaks tab URLs and the CDP token"
```

---

### Task 5: Titles come from the relay, not from `page.title()`

Across three real listings of ~72 tabs, the only tab with a title was one BrowserForce had just opened. `pageTitleBounded` (`:516`) is not the bug — its 1s bound is correct, because on a lazily-attached tab the relay synthetically acks `Runtime.enable`, no execution context ever arrives, and an unbounded `page.title()` never settles. The source is wrong. The relay already holds every title with no debugger attach.

A tab list exists so something can choose a tab. Without titles it cannot, and `use <name|text>` has nothing to match against.

**Files:**
- Modify: `mcp/src/browser-session-runtime.js` — import (`:1` area), `fetchRelayTargets()` + `listIdentifiedPages()` near `listStablePages()` (`:404`), `listTabRows()` (`:531-556`), `resolveTabTarget()` (`:575+`)
- Test: `mcp/test/browser-session-runtime.test.js`

**Interfaces:**
- Consumes: `matchPagesToTargets` (Task 3); existing `getRelayHttpUrl()` and `doFetch` deps.
- Produces: `listIdentifiedPages(): Promise<Array<{page, url, targetId, title, handle}>>`, consumed by Tasks 6, 7 and 8.

- [ ] **Step 1: Write the failing tests**

```js
function makeRelayFetch(targets) {
  return async (url) => {
    if (!String(url).endsWith('/json/list')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => targets };
  };
}

test('tab titles come from the relay target list, not page.title()', async () => {
  const pages = [
    { ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/', title: async () => { throw new Error('never settles'); } },
  ];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: makeRelayFetch([{ id: 'T1', url: 'https://a.test/', title: 'Real Title' }]),
  });
  const [row] = await runtime.listTabRows();
  assert.equal(row.title, 'Real Title');
});

test('falls back to the bounded page title when no relay target matches', async () => {
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/', title: async () => 'From Page' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => '',
    fetch: async () => { throw new Error('no relay'); },
  });
  const [row] = await runtime.listTabRows();
  assert.equal(row.title, 'From Page');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: FAIL — first test times out or returns `''`; titles still come from `page.title()`.

- [ ] **Step 3: Implement**

Add the import at the top of `mcp/src/browser-session-runtime.js` (this is the one permitted import — `tab-identity.js` is itself import-free, so the module stays leaf-only):

```js
import { matchPagesToTargets } from './tab-identity.js';
```

Add beside `listStablePages()`:

```js
  /**
   * Relay target list: id, url and title for EVERY tab, with no debugger
   * attach. Returns [] on any failure — a managed/headless backend has no
   * relay, and identity then falls back to per-connection page identity.
   */
  async function fetchRelayTargets({ timeoutMs = 1500 } = {}) {
    try {
      const relayHttpUrl = typeof getRelayHttpUrl === 'function' ? getRelayHttpUrl() : null;
      if (!relayHttpUrl) return [];
      const response = await doFetch(`${relayHttpUrl}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    } catch {
      return [];
    }
  }

  /**
   * Open pages with their relay target id, title and stable handle.
   *
   * Titles come from the relay because page.title() cannot be trusted here: on
   * a lazily-attached tab the relay acks Runtime.enable synthetically, no
   * execution context arrives, and the bounded read times out to '' — which is
   * why every tab in a real many-tab session listed as "(untitled)". The
   * bounded read stays as the fallback for backends with no relay.
   */
  async function listIdentifiedPages() {
    const pages = getPages().filter((page) => isUsablePage(page));
    const urls = pages.map((page) => { try { return page.url() || ''; } catch { return ''; } });
    const identities = matchPagesToTargets(urls, await fetchRelayTargets());
    return Promise.all(pages.map(async (page, i) => {
      const { targetId, title } = identities[i] ?? { targetId: null, title: '' };
      return {
        page,
        url: urls[i],
        targetId,
        title: targetId ? title : await pageTitleBounded(page),
        handle: getStablePageHandle(page, targetId),
      };
    }));
  }
```

Rewrite the body of `listTabRows()` to consume it:

```js
      const active = resolveActivePage(getContext());
      const identified = await listIdentifiedPages();
      return identified.map(({ page, handle, title, url }, index) => ({
        handle,
        index,
        title,
        url,
        active: page === active,
        name: nameForPage(page),
      }));
```

In `resolveTabTarget()`, replace `const stable = listStablePages();` with `const stable = await listIdentifiedPages();` and delete the now-redundant per-row `pageTitleBounded`/`page.url()` block in its `metas` construction — `listIdentifiedPages()` already carries `url` and `title`, so `metas` becomes `const metas = stable;`.

Leave `listStablePages()` in place only if something still calls it; if nothing does, delete it (orphan cleanup — this change made it unused).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/browser-session-runtime.test.js && node --test mcp/test/browserforce-command-registry.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/browser-session-runtime.js mcp/test/browser-session-runtime.test.js
git commit -m "fix(mcp): read tab titles from the relay so listings stop being all (untitled)"
```

---

### Task 6: Handles keyed by relay target id survive the idle reconnect

The dangerous one. An agent that lists tabs and acts on a handle gets no error — it acts on **the wrong tab**, silently. `help(tabs)` promises "stable t<N> handles"; `SKILL.md` promises they "persist for the lifetime of the session". Today the documentation is the trap.

Cause (verified): the idle disconnect's `disconnected` handler (`:281-286`) clears `browser`, `contextListenerAttached` and `consoleLogs` but not `stableHandles` or `nextStableHandleNumber`. Reconnect builds a whole new `Page` graph, every WeakMap key is dead, every tab draws a fresh handle from a counter that never reset — t1…t72, then t146…t218, then t219…t289.

Keying by relay target id fixes it without touching the disconnect handler at all.

**Files:**
- Modify: `mcp/src/browser-session-runtime.js:113-116` (state), `:391-400` (`getStablePageHandle`), `:734` (`reset`)
- Modify: `mcp/src/help-docs.js` (tabs section, `:32`)
- Modify: `skills/browserforce/SKILL.md` (the stability sentence)
- Test: `mcp/test/browser-session-runtime.test.js`

**Interfaces:**
- Consumes: `listIdentifiedPages()` (Task 5).
- Produces: `getStablePageHandle(page, targetId = null): string|null` — second parameter is new.

- [ ] **Step 1: Write the failing test**

```js
test('a handle names the same tab after an idle reconnect replaces every Page object', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }, { id: 'T2', url: 'https://b.test/', title: 'B' }];
  const makePages = () => targets.map((t) => ({ ...makeFakePage(), isClosed: () => false, url: () => t.url }));
  let pages = makePages();
  let browser;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => { browser = makeFakeBrowser({ pages }); return browser; },
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: makeRelayFetch(targets),
  });

  const before = await runtime.listTabRows();
  browser.fireDisconnected();
  pages = makePages();               // reconnect: brand-new Page objects, same tabs
  const after = await runtime.listTabRows();

  assert.deepEqual(after.map((r) => r.handle), before.map((r) => r.handle));
  assert.equal(after[0].handle, 't1');
});

test('handles still work per-connection when no relay target is available', async () => {
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/', title: async () => 'A' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => '',
    fetch: async () => { throw new Error('no relay'); },
  });
  assert.equal((await runtime.listTabRows())[0].handle, 't1');
  assert.equal((await runtime.listTabRows())[0].handle, 't1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: FAIL — `after` is `['t3','t4']`, `before` is `['t1','t2']`.

- [ ] **Step 3: Implement**

Replace the tab identity state block (`:113-116`):

```js
  const namedPages = new Map(); // name → page
  const handlesByTargetId = new Map(); // relay targetId → 't<N>' — survives reconnect
  let stableHandles = new WeakMap();   // page → 't<N>' — fallback when no relay target
  let nextStableHandleNumber = 1;
```

Replace `getStablePageHandle`:

```js
  /**
   * Stable `t<N>` handle. Keyed by relay target id when one is known, because
   * Playwright rebuilds every Page object on the idle reconnect — a Page-keyed
   * map renumbered every tab on every reconnect and an agent acting on a stale
   * handle silently hit the WRONG TAB. Falls back to page identity (valid for
   * one connection) when there is no relay target: a managed/headless backend
   * has no target ids.
   */
  function getStablePageHandle(page, targetId = null) {
    if (!page) return null;
    if (targetId) {
      let handle = handlesByTargetId.get(targetId);
      if (!handle) {
        handle = `t${nextStableHandleNumber++}`;
        handlesByTargetId.set(targetId, handle);
      }
      stableHandles.set(page, handle); // fast path for lookups with no target id to hand
      return handle;
    }
    let handle = stableHandles.get(page);
    if (!handle) {
      handle = `t${nextStableHandleNumber++}`;
      stableHandles.set(page, handle);
    }
    return handle;
  }
```

In `reset()` (`:734`), add `handlesByTargetId.clear();` beside the existing `stableHandles = new WeakMap();`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: PASS

- [ ] **Step 5: Make the documentation true**

`mcp/src/help-docs.js` tabs section, first bullet — replace the parenthetical with the honest guarantee:

```
- Prefer the command surface for tab work: browserforce "tabs" (t<N> handles, stable for the session — a handle names the same tab across calls and across reconnects), "use <handle|name|text>", "open <url> --as <name>". The rules below cover exec-scope tab work.
```

In `skills/browserforce/SKILL.md`, keep the "Stable handles and names persist for the lifetime of the session." sentence — it is now true — and append: `A handle survives the idle reconnect; it is invalidated only by \`reset\`.`

- [ ] **Step 6: Commit**

```bash
git add mcp/src/browser-session-runtime.js mcp/test/browser-session-runtime.test.js mcp/src/help-docs.js skills/browserforce/SKILL.md
git commit -m "fix(mcp): key tab handles by relay target id so they survive the idle reconnect"
```

---

### Task 7: Tab names survive the idle reconnect

Same root cause, second victim, found during verification rather than in the brief. `namedPages` (`:114`) maps name → `Page`. After a reconnect every stored `Page` is stale, `isUsablePage` rejects it and `pruneNamedPages` (`:409-412`) deletes every name. A user who named a tab loses the name with no message.

**Files:**
- Modify: `mcp/src/browser-session-runtime.js:114`, `:409-412` (`pruneNamedPages`), `:450-498` (set/get/rename/forget/list/`nameForPage`), `listIdentifiedPages()` from Task 5
- Test: `mcp/test/browser-session-runtime.test.js`

**Interfaces:**
- Consumes: `listIdentifiedPages()` (Task 5).
- Produces: `namedPages` becomes `Map<string, { targetId: string|null, page }>`; `nameForPage(page, targetId = null)` gains a second parameter.

- [ ] **Step 1: Write the failing test**

```js
test('a tab name still resolves after an idle reconnect', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const makePages = () => targets.map((t) => ({ ...makeFakePage(), isClosed: () => false, url: () => t.url }));
  let pages = makePages();
  let browser;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => { browser = makeFakeBrowser({ pages }); return browser; },
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: makeRelayFetch(targets),
  });

  await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0]);
  browser.fireDisconnected();
  pages = makePages();

  const rows = await runtime.listTabRows();
  assert.equal(rows[0].name, 'docs');
  assert.equal((await runtime.resolveTabTarget('docs')).page, pages[0]);
});

test('a name is dropped when its tab is gone from the relay listing', async () => {
  let targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  let pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: async (url) => ({ ok: true, json: async () => targets }),
  });
  await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0]);
  targets = []; pages = [];
  await runtime.listTabRows();
  assert.deepEqual(runtime.listNamedPages().map((n) => n.name), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: FAIL — `rows[0].name` is `undefined`; the name was pruned on reconnect.

- [ ] **Step 3: Implement**

Change the map's shape and comment:

```js
  // name → { targetId, page }. Names are keyed by relay target id for the same
  // reason handles are: reconnect replaces every Page object, and a Page-keyed
  // name map deleted every user-assigned name on each idle disconnect. `page`
  // is a cache re-bound on each listing; `targetId` is the identity.
  const namedPages = new Map();
```

`setNamedPage(name, page, targetId = null)` stores `{ targetId, page }`; `renamePageName` moves the whole entry; `forget` is unchanged; `listNamedPages()` returns `{ name, page }` from `entry.page`.

Replace `pruneNamedPages`:

```js
  // Drop a name only when its tab is really gone. A stale `page` after a
  // reconnect is NOT gone — it is re-bound by rebindNamedPages().
  function pruneNamedPages() {
    for (const [name, entry] of namedPages) {
      if (!entry.targetId && !isUsablePage(entry.page)) namedPages.delete(name);
    }
  }

  /** Re-point named entries at the current Page objects; drop names whose target is gone. */
  function rebindNamedPages(identified) {
    const byTargetId = new Map(identified.filter((i) => i.targetId).map((i) => [i.targetId, i.page]));
    const relayKnown = byTargetId.size > 0;
    for (const [name, entry] of namedPages) {
      if (!entry.targetId) continue;
      const page = byTargetId.get(entry.targetId);
      if (page) entry.page = page;
      else if (relayKnown) namedPages.delete(name);
    }
    pruneNamedPages();
  }
```

Replace `nameForPage`:

```js
  function nameForPage(page, targetId = null) {
    for (const [name, entry] of namedPages) {
      if (targetId && entry.targetId === targetId) return name;
      if (entry.page === page) return name;
    }
    return null;
  }
```

In `listIdentifiedPages()`, call `rebindNamedPages(identified)` on the resolved array before returning it. In `listTabRows()`, pass the target id through: `name: nameForPage(page, targetId)`.

At every `setNamedPage` call site (`open --as`, `rename`), pass the target id from the current `listIdentifiedPages()` row so new names are durable from the moment they are created.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mcp/test/browser-session-runtime.test.js && node --test mcp/test/browserforce-command-registry.test.js && node --test test/cli-sessiond.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/browser-session-runtime.js mcp/test/browser-session-runtime.test.js
git commit -m "fix(mcp): key tab names by relay target id so a reconnect stops deleting them"
```

---

### Task 8: `tabs` is capped and filterable

The first `tabs` call against a real Chrome returned 72 rows for ~1,400 tokens. An expensive entry point teaches an agent to avoid the tool, which is the failure this whole plan exists to fix. `COMMAND_SPECS.tabs` (`:40`) declares no flags and `renderTabRowsText` (`:731`) renders every row.

**Files:**
- Modify: `mcp/src/browserforce-command-registry.js:40` (spec), `:673` (arg builder), `:731-739` (renderer)
- Modify: `mcp/src/help-docs.js` (tabs section)
- Test: `mcp/test/browserforce-command-registry.test.js`

**Interfaces:**
- Consumes: `listTabRows()` (Tasks 5-7).
- Produces: `tabs [--all] [--match <text>] [--limit <n>]`; `data.tabs` unchanged in shape, plus `data.omitted: number` and `data.total: number`.

- [ ] **Step 1: Write the failing tests**

```js
test('tabs caps the default listing and says what it omitted', async () => {
  const runtime = fakeRuntimeWithTabs(72);
  const { data, text } = await executeBrowserforceCommand('tabs', { runtime });
  assert.equal(data.tabs.length, 20);
  assert.equal(data.total, 72);
  assert.equal(data.omitted, 52);
  assert.match(text, /52 more/);
  assert.match(text, /--all/);
});

test('tabs --all returns every row with no omission notice', async () => {
  const { data, text } = await executeBrowserforceCommand('tabs --all', { runtime: fakeRuntimeWithTabs(72) });
  assert.equal(data.tabs.length, 72);
  assert.equal(data.omitted, 0);
  assert.doesNotMatch(text, /more/);
});

test('tabs --match filters on title and URL before the cap applies', async () => {
  const { data } = await executeBrowserforceCommand('tabs --match github', { runtime: fakeRuntimeWithTabs(72) });
  assert.ok(data.tabs.every((t) => `${t.title} ${t.url}`.toLowerCase().includes('github')));
});

test('tabs --limit overrides the default cap', async () => {
  const { data } = await executeBrowserforceCommand('tabs --limit 3', { runtime: fakeRuntimeWithTabs(72) });
  assert.equal(data.tabs.length, 3);
  assert.equal(data.omitted, 69);
});
```

`fakeRuntimeWithTabs(n)` returns a runtime stub whose `listTabRows()` resolves to `n` rows, every third one titled `github`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test mcp/test/browserforce-command-registry.test.js`
Expected: FAIL — `--all` rejected as an unknown flag; `data.tabs.length` is 72.

- [ ] **Step 3: Implement**

Spec (`:40`):

```js
  tabs: { flags: { all: 'boolean', match: 'value', limit: 'value' } },
```

Arg builder (`:673`):

```js
    case 'tabs':
      return { all: flags.all === true, match: flags.match, limit: flags.limit };
```

Add near the other constants:

```js
// A first `tabs` call against a real Chrome returned 72 rows (~1,400 tokens).
// An expensive entry point teaches an agent to avoid the tool, so cap by
// default and always say what was omitted and how to see it.
const DEFAULT_TAB_LIST_LIMIT = 20;
```

In the `tabs` executor, filter then cap, and return `{ tabs, total, omitted }`. Renderer:

```js
function renderTabRowsText(rows, { total = rows?.length ?? 0, omitted = 0 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return 'No tabs open.';
  const lines = rows.map((row) => {
    const marker = row.active ? '*' : ' ';
    const name = row.name ? ` (${row.name})` : '';
    return `${marker} ${row.handle}${name} ${row.title || '(untitled)'}\n    ${row.url}`;
  });
  if (omitted > 0) {
    lines.push(`\n${omitted} more of ${total} tabs not shown. Narrow with --match <text>, or list all with --all.`);
  }
  return lines.join('\n');
}
```

Update the `case 'tabs':` render call to pass `data`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/browserforce-command-registry.test.js && node --test test/cli.test.js && node --test test/cli-sessiond.test.js`
Expected: PASS

- [ ] **Step 5: Document**

`mcp/src/help-docs.js` tabs section — add one bullet: `- "tabs" lists the first 20 tabs and reports how many it omitted. Narrow with --match <text>, widen with --limit <n>, or list everything with --all.`

- [ ] **Step 6: Commit**

```bash
git add mcp/src/browserforce-command-registry.js mcp/src/help-docs.js mcp/test/browserforce-command-registry.test.js
git commit -m "feat(mcp): cap and filter the tabs listing so the first call is cheap"
```

---

### Task 9: Unknown `tabs` subcommands are refused, not swallowed

`tabs close t123` silently did nothing and returned a tab listing that still contained the tab — read at the time as a stale render. There is no `close` verb in `COMMAND_SPECS` at all: the string parses as verb `tabs` with args `['close','t123']`, and `case 'tabs': return {}` (`:673`) discards them unexamined. A command surface that reports success while doing nothing is the same class of failure as a handle that names the wrong tab.

`snapshot` (`:685-689`) already throws a usage error on stray positionals. Copy that.

**Files:**
- Modify: `mcp/src/browserforce-command-registry.js:673`
- Test: `mcp/test/browserforce-command-registry.test.js`

**Interfaces:**
- Consumes: existing `usageError()`. Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```js
test('tabs refuses a subcommand it does not have', () => {
  assert.throws(() => parseBrowserforceCommand('tabs close t5'), (err) => {
    assert.equal(err.code, 'COMMAND_USAGE');
    assert.match(err.message, /tabs takes no positional arguments/);
    assert.match(err.suggestion ?? err.message, /close/i);
    return true;
  });
});

test('bare tabs still parses', () => {
  assert.equal(parseBrowserforceCommand('tabs').verb, 'tabs');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mcp/test/browserforce-command-registry.test.js`
Expected: FAIL — no throw; `tabs close t5` parses cleanly.

- [ ] **Step 3: Implement**

```js
    case 'tabs':
      // `tabs close t5` used to parse as verb `tabs` with the arguments
      // discarded: it reported success and closed nothing. There is no close
      // verb — refuse rather than no-op.
      if (args.length > 0) {
        throw usageError(
          `tabs takes no positional arguments (got "${args.join(' ')}"). ` +
          'There is no "tabs close" — close a tab with exec: (await getBrowserforcePageForTab()).close(). ' +
          'Filter the listing with --match <text>, --limit <n> or --all.'
        );
      }
      return { all: flags.all === true, match: flags.match, limit: flags.limit };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mcp/test/browserforce-command-registry.test.js`
Expected: PASS

- [ ] **Step 5: Verify the original symptom is gone (manual, throwaway tabs)**

With the relay up, open two scratch tabs, run `browserforce "tabs close t1"`, and confirm it now errors instead of returning a listing. Confirm the tab count is unchanged.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/browserforce-command-registry.js mcp/test/browserforce-command-registry.test.js
git commit -m "fix(mcp): refuse unknown tabs subcommands instead of silently discarding them"
```

---

### Task 10: One probe, four answers, each naming its fix

The goal is that nobody installing BrowserForce has to wonder whether it is working. `ensureRelay()` already restarts a down relay, so the remaining states an agent can actually hit are narrower than the brief assumed — but they still arrive as one undifferentiated failure. `assertExtensionConnected` (`mcp/src/exec-engine.js:110-131`) names a fix for an unreachable relay and names none for a disconnected extension.

Four states, four messages:

| State | Message must say |
|---|---|
| Relay unreachable after auto-start | auto-start failed; run `browserforce serve` and check the port |
| Relay up, extension not connected | open Chrome; enable the BrowserForce extension at `chrome://extensions` |
| Relay up, extension connected, no tabs | open a tab in Chrome |
| Ready | nothing — proceed |

**Files:**
- Modify: `mcp/src/exec-engine.js:110-131`
- Modify: `mcp/src/doctor.js` (extension check detail, `:117-122`)
- Test: `mcp/test/mcp-tools.test.js`, `test/doctor.test.js`

**Interfaces:**
- Consumes: existing `getExtensionStatus()` shape `{ connected, attachedTabs }`.
- Produces: `assertExtensionConnected` throws `BrowserForceMcpError` with `code` in `RELAY_UNREACHABLE` / `EXTENSION_DISCONNECTED` / `NO_TABS`.

- [ ] **Step 1: Write the failing tests**

```js
test('each unready state names its own fix', async () => {
  await assert.rejects(
    () => assertExtensionConnected({ getStatus: async () => { throw new Error('ECONNREFUSED'); } }),
    (e) => { assert.equal(e.code, 'RELAY_UNREACHABLE'); assert.match(e.message, /browserforce serve/); return true; },
  );
  await assert.rejects(
    () => assertExtensionConnected({ getStatus: async () => ({ connected: false }) }),
    (e) => { assert.equal(e.code, 'EXTENSION_DISCONNECTED'); assert.match(e.message, /chrome:\/\/extensions/); return true; },
  );
  await assert.rejects(
    () => assertExtensionConnected({ getStatus: async () => ({ connected: true, attachedTabs: [] }) }),
    (e) => { assert.equal(e.code, 'NO_TABS'); assert.match(e.message, /open a tab/i); return true; },
  );
  assert.ok(await assertExtensionConnected({ getStatus: async () => ({ connected: true, attachedTabs: [{}] }) }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mcp/test/mcp-tools.test.js`
Expected: FAIL — no `code` on the thrown errors; the connected-but-empty case resolves.

- [ ] **Step 3: Implement**

```js
export async function assertExtensionConnected({
  baseUrl = getRelayHttpUrl(),
  timeoutMs = 2000,
  getStatus = null,
} = {}) {
  // Four distinct states, four fixes. They used to arrive as one failure, and
  // an agent that cannot tell "not installed" from "Chrome is closed" reports
  // no browser available and skips the work.
  const resolvedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  const probe = getStatus || (() => getExtensionStatus({ baseUrl: resolvedBaseUrl, timeoutMs }));

  let status;
  try {
    status = await probe();
  } catch (err) {
    throw new BrowserForceMcpError(
      `BrowserForce relay is not reachable at ${resolvedBaseUrl} and did not auto-start. ` +
      `Start it with \`browserforce serve\`, then check nothing else holds the port (${err.message}).`,
      { code: 'RELAY_UNREACHABLE', details: { baseUrl: resolvedBaseUrl } },
    );
  }

  if (!status?.connected) {
    throw new BrowserForceMcpError(
      'BrowserForce relay is up but the Chrome extension is not connected. ' +
      'Open Chrome, then enable the BrowserForce extension at chrome://extensions.',
      { code: 'EXTENSION_DISCONNECTED', details: { baseUrl: resolvedBaseUrl } },
    );
  }

  if (Array.isArray(status.attachedTabs) && status.attachedTabs.length === 0) {
    throw new BrowserForceMcpError(
      'BrowserForce is connected but Chrome has no tabs to work with. Open a tab and retry.',
      { code: 'NO_TABS', details: { baseUrl: resolvedBaseUrl } },
    );
  }

  return status;
}
```

Mirror the extension check's detail in `mcp/src/doctor.js` so `doctor` and the agent-facing error say the same thing:

```js
    checks.push(check('extension', 'Chrome extension', FAIL,
      'relay is up but the extension is not connected — open Chrome, then enable the BrowserForce extension at chrome://extensions'));
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mcp/test/mcp-tools.test.js && node --test test/doctor.test.js`
Expected: PASS

- [ ] **Step 5: Check the blast radius**

`rg -n "assertExtensionConnected" -g '*.js' -g '!node_modules' .` — every caller must still handle a thrown error; the type changed from `Error` to `BrowserForceMcpError`, which extends it. Confirm no caller matches on `err.constructor === Error` or on the old message strings.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/exec-engine.js mcp/src/doctor.js mcp/test/mcp-tools.test.js test/doctor.test.js
git commit -m "fix(mcp): give each unready BrowserForce state its own message and fix"
```

---

### Task 11: Record the arc

**Files:**
- Modify: `docs/knowledge/timeline2.md`, `AGENTS.md`, `README.md`

- [ ] **Step 1: Append the timeline entry**

```markdown
## 2026-09-08 — Agent discoverability and durable tab identity

- Rewrote the skill description and the three MCP tool descriptions to claim
  browser work outright and state why a fresh-profile driver cannot substitute:
  agents asked for plain browser work were selecting a hidden competing skill
  and reporting no browser available.
- Added a `browserforce doctor` check that FAILS when a deployed SKILL.md
  differs from the shipped guide. A local copy had forked silently for two
  months, so every text fix reached no agent.
- Keyed tab handles and tab names by relay target id. Playwright rebuilds every
  Page object on the idle reconnect, so the previous Page-keyed maps renumbered
  every handle and deleted every user-assigned name on each reconnect — an
  agent acting on a handle from the previous call silently hit the wrong tab.
- Sourced tab titles from the relay's `/json/list`. `page.title()` cannot
  resolve on a lazily-attached tab, so every row in a real many-tab session
  listed as `(untitled)`.
- Removed `/json` and `/json/list` from wildcard CORS: they serve every tab URL
  and title plus the CDP auth token.
- Capped the default `tabs` listing at 20 with `--all`/`--match`/`--limit` and
  an explicit omission notice; the first call had cost ~1,400 tokens.
- `tabs` now refuses positional arguments. `tabs close <handle>` had parsed as a
  bare listing with the arguments discarded: it reported success and closed
  nothing.
```

- [ ] **Step 2: Add the conventions to `AGENTS.md`**

Under **Critical Patterns**, a new section:

```markdown
### Tab Identity Survives Reconnect

Handles (`t<N>`) and names are keyed by **relay target id**, not by Playwright
`Page` identity. Playwright rebuilds every `Page` object when the idle
disconnect drops the CDP connection, so a `Page`-keyed map renumbers every
handle and deletes every name on each reconnect — and an agent acting on a
stale handle hits the WRONG TAB silently. `mcp/src/tab-identity.js`
(`matchPagesToTargets`) pairs pages to relay targets by URL, positionally
within a duplicate-URL group, since both lists derive from the relay's target
map in insertion order. A page with no matching target falls back to
per-connection page identity — a managed/headless backend has no relay.

Titles come from the relay for the same reason `page.title()` is bounded: on a
lazily-attached tab the relay acks `Runtime.enable` synthetically, no execution
context ever arrives, and the read never settles. Never re-source titles from
`page.title()`.
```

Under **Key Files Quick Reference**, add: `| \`mcp/src/tab-identity.js\` | ~30 | Pure page↔relay-target pairing — the rule handles and names are keyed by |`

- [ ] **Step 3: Full verification**

Run: `pnpm test`
Expected: PASS, all suites. Record any pre-existing failure explicitly rather than folding it into this work.

- [ ] **Step 4: Commit**

```bash
git add docs/knowledge/timeline2.md AGENTS.md README.md
git commit -m "docs: record agent discoverability and durable tab identity"
```

---

## Non-goals

- **Auto-starting Chrome or auto-installing the extension.** `ensureRelay()` covers the relay; the rest needs the user.
- **Making `agent-browser` worse.** It may be the better tool where a clean profile is wanted. This plan argues only that BrowserForce must not lose **by default**.
- **A `tabs close` verb.** Task 9 refuses the string; adding the verb is separate work with its own ownership question (`ownerKey` refusal already exists at the extension boundary).
- **Nested-OOPIF or cross-process target matching.** `matchPagesToTargets` pairs page targets only.

## Residual risk

`matchPagesToTargets` pairs duplicate-URL tabs positionally. Both lists derive from the relay's target map in insertion order, so they agree in practice, but a reordering on either side would mis-pair two tabs that share a URL — swapping their handles, not inventing one. The failure is bounded to tabs whose URL is identical. If that proves wrong in a real session, the escalation is `Target.getTargetInfo` over a per-page CDP session, rejected here because it mints an alias session per page (`relay/src/index.js:1390-1408`) and a 72-tab listing would mint 72.
