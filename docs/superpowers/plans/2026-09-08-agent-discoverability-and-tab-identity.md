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
- Produces: a **new** `readSkillText = defaultReadSkillText` parameter, declared alongside `readText` rather than replacing it — the CDP-sidecar checks still use `readText`, and collapsing the two would break their fixtures' isolation.
- Produces: check id `skill`, statuses `OK`/`FAIL`; `paths.shippedSkillFile: string` and `paths.deployedSkillFiles: string[]`.

- [ ] **Step 1: Write the failing tests**

```js
// test/doctor.test.js
test('doctor fails when a deployed skill has drifted from the shipped one', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readSkillText: (p) => (p.includes('deployed') ? 'stale copy' : 'shipped copy'),
    readRawLock: () => null,
    paths: { ...basePaths, shippedSkillFile: '/repo/shipped/SKILL.md', deployedSkillFiles: ['/home/deployed/SKILL.md'] },
  });
  const skill = checks.find((c) => c.id === 'skill');
  assert.equal(skill.status, 'fail');
  assert.match(skill.detail, /\/home\/deployed\/SKILL\.md/);
  assert.match(skill.detail, /npx -y skills add ivalsaraj\/browserforce/);
});

test('leading whitespace drift is a mismatch, not a pass', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readSkillText: (p) => (p.includes('deployed') ? '\n same' : 'same'),
    readRawLock: () => null,
    paths: { ...basePaths, shippedSkillFile: '/repo/shipped/SKILL.md', deployedSkillFiles: ['/home/deployed/SKILL.md'] },
  });
  assert.equal(checks.find((c) => c.id === 'skill').status, 'fail');
});

test('doctor passes when the deployed skill matches, ignoring trailing whitespace', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readSkillText: (p) => (p.includes('deployed') ? 'same\n\n' : 'same'),
    readRawLock: () => null,
    paths: { ...basePaths, shippedSkillFile: '/repo/shipped/SKILL.md', deployedSkillFiles: ['/home/deployed/SKILL.md'] },
  });
  assert.equal(checks.find((c) => c.id === 'skill').status, 'ok');
});

test('doctor reports no deployed skill without failing', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true }),
    readSkillText: (p) => (p.includes('deployed') ? null : 'shipped copy'),
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

/** Raw read: only trailing whitespace may differ between shipped and deployed. */
function defaultReadSkillText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

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
  // NOT readText: defaultReadText trims BOTH ends (doctor.js:44), so a deployed
  // copy with drifted leading whitespace or frontmatter would compare equal.
  // Only trailing whitespace is tolerated.
  const shippedSkill = readSkillText(paths.shippedSkillFile);
  const deployed = (paths.deployedSkillFiles || [])
    .map((p) => ({ path: p, text: readSkillText(p) }))
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

- [ ] **Step 7: Repair this machine (manual, not committed) — RUN THIS AFTER TASK 12**

Tasks 2, 6, 11 and 12 all edit `skills/browserforce/SKILL.md`. Installing now deploys a copy every later task invalidates, and the Task 13 `doctor` check would then fail on drift this step created. Do the repair once the last skill edit has landed; Task 13 Step 3 re-runs `doctor` to confirm.

The stale copy is `~/.claude/skills/browserforce` → `~/brainvault/skills/browserforce` (July fork). Replace the symlink with a real install from the repo, then confirm:

**This step touches files outside this repository. Back up first, and do not run it without the owner's explicit go-ahead** — `~/brainvault` is a separate git repo holding shared agent guidance, and the fork may contain edits that exist nowhere else.

```bash
# 1. Back up, unconditionally.
cp -R ~/brainvault/skills/browserforce /tmp/browserforce-skill-backup-$(date +%s)

# 2. Diff the fork against the shipped guide and READ it. Port anything worth
#    keeping into skills/browserforce/SKILL.md before going further.
diff ~/brainvault/skills/browserforce/SKILL.md skills/browserforce/SKILL.md

# 3. Replace the symlink with a real install (removes the symlink, not its target).
rm ~/.claude/skills/browserforce
npx -y skills add . --skill browserforce --copy --yes
node bin.js doctor                                    # expect: ✔ skill
```

Removing `~/brainvault/skills/browserforce/` afterwards is **optional and the owner's call**. Doctor now fails loudly on drift either way; deleting it only stops `brainvault-sync` republishing the fork. If the owner declines, nothing in this plan breaks.

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
  assert.match(text, /^name:\s*browserforce\s*$/m, `${sourceLabel} must keep its name`);
  // Strip the surrounding quotes the description now needs (it contains ": ").
  const description = (text.match(/^description:\s*(.+)$/m)?.[1] ?? '').replace(/^"(.*)"$/, '$1');
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
// `index.js` calls main() at import time, so the descriptions cannot be
// imported — they are read from source. The capture must tolerate backslash
// escapes: a naive [^']+ stops at the first escaped apostrophe and silently
// truncates the description under test.
const QUOTED = (name) => new RegExp(`'${name}',\\s*\n\\s*'((?:[^'\\\\]|\\\\.)*)'`);

test('only the browserforce tool claims browser work, so ToolSearch ranking is deterministic', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  const browserforceDesc = src.match(QUOTED('browserforce'))?.[1] ?? '';
  assert.ok(browserforceDesc, 'browserforce description not found');
  for (const term of [/\bbrowser\b/i, /real Chrome/i, /\bweb page\b/i, /\bopen\b/i, /\bclick\b/i, /\bscreenshot\b/i]) {
    assert.match(browserforceDesc, term);
  }

  // The sibling tools must NOT compete for the same query. `help` is registered
  // first (index.js:133) and would otherwise outrank the tool that does the work.
  const helpDesc = src.match(QUOTED('help'))?.[1] ?? '';
  assert.ok(helpDesc, 'help description not found');
  assert.doesNotMatch(helpDesc, /^[^.]*\bbrowser\b/i,
    'help must not open by claiming browser work — it competes with the browserforce tool');
  assert.match(helpDesc, /docs|documentation|reference/i);
  // mcp/test/mcp-tools.test.js:203-204 asserts this exact phrase; keep it.
  assert.match(helpDesc, /No Chrome connection/);

  const execFirstLine = src.match(/const EXECUTE_PROMPT = `([^\n]+)/)?.[1] ?? '';
  assert.match(execFirstLine, /escape hatch/i,
    'exec must present as the escape hatch, not as the browser tool');
  assert.doesNotMatch(execFirstLine, /real Chrome|browser work|web page/i,
    'exec must not claim the browser category — it outranks browserforce in ToolSearch if it does');
});

test('no tool description contains a raw apostrophe that would break single-quoted source', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  for (const name of ['browserforce', 'help']) {
    const desc = src.match(QUOTED(name))?.[1] ?? '';
    assert.doesNotMatch(desc, /\\'/, `${name} description escapes an apostrophe; reword to avoid it`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/browserforce-skill.test.js mcp/test/mcp-tools.test.js`
Expected: FAIL — current description has no `open`/`click`/`fill`/`screenshot`, no fresh-profile contrast; `help` description has no "browser".

- [ ] **Step 3: Rewrite the skill frontmatter**

Replace the `description:` and `read_when:` block only. **Keep `name: browserforce` (line 2)** — dropping it breaks installation and `assertBrowserforceCoreSkill`'s `^name:\s*browserforce$` assertion. And **quote the description**: the plain scalar contains `: ` (in "web-page work: open a page"), which is not a valid YAML plain scalar.

```yaml
name: browserforce
description: "Drive the user's real Chrome — their tabs, their logins, their cookies, their extensions. Use for any browser or web-page work: open a page, click, fill, screenshot, scrape, sign in, verify what a page renders, QA a flow. Other browser tools launch a fresh Chromium and cannot see the user's sessions; this is the user's actual browser."
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

Write all three apostrophe-free. `user's` inside a single-quoted JS literal needs `\'`, and any source-reading test that captures with `[^']+` truncates there.

`mcp/src/index.js:135` (`help`) — documentation first, so it does not compete for "browser":

```js
  'BrowserForce documentation by section: tabs, snapshots, commands, recovery. Reference only. No Chrome connection. First read returns docs; repeats return a receipt unless force:true.',
```

`mcp/src/index.js:161`, first line of `EXECUTE_PROMPT` — escape hatch first:

```js
const EXECUTE_PROMPT = `Escape hatch for the browserforce command tool: run raw Playwright JS when no command can express the task. Prefer the browserforce tool.
```

It must not restate the category. "real Chrome" and "browser work" here make `exec` a direct competitor in `ToolSearch("browser")`, and it registers first (`:161` before `:261`).

`mcp/src/index.js:261` (`browserforce`) — the only one that claims the category:

```js
    'Control the browser: the real Chrome the user already has open, with their tabs, logins, cookies and extensions. Use for any web page work — open a page, click, fill, press, wait, get, snapshot, screenshot, scrape, sign in, check what a page renders. Commands: tabs, use, open, snapshot, click, fill, press, wait, get, eval. Start here; reach for exec only when a command cannot express the task.',
```

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/browserforce-skill.test.js mcp/test/mcp-tools.test.js && pnpm test:skill-install`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add skills/browserforce/SKILL.md mcp/src/index.js test/browserforce-skill-contract.js mcp/test/mcp-tools.test.js
git commit -m "fix(skill,mcp): claim browser work outright so agents pick BrowserForce unprompted"
```

- [ ] **Step 8: Prove both acceptance criteria, separately**

They are different claims and one does not imply the other.

*Skill selection.* No test can prove it. In a **fresh** session with no tool named, give an agent a plain browser task ("open example.com and tell me what the heading says") and record which tool it reaches for. Run it before and after this commit. If you cannot tell the difference, the edit did not work — revisit the description rather than moving on.

*Tool ranking.* In a fresh session run `ToolSearch("browser")` and record the returned order. `mcp__browserforce__browserforce` must come first. `help` is registered earlier (`mcp/src/index.js:133`) and outranked it while its description opened with "browser commands" — which is why Step 5 rewrites `help` to lead with documentation. If `help` or `exec` still ranks first, the sibling descriptions are still competing; fix them, do not weaken the browserforce one.

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

test('duplicate URLs match nothing, even when the counts line up', () => {
  // Fail closed: 2 pages and 2 targets at one URL could be paired positionally,
  // but only if both lists share an order, which is unproven. A swap here is a
  // silent wrong-tab action; renumbering is merely visible.
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank'],
    [{ id: 'T1', url: 'about:blank', title: 'first' }, { id: 'T2', url: 'about:blank', title: 'second' }],
  );
  assert.deepEqual(out, [{ targetId: null, title: '' }, { targetId: null, title: '' }]);
});

test('a page with no matching target yields a null targetId rather than a guess', () => {
  const out = matchPagesToTargets(['https://a.test/'], [{ id: 'T1', url: 'https://other.test/', title: 'X' }]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('an incomplete duplicate group also matches nothing', () => {
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank'],
    [{ id: 'T1', url: 'about:blank', title: 'only' }],
  );
  assert.deepEqual(out, [{ targetId: null, title: '' }, { targetId: null, title: '' }]);
});

test('a unique URL still matches even when another URL is duplicated', () => {
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank', 'https://a.test/'],
    [{ id: 'T1', url: 'about:blank', title: 'x' }, { id: 'T9', url: 'https://a.test/', title: 'A' }],
  );
  assert.deepEqual(out, [
    { targetId: null, title: '' },
    { targetId: null, title: '' },
    { targetId: 'T9', title: 'A' },
  ]);
});

test('ignores targets with no id and tolerates a missing title', () => {
  assert.deepEqual(matchPagesToTargets(['u'], [{ url: 'u', title: 'no id' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 'T1', url: 'u' }]), [{ targetId: 'T1', title: '' }]);
});

test('duplicate target ids make the whole listing ambiguous', () => {
  // Two distinct URLs sharing an id would both resolve to one t<N>, so the
  // handle would select the wrong tab.
  const out = matchPagesToTargets(['https://a.test/', 'https://b.test/'], [
    { id: 'T1', url: 'https://a.test/', title: 'A' },
    { id: 'T1', url: 'https://b.test/', title: 'B' },
  ]);
  assert.deepEqual(out, [{ targetId: null, title: '' }, { targetId: null, title: '' }]);
});

test('a malformed target with no URL makes the whole listing ambiguous', () => {
  const out = matchPagesToTargets(['https://a.test/'], [
    { id: 'T1', url: 'https://a.test/', title: 'good' },
    { id: 'T2', title: 'no url' },
  ]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('a malformed target makes its whole URL group ambiguous', () => {
  const out = matchPagesToTargets(['https://a.test/'], [
    { id: 'T1', url: 'https://a.test/', title: 'good' },
    { url: 'https://a.test/', title: 'no id' },
  ]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('malformed targets and unreadable page URLs never match', () => {
  // A page whose url() threw is recorded as ''. Coercing a target's missing URL
  // to '' too would pair them and hand a real handle to an unrelated target.
  assert.deepEqual(matchPagesToTargets([''], [{ id: 'T1', title: 'x' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets([''], [{ id: 'T1', url: '', title: 'x' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 42, url: 'u', title: 'x' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 'T1', url: 99, title: 'x' }]), [{ targetId: null, title: '' }]);
});

test('empty and non-array inputs return an empty array', () => {
  assert.deepEqual(matchPagesToTargets([], [{ id: 'T1', url: 'u', title: 't' }]), []);
  assert.deepEqual(matchPagesToTargets(undefined, undefined), []);
});

// The safety invariant. Positional pairing inside a duplicate-URL group can, in
// principle, pair the wrong two tabs. This asserts the blast radius: a page can
// only ever be paired with a target that has its EXACT URL, so a mis-pair is
// confined to tabs already showing the same page and can never hand out a
// handle pointing at a different site.
test('a page is never paired with a target of a different URL', () => {
  const pageUrls = ['about:blank', 'https://console.test/prod', 'about:blank', 'https://a.test/'];
  const targets = [
    { id: 'T1', url: 'about:blank', title: 'x' },
    { id: 'T2', url: 'https://console.test/prod', title: 'console' },
    { id: 'T3', url: 'about:blank', title: 'y' },
    { id: 'T4', url: 'https://a.test/', title: 'a' },
  ];
  const byId = new Map(targets.map((t) => [t.id, t.url]));
  matchPagesToTargets(pageUrls, targets).forEach(({ targetId }, i) => {
    if (targetId) assert.equal(byId.get(targetId), pageUrls[i]);
  });
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
 * A URL identifies a tab only when it is UNIQUE on both sides — exactly one
 * page and exactly one target carry it. Everything else matches nothing.
 *
 * No positional tie-breaking. Pairing the k-th duplicate page with the k-th
 * duplicate target would rely on ctx.pages() and the relay target list sharing
 * an insertion order, which is plausible but unproven; if it is ever false, two
 * tabs showing the same page swap handles with no error, which is precisely the
 * wrong-tab action this module exists to prevent. Duplicate-URL tabs therefore
 * fall back to per-connection identity and renumber across a reconnect —
 * visible, honest degradation instead of a silent mis-bind.
 *
 * An unmatched page yields `targetId: null`; the caller falls back to
 * per-connection identity, which is also what a relay-less managed backend gets.
 */
export function matchPagesToTargets(pageUrls, targets) {
  const urls = Array.isArray(pageUrls) ? pageUrls : [];

  // Reject malformed entries instead of coercing them to ''. Coercion let a
  // target with a missing URL collide with a page whose url() read threw (also
  // ''), handing a real handle to an unrelated target — a wrong-tab action.
  // A malformed entry POISONS its URL group rather than being dropped. Dropping
  // it left a valid same-URL sibling looking unique, so a page could take a
  // handle for a tab that may not be the one it is showing.
  const targetsByUrl = new Map();
  const poisonedUrls = new Set();
  const seenIds = new Set();
  let globallyAmbiguous = false;
  for (const target of Array.isArray(targets) ? targets : []) {
    const url = typeof target?.url === 'string' && target.url ? target.url : null;
    const id = typeof target?.id === 'string' && target.id ? target.id : null;
    if (!url || !id) {
      // A malformed entry with no usable URL cannot be scoped to a group, so it
      // could belong to any of them. Global ambiguity beats letting some other
      // group look unique and hand out a handle on a guess.
      if (url) poisonedUrls.add(url); else globallyAmbiguous = true;
      continue;
    }
    if (seenIds.has(id)) { globallyAmbiguous = true; continue; }   // duplicate id
    seenIds.add(id);
    if (!targetsByUrl.has(url)) targetsByUrl.set(url, []);
    targetsByUrl.get(url).push(target);
  }

  // An empty page URL means the read failed; it can never identify a tab.
  const pageIndicesByUrl = new Map();
  urls.forEach((pageUrl, i) => {
    if (typeof pageUrl !== 'string' || !pageUrl) return;
    if (!pageIndicesByUrl.has(pageUrl)) pageIndicesByUrl.set(pageUrl, []);
    pageIndicesByUrl.get(pageUrl).push(i);
  });

  const out = urls.map(() => ({ targetId: null, title: '' }));
  if (globallyAmbiguous) return out;
  for (const [url, indices] of pageIndicesByUrl) {
    if (poisonedUrls.has(url)) continue;   // ambiguous: a malformed sibling exists
    const group = targetsByUrl.get(url);
    // FAIL CLOSED on any duplicate. Pairing the k-th page with the k-th target
    // assumes ctx.pages() and the relay target list share an order; that is
    // plausible but unproven, and if it is ever false two tabs showing the same
    // page swap handles silently — the exact wrong-tab action this module
    // exists to prevent. Only a 1:1 URL identifies a tab.
    if (!group || group.length !== 1 || indices.length !== 1) continue;
    const target = group[0];
    out[indices[0]] = {
      targetId: target.id,
      title: typeof target.title === 'string' ? target.title : '',
    };
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/tab-identity.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5: Register the test file**

In `package.json`, add `node --test mcp/test/tab-identity.test.js` to the `test` chain and the `test:mcp` chain, immediately after `mcp/test/browser-session-runtime.test.js`.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/tab-identity.js mcp/test/tab-identity.test.js package.json
git commit -m "feat(mcp): add pure page-to-relay-target matcher for durable tab identity"
```

---

### Task 4: Take `/json/list` out of wildcard CORS

`relay/src/index.js:80-83` states that introspection endpoints carrying tab URLs and titles must not be readable cross-origin, then lists only `/extension/status` and `/attached-tabs`. **Three** unauthenticated routes embed `webSocketDebuggerUrl` with the CDP auth token and are served with `Access-Control-Allow-Origin: *`:

| Route | Line | Leaks |
|---|---|---|
| `/json/version` | `:431-437` | the CDP auth token — and this is the route `connectOverCDP` fetches |
| `/json/list`, `/json` | `:440-449` | the token on **every** target, plus each tab's URL and title |
| `/restrictions` | `:452-465` | the user's automation settings **and their free-text `instructions`** |
| `/agent-preferences` | `:467-479` | the user's agent preferences |

Any page the user visits can read all of these. A denylist was the wrong shape for this and the route table proves it: `/extension/status` and `/attached-tabs` were exempted deliberately, but four equally sensitive routes added since then were never added, and a fifth will be missed the same way. **Invert it to an allowlist.** Only `/` — a counts-only health check — needs wildcard CORS; everything else is denied by default and a new sensitive route is safe without anyone remembering.

Extension pages keep working: `/extension/status` is already denied and `extension/background.js:1090` fetches it fine, because extension pages carry host permissions and bypass CORS. `extension/options.js:153` reaches `/restrictions` and `/agent-preferences` the same way.

- [ ] **Step 1: Write the failing test**

```js
// Every route whose body can contain the CDP auth token. Driven off one list so
// a new token-bearing route cannot be added without a deliberate decision here.
// Every route that returns a token, tab metadata, or user settings. `/` is the
// only wildcard route, so this list is the inverse of the allowlist and any new
// sensitive route is covered without editing it.
const SENSITIVE_ROUTES = [
  '/json', '/json/list', '/json/version',
  '/extension/status', '/attached-tabs',
  '/restrictions', '/agent-preferences',
];

test('no sensitive route is readable cross-origin', async () => {
  // RelayServer takes a POSITIONAL port (relay/src/index.js:255), and start()
  // rebinds this.port from server.address() — so port 0 is safe once awaited.
  const relay = new RelayServer(0);
  await relay.start({ writeCdpUrl: false });
  try {
    for (const route of SENSITIVE_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, {
        headers: { Origin: 'https://evil.test' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), null,
        `${route} must not send wildcard CORS`);
    }
  } finally {
    relay.stop();
  }
});

test('the health route stays wildcard-readable', async () => {
  const relay = new RelayServer(0);
  await relay.start({ writeCdpUrl: false });
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`, { headers: { Origin: 'https://evil.test' } });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.status, 200);
  } finally {
    relay.stop();
  }
});
```

`relay/test/relay-server.test.js` is CommonJS: `const { RelayServer } = require('../src/index.js');`

- [ ] **Step 2: Run to verify it fails**

Run: `node --test relay/test/relay-server.test.js`
Expected: FAIL — header is `*`.

- [ ] **Step 3: Implement**

Replace the denylist with an allowlist (`:83-87`):

```js
// Allowlist, not a denylist. Routes here are readable by any page the user
// visits, so the default must be "denied": the old denylist exempted
// /extension/status and /attached-tabs, then four sensitive routes were added
// without being listed — /json/version and /json/list embed the CDP auth token
// in webSocketDebuggerUrl, and /restrictions and /agent-preferences return the
// user's settings including their free-text instructions.
// `/` returns counts only. Extension pages are unaffected: they carry host
// permissions and bypass CORS entirely.
const WILDCARD_CORS_PATHS = new Set(['/']);

function shouldAllowWildcardCors(pathname) {
  return WILDCARD_CORS_PATHS.has(pathname);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test relay/test/relay-server.test.js`
Expected: PASS. Then `pnpm test:mcp` — same-origin `fetch` from Node ignores CORS, so nothing else moves.

- [ ] **Step 5: Document**

`README.md:1079` still describes the old wildcard behaviour and would leave a false security contract in the docs — rewrite it to the allowlist. Then add to `AGENTS.md` under **Security Rules**:

```markdown
- Wildcard CORS is an ALLOWLIST (`WILDCARD_CORS_PATHS`), not a denylist. Only
  `/` (counts-only health) is readable cross-origin. Everything else is denied
  by default — the previous denylist silently exempted `/json/version`,
  `/json/list` (both embed the CDP auth token in `webSocketDebuggerUrl`),
  `/restrictions` and `/agent-preferences` (user settings, including free-text
  instructions). Never add a route to the allowlist without establishing that
  its body is safe for any page the user visits to read.
```

- [ ] **Step 6: Commit**

```bash
git add relay/src/index.js relay/test/relay-server.test.js AGENTS.md README.md
git commit -m "fix(relay): make wildcard CORS an allowlist so sensitive routes are denied by default\n\n/json, /json/list and /json/version all embed the CDP auth token in\nwebSocketDebuggerUrl and were wildcard-CORS readable by any page."
```

---

### Task 5: Titles and URLs come from the relay, and stay fresh

Measured against the live 72-tab Chrome: `node bin.js tabs` reported **72 of 72 tabs `(untitled)`**, while `GET /json/list` returned **72/72 with real titles and real URLs and no debugger attached**. `pageTitleBounded` (`:516`) is not the bug — its 1s bound is correct, because on a lazily-attached tab the relay synthetically acks `Runtime.enable`, no execution context ever arrives, and an unbounded `page.title()` never settles. The source is wrong.

A tab list exists so something can choose a tab. Without titles it cannot, and `use <name|text>` has nothing to match against.

**Three defects sit between "the relay has the data" and "the runtime can trust it", all found in review:**

0. **Closed tabs are never reported.** `onTabRemoved` (`extension/background.js:805`) carries the same gate — `if (!attachedTabs.has(tabId)) return;` — so closing a lazily-attached tab never reaches the relay. Its target list, and every row, handle and name derived from it, keeps pointing at a tab that no longer exists until something forces rediscovery. Send `tabDetached` for **every** tab; the relay ignores unknown tab ids (`relay/src/index.js:1178-1181`), so a message about an undiscovered tab is harmless. Keep the `cleanupTab`/`updateBadge` work inside an `if (isAttached)` block.
1. **The relay's cache goes stale.** `extension/background.js:816` opens `onTabUpdated` with `if (!attachedTabs.has(tabId)) return;` — URL and title changes are reported only for *attached* tabs, and attachment is lazy. After a user navigates an unattached tab the relay serves the URL from discovery time. A stale URL does not just show a wrong title: it breaks the match, so that tab silently drops back to a renumbering handle. Fixed at the source; `_handleTabUpdated` (`relay/src/index.js:1177-1181`) already drops updates for tabs it does not know, so widening emission is safe.
2. **Relay identity is not backend-scoped.** `cli/sessiond.js:195` passes `getRelayHttpUrl` unconditionally and *before* `negotiateBackend()` runs. A managed or headless session with a relay running on the same machine would match its own pages against the real Chrome's targets. Gate on the negotiated backend.
3. **A transient fetch failure renumbers every handle.** Returning `[]` on failure means no page matches, every page falls back to per-connection identity, and the next call mints fresh handles — reintroducing the exact defect this arc removes. Remember identity per page and reuse the last good snapshot.

**Files:**
- Modify: `extension/background.js:805` (`onTabRemoved` gate) and `:815-817` (`onTabUpdated` gate)
- Modify: `relay/src/index.js:1184-1185` (same truthiness bug: `if (url)` / `if (title)` → `!== undefined`)
- Test: `relay/test/relay-server.test.js` — the emptied-title regression below
- Modify: `mcp/src/browser-session-runtime.js` — import, `fetchRelayTargets()` + `listIdentifiedPages()` near `listStablePages()` (`:404`), `listTabRows()` (`:531-548`), `resolveTabTarget()` (`:575+`)
- Test: `mcp/test/browser-session-runtime.test.js`, `test/agent/extension-tab-updates.test.js` *(new — register in `package.json` `test` and `test:agent`)*
- **Must update in this task** — both assert the whole row with `deepEqual`, so adding `targetId` fails them:
  - `mcp/test/browser-session-runtime.test.js:514-528` — `assert.deepEqual(rows, [{ handle, index, title, url, active, name }, …])`
  - `mcp/test/browserforce-command-registry.test.js:261-273` — same shape on `data.tabs`
  Add `targetId` to the expected objects (`'T1'` / `null` as the fixture dictates). `mcp/test/browserforce-command-registry.test.js:280` (`deepEqual(verbData, commandData)`) stays green because both surfaces gain the field.

**Interfaces:**
- Consumes: `matchPagesToTargets` (Task 3); existing `getRelayHttpUrl()`, `doFetch` and `backendInfo` (set by sessiond via `setBackendInfo`; left null by MCP, which is always real).
- Produces: `listIdentifiedPages(): Promise<Array<{page, url, targetId, title, handle}>>`, consumed by Tasks 6, 7 and 8. `listTabRows()` rows gain `targetId` — the shipped row literal (`:530-548`) has six fields and no `targetId`, and Task 7 needs it.

- [ ] **Step 1: Write the failing tests**

```js
function makeRelayFetch(targets, { fail = false } = {}) {
  return async (url) => {
    if (fail) throw new Error('relay unreachable');
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

test('rows carry targetId so names and handles can key on it', async () => {
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: makeRelayFetch([{ id: 'T1', url: 'https://a.test/', title: 'A' }]),
  });
  assert.equal((await runtime.listTabRows())[0].targetId, 'T1');
});

test('a managed backend never reads the relay target list, even with a relay running', async () => {
  // NOT "zero fetches": waitForInitialPageDiscovery probes /extension/status on
  // any backend whose getRelayHttpUrl is truthy, and sessiond wires that
  // unconditionally (cli/sessiond.js:195). Assert on the URLs, not a count.
  const urls = [];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/', title: async () => 'Managed' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async (url, ...rest) => { urls.push(String(url)); return makeRelayFetch([{ id: 'T1', url: 'https://a.test/', title: 'Real Chrome' }])(url, ...rest); },
  });
  runtime.setBackendInfo({ backend: 'managed', requestedBackend: 'auto' });
  const [row] = await runtime.listTabRows();
  assert.equal(urls.filter((u) => u.endsWith('/json/list')).length, 0,
    'managed backend must not read the real browser target list');
  assert.equal(row.targetId, null, 'no relay identity on a managed backend');
  assert.equal(row.title, 'Managed', 'titles fall back to the bounded page read');
});

test('the discovery probe is also backend-gated', async () => {
  const urls = [];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/', title: async () => 'M' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({}) }; },
  });
  runtime.setBackendInfo({ backend: 'managed', requestedBackend: 'auto' });
  await runtime.listTabRows();
  assert.deepEqual(urls, [], 'a managed session has no relay to ask about anything');
});

test('a stale snapshot never identifies a page it has not seen before', async () => {
  // The hazard: a tab closes, a new tab opens at the same URL, the relay fetch
  // fails, and the cached target list hands the newcomer the dead tab's id.
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  let fail = false;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async (...a) => (fail ? Promise.reject(new Error('down')) : makeRelayFetch(targets)(...a)),
  });
  await runtime.listTabRows();
  pages[0] = { ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }; // replacement
  fail = true;
  const [row] = await runtime.listTabRows();
  assert.equal(row.targetId, null, 'a page never seen before must not inherit a cached id');
});

test('a transient relay failure keeps identity instead of renumbering', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  let fail = false;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: async (...a) => (fail ? Promise.reject(new Error('boom')) : makeRelayFetch(targets)(...a)),
  });
  const before = await runtime.listTabRows();
  fail = true;
  const during = await runtime.listTabRows();
  assert.deepEqual(during.map((r) => r.handle), before.map((r) => r.handle));
  assert.equal(during[0].targetId, 'T1', 'a known page keeps its target id when the fetch fails');
});
```

```js
// relay/test/relay-server.test.js — the relay half. The predicate test below
// only covers the extension's decision to SEND; this covers the relay applying
// it, which is where the matching truthiness bug lives (:1184-1185).
test('an emptied title is applied, not ignored', async () => {
  const relay = new RelayServer(0);
  await relay.start({ writeCdpUrl: false });
  try {
    // Helpers this file already has: connectWs (:135) and httpGet (:20).
    // connectMockExtension/httpGetJson live in test/cli.test.js — not in scope.
    const ext = await connectWs(`ws://127.0.0.1:${relay.port}/extension`,
      { headers: { Origin: 'chrome-extension://test' } });
    await seedOneTarget(ext, { tabId: 7, url: 'https://a.test/', title: 'Before' });
    ext.send(JSON.stringify({ method: 'tabUpdated', params: { tabId: 7, title: '' } }));
    await sleep(100);
    // httpGet returns { status, body } with body ALREADY parsed
    // (relay-server.test.js:20-30) — do not JSON.parse it again.
    const { body } = await httpGet(`http://127.0.0.1:${relay.port}/json/list`);
    const [entry] = body;
    assert.equal(entry.title, '', 'a cleared title must not leave the old one cached');
    ext.close();
  } finally { relay.stop(); }
});
```

`seedOneTarget(ext, tab)` is a new local helper for this file: await the relay's `listTabs` command, reply `{ tabs: [tab] }` so exactly one target registers, then resolve. Define it beside `connectWs` (`:135`); read the expected reply shape from `relay/src/index.js:1447-1520` when writing it.

```js
// test/agent/extension-tab-updates.test.js — the extension gate, tested the way
// extension logic is tested here: on the pure predicate, not via Chrome APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReportTabUpdate, shouldReportTabRemoval } from '../../extension/tab-update-policy.js';

test('reports url and title changes for tabs that are not attached', () => {
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { url: 'https://a.test/' } }), true);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { title: 'A' } }), true);
});

test('still reports for attached tabs', () => {
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { url: 'https://a.test/' } }), true);
});

test('ignores changes that carry neither url nor title', () => {
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { status: 'loading' } }), false);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: {} }), false);
});

test('closing an unattached tab is still reported', () => {
  // Otherwise the relay keeps serving a target for a tab that is gone, and
  // rows, handles and names built from it point at nothing.
  assert.equal(shouldReportTabRemoval({ isAttached: false }), true);
  assert.equal(shouldReportTabRemoval({ isAttached: true }), true);
});

test('an emptied title or url is still reported', () => {
  // Truthiness checks drop these and the relay keeps serving stale metadata.
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { title: '' } }), true);
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { url: '' } }), true);
});

test('group-only changes are reported for attached tabs only', () => {
  // Group reconciliation is meaningful only where the relay tracks the tab.
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { groupId: 3 } }), true);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { groupId: 3 } }), false);
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

First, the extension. Extract the gate as a pure predicate (the house pattern — `extension/window-affinity.js`, `extension/auto-manage-state.js` — since extension code cannot be unit-tested directly):

```js
// extension/tab-update-policy.js
//
// The relay caches each tab's url/title and serves them from /json/list with no
// debugger attach. That cache is only as fresh as what the extension reports,
// and reporting used to be gated on `attachedTabs.has(tabId)` — but attachment
// is LAZY, so almost no tab qualified. A user navigating an unattached tab left
// the relay serving the discovery-time URL, which breaks page-to-target
// matching and drops that tab back to a renumbering handle.

/** A closed tab is always worth reporting — the relay drops ids it does not know. */
export function shouldReportTabRemoval() {
  return true;
}

/** Report url/title changes for every tab; group changes only where the relay tracks the tab. */
export function shouldReportTabUpdate({ isAttached, changeInfo }) {
  if (!changeInfo) return false;
  // Property PRESENCE, not truthiness: a page that clears its title reports
  // `{ title: '' }`, and a truthiness check would drop it and leave the relay
  // serving the previous title forever.
  if ('url' in changeInfo || 'title' in changeInfo) return true;
  return isAttached === true && changeInfo.groupId !== undefined;
}
```

In `extension/background.js`, import it and replace the opening of `onTabUpdated` (`:815-817`):

```js
function onTabUpdated(tabId, changeInfo) {
  const isAttached = attachedTabs.has(tabId);
  if (!shouldReportTabUpdate({ isAttached, changeInfo })) return;
```

The rest of the function already reads `attachedTabs.get(tabId)` to mutate `entry.targetInfo`; guard that block with `if (isAttached)` and send the `tabUpdated` message unconditionally. `relay/src/index.js:1184-1185` has the matching truthiness bug (`if (url) ... if (title) ...`) — switch both to `!== undefined` in the same commit, or an emptied title never clears. The relay drops updates for tabs it does not know (`relay/src/index.js:1178-1181` returns early on both an unknown `tabId` and an unknown `sessionId`), so a message for an undiscovered tab is harmless.

Extract the backend predicate so both call sites share it, and guard the existing `/extension/status` probe in `waitForInitialPageDiscovery` (`:236`) with it as well as the new fetch:

```js
  /** Relay identity applies only to the real-Chrome backend. Null = MCP = real. */
  function relayBackendActive() {
    return !backendInfo.backend || backendInfo.backend === 'real';
  }
```

Then the runtime. Add beside `listStablePages()`:

```js
  // Last good relay snapshot + per-page identity, so one failed fetch cannot
  // renumber every handle. Returning [] on failure would unmatch every page,
  // fall everything back to per-connection identity, and mint fresh handles on
  // the next call — reintroducing the exact defect this arc removes.
  let lastRelayTargets = null;
  let targetIdByPage = new WeakMap();

  // Connection generation and the identity cache live HERE, not in Task 12,
  // because Task 7 (names) needs both and runs first; Task 12 only consumes
  // them. `connectionGeneration` increments in the `disconnected` handler
  // (:281-286) — a Page from a previous generation is orphaned, not closed, so
  // isClosed() alone can never decide whether a stored page is still live.
  let connectionGeneration = 0;
  let identityCache = { generation: -1, rows: [] };

  /** Live Page for a relay target id, from the last identity refresh. */
  function pageForTargetId(targetId) {
    if (!targetId || identityCache.generation !== connectionGeneration) return null;
    return identityCache.rows.find((r) => r.targetId === targetId)?.page ?? null;
  }

  /**
   * Relay target list: id, url and title for EVERY tab, with no debugger attach.
   *
   * Skipped entirely unless the negotiated backend is real Chrome. sessiond
   * constructs this runtime BEFORE negotiateBackend() and passes getRelayHttpUrl
   * unconditionally (cli/sessiond.js:195), so a managed or headless session on a
   * machine with a relay running would otherwise match its own pages against the
   * real browser's targets. MCP never calls setBackendInfo and is always real,
   * so a null backend means "use the relay".
   */
  async function fetchRelayTargets({ timeoutMs = 1500 } = {}) {
    // Returns { targets, authoritative } and NEVER sets a shared flag. A
    // module-level authority flag read after an await races with the parallel
    // clients Task 12 deliberately enables: a concurrent listing could read
    // another call's flag, treat a stale cached snapshot as authoritative, and
    // assign a closed target to a fresh page — undoing the round-6 fix.
    if (!relayBackendActive()) return { targets: [], authoritative: false };
    const relayHttpUrl = typeof getRelayHttpUrl === 'function' ? getRelayHttpUrl() : null;
    if (!relayHttpUrl) return { targets: [], authoritative: false };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await doFetch(`${relayHttpUrl}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok) {
          const body = await response.json();
          if (Array.isArray(body)) {
            lastRelayTargets = body;
            return { targets: body, authoritative: true };
          }
        }
      } catch { /* retry once, then fall through to the last good snapshot */ }
    }
    return { targets: lastRelayTargets ?? [], authoritative: false };
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
    await ensureBrowser();   // callers may run before any connection exists
    const pages = getPages().filter((page) => isUsablePage(page));
    const urls = pages.map((page) => { try { return page.url() || ''; } catch { return ''; } });
    const { targets, authoritative } = await fetchRelayTargets();
    const identities = matchPagesToTargets(urls, targets);
    return Promise.all(pages.map(async (page, i) => {
      // A page already identified in this connection keeps its target id even if
      // this round's match failed (stale URL, incomplete duplicate group, failed
      // fetch). Identity may only be learned, never silently forgotten.
      const matched = identities[i] ?? { targetId: null, title: '' };
      // A STALE snapshot may only CONFIRM identity for a Page we already knew.
      // Rematching a fresh Page against cached targets lets a replacement tab
      // at the same URL inherit the closed tab's target id — and its handle.
      const knownId = targetIdByPage.get(page) ?? null;
      const targetId = (authoritative ? matched.targetId : null) ?? knownId;
      if (authoritative && matched.targetId) targetIdByPage.set(page, matched.targetId);
      return {
        page,
        url: urls[i],
        targetId,
        // A stale snapshot may not supply a TITLE to a page it never identified
        // either: a replacement tab at the same URL would show the dead tab's
        // title, and could then be selected by it.
        title: (authoritative || knownId) ? (matched.title || '') : await pageTitleBounded(page),
        handle: getStablePageHandle(page, targetId),
      };
    }));
  }
```

A slot can legitimately be stored before its page has ever been listed — a
`state.page` assignment inside an `eval` names a page `listIdentifiedPages` has
not seen, so `targetIdByPage` has nothing, the slot stores `null`, and it cannot
rebind. Adopt the id when identity later discovers that page:

```js
  // Backfill: a slot stored before its page was identified would otherwise keep
  // targetId null forever and lose its tab on the next reconnect.
  function adoptTargetIdsForClientSlots(rows) {
    for (const slot of activePageByClient.values()) {
      if (slot.targetId || !slot.page) continue;
      const match = rows.find((r) => r.page === slot.page);
      if (match?.targetId) slot.targetId = match.targetId;
    }
  }
```

Call it beside `rebindNamedPages`. Its test must assign `state.page` to a page
opened *after* the last listing, so the null-id path is actually exercised;
listing first hides the defect.

`listIdentifiedPages` finishes by caching what it resolved and rebinding from that same local snapshot, never from shared state:

```js
    // Capture the generation BEFORE any await and re-check after. A listing
    // that spans a disconnect resolves old Page objects; publishing them under
    // the NEW generation would let pageForTargetId hand a client slot an
    // orphan, with the generation check itself vouching for it.
    const startedAt = connectionGeneration;      // read at the top of the function
    const rows = await Promise.all(/* … the map above … */);
    if (startedAt !== connectionGeneration) return listIdentifiedPages();  // retry once on the new connection
    identityCache = { generation: connectionGeneration, rows };
    rebindNamedPages(rows, { authoritative, targets });
    adoptTargetIdsForClientSlots(rows);
    return rows;
```

Rewrite the body of `listTabRows()` to consume it:

```js
      // Identity first: resolveActivePage consults client slots, and after a
      // reconnect those rebind only once listIdentifiedPages has run. Resolving
      // first marked the shared tab — or nothing — as active.
      const identified = await listIdentifiedPages();
      const active = resolveActivePage(getContext(), { clientId });
      return identified.map(({ page, handle, title, url, targetId }, index) => ({
        handle,
        index,
        title,
        url,
        targetId,                 // Task 7 keys names on this; the shipped row had six fields
        active: page === active,
        name: nameForPage(page),  // gains a second argument in Task 7
      }));
```

In `resolveTabTarget()`, replace `const stable = listStablePages();` with `const stable = await listIdentifiedPages();` and delete the now-redundant per-row `pageTitleBounded`/`page.url()` block in its `metas` construction — `listIdentifiedPages()` already carries `url` and `title`, so `metas` becomes `const metas = stable;`.

Leave `listStablePages()` in place only if something still calls it; if nothing does, delete it (orphan cleanup — this change made it unused).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/browser-session-runtime.test.js && node --test mcp/test/browserforce-command-registry.test.js`
Expected: PASS

- [ ] **Step 5: Prove it against the live browser**

With the relay up and Chrome connected, compare before and after:

```bash
node bin.js tabs | grep -c '(untitled)'    # baseline measured: 72 of 72
```

Then navigate one unattached tab in Chrome and re-run — its row must show the NEW title, which is what proves the extension gate fix rather than just the read-source change.

- [ ] **Step 6: Commit**

```bash
git add extension/tab-update-policy.js extension/background.js relay/src/index.js \
       relay/test/relay-server.test.js mcp/src/browser-session-runtime.js \
       mcp/test/browser-session-runtime.test.js mcp/test/browserforce-command-registry.test.js \
       test/agent/extension-tab-updates.test.js package.json
git commit -m "fix(mcp,extension): source tab titles from the relay and keep its cache fresh"
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

test('a fallback handle is promoted, not replaced, when the relay recovers', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  let fail = true;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async (...a) => (fail ? Promise.reject(new Error('down')) : makeRelayFetch(targets)(...a)),
  });
  const first = (await runtime.listTabRows())[0].handle;   // fallback handle
  fail = false;
  const second = (await runtime.listTabRows())[0];
  assert.equal(second.handle, first, 'the handle already handed out must not change');
  assert.equal(second.targetId, 'T1');
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
        // PROMOTE an existing fallback handle instead of minting a new number.
        // A failed first fetch gives the page a per-connection handle; allocating
        // a fresh one on recovery would change a handle already handed to an
        // agent and strand the old one.
        handle = stableHandles.get(page) ?? `t${nextStableHandleNumber++}`;
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

In `reset()` (`:734`), clear **every** identity cache, not just the handle map. Leaving any of them means a post-reset fetch failure applies stale identity or titles to a brand-new page graph:

```js
    stableHandles = new WeakMap();
    handlesByTargetId.clear();
    targetIdByPage = new WeakMap();
    lastRelayTargets = null;
    identityCache = { generation: -1, rows: [] };
    nextStableHandleNumber = 1;
```

```js
test('reset drops the cached relay snapshot, so a later failure cannot reuse it', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/', title: async () => 'live' }];
  let fail = false;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async (...a) => (fail ? Promise.reject(new Error('down')) : makeRelayFetch(targets)(...a)),
  });
  await runtime.listTabRows();
  await runtime.reset();
  fail = true;
  const [row] = await runtime.listTabRows();
  assert.equal(row.targetId, null, 'a reset session must not resurrect the pre-reset target list');
  assert.equal(row.handle, 't1', 'numbering restarts');
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: PASS

- [ ] **Step 5: Make the documentation true**

`mcp/src/help-docs.js` tabs section, first bullet — replace the parenthetical with the honest guarantee:

```
- Prefer the command surface for tab work: browserforce "tabs" (t<N> handles, stable for the session — a handle names the same tab across calls and across reconnects), "use <handle|name|text>", "open <url> --as <name>". The rules below cover exec-scope tab work.
```

In `skills/browserforce/SKILL.md`, keep the "Stable handles and names persist for the lifetime of the session." sentence — it is now true — and append: `A handle survives the idle reconnect; it is invalidated only by \`reset\`.`

- [ ] **Step 6: Prove it against real Chrome**

Not through `test/sessiond-real-smoke.mjs`. Its `cli` helper takes an **array** and resolves to `{ code, json, stdout, stderr }`, and more importantly sessiond never passes `idleDisconnectMs` (`cli/sessiond.js:195-201`), so the runtime default of `0` means its browser connection never idles out — a sessiond leg cannot force the reconnect this task is about. Its `idleMs` is a daemon-shutdown timer, a different mechanism.

Use the harness that reproduced the defect. Save as `scripts/repro-tab-handles.mjs` (it must live inside the repo to resolve `playwright-core`):

```js
// Reproduces, then guards, handle durability across the browser idle
// disconnect. Same runtime wiring as mcp/src/index.js with the idle window
// shortened so one run spans a reconnect. Requires the relay up and the
// extension connected; exits 0 with SKIP otherwise.
import { chromium } from 'playwright-core';
import { createBrowserSessionRuntime } from '../mcp/src/browser-session-runtime.js';
import { ensureRelay, getCdpUrl, getRelayHttpUrl, getRelayHttpUrlFromCdpUrl,
         connectOverCdpWithBusyRetry, getExtensionStatus } from '../mcp/src/exec-engine.js';
import { withClientLabel } from '../mcp/src/client-label.js';

const status = await getExtensionStatus().catch(() => null);
if (!status?.connected) { console.log('SKIP: extension not connected'); process.exit(0); }

const runtime = createBrowserSessionRuntime({
  connectBrowser: async () => {
    await ensureRelay();
    const cdpUrl = withClientLabel(await getCdpUrl());
    return connectOverCdpWithBusyRetry({
      connect: (u) => chromium.connectOverCDP(u),
      cdpUrl, baseUrl: getRelayHttpUrlFromCdpUrl(cdpUrl), timeoutMs: 30000,
    });
  },
  getRelayHttpUrl,
  idleDisconnectMs: 2000,
});

const before = await runtime.listTabRows();
if (before.length === 0) { console.error('FAIL: no tabs open — this run proves nothing'); process.exit(1); }
await new Promise((r) => setTimeout(r, 7000));
if (runtime.isConnected()) { console.error('FAIL: no idle disconnect happened; the run proves nothing'); process.exit(1); }
const after = await runtime.listTabRows();

const handles = (rows) => rows.map((r) => r.handle);
const titled = (rows) => rows.filter((r) => r.title).length;
console.log(`before ${handles(before)[0]}..${handles(before).at(-1)} titled=${titled(before)}/${before.length}`);
console.log(`after  ${handles(after)[0]}..${handles(after).at(-1)} titled=${titled(after)}/${after.length}`);

let failed = false;
if (JSON.stringify(handles(before)) !== JSON.stringify(handles(after))) {
  console.error('FAIL: handles renumbered across the reconnect'); failed = true;
}
if (titled(before) === 0) {
  console.error('FAIL: every tab is untitled — the relay title source is not wired'); failed = true;
}
if (titled(after) < titled(before)) {
  console.error(`FAIL: titles lost across the reconnect (${titled(before)} -> ${titled(after)})`); failed = true;
}
if (after.length !== before.length) {
  console.error(`FAIL: row count changed (${before.length} -> ${after.length}); comparison is not like-for-like`); failed = true;
}
process.exit(failed ? 1 : 0);
```

Run: `node scripts/repro-tab-handles.mjs`

Expected **before** this task: `handles renumbered`. Measured on the live 72-tab Chrome while writing this plan:

```
call 1: {"n":72,"first":"t1","last":"t72","untitled":72}
still connected? false
call 2: {"n":72,"first":"t73","last":"t144","untitled":72}
RESULT: handles RENUMBERED: t1..t72 -> t73..t144
```

Expected **after**: identical handle lists and a non-zero titled count. A `SKIP` is not a pass — say so if that is what happened.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/browser-session-runtime.js mcp/test/browser-session-runtime.test.js \
        mcp/src/help-docs.js skills/browserforce/SKILL.md scripts/repro-tab-handles.mjs
git commit -m "fix(mcp): key tab handles by relay target id so they survive the idle reconnect"
```

---

### Task 7: Tab names survive the idle reconnect

Same root cause, second victim, found during verification rather than in the brief. `namedPages` (`:114`) maps name → `Page`. After a reconnect every stored `Page` is stale, `isUsablePage` rejects it and `pruneNamedPages` (`:409-412`) deletes every name. A user who named a tab loses the name with no message.

**The shipped API, read rather than assumed** (an earlier draft invented `listNamedPages` and a third positional argument; neither exists):

| Function | Line | Real signature |
|---|---|---|
| `setNamedPage` | `:446` | `(name, page, { replace = false } = {})` → `{ name, replaced }` |
| `getNamedPage` | `:459` | `(name)` → page or `null` |
| `renamePageName` | `:471` | `(oldName, newName, { replace = false } = {})` → `{ name, replaced }` |
| `forgetPageName` | `:485` | `(name)` → boolean |
| `listPageNames` | `:492` | `()` → `[{ name, page }]` |
| `nameForPage` | `:496` | `(page)` — internal, **not** exported |

Target identity rides in the existing options object as `{ replace, targetId }` — adding a positional argument would silently collide with `{ replace }` at every call site. `listPageNames`'s public shape `{ name, page }` is preserved, so no consumer changes.

**Files:**
- Modify: `mcp/src/browser-session-runtime.js:114`, `:409-412`, `:446-498`
- Modify: `mcp/src/browserforce-command-registry.js:467-496` (`open --as`, `rename`)
- Test: `mcp/test/browser-session-runtime.test.js`, `mcp/test/browserforce-command-registry.test.js`

**Interfaces:**
- Consumes: `listIdentifiedPages()` and row `targetId` (Task 5).
- Produces: `namedPages` becomes `Map<string, { targetId: string|null, page }>`; `setNamedPage(name, page, { replace, targetId })`; `nameForPage(page, targetId = null)`. Every other exported signature and return shape is unchanged.

- [ ] **Step 1: Write the failing tests**

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

  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', row.page ?? pages[0], { targetId: row.targetId });
  browser.fireDisconnected();
  pages = makePages();                        // reconnect: new Page objects, same tab

  const rows = await runtime.listTabRows();
  assert.equal(rows[0].name, 'docs');
  assert.equal(runtime.getNamedPage('docs'), pages[0], 'the name must re-bind to the live page');
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs']);
});

test('a name is dropped only when an authoritative listing no longer has its target', async () => {
  let targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  let pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: async () => ({ ok: true, json: async () => targets }),
  });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });

  targets = []; pages = [];                   // the tab really closed
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), []);
});

test('a name survives when its tab is present but unmatched', async () => {
  // Two tabs share a URL, so the matcher fails closed and neither is
  // identified — but both are in /json/list, so neither name is gone.
  let targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async () => ({ ok: true, json: async () => targets }),
  });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });

  // Same tab, now duplicated -> matcher fails closed, target still present.
  targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }, { id: 'T2', url: 'https://a.test/', title: 'A2' }];
  pages.push({ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' });
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs'],
    'unmatched is not the same as gone');
});

test('a failed relay fetch never deletes a name', async () => {
  const targets = [{ id: 'T1', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  let fail = false;
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://127.0.0.1:19222',
    fetch: async (...a) => (fail ? Promise.reject(new Error('boom')) : makeRelayFetch(targets)(...a)),
  });
  const [row] = await runtime.listTabRows();
  runtime.setNamedPage('docs', pages[0], { targetId: row.targetId });
  fail = true;
  await runtime.listTabRows();
  assert.deepEqual(runtime.listPageNames().map((n) => n.name), ['docs'],
    'an unreachable relay is not evidence that a tab closed');
});

test('setNamedPage still honours { replace } and rejects a conflict without it', async () => {
  const pages = [
    { ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' },
    { ...makeFakePage(), isClosed: () => false, url: () => 'https://b.test/' },
  ];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => '',
    fetch: async () => { throw new Error('no relay'); },
  });
  runtime.setNamedPage('docs', pages[0]);
  assert.throws(() => runtime.setNamedPage('docs', pages[1]), /docs/);
  assert.deepEqual(runtime.setNamedPage('docs', pages[1], { replace: true }), { name: 'docs', replaced: true });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: FAIL — `rows[0].name` is `undefined` after the reconnect; the name was pruned.

- [ ] **Step 3: Implement**

State (`:114`):

```js
  // name → { targetId, page }. Names key on relay target id for the same reason
  // handles do: reconnect replaces every Page object, and a Page-keyed name map
  // deleted every user-assigned name on each idle disconnect. `page` is a cache
  // re-bound on each listing; `targetId` is the identity.
  const namedPages = new Map();
```

Make the relay listing's authority explicit — `byTargetId.size > 0` cannot tell a successful empty listing from a failed fetch, and both delete-every-name and delete-nothing are wrong answers to the other case. Add beside `lastRelayTargets`:

```js
```

`fetchRelayTargets` returns it per call; `listIdentifiedPages` passes it to `rebindNamedPages` with the rows, then caches `{ generation: connectionGeneration, rows }` in `identityCache`. Nothing stores authority at module scope.

**Evict handles for targets that are gone.** The relay synthesizes `bf-target-${tabId}` when the extension has no real CDP target id (`relay/src/index.js:1481`, and `extension/background.js:492` uses `tab-${tabId}`), and **Chrome reuses tab ids** — so a closed-then-reopened tab can present the same synthesized id and inherit the previous tab's handle. Task 5's `onTabRemoved` fix is what makes this fixable: the relay now learns of closes, so a gone target disappears from `/json/list`. On an **authoritative** listing, drop every `handlesByTargetId` entry whose id is absent:

```js
    if (authoritative) {
      const live = new Set(targets.map((t) => t?.id).filter(Boolean));
      for (const id of handlesByTargetId.keys()) if (!live.has(id)) handlesByTargetId.delete(id);
    }
```

Only on an authoritative listing — a failed fetch is not evidence a tab closed.

```js
test('a reopened tab reusing a Chrome tab id does not inherit the old handle', async () => {
  // The relay synthesizes bf-target-<tabId> and Chrome reuses tab ids, so
  // without eviction the new tab silently answers to the closed tab's handle.
  let targets = [{ id: 'bf-target-7', url: 'https://a.test/', title: 'A' }];
  const pages = [{ ...makeFakePage(), isClosed: () => false, url: () => 'https://a.test/' }];
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => makeFakeBrowser({ pages }),
    getContext: () => ({ pages: () => pages, on() {} }),
    getRelayHttpUrl: () => 'http://relay.test',
    fetch: async () => ({ ok: true, json: async () => targets }),
  });
  const before = (await runtime.listTabRows())[0].handle;
  targets = []; pages.length = 0;                       // tab closed, relay says so
  await runtime.listTabRows();
  targets = [{ id: 'bf-target-7', url: 'https://b.test/', title: 'B' }];   // id reused
  pages.push({ ...makeFakePage(), isClosed: () => false, url: () => 'https://b.test/' });
  assert.notEqual((await runtime.listTabRows())[0].handle, before,
    'a different tab must not answer to the closed tab handle');
});
```

Accessors — the options object carries identity:

```js
  function setNamedPage(name, page, { replace = false, targetId = null } = {}) {
    const key = assertValidTabName(name);
    pruneNamedPages();   // kept: a closed no-target page must not block its name
    const existing = namedPages.get(key);
    if (existing && !replace) {
      // TAB_NAME_IN_USE, not a new code: TAB_ERROR_SUGGESTIONS
      // (mcp/src/browserforce-command-registry.js:323-325) maps that one, and an
      // unmapped code loses its structured suggestion.
      throw tabStateError('TAB_NAME_IN_USE', `Tab name "${key}" is already in use. Pass --replace to move it.`);
    }
    namedPages.set(key, { targetId, page, gen: connectionGeneration });
    return { name: key, replaced: Boolean(existing) };
  }

  function getNamedPage(name) {
    const key = String(name ?? '').trim();
    const entry = namedPages.get(key);
    if (!entry) return null;
    // Generation before usability, same reason as client slots: a Page from a
    // dead connection is orphaned, not closed, so isClosed() is false and this
    // would hand back a handle onto a dead CDP session.
    if (entry.gen === connectionGeneration && isUsablePage(entry.page)) return entry.page;
    const rebound = entry.targetId ? pageForTargetId(entry.targetId) : null;
    if (rebound) { entry.page = rebound; entry.gen = connectionGeneration; return rebound; }
    if (!entry.targetId) { namedPages.delete(key); return null; }
    return null; // target-keyed but unresolved: fail closed, keep the name
  }

  function listPageNames() {
    return [...namedPages.entries()].map(([name, entry]) => ({ name, page: entry.page }));
  }

  function nameForPage(page, targetId = null) {
    for (const [name, entry] of namedPages) {
      if (targetId && entry.targetId === targetId) return name;
      if (entry.page === page) return name;
    }
    return null;
  }
```

`renamePageName` moves the whole entry (`namedPages.set(to, namedPages.get(from)); namedPages.delete(from);`) and keeps its `{ name, replaced }` return. `forgetPageName` is unchanged.

Pruning and re-binding:

```js
  // Drop a name only when its tab is really gone. A stale `page` after a
  // reconnect is NOT gone — rebindNamedPages() re-points it.
  function pruneNamedPages() {
    for (const [name, entry] of namedPages) {
      if (!entry.targetId && !isUsablePage(entry.page)) namedPages.delete(name);
    }
  }

  /**
   * Re-point named entries at the current Page objects.
   *
   * A target-keyed name is deleted ONLY when the relay listing is authoritative
   * and does not contain its target — an unreachable relay is not evidence that
   * a tab closed, and deleting on a failed fetch silently loses user names.
   */
  function rebindNamedPages(identified, { authoritative, targets }) {
    const byTargetId = new Map(identified.filter((i) => i.targetId).map((i) => [i.targetId, i.page]));
    // Existence comes from the RAW target list, never from `identified`. A tab
    // can be present in /json/list yet unmatched here — its URL changed, or it
    // shares a URL with another tab so the matcher failed closed. Treating
    // "unmatched" as "gone" deletes a name for a tab that is plainly still open.
    // The LOCAL snapshot, not lastRelayTargets: a concurrent listing can
    // overwrite the shared one between this call's fetch and this line, and a
    // live name would be deleted on another client's result.
    const liveTargetIds = new Set(
      (targets ?? []).map((t) => t?.id).filter((id) => typeof id === 'string' && id),
    );
    for (const [name, entry] of namedPages) {
      if (!entry.targetId) continue;
      const page = byTargetId.get(entry.targetId);
      if (page) { entry.page = page; entry.gen = connectionGeneration; continue; }
      if (authoritative && !liveTargetIds.has(entry.targetId)) namedPages.delete(name);
    }
    pruneNamedPages();
  }
```

`listIdentifiedPages()` calls `rebindNamedPages(rows, { authoritative, targets })` on its own local snapshot before returning; `listTabRows()` passes the id through as `name: nameForPage(page, targetId)`.

- [ ] **Step 4: Refresh identity around name lookups AND after page creation**

Two distinct problems in `open --as` (`mcp/src/browserforce-command-registry.js:445-489`), and they need opposite fixes:

1. **The conflict check runs too early against stale entries.** Order today is: validate name (`:465`) → `getNamedPage(name)` conflict check (`:466-479`) → `openNewPage()` (`:482`) → `setNamedPage` (`:483`) → `activeTabRow()` (`:484`, the only listing). Straight after a reconnect the conflict check consults un-rebound entries. Fix: `await runtime.listIdentifiedPages()` **before** the conflict check. It calls `ensureBrowser()` first (Task 5), so a first named `open` on a fresh runtime connects instead of failing with "Not connected".
2. **A brand-new page has no target id yet.** `openNewPage()` returns a Playwright `Page` and nothing else (`mcp/src/browser-session-runtime.js:646-672`), so at `:483` there is no id to store and the name would be page-keyed — lost on the next reconnect, which is the whole defect. Fix: list **after** creation to learn the new page's `targetId`, set the name, then list **again** for the row that is returned. Merely moving the existing `activeTabRow()` above `setNamedPage` is not enough — the returned row would be built before the name exists, so `data.tab.name` comes back `null` and the CLI assertions reading it fail:

```js
    const page = await runtime.openNewPage({ url, timeout });
    const created = (await runtime.listIdentifiedPages()).find((i) => i.page === page);
    if (name) runtime.setNamedPage(name, page, { replace, targetId: created?.targetId ?? null });
    const active = await activeTabRow(runtime);   // re-listed, so the row carries the new name
    return { opened: url, tab: active };
```

Apply the same before-lookup refresh to `rename`. Export `listIdentifiedPages` from the runtime.

```js
test('open --as after a reconnect still detects a name conflict', async () => {
  const { runtime, run, pages } = tabRuntimeEnv({ pages: [fakePage({ url: 'https://a.test/' })] });
  await run('open https://a.test/ --as docs');
  runtime.__fireDisconnect();                      // fixture helper: new Page objects, same tabs
  await assert.rejects(() => run('open https://b.test/ --as docs'), /docs/,
    'the conflict check must run against rebound names, not stale entries');
});

test('open --as records a durable target id for the page it just created', async () => {
  const { runtime, run } = tabRuntimeEnv({ pages: [] });
  await run('open https://a.test/ --as docs');
  const [entry] = runtime.listPageNames();
  assert.equal(entry.name, 'docs');
  const rows = await runtime.listTabRows();
  const named = rows.find((r) => r.name === 'docs');
  assert.ok(named?.targetId, 'a name created by open --as must carry a target id');

  runtime.__fireDisconnect();
  const after = await runtime.listTabRows();
  assert.equal(after.find((r) => r.name === 'docs')?.targetId, named.targetId,
    'the name survives the reconnect it was created before');
});
```

`tabRuntimeEnv({ pages })` and `fakePage({ url, title })` are the existing fixtures at `mcp/test/browserforce-command-registry.test.js:36` and `:53`. Two additions to `tabRuntimeEnv`, both shared by every durability test in this arc:

1. **Serve `/json/list`.** Its injected `fetch` answers `/restrictions` only and returns `{}` for everything else, so `row.targetId` is always `null` and no test can exercise `pageForTargetId` or slot rebinding — they would pass vacuously.

   Three details the obvious recipe gets wrong: `fakePage` keeps no title property, so extend it to hold one; allocate ids from a **per-page WeakMap counter**, never the array index, or every id shifts when a tab closes; and read the **live mutable list** the fixture mutates, not the `pages` argument captured at construction, or pages opened during a test are invisible.

   ```js
   const idFor = new WeakMap();
   let nextTargetId = 1;
   const targetsNow = () => livePages.map((pg) => {
     if (!idFor.has(pg)) idFor.set(pg, `T${nextTargetId++}`);
     return { id: idFor.get(pg), url: pg.url(), title: pg.pageTitle ?? '' };
   });
   ```
2. **`run(command, opts)` must forward `opts`.** The helper is `(command, timeout) => executeBrowserforceCommand({ command, runtime, timeout })` (`:82`); Task 12 calls `run(cmd, { clientId })`, which would silently land in the `timeout` slot. Widen it to take an options object.
3. **`__fireDisconnect()`** fires the fake browser's `disconnected` handler and swaps in fresh page objects carrying the same URLs, leaving the old ones **open but orphaned** — which is what Playwright actually does, and what the generation check above exists to catch.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test mcp/test/browser-session-runtime.test.js && node --test mcp/test/browserforce-command-registry.test.js && node --test test/cli-sessiond.test.js && node --test test/cli.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add mcp/src/browser-session-runtime.js mcp/src/browserforce-command-registry.js \
        mcp/test/browser-session-runtime.test.js mcp/test/browserforce-command-registry.test.js
git commit -m "fix(mcp): key tab names by relay target id so a reconnect stops deleting them"
```

---

### Task 8: `tabs` is capped and filterable

The first `tabs` call against a real Chrome returned 72 rows for ~1,400 tokens. An expensive entry point teaches an agent to avoid the tool, which is the failure this whole plan exists to fix. `COMMAND_SPECS.tabs` (`:40`) declares no flags and `renderTabRowsText` (`:731`) renders every row.

**Files:**
- Modify: `mcp/src/browserforce-command-registry.js:40` (spec), `:673` (`commandToBody`), `:731-739` (renderer), `tabs` executor
- Modify: `bin.js:1054-1060` (`tabs --json` compat path)
- Modify: `mcp/src/help-docs.js` (tabs section)
- Modify: `mcp/test/browserforce-command-registry.test.js:457-468` — the existing 87-tab stress test asserts `data.tabs.length === 87` and goes red under a default cap of 20. Switch it to `run('tabs --all')` and keep every other assertion (unique handles, <2s). Add a second case asserting the *default* caps to 20 and reports `omitted: 67`, so both behaviours stay pinned.
- Test: `mcp/test/browserforce-command-registry.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `listTabRows()` (Tasks 5-7).
- Produces: `tabs [--all] [--match <text>] [--limit <n>]`; `data.tabs` unchanged in shape, plus `data.omitted: number` and `data.total: number`.

- [ ] **Step 1: Write the failing tests**

```js
test('tabs caps the default listing and says what it omitted', async () => {
  const { run } = manyTabsEnv(72);
  const { data, text } = await run('tabs');
  assert.equal(data.tabs.length, 20);
  assert.equal(data.total, 72);
  assert.equal(data.omitted, 52);
  assert.match(text, /52 more/);
  assert.match(text, /--all/);
});

test('tabs --all returns every row with no omission notice', async () => {
  const { data, text } = await manyTabsEnv(72).run('tabs --all');
  assert.equal(data.tabs.length, 72);
  assert.equal(data.omitted, 0);
  assert.doesNotMatch(text, /more/);
});

test('tabs --match filters on title and URL before the cap applies', async () => {
  const { data } = await manyTabsEnv(72).run('tabs --match site-1');
  assert.ok(data.tabs.length > 0);
  assert.ok(data.tabs.every((t) => `${t.title} ${t.url}`.toLowerCase().includes('site-1')));
});

test('tabs --limit overrides the default cap', async () => {
  const { data } = await manyTabsEnv(72).run('tabs --limit 3');
  assert.equal(data.tabs.length, 3);
  assert.equal(data.omitted, 69);
});

test('tabs rejects a non-integer or negative --limit instead of coercing it', async () => {
  // Value flags are stored as RAW STRINGS with no numeric validation
  // (registry :229-249). Passing them to Array.slice() silently coerces:
  // '-1' slices from the end, 'abc' becomes 0 and returns nothing.
  for (const bad of ['abc', '-1', '2.5', '']) {
    await assert.rejects(
      () => manyTabsEnv(5).run(`tabs --limit ${bad}`),
      (err) => { assert.match(err.message, /--limit/); return true; },
    );
  }
});

test('the sessiond direct-verb path validates --limit too', async () => {
  // executeBrowserforceVerb takes a raw body that never passes through
  // commandToBody, so validation there alone would leave this surface coercing.
  const { runtime } = manyTabsEnv(5);
  await assert.rejects(
    () => executeBrowserforceVerb({ verb: 'tabs', body: { limit: 'abc' }, runtime }),
    /--limit/,
  );
});

test('tabs --limit 0 means no cap, matching --all', async () => {
  const { data } = await manyTabsEnv(72).run('tabs --limit 0');
  assert.equal(data.tabs.length, 72);
  assert.equal(data.omitted, 0);
});

test('--all wins over --limit rather than silently disagreeing', async () => {
  const { data } = await manyTabsEnv(72).run('tabs --all --limit 3');
  assert.equal(data.tabs.length, 72);
});

test('the existing 87-tab stress case still returns every row under --all', async () => {
  const { data } = await manyTabsEnv(87).run('tabs --all');
  assert.equal(data.tabs.length, 87);
  assert.equal(new Set(data.tabs.map((t) => t.handle)).size, 87);
});
```

```js
// test/cli-sessiond.test.js — machine clients must learn that rows were
// withheld. There is no runtime-injection seam in the CLI tests; they spawn a
// real subprocess against an in-process relay + mock extension, so extend the
// existing tabs --json case at :660-673 rather than inventing a helper.
test('tabs --json reports total and omitted alongside the rows', async () => {
  const { stdout } = await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env });
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.tabs), 'rows move under .tabs');
  assert.equal(typeof parsed.total, 'number');
  assert.equal(typeof parsed.omitted, 'number');
  assert.equal(parsed.tabs[0].handle, 't1');
});
```

`manyTabsEnv(n)` generalises the existing local fixture at `mcp/test/browserforce-command-registry.test.js:446-455`. **`n` is the TOTAL tab count, so the loop runs `n - 3`** — the fixture splices in three named tabs (`mrr`, `dashOne`, `dashTwo`) afterwards. Parameterising the hard-coded `84` directly would make `manyTabsEnv(72)` yield 75 tabs and every count assertion wrong. It returns `{ ...tabRuntimeEnv({ pages }), … }`, whose `run(command)` is `(command) => executeBrowserforceCommand({ command, runtime })` (`:82`). Note the real signature takes **one object**, not `(command, opts)`. Also `import { commandToBody } from '../src/browserforce-command-registry.js'` — it is exported (`:671`) but not currently imported by that test file.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test mcp/test/browserforce-command-registry.test.js`
Expected: FAIL — `--all` rejected as an unknown flag; `data.tabs.length` is 72.

- [ ] **Step 3: Implement**

Spec (`:40`):

```js
  tabs: { flags: { all: 'boolean', match: 'value', limit: 'value' } },
```

`commandToBody` (`:671`, **not** the parser — see Task 9). Value flags arrive as raw strings with no numeric validation anywhere in the parser (`:229-249`), so validate here rather than letting `Array.slice()` coerce:

```js
    case 'tabs':
      return { all: flags.all === true, match: flags.match, limit: flags.limit };
```

Validation cannot live only in `commandToBody`: sessiond's direct-verb route calls `executeBrowserforceVerb({ verb, body, runtime })` (`:624`) with a raw body that never passes through `commandToBody`, so `{"limit":"abc"}` would still reach `slice()`. Put `parseTabLimit` in the **`tabs` executor**, which both paths share, and have `commandToBody` pass the raw value straight through.

```js
// Value flags are raw strings; `slice(0, '-1')` and `slice(0, 'abc')` both
// silently return the wrong rows rather than failing. 0 means "no cap", which
// is how --limit expresses --all. Called from the executor so the sessiond
// direct-verb path (executeBrowserforceVerb, :624) is covered too.
function parseTabLimit(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(String(raw))) {
    throw usageError(`--limit takes a non-negative whole number (got "${raw}"). Use --limit 0 or --all for every tab.`);
  }
  return Number(raw);
}
```

In the `tabs` executor, call `parseTabLimit(body.limit)` first, then: `--all` (or `limit === 0`) means no cap; otherwise the cap is `limit ?? DEFAULT_TAB_LIST_LIMIT`. Filter by `--match` **before** capping so the cap applies to matches, and return `{ tabs, total, omitted }` where `total` is the post-filter count.

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

Update the `case 'tabs':` render call (`:768`) to pass `data`.

Finally `bin.js:1054-1060`. The compat path unwraps to a bare array, so `total`/`omitted` never reach a machine client:

```js
    if (parsed.verb === 'tabs' && resp && resp.success !== false) {
      output(resp.data?.tabs ?? [], true);
      return;
    }
```

A capped list that cannot say it was capped is the same trap as a handle that cannot say it went stale. Emit the envelope, and keep the rows under `.tabs`:

```js
    // Compat: rows keep the pre-registry shape (index/title/url plus
    // handle/active/name/targetId). They move under `.tabs` so a capped listing
    // can report `total`/`omitted` — a machine client must be able to tell that
    // rows were withheld and how to ask for them.
    if (parsed.verb === 'tabs' && resp && resp.success !== false) {
      const { tabs = [], total = tabs.length, omitted = 0 } = resp.data ?? {};
      output({ tabs, total, omitted }, true);
      return;
    }
```

This changes the `tabs --json` top-level shape from array to object, and the consumers are known — update all of them in this commit:

| File | Lines | What breaks |
|---|---|---|
| `test/cli-sessiond.test.js` | `:665` | `assert.ok(Array.isArray(rows))` — hard fail |
| | `:666-673` | `rows[0]` is `undefined`; every field assertion throws |
| | `:827-833` | `rows.length`, `rows.map` — TypeError |
| | `:836-841`, `:856-857`, `:875-878` | `rows.find` / `rows.filter` — TypeError |
| | `:882`, `:893-894` | `before.length`/`after.length` become `undefined === undefined` — a **silent false pass**, so these must be fixed even though they stay green |
| `README.md` | `:435-437` | says "`tabs --json` prints the rows array directly" |
| `mcp/src/help-docs.js` | `:148` | same claim in the `cli-session` section |

Change each `JSON.parse(...)` to read `.tabs`. `test/cli-sessiond.test.js:661-662` (`viaRun === direct`) survives untouched — it only compares the two surfaces.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/browserforce-command-registry.test.js && node --test test/cli.test.js && node --test test/cli-sessiond.test.js`
Expected: PASS

- [ ] **Step 5: Document**

`mcp/src/help-docs.js` tabs section — add one bullet: `- "tabs" lists the first 20 tabs and reports how many it omitted. Narrow with --match <text>, widen with --limit <n>, or list everything with --all.`

- [ ] **Step 6: Commit**

```bash
git add mcp/src/browserforce-command-registry.js bin.js mcp/src/help-docs.js README.md \
        mcp/test/browserforce-command-registry.test.js test/cli-sessiond.test.js
git commit -m "feat(mcp,cli): cap and filter the tabs listing, and report what was omitted"
```

---

### Task 9: Unknown `tabs` subcommands are refused, not swallowed

`tabs close t123` silently did nothing and returned a tab listing that still contained the tab — read at the time as a stale render. There is no `close` verb in `COMMAND_SPECS` at all: the string parses as verb `tabs` with args `['close','t123']`, and `case 'tabs': return {}` (`:673`) discards them unexamined. A command surface that reports success while doing nothing is the same class of failure as a handle that names the wrong tab.

`snapshot` (`:685-689`) already throws a usage error on stray positionals. Copy that.

**Test the right function.** The `case 'tabs':` at `:673` lives in `commandToBody()` (`:671`), which `parseBrowserforceCommand()` (`:169-253`) never calls — parse tokenizes and returns `{ verb, args, flags, command }`, and `executeBrowserforceCommand` (`:796-805`) calls `commandToBody` as a separate step afterwards. A throw added there does **not** surface from `parseBrowserforceCommand`, so a test asserting that would stay red no matter how correct the fix is. Assert against `commandToBody` directly, and once end-to-end through `executeBrowserforceCommand`.

The generic `HELP_SUGGESTION` (`:31`, "Run browserforce \"help\" to see available commands.") is attached to every usage error and does not mention `close`. This error has to teach the actual next step, so it carries its own message.

**Files:**
- Modify: `mcp/src/browserforce-command-registry.js:673`
- Test: `mcp/test/browserforce-command-registry.test.js`

**Interfaces:**
- Consumes: existing `usageError()`. Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Add `commandToBody` to the file's imports from `../src/browserforce-command-registry.js` — it is exported (`:671`) but not yet imported there.

```js
test('tabs refuses a subcommand it does not have', () => {
  // commandToBody, not parseBrowserforceCommand: parse never calls it.
  const parsed = parseBrowserforceCommand('tabs close t5');
  assert.equal(parsed.verb, 'tabs');
  assert.deepEqual(parsed.args, ['close', 't5'], 'parse still tokenizes; the refusal happens later');

  assert.throws(() => commandToBody(parsed), (err) => {
    assert.match(err.message, /tabs takes no positional arguments/);
    assert.match(err.message, /close/i, 'must name the thing the user actually tried');
    return true;
  });
});

test('the refusal reaches an agent through the real execution path', async () => {
  const { run } = tabRuntimeEnv({ pages: [fakePage({ url: 'https://a.test/' })] });
  await assert.rejects(
    () => run('tabs close t5'),
    (err) => { assert.match(err.message, /tabs takes no positional arguments/); return true; },
  );
});

test('bare tabs and its flags still work', () => {
  assert.equal(parseBrowserforceCommand('tabs').verb, 'tabs');
  assert.deepEqual(commandToBody(parseBrowserforceCommand('tabs')), { all: false, match: undefined, limit: undefined });
  assert.equal(commandToBody(parseBrowserforceCommand('tabs --all')).all, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mcp/test/browserforce-command-registry.test.js`
Expected: FAIL — `commandToBody` returns `{}` and throws nothing. Verified live before writing this task:

```
"tabs close t5"     -> {"verb":"tabs","args":["close","t5"]}
"tabs garbage here" -> {"verb":"tabs","args":["garbage","here"]}
```

- [ ] **Step 3: Implement**

```js
    case 'tabs':
      // `tabs close t5` used to parse as verb `tabs` with the arguments
      // discarded: it reported success and closed nothing. There is no close
      // verb — refuse rather than no-op.
      if (args.length > 0) {
        throw usageError(
          `tabs takes no positional arguments (got "${args.join(' ')}"). ` +
          // No bare getBrowserforcePageForTab(): with no selector it falls back
          // to availableTabs[0], so following this advice closes an arbitrary
          // tab. Point at selection, never hand over a default.
          'There is no "tabs close" verb. Select the tab first (use <handle>), then close it from exec. ' +
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

`ensureRelay()` already restarts a down relay, so the states an agent can actually hit are narrower than the brief assumed — but they still arrive as one undifferentiated failure. `assertExtensionConnected` (`mcp/src/exec-engine.js:110-131`) names a fix for an unreachable relay and names none for a disconnected extension.

**Two constraints found in review, both of which invalidate the obvious implementation.**

1. **`attachedTabs` is empty on a healthy browser.** Targets do not populate until a CDP client sends `Target.setAutoAttach`. Measured on the live machine with 72 tabs open and the extension connected:

   ```
   {"connected":true,"activeTargets":0,"activeManualTargets":0,
    "attachedTabs":[],"manualAttachedTabs":[],"clients":0}
   ```

   A pre-connect `NO_TABS` check on `attachedTabs.length === 0` therefore rejects a perfectly good session. The no-tabs question can only be asked **after** discovery, against the page count the runtime actually sees.

2. **MCP must not be routed through `assertExtensionConnected`.** It is called only from `cli/sessiond.js:63` and `bin.js:110`; MCP's preflight is `preflightAttachedPageBeforeCdp` (`mcp/src/startup.js:74-93`), which uses `getExtensionStatus` + `runPreflightAssertions`. That split is deliberate and pinned: `mcp/test/mcp-tools.test.js:734,743` asserts the MCP connect path does **not** mention `assertExtensionConnected`. So the shared thing is a pure **classifier** both surfaces call — not one surface calling the other's assertion.

**Files:**
- Create: `mcp/src/readiness.js` (pure, no I/O)
- Create: `mcp/test/readiness.test.js` *(register in `package.json` `test` and `test:mcp`)*
- Modify: `mcp/src/exec-engine.js:110-131` (`assertExtensionConnected` → classifier)
- Modify: `mcp/src/startup.js:92-93` (same messages on the MCP side)
- Modify: `mcp/src/doctor.js:117-122` (extension check detail)
- Modify: `mcp/src/browser-session-runtime.js` — raise `NO_TABS` after discovery, where the page count is known

**Interfaces:**
- Produces: `classifyReadiness({ statusError, status, discoveredPageCount }) → { code, message }` with `code` in `READY | RELAY_UNREACHABLE | EXTENSION_DISCONNECTED | NO_TABS`. `discoveredPageCount` is optional; **omit it pre-connect** and `NO_TABS` can never fire.

- [ ] **Step 1: Write the failing tests**

```js
// mcp/test/readiness.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadiness } from '../src/readiness.js';

test('an unreachable relay names the command that starts it', () => {
  const { code, message } = classifyReadiness({ statusError: new Error('ECONNREFUSED') });
  assert.equal(code, 'RELAY_UNREACHABLE');
  assert.match(message, /browserforce serve/);
});

test('a disconnected extension names Chrome and the extensions page', () => {
  const { code, message } = classifyReadiness({ status: { connected: false } });
  assert.equal(code, 'EXTENSION_DISCONNECTED');
  assert.match(message, /chrome:\/\/extensions/);
  assert.match(message, /open Chrome/i);
});

test('a malformed status is not READY', () => {
  // { connected: "false" } is truthy; a loose check would start CDP against a
  // relay that never confirmed the extension.
  for (const bad of ['false', 0, null, undefined, {}]) {
    assert.equal(classifyReadiness({ status: { connected: bad } }).code, 'EXTENSION_DISCONNECTED');
  }
  assert.equal(classifyReadiness({ status: {} }).code, 'EXTENSION_DISCONNECTED');
});

test('the wording keeps the substrings existing tests match on', () => {
  // mcp/test/exec-engine-plugins.test.js:1820 and :1848 assert these.
  assert.match(classifyReadiness({ statusError: new Error('x') }).message, /Cannot reach BrowserForce relay/i);
  assert.match(classifyReadiness({ status: { connected: false } }).message, /extension is not connected/i);
});

test('a connected extension with no attached tabs is READY before discovery', () => {
  // Measured live: 72 real tabs, connected:true, attachedTabs:[] — targets do
  // not populate until Target.setAutoAttach. A pre-connect no-tabs check here
  // would reject a healthy browser.
  assert.equal(classifyReadiness({ status: { connected: true, attachedTabs: [] } }).code, 'READY');
});

test('NO_TABS fires only on a post-discovery page count of zero', () => {
  const { code, message } = classifyReadiness({
    status: { connected: true, attachedTabs: [] }, discoveredPageCount: 0,
  });
  assert.equal(code, 'NO_TABS');
  assert.match(message, /open a tab/i);
  assert.equal(classifyReadiness({ status: { connected: true }, discoveredPageCount: 3 }).code, 'READY');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mcp/test/readiness.test.js`
Expected: FAIL — `Cannot find module '../src/readiness.js'`

- [ ] **Step 3: Implement the classifier**

```js
// mcp/src/readiness.js — pure classification of BrowserForce readiness.
//
// Four states used to arrive as one failure, and an agent that cannot tell
// "not installed" from "Chrome is closed" reports no browser available and
// skips the work. Kept pure and I/O-free so both callers share one wording:
// the CLI assertion (exec-engine) and the MCP preflight (startup), which are
// deliberately separate code paths — see mcp/test/mcp-tools.test.js:734.

export const READY = 'READY';
export const RELAY_UNREACHABLE = 'RELAY_UNREACHABLE';
export const EXTENSION_DISCONNECTED = 'EXTENSION_DISCONNECTED';
export const NO_TABS = 'NO_TABS';

/**
 * @param statusError    error thrown while reading /extension/status, if any
 * @param status         the /extension/status body, if it was read
 * @param discoveredPageCount  pages the CDP client can see. OMIT pre-connect:
 *   `attachedTabs` is empty on a healthy browser until Target.setAutoAttach, so
 *   asking the no-tabs question before discovery rejects working sessions.
 */
export function classifyReadiness({ statusError = null, status = null, discoveredPageCount } = {}) {
  if (statusError) {
    return {
      code: RELAY_UNREACHABLE,
      message: 'Cannot reach BrowserForce relay — it is not reachable and did not auto-start. '
        + `Start it with \`browserforce serve\`, then check nothing else holds the port (${statusError.message}).`,
      // Keeps the substring mcp/test/exec-engine-plugins.test.js:1848 matches.
    };
  }
  // Strict equality: a malformed body such as { connected: "false" } is truthy
  // and would classify a broken relay as READY, permitting CDP startup.
  if (status?.connected !== true) {
    return {
      code: EXTENSION_DISCONNECTED,
      // Keeps the substring mcp/test/exec-engine-plugins.test.js:1820 matches.
      message: 'BrowserForce relay is up but the Chrome extension is not connected to it. '
        + 'Open Chrome, then enable the BrowserForce extension at chrome://extensions.',
    };
  }
  if (discoveredPageCount === 0) {
    return { code: NO_TABS, message: 'BrowserForce is connected but Chrome has no tabs. Open a tab and retry.' };
  }
  return { code: READY, message: '' };
}
```

- [ ] **Step 4: Use it on both surfaces**

In `assertExtensionConnected`, replace the two inline messages with `classifyReadiness({ statusError })` / `classifyReadiness({ status })` and throw `BrowserForceMcpError(message, { code })`. Do **not** pass `discoveredPageCount` — this runs pre-connect.

In `mcp/src/startup.js:78-93`, wrap **both** `ensureRelay()` (`:78`) and `getExtensionStatus()` (`:92`) in the try/catch and run the same classifier. `ensureRelay()` is the auto-start; if it throws, that IS the `RELAY_UNREACHABLE` case and leaving it outside the catch means the one state with an actionable fix escapes as a raw error.

- [ ] **Step 5: Raise `NO_TABS` where it can actually surface**

Not inside `ensureBrowser()`. Its context block ends in a bare `catch { /* context not ready yet */ }` (`mcp/src/browser-session-runtime.js:288-299`) that swallows everything thrown after `waitForInitialPageDiscovery` — a `NO_TABS` thrown there vanishes silently. Moving it outside that catch is worse: `openNewPage()` also calls `ensureBrowser()`, and an empty browser is exactly when opening the first tab must succeed.

So raise it at the **inspect** entry points, not the connect path. But `tabs` and `use` are not the only ones: `snapshot`, `get`, `click`, `fill`, `press`, `wait` and `hover` without `--tab` never call `resolveTabTarget` — they go straight to `runCommand()` and fail with a generic "No active page". Gate every inspect path, and shape the code once in `runCommand()` so all of them report the same fix:

```js
  // Only inspect paths care: openNewPage() is how an empty browser gets its
  // first tab, so it must never be gated on there being one.
  function assertPagesAvailable() {
    if (getPages().filter(isUsablePage).length === 0) {
      throw tabStateError('NO_TABS', 'BrowserForce is connected but Chrome has no tabs. Open a tab and retry.');
    }
  }
```

Call it from `listTabRows()`, `resolveTabTarget()`, and at the top of `runCommand()` for every verb except `open` — `open` is how an empty browser gets its first tab. A single check in `runCommand()` covers the whole atomic-verb surface (CLI, sessiond and MCP all route through it), so no verb can be added later that silently misses the gate.

```js
test('every inspect verb reports NO_TABS, not "no active page"', async () => {
  const { run } = tabRuntimeEnv({ pages: [] });
  for (const cmd of ['tabs', 'snapshot', 'get url', 'click @e1', 'use t1']) {
    await assert.rejects(() => run(cmd), (err) => {
      assert.equal(err.code, 'NO_TABS', `${cmd} must classify as NO_TABS`);
      assert.match(err.message, /open a tab/i);
      assert.equal(err.resetHintAllowed, false, 'a missing tab is not a connection failure');
      return true;
    });
  }
});

test('open still works on an empty browser', async () => {
  const { run } = tabRuntimeEnv({ pages: [] });
  await assert.doesNotReject(() => run('open https://a.test/'));
});
```

Propagation needs no new import — `tabStateError` (`:118`) attaches a stable `code` and the registry maps runtime codes to agent-facing `BrowserforceCommandError` suggestions — but adding `NO_TABS` to `TAB_ERROR_SUGGESTIONS` is **not sufficient**. `wrapTabStateError` is applied on specific paths (`mcp/src/browserforce-command-registry.js:402-418`); the `tabs` executor returns a plain error, and other inspect verbs fall through to the generic wrapper at `:432-434` and become `COMMAND_FAILED`, losing both the code and `resetHintAllowed: false`.

So: add `NO_TABS` to the map with `resetHintAllowed: false` — a missing tab is not a connection failure and must never draw a reset hint — **and** route every runtime tab-state error through `wrapTabStateError` before the generic wrapper, including the `tabs` executor. The test below iterates the verbs precisely to catch a path that skips it.

- [ ] **Step 6: Give doctor a page-count probe**

`runDoctor` cannot currently tell "connected, zero tabs" from "healthy" — it never asks for a page list, so the four-state live proof in the next step is impossible and a zero-tab user gets a clean bill of health. Add an injectable probe alongside `probeExtensionStatus`:

A bare `/json/list` read is wrong here: the relay populates `targets` only after a CDP client sends `Target.setAutoAttach`, and standalone `browserforce doctor` never connects one — measured on a healthy 72-tab browser, `/extension/status` reported `activeTargets: 0`. A `/json/list` probe would therefore report `NO_TABS` on a perfectly good session, which is the same bug this task removes elsewhere.

Use the extension-backed count, and report **unknown** rather than guessing when discovery has not happened:

```js
  // Returns a number, or null when nothing has triggered target discovery yet.
  // null => report "cannot determine", never "no tabs".
  // { discovered, count }. Collapsing "not discovered" and "discovered, zero
  // tabs" into one value makes the promised no-tabs state unreachable — the
  // opposite failure from reporting it wrongly.
  // Derived from the status ALREADY fetched at the top of runDoctor — calling
  // probeExtensionStatus() a second time throws in the relay-down state, which
  // is precisely when doctor must still produce a report.
  deriveTabState = (status) => {
    if (!Array.isArray(status?.attachedTabs)) return { discovered: false, count: 0 };
    // Strict: a malformed body reads as "unknown", never as a healthy zero.
    // Number('') is 0 and Number('3abc') is NaN, and a garbage array member
    // must not be counted as a tab.
    const tabs = status.attachedTabs;
    // Integer tabId, not merely present: null, '' and 'abc' all pass a
    // !== undefined check and would classify a malformed status as healthy.
    const wellFormed = tabs.every((t) => t && typeof t === 'object' && Number.isInteger(t.tabId));
    const active = status.activeTargets;
    if (!wellFormed || (active !== undefined && !Number.isInteger(active))) {
      return { discovered: false, count: 0 };  // malformed => unknown, never healthy-zero
    }
    // The relay derives activeTargets from the SAME target list
    // (relay/src/index.js:772-780), so { activeTargets: 3, attachedTabs: [] } is
    // impossible — treat a disagreement as malformed, not as zero tabs.
    if (Number.isInteger(active) && active !== tabs.length) return { discovered: false, count: 0 };
    // Discovery cannot be inferred from a zero count: activeTargets is 0 both
    // before Target.setAutoAttach and on a genuinely empty browser, so
    // `discovered` is true only on positive evidence.
    return { discovered: tabs.length > 0, count: tabs.length };
  },
```

**`doctor` reports the tab count; it does not adjudicate emptiness.** It never connects a CDP client, so it cannot distinguish "no tabs" from "discovery has not run" — `activeTargets` is 0 in both cases. Two rounds of this plan oscillated between inventing a false `NO_TABS` and making the state unreachable; the honest split ends that:

- `doctor` — the `tabs` check reports `N tabs attached` when discovered, else `cannot determine without a connected agent (run any browserforce command)`. It is **never** a `fail`.
- The **agent path** owns `NO_TABS`: `assertPagesAvailable()` runs after `waitForInitialPageDiscovery`, where a zero count is real evidence.

Run the probe only when `relayUp && relayStatus?.connected === true` — strict equality matching the classifier, so a malformed truthy `connected` never reaches it. Every doctor test stays on injected values — the fixtures must never reach the real network.

```js
test('doctor still reports when the relay is down', async () => {
  const { checks, ok } = await runDoctor({
    probeExtensionStatus: async () => { throw new Error('ECONNREFUSED'); },
    readRawLock: () => null, paths: basePaths,
  });
  assert.equal(ok, false);
  assert.equal(checks.find((c) => c.id === 'relay').status, 'fail');
  assert.notEqual(checks.find((c) => c.id === 'tabs')?.status, 'fail',
    'the tab check must not fire, and must not throw, when there is no relay');
});

test('a malformed connected value never reaches the tab check', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: 'false', activeTargets: 3, attachedTabs: [] }),
    readRawLock: () => null, paths: basePaths,
  });
  assert.equal(checks.find((c) => c.id === 'extension').status, 'fail');
  assert.notEqual(checks.find((c) => c.id === 'tabs')?.status, 'fail');
});
```

```js
test('doctor does not claim zero tabs before discovery has run', async () => {
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true, activeTargets: 0, attachedTabs: [] }),
    readRawLock: () => null, paths: basePaths,
  });
  const tabs = checks.find((c) => c.id === 'tabs');
  assert.notEqual(tabs?.status, 'fail');
  assert.match(tabs.detail, /cannot determine|not yet/i);
});

test('doctor never fails the tab check, in any state', async () => {
  // It cannot connect a CDP client, so it has no evidence of emptiness.
  // NO_TABS is the agent path's call, where discovery has actually run.
  for (const status of [
    { connected: true, activeTargets: 0, attachedTabs: [] },
    { connected: true, activeTargets: 2, attachedTabs: [{ tabId: 1 }, { tabId: 2 }] },
  ]) {
    const { checks } = await runDoctor({
      probeExtensionStatus: async () => status, readRawLock: () => null, paths: basePaths,
    });
    assert.notEqual(checks.find((c) => c.id === 'tabs')?.status, 'fail');
  }
});

test('a self-contradictory status reads as unknown, not as zero tabs', async () => {
  // The relay computes activeTargets from the same list, so 3-and-empty cannot
  // occur; treating it as "discovered, zero tabs" would invent a NO_TABS.
  const { checks } = await runDoctor({
    probeExtensionStatus: async () => ({ connected: true, activeTargets: 3, attachedTabs: [] }),
    readRawLock: () => null, paths: basePaths,
  });
  assert.notEqual(checks.find((c) => c.id === 'tabs')?.status, 'fail');
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `node --test mcp/test/readiness.test.js && node --test mcp/test/mcp-tools.test.js && node --test test/doctor.test.js && node --test test/cli-sessiond.test.js && node --test mcp/test/exec-engine-plugins.test.js && node --test mcp/test/browserforce-command-registry.test.js`

`mcp/test/exec-engine-plugins.test.js:1811-1854` asserts the two message substrings this task rewrites; it is in scope and must be run, not assumed.
Expected: PASS — including the existing `assert.doesNotMatch(..., /assertExtensionConnected/)` at `mcp/test/mcp-tools.test.js:734,743`, which this design deliberately preserves.

- [ ] **Step 8: Prove each state on the live machine**

Three via `node bin.js doctor`: relay stopped; relay up with Chrome quit; normal. Each must name its own fix and the healthy case must pass.

The fourth is proven on the **agent path**, where the evidence exists: with Chrome open and every tab closed, `node bin.js snapshot` must report `NO_TABS` naming "open a tab", not a generic no-active-page error. In that same state `doctor` must report the count as undetermined and must **not** fail — it has connected no client, so it has no evidence either way.

- [ ] **Step 9: Commit**

```bash
git add mcp/src/readiness.js mcp/test/readiness.test.js mcp/src/exec-engine.js mcp/src/startup.js \
        mcp/src/doctor.js mcp/src/browser-session-runtime.js \
        mcp/src/browserforce-command-registry.js test/doctor.test.js package.json
git commit -m "fix(mcp): give each unready BrowserForce state its own message and fix"
```

---

### Task 11: A subagent handoff an orchestrator can paste

Orchestrating agents delegate browser work to subagents and must say, in one line, how to do it. BrowserForce has the machinery and no snippet, so it does not get delegated.

A scan of `agent-browser` 0.37.0 (the installed copy is 0.27.0 — ten minor versions stale) found **no subagent handoff surface at all**: zero matches for `sub-?agent|delegat|orchestrat|hand-?off|spawn` across its whole package. What it has instead is deterministic derivation — `session id --scope worktree --prefix <p>` gives orchestrator and subagent the same session name from the worktree they already share — and an explicit doctrine that agents must **avoid** each other's browsers: *"The default (unnamed) session is a single shared browser: it is shared with every other agent on the machine … working in it can hijack another agent's page mid-task"* (`core/SKILL.md:32`).

So the competitive position is the inverse of what it looks like. It has isolation primitives and no sharing protocol. BrowserForce's global daemon makes sharing the **default** — a subagent inherits the parent's logged-in tabs with zero setup, which is the thing orchestrators actually want. That is the advantage to lean into, and it is only an advantage if sharing is safe. Measured on agent-browser: four concurrent clients on one session name produced no lock, no queue, no warning, and last-write-wins on a single active tab. BrowserForce has the same hazard for the same reason, so documenting `--tab` is the minimum, not the finish line.

What already exists, none of it documented where an agent reads:

- `DEFAULT_SESSIOND_LOCK_PATH = ~/.browserforce/sessiond-lock.json` (`cli/session-client.js:18`) is a **single global daemon**. Every invocation on the machine — orchestrator or subagent — already shares one browser session, its active tab, its named tabs and its snapshot refs. A subagent inherits the parent's logged-in tabs with zero setup, which is what `--session` has to be configured to achieve.
- `--tab <target>` pins a page for **that run only** and never mutates the shared active tab — but only on the verbs that declare it: `snapshot, click, hover, fill, type, press, wait, get, eval` (`COMMAND_SPECS:42-51`). `tabs` and `use` declare **no flags at all** and `open` declares only `--as`/`--replace` (`:39-41`), so `--tab` on any of the three throws `UNKNOWN_FLAG`. An instruction saying "pass `--tab` on EVERY command" makes a subagent's first `tabs` call fail.
- `BF_SESSIOND_LOCK_PATH` gives a subagent its own daemon and therefore its own session state.

The hazard the snippet must prevent: two subagents sharing the global daemon **stomp each other's active tab**, because `state.page` is shared. Shared-by-default is the right default and a silent trap for parallel subagents. The instruction must pin every verb that *can* be pinned and forbid the ones that mutate shared state (`use`, `open`, and any `eval` that assigns `state.page`).

**Two claims an earlier draft made that are false, both caught in review:**

- **`BROWSERFORCE_CDP_CLIENT_LABEL` does nothing on the CLI.** `withClientLabel` (`mcp/src/client-label.js:15`) is called from exactly one place: `mcp/src/index.js:67`. `cli/sessiond.js:61-64` connects with the bare URL, so the relay falls back to the ephemeral connection id for affinity keying (`relay/src/index.js:1605-1608`) — which also means **sessiond's window pin dies on every disconnect**, the same class of bug as the handles. Step 5 wires it up rather than documenting a knob that is inert.
- **A separate daemon does not isolate tab access.** `_autoAttachAllTabs` (`relay/src/index.js:1518-1520`) loops over the global `this.targets` unconditionally, and `_broadcastCdp` (`:1892-1902`) sends every target event to every client. There is no per-client filtering anywhere; `ownerKey` governs only which window new tabs land in and refusal of a cross-agent explicit `closeTab`. A second daemon sees, attaches to, and can drive every tab in the browser. The section must claim separate **session state and created-window affinity**, never "cannot touch your tabs".

**Files:**
- Modify: `skills/browserforce/SKILL.md` (new section)
- Modify: `mcp/src/help-docs.js` (new `subagents` section, registered in `HELP_SECTION_NAMES`)
- Modify: `test/browserforce-skill-contract.js`
- Test: `mcp/test/help-docs.test.js`

**Interfaces:**
- Consumes: `HELP_SECTION_NAMES` (drives the `help` tool's `z.enum`, so adding a section widens the MCP schema — verify `mcp/test/mcp-tools.test.js` still passes).
- Produces: help section id `subagents`.

- [ ] **Step 1: Write the failing tests**

```js
// test/browserforce-skill-contract.js — inside assertBrowserforceCoreSkill
assert.match(text, /subagent/i, `${sourceLabel} must tell an orchestrator how to delegate`);
assert.match(text, /--tab/, `${sourceLabel} subagent guidance must require --tab for parallel work`);
assert.match(text, /BF_SESSIOND_LOCK_PATH/, `${sourceLabel} must document the isolation knob`);
```

```js
// mcp/test/help-docs.test.js — HELP_SECTIONS is module-private; the exported
// accessors are listHelpSections() and getHelpSection(name) (help-docs.js:206,
// :222, :233). Import HELP_SECTION_NAMES explicitly.
import { getHelpSection, listHelpSections, HELP_SECTION_NAMES } from '../src/help-docs.js';

test('help exposes a subagents section naming both modes and the shared-tab hazard', () => {
  assert.ok(HELP_SECTION_NAMES.includes('subagents'));
  const text = getHelpSection('subagents');
  assert.match(text, /--tab/);
  assert.match(text, /BF_SESSIOND_LOCK_PATH/);
  assert.match(text, /shared active tab/i);
  assert.ok(listHelpSections().some((sec) => sec.name === 'subagents' && sec.summary));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/browserforce-skill.test.js mcp/test/help-docs.test.js`
Expected: FAIL — no `subagents` section; skill has no subagent guidance.

- [ ] **Step 3: Add the SKILL.md section**

Place it directly after the tabs/handles material so the `--tab` requirement lands with the handle concept:

```markdown
## Handing browser work to a subagent

Subagents share your browser session automatically — one daemon per machine, so
they see your tabs, your logins and your snapshot refs with no setup. Paste one
of these into the subagent's prompt.

**Sequential subagents (default).** They share your active tab:

> Browser: use the `browserforce` CLI. It is already connected to the user's real
> Chrome and shares this session's tabs. Run `browserforce tabs` to see them,
> `browserforce use <handle>` to pick one, then `snapshot` / `click @eN` /
> `fill @eN <text>`.

**Parallel subagents.** They share one active tab, so each must pin its own or
they will overwrite each other mid-run:

> Browser: use the `browserforce` CLI. Your tab is `<handle>`. Pass
> `--tab <handle>` on every command that accepts it — `snapshot`, `click`,
> `fill`, `type`, `press`, `hover`, `wait`, `get`, `eval`. Do NOT run `use` or
> `open`, and do not assign `state.page` in `eval`: those change the active tab
> that other agents are relying on. `tabs` needs no `--tab` and does not accept
> one.

**A subagent that should keep its own session.** Give it its own daemon:

> Browser: use the `browserforce` CLI with `BF_SESSIOND_LOCK_PATH=/tmp/bf-<name>.json`
> and `BROWSERFORCE_CDP_CLIENT_LABEL=<name>` exported. You get your own session
> state and your own Chrome window for tabs you create.

That last one separates session state and where new tabs open. It is **not** a
sandbox: every BrowserForce client can see and drive every tab in the browser.
If a tab must not be touched, do not delegate work that reaches it.

Handles (`t<N>`) are stable for the session, so a handle you pass to a subagent
still names the same tab when it runs.
```

- [ ] **Step 4: Add the help section**

In `mcp/src/help-docs.js`, add a `subagents` entry carrying the same three snippets in the file's existing bullet style, and register `'subagents'` in `HELP_SECTION_NAMES`. Cross-reference rather than restate: the tabs section already owns handle semantics, so link to it (`see help(tabs)`), per the repo's rule against stating a rationale twice.

- [ ] **Step 5: Make the label knob real on the CLI**

Documenting `BROWSERFORCE_CDP_CLIENT_LABEL` while `cli/sessiond.js` ignores it would ship a lie. Import `withClientLabel` in `cli/sessiond.js` and wrap the URL in `connectRealBrowser` (`:61`):

```js
  const cdpUrl = withClientLabel(await getCdpUrl());
```

This also fixes a defect found alongside it: without a label the relay keys window affinity on the ephemeral connection id (`relay/src/index.js:1605-1608`), so sessiond's agent-window pin is discarded on every disconnect and the next created tab can land in the user's own window. `connectRealBrowser` is private and the tests bypass it entirely through the `BF_SESSIOND_CONNECT_MODULE` fake-connect seam (`cli/sessiond.js:331`), so it cannot be observed as written. Export the URL builder instead and test that directly:

```js
// cli/sessiond.js
/** The CDP URL sessiond connects with, label included. Exported so the label
 *  contract is testable without a real browser — connectRealBrowser is private
 *  and the tests replace it wholesale via BF_SESSIOND_CONNECT_MODULE. */
export async function buildRealCdpUrl() {
  return withClientLabel(await getCdpUrl());
}
```

`connectRealBrowser` then calls it. Test:

```js
// test/cli-sessiond.test.js — client-label.js reads the env once at module
// load, so the override must be exercised in a subprocess.
test('sessiond labels its CDP connection so window affinity survives a reconnect', async () => {
  const { stdout } = await exec('node', ['-e',
    "import('./cli/sessiond.js').then(m => m.buildRealCdpUrl()).then(u => console.log(u))"],
    { cwd: ROOT, env: { ...env, BROWSERFORCE_CDP_CLIENT_LABEL: 'shared-team-window' } });
  assert.match(stdout, /[?&]label=shared-team-window\b/);
});

test('an unlabelled CDP URL is what makes the window pin ephemeral', async () => {
  // Documents WHY the label matters: without it the relay keys affinity on the
  // connection id (relay/src/index.js:1605-1608) and the pin dies on disconnect.
  const { stdout } = await exec('node', ['-e',
    "import('./cli/sessiond.js').then(m => m.buildRealCdpUrl()).then(u => console.log(u))"],
    { cwd: ROOT, env: { ...env, BROWSERFORCE_CDP_CLIENT_LABEL: '' } });
  assert.match(stdout, /[?&]label=browserforce-mcp-[0-9a-f]{8}/);
});
```

- [ ] **Step 6: Prove the hazard is real before documenting it as one**

With the relay up, open two tabs. From two shells against the same daemon, run `browserforce use t1` in one and `browserforce use t2` in the other, then `browserforce get url` in the first. If it reports t2's URL, the shared-active-tab stomp is confirmed and the `--tab` requirement is load-bearing. If it does not, correct the section — do not ship a warning about a hazard that does not exist.

Separately, confirm the non-isolation claim: start a second daemon with `BF_SESSIOND_LOCK_PATH=/tmp/bf-probe.json` and run `tabs`. It must list the same tabs as the first daemon. If it does, the wording in Step 3 is correct; if it does not, the relay filters per client after all and the section should say so.

- [ ] **Step 7: Run the suites**

Run: `node --test test/browserforce-skill.test.js mcp/test/help-docs.test.js mcp/test/mcp-tools.test.js test/cli-sessiond.test.js && pnpm test:skill-install`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add skills/browserforce/SKILL.md mcp/src/help-docs.js cli/sessiond.js \
        test/browserforce-skill-contract.js mcp/test/help-docs.test.js test/cli-sessiond.test.js
git commit -m "feat(skill,cli): document subagent handoff and make the client label work on the CLI"
```

---

### Task 12: Per-client active tab, so sharing is actually safe

Codex was asked directly whether documenting `--tab` is sufficient for parallel subagents. It is not, and the reasoning holds: `--tab` is advisory, it is not accepted by `tabs`/`use`/`open` at all, and nothing stops a subagent from running `use` or assigning `state.page` in `eval`. Task 11's snippet reduces the odds; it does not remove the failure.

This is the difference that matters competitively. `agent-browser` has isolation primitives and no sharing protocol — its own guide tells agents the shared browser "can hijack another agent's page mid-task", and four concurrent clients on one session name produced no lock, no queue and last-write-wins. BrowserForce shares by default, which is what orchestrators actually want. Making that safe is the product.

The minimal fix is not a lock or a queue: it is to stop pretending there is one active tab when there are several agents. Give each identified client its own active page inside the one shared session. Unidentified clients keep today's shared page exactly, so nothing existing changes behaviour.

**Files** — the id must reach execution, so every layer in the table below is edited AND staged; a chain that stops halfway leaves the stomp in place:
- Modify: `mcp/src/browser-session-runtime.js:351-369` (`setActivePage`/`resolveActivePage`/`getActivePage`, plus `openNewPage`/`listTabRows`/`activeTabRow` scoping and `stateViewFor`)
- Modify: `mcp/src/exec-engine.js:541-545` (client-scoped `activePage()` resolver and `state` view)
- Modify: `mcp/src/browserforce-command-registry.js:440-442` (`use`, and `clientId` through `executeBrowserforceVerb`/`executeBrowserforceCommand`)
- Modify: `cli/session-client.js` (send `X-BrowserForce-Client`)
- Modify: `cli/sessiond.js` (read + sanitize the header, pass it through)
- Modify: `bin.js` (read `BROWSERFORCE_CLIENT_ID`)
- Modify: `skills/browserforce/SKILL.md`, `mcp/src/help-docs.js` (`subagents` section)
- Test: `mcp/test/browser-session-runtime.test.js`, `mcp/test/browserforce-command-registry.test.js`, `test/cli-sessiond.test.js`

**Interfaces:**
- Produces: `setActivePage(page, { clientId } = {})`, `resolveActivePage(ctx, { clientId } = {})`. `clientId` omitted ⇒ the shared slot, byte-identical to today.
- Wire: sessiond reads `X-BrowserForce-Client` (falling back to a `clientId` body field); absent ⇒ shared.

- [ ] **Step 1: Write the failing tests**

```js
test('two identified clients keep separate active tabs in one shared session', async () => {
  const { runtime, pages } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://a.test/' }), fakePage({ url: 'https://b.test/' })],
  });
  runtime.setActivePage(pages[0], { clientId: 'agent-1' });
  runtime.setActivePage(pages[1], { clientId: 'agent-2' });
  assert.equal(runtime.getActivePage({ clientId: 'agent-1' }), pages[0],
    'agent-1 must not see agent-2 switch tabs underneath it');
  assert.equal(runtime.getActivePage({ clientId: 'agent-2' }), pages[1]);
});

test('unidentified clients still share one active tab', async () => {
  const { runtime, pages } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://a.test/' }), fakePage({ url: 'https://b.test/' })],
  });
  runtime.setActivePage(pages[0]);
  runtime.setActivePage(pages[1]);
  assert.equal(runtime.getActivePage(), pages[1], 'sequential CLI behaviour is unchanged');
});

test('a client falls back to the shared tab before it picks one', async () => {
  const { runtime, pages } = tabRuntimeEnv({ pages: [fakePage({ url: 'https://a.test/' })] });
  runtime.setActivePage(pages[0]);
  assert.equal(runtime.getActivePage({ clientId: 'fresh-agent' }), pages[0],
    'a subagent inherits the parent tab until it chooses its own — that is the point of sharing');
});

test('a client slot rebinds across a reconnect instead of falling back', async () => {
  // The regression that matters: a Page-keyed slot dies on reconnect and the
  // client silently lands on the SHARED page — another agent's tab.
  const { runtime, pages, __fireDisconnect } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://a.test/' }), fakePage({ url: 'https://b.test/' })],
  });
  const rows = await runtime.listTabRows();
  runtime.setActivePage(pages[1], { clientId: 'agent-2', targetId: rows[1].targetId });
  runtime.setActivePage(pages[0]);                       // shared slot = tab A
  __fireDisconnect();
  const after = await runtime.listTabRows();
  const own = runtime.getActivePage({ clientId: 'agent-2' });
  assert.equal(own?.url(), 'https://b.test/', 'agent-2 must still be on its own tab');
  assert.notEqual(own, runtime.getActivePage(), 'and must not have fallen back to the shared tab');
});

test('a blocked slot stays blocked instead of silently sharing', async () => {
  // Two consecutive failures. If the slot is deleted on the first, the second
  // finds none and falls back to the shared tab — the stomp, one call later.
  const { runtime, pages, __fireDisconnect } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://one.test/' }), fakePage({ url: 'https://two.test/' })],
  });
  const rows = await runtime.listTabRows();
  runtime.setActivePage(pages[1], { clientId: 'b', targetId: rows[1].targetId });
  runtime.setActivePage(pages[0]);            // shared slot = tab one
  pages.length = 1;                            // b's tab is gone entirely
  __fireDisconnect();
  await runtime.listTabRows();
  assert.equal(runtime.getActivePage({ clientId: 'b' }), null);
  assert.equal(runtime.getActivePage({ clientId: 'b' }), null,
    'the second call must not fall back to the shared tab');
});

test('a closed page clears only its own client slot', async () => {
  const { runtime, pages } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://a.test/' }), fakePage({ url: 'https://b.test/' })],
  });
  runtime.setActivePage(pages[0], { clientId: 'agent-1' });
  runtime.setActivePage(pages[1], { clientId: 'agent-2' });
  pages[0].__close();
  assert.equal(runtime.getActivePage({ clientId: 'agent-1' }), null);
  assert.equal(runtime.getActivePage({ clientId: 'agent-2' }), pages[1]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test mcp/test/browser-session-runtime.test.js`
Expected: FAIL — `setActivePage` takes no options today, so agent-2's page overwrites agent-1's.

- [ ] **Step 3: Implement**

```js
  // One shared active page was correct while one agent used the session. With
  // orchestrators delegating to parallel subagents it silently stomps: agent-2
  // runs `use`, and agent-1's next unpinned command acts on agent-2's tab.
  // Identified clients get their own slot; unidentified ones share, so every
  // existing sequential caller is unaffected.
  // clientId → { targetId, page }. Storing the PAGE alone would repeat the bug
  // this whole arc fixes: reconnect replaces every Page object, the slot would
  // look dead, and the client would silently fall back to the SHARED page —
  // i.e. onto another agent's tab. targetId is what survives, so the slot
  // rebinds instead.
  const activePageByClient = new Map();

  function setActivePage(page, { clientId = null, targetId = null } = {}) {
    // Keep the existing usability check and return value — an existing test
    // asserts a closed page is rejected, and callers use the returned page.
    if (!isUsablePage(page)) return null;
    if (clientId) {
      activePageByClient.set(clientId, { targetId, page, gen: connectionGeneration });
      return page;
    }
    userState.page = page;
    return page;
  }

  function getActivePage({ clientId = null } = {}) {
    if (clientId) {
      const slot = activePageByClient.get(clientId);
      if (slot) {
        // Generation check FIRST. `isUsablePage` only asks isClosed(), and a
        // Page from the previous connection reports false — it is orphaned, not
        // closed. Trusting it would hand back a handle onto a dead CDP session.
        // The disconnect handler clears `browser`, never the old Page objects.
        if (slot.gen === connectionGeneration && isUsablePage(slot.page)) return slot.page;
        const rebound = slot.targetId ? pageForTargetId(slot.targetId) : null;
        if (rebound) { slot.page = rebound; slot.gen = connectionGeneration; return rebound; }
        // Fail closed AND keep the slot. Deleting it means the next command
        // finds no slot, falls through to the shared page, and the cross-agent
        // stomp is back one call later. A blocked slot clears only on explicit
        // reselection (use/open) or reset.
        slot.page = null;
        return null;
      }
      // No slot yet: inherit the shared page. That is what makes a delegated
      // subagent useful before it picks its own tab.
    }
    const page = userState.page ?? null;
    if (page && !isUsablePage(page)) { userState.page = null; return null; }
    return page;
  }
```

Add `activePageByClient.clear();` to `reset()` **in this task** — Task 6 must not clear a map that does not exist until now.

`connectionGeneration` is a counter incremented in the `disconnected` handler (`:281-286`), which is also what invalidates the identity cache: `pageForTargetId(targetId)` reads the last `listIdentifiedPages()` result cached beside `lastRelayTargets`, and that cache is stale exactly when a slot needs rebinding. `runCommand()` therefore `await`s `listIdentifiedPages()` before resolving a client slot whenever `identityCache.generation !== connectionGeneration` — that field is set by `listIdentifiedPages` when it caches its rows. Without it the first post-reconnect command fails closed and the agent sees a spurious "no active tab".

```js
test('an orphaned Page from the previous connection is never returned', async () => {
  // The subtle one: Playwright Pages from a dead connection are NOT closed, so
  // isClosed() is false and a usability-first check hands back a dead handle.
  const { runtime, pages, __fireDisconnect } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://one.test/' }), fakePage({ url: 'https://two.test/' })],
  });
  const rows = await runtime.listTabRows();
  const stale = pages[1];
  runtime.setActivePage(stale, { clientId: 'agent-2', targetId: rows[1].targetId });
  __fireDisconnect();                     // old Pages remain open(), just orphaned
  assert.equal(stale.isClosed(), false, 'fixture must model the real hazard');
  await runtime.listTabRows();
  const got = runtime.getActivePage({ clientId: 'agent-2' });
  assert.notEqual(got, stale, 'must not return the orphaned Page');
  assert.equal(got.url(), 'https://two.test/', 'must rebind to the live page for that target');
});
```

`resolveActivePage(ctx, { clientId } = {})` threads the same option through. Every existing caller passes nothing and is unchanged.

`setActivePage` defaults `targetId` to `null`, and `use`, `open` and a `state.page` assignment each write the slot from a different place — any one passing nothing leaves a slot that cannot rebind after reconnect, which is the entire point of the task. Derive the id in **one** place rather than at three call sites:

```js
  // Every client-slot write funnels through here, so no path can store a null
  // id by omission. A page with no relay identity (managed backend) still
  // legitimately stores null.
  function setActivePageForClient(page, clientId) {
    setActivePage(page, { clientId, targetId: targetIdByPage.get(page) ?? null });
  }
```

`use`, `open` and the `state.page` setter all call it. In `open` it goes immediately after the post-create match, using the id that match produced:

```js
    // Task 12 only. Task 7 leaves `open` client-neutral; `clientId` does not
    // exist in this executor's signature until this task adds it.
    if (clientId) runtime.setActivePageForClient(page, clientId);
```

Add a reconnect test per path: a slot written by `use` and one written by `open` must both survive `__fireDisconnect()`.

Threading the id is most of the work, and none of it is optional — an id that stops halfway leaves the stomp in place:

| Layer | Change |
|---|---|
| `bin.js` | read `process.env.BROWSERFORCE_CLIENT_ID`; pass to the session client |
| `cli/session-client.js` | send it as `X-BrowserForce-Client` on every state request |
| `cli/sessiond.js` | read `req.headers['x-browserforce-client']`, sanitize (`/^[A-Za-z0-9._-]{1,64}$/`, else ignore), pass `{ clientId }` into `runCommand` |
| `mcp/src/browserforce-command-registry.js` | carry `clientId` into every `runtime.*` active-page call — **including `use` (`:440-442`)**, which calls `setActivePage(page)` today and would keep writing the shared slot |
| `mcp/src/browser-session-runtime.js` | `resolveTabTarget()` must return `targetId` beside `page` so `use` can pass `{ clientId, targetId }`; `open` gets it from the post-create listing above. Without the id a slot stores `null` and cannot rebind after reconnect |
| `mcp/src/browser-session-runtime.js` | `runCommand({ clientId })` resolves the page via `getActivePage({ clientId })` |
| `mcp/src/exec-engine.js:541-545` | **`buildExecContext.activePage()` reads shared `userState.page` before its `defaultPage`.** Picking the right page before construction is not enough — helpers still reach the shared tab. Pass a client-scoped resolver in |
| `mcp/src/exec-engine.js` | **`state` is the shared `userState` object.** A scoped `activePage()` does not scope `state.page`: an `eval` that reads it sees another client's tab, and one that assigns it stomps them. Expose a per-client `state` view whose `page` getter/setter routes through `getActivePage`/`setActivePage` for that `clientId`, leaving every other key shared |
| `mcp/src/browser-session-runtime.js` | `openNewPage({ clientId })` must write the client's slot, not `userState.page`; `listTabRows({ clientId })` and `activeTabRow({ clientId })` must mark the caller's own active row. Otherwise `open`, `use` and `tabs` all report and mutate the shared tab even when everything else is scoped |

`--tab` still wins for a single run. Add the end-to-end test at the CLI layer, since that is where a broken link shows up:

Assert **exact distinct URLs**, not merely non-equality — two clients both landing on the shared tab would pass a weaker check.

```js
test('unpinned commands are client-scoped end to end', async () => {
  // The whole chain: env -> header -> sessiond -> registry -> runtime ->
  // buildExecContext. A break anywhere puts both clients on one tab.
  const a = { ...env, BROWSERFORCE_CLIENT_ID: 'agent-a' };
  const b = { ...env, BROWSERFORCE_CLIENT_ID: 'agent-b' };
  await exec('node', ['bin.js', 'use', 't1'], { cwd: ROOT, env: a });
  await exec('node', ['bin.js', 'use', 't2'], { cwd: ROOT, env: b });
  for (const [who, want] of [[a, 'one.test'], [b, 'two.test']]) {
    for (const verb of [['get', 'url'], ['eval', 'return page.url()'], ['eval', 'return state.page.url()']]) {
      const { stdout } = await exec('node', ['bin.js', ...verb], { cwd: ROOT, env: who });
      assert.ok(stdout.includes(want),
        `${verb[0]} must resolve the caller's own tab, not the shared one`);
    }
  }
});

test('state.page is client-scoped for reads and writes', async () => {
  const { runtime, pages } = tabRuntimeEnv({
    pages: [fakePage({ url: 'https://one.test/' }), fakePage({ url: 'https://two.test/' })],
  });
  const rows = await runtime.listTabRows();
  runtime.setActivePage(pages[0], { clientId: 'a', targetId: rows[0].targetId });
  runtime.setActivePage(pages[1], { clientId: 'b', targetId: rows[1].targetId });
  const stateA = runtime.stateViewFor('a');
  const stateB = runtime.stateViewFor('b');
  assert.equal(stateA.page.url(), 'https://one.test/');
  assert.equal(stateB.page.url(), 'https://two.test/');
  // B assigns a page A does NOT hold. Assigning A's own page would pass even
  // against a shared implementation, leaving the stomp untested.
  const third = fakePage({ url: 'https://three.test/' });
  pages.push(third);
  await runtime.listTabRows();
  stateB.page = third;
  assert.equal(stateB.page.url(), 'https://three.test/');
  assert.equal(stateA.page.url(), 'https://one.test/', 'b assigning state.page must not move a');
});

test('open and tabs report the caller own active tab', async () => {
  const { runtime, run } = tabRuntimeEnv({ pages: [fakePage({ url: 'https://one.test/' })] });
  await run('open https://two.test/', { clientId: 'a' });
  const rowsB = await runtime.listTabRows({ clientId: 'b' });
  assert.ok(!rowsB.find((r) => r.active && r.url === 'https://two.test/'),
    'b must not inherit the tab a just opened as its active row');
});

test('two CLI clients keep separate active tabs against one daemon', async () => {
  const a = { ...env, BROWSERFORCE_CLIENT_ID: 'agent-a' };
  const b = { ...env, BROWSERFORCE_CLIENT_ID: 'agent-b' };
  await exec('node', ['bin.js', 'use', 't1'], { cwd: ROOT, env: a });
  await exec('node', ['bin.js', 'use', 't2'], { cwd: ROOT, env: b });
  const { stdout } = await exec('node', ['bin.js', 'get', 'url'], { cwd: ROOT, env: a });
  assert.match(stdout, /fake\.test/, 'agent-a must still be on the tab it selected');
});
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test mcp/test/browser-session-runtime.test.js && node --test test/cli-sessiond.test.js && node --test mcp/test/browserforce-command-registry.test.js`
Expected: PASS, with every existing active-tab test green and untouched — that is the proof the shared path did not move.

- [ ] **Step 5: Prove it against the live browser**

Reproduce the stomp from Task 11 Step 6, then re-run it with two different `X-BrowserForce-Client` values (`BROWSERFORCE_CLIENT_ID=a` / `=b`). `get url` in the first shell must report its own tab. Without this task it reports the other agent's.

- [ ] **Step 6: Simplify the handoff snippet**

The parallel-subagent instruction in Task 11 can now stop enumerating flags:

> Browser: use the `browserforce` CLI with `BROWSERFORCE_CLIENT_ID=<your-name>`
> exported. You share the session's tabs and logins with the other agents, but
> your active tab is your own — `use` and `open` will not move theirs.

Keep the `--tab` guidance as the fallback for clients that cannot set the id.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/browser-session-runtime.js mcp/src/exec-engine.js \
        mcp/src/browserforce-command-registry.js cli/session-client.js cli/sessiond.js bin.js \
        skills/browserforce/SKILL.md mcp/src/help-docs.js \
        mcp/test/browser-session-runtime.test.js mcp/test/browserforce-command-registry.test.js \
        test/cli-sessiond.test.js
git commit -m "feat(mcp,cli): give each identified client its own active tab so parallel subagents stop stomping"
```

---

### Task 13: Record the arc

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
- Inverted wildcard CORS to an allowlist. A denylist had exempted only
  `/extension/status` and `/attached-tabs`, leaving `/json`, `/json/list` and
  `/json/version` serving the CDP auth token, and `/restrictions` and
  `/agent-preferences` serving user settings, to any page the user visits.
  Only `/` is wildcard now.
- Capped the default `tabs` listing at 20 with `--all`/`--match`/`--limit` and
  an explicit omission notice; the first call had cost ~1,400 tokens.
- `tabs` now refuses positional arguments. `tabs close <handle>` had parsed as a
  bare listing with the arguments discarded: it reported success and closed
  nothing.
- Documented the subagent handoff. Orchestrators delegate browser work by
  pasting an instruction line, and BrowserForce had none — despite subagents
  already sharing one daemon, and one shared active tab, by default.
- Gave each identified client its own active tab inside the shared session.
  Sharing by default is the reason delegation is worth doing; one shared
  `state.page` made it unsafe the moment two subagents ran at once.
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
(`matchPagesToTargets`) pairs a page to a relay target **only when the URL is
unique on both sides** — exactly one page and exactly one target carry it. There
is no positional tie-breaking: that would assume `ctx.pages()` and the relay
target list share an insertion order, which is unproven, and if it were ever
false two tabs showing the same page would swap handles silently. Duplicate-URL
tabs fall back to per-connection identity and renumber across a reconnect —
visible degradation, never a silent mis-bind. Relay identity is additionally
gated on the negotiated backend; a managed/headless session has no relay.

Titles come from the relay for the same reason `page.title()` is bounded: on a
lazily-attached tab the relay acks `Runtime.enable` synthetically, no execution
context ever arrives, and the read never settles. Never issue an **unbounded**
`page.title()` against a relay-backed tab. `pageTitleBounded()` stays as the
fallback for pages with no relay identity — a managed/headless backend has no
target list, and removing it would leave those sessions untitled.
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

## Considered and rejected

**Serving the skill from the binary instead of shipping a file.** `agent-browser` ships a
deliberate stub SKILL.md and serves version-matched docs from the CLI (`skills get core`),
which makes doc/version drift structurally impossible and would dissolve Task 1 rather than
police it. It is rejected here because this repo already decided against it, in writing:
`AGENTS.md` states the installed guide "is the complete canonical guide … There is no second
documentation command or runtime skill loader." Reversing that is a separate decision with its
own plan, not a step inside this one. Note also that the pattern is not a complete answer —
agent-browser's *served* docs still document the ref format as `@e1 [header]` when the binary
actually emits `- link "…" [ref=e1]`. Version-locking stops staleness, not wrongness.

**Deriving the isolated subagent's daemon path** (agent-browser's `session id --scope worktree`)
rather than having the orchestrator name it. Better ergonomics, but it adds a verb and this plan
already touches the command surface in three tasks. Worth doing after this lands.

## Follow-on work this scan surfaced (not in scope)

- **Untrusted-content fencing.** `agent-browser --content-boundaries` wraps page text in a
  per-invocation random nonce plus origin, so page content cannot forge the end marker and escape
  quarantine. BrowserForce returns page text unfenced. This is the largest single gap found and
  belongs in its own security-scoped plan.
- **Output bounded by default.** Its `--max-output` truncation line names both the withheld amount
  and the flag that changes it — the same contract Task 8 adopts for `tabs`. Applying it to
  `snapshot` is the obvious next step; a real page measured ~11k tokens for an interactive-only
  snapshot.

## Non-goals

- **Auto-starting Chrome or auto-installing the extension.** `ensureRelay()` covers the relay; the rest needs the user.
- **Making `agent-browser` worse.** It may be the better tool where a clean profile is wanted. This plan argues only that BrowserForce must not lose **by default**.
- **A `tabs close` verb.** Task 9 refuses the string; adding the verb is separate work with its own ownership question (`ownerKey` refusal already exists at the extension boundary).
- **Nested-OOPIF or cross-process target matching.** `matchPagesToTargets` pairs page targets only.

## Resolving ambiguous groups exactly

The unique-URL matcher leaves duplicate-URL tabs on per-connection handles, and
those renumber across a reconnect. That does not meet the acceptance criterion
as written — "a handle from call N still names the same tab in call N+1" is
unqualified. Earlier rounds accepted the gap; it should not ship.

`Target.getTargetInfo` over a per-page CDP session was ruled out **for a full
listing**: the relay mints an alias session per `attachToTarget`
(`relay/src/index.js:1390-1408`) and 72 tabs would mint 72. That reasoning does
not extend to the ambiguous subset, which is typically zero and rarely more than
three. Use it exactly there:

```js
  // Exact resolution for tabs the URL matcher could not identify. Bounded by
  // the ambiguous set, not the tab count: a 72-tab listing containing two
  // about:blank tabs opens two alias sessions, not 72. Detached immediately so
  // the relay drops the alias.
  async function resolveAmbiguousTargetIds(ctx, rows) {
    const unresolved = rows.filter((r) => !r.targetId);
    if (unresolved.length === 0 || unresolved.length > AMBIGUOUS_RESOLUTION_LIMIT) return;
    await Promise.all(unresolved.map(async (row) => {
      let session;
      try {
        session = await ctx.newCDPSession(row.page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo?.targetId) {
          row.targetId = targetInfo.targetId;
          targetIdByPage.set(row.page, targetInfo.targetId);
          row.handle = getStablePageHandle(row.page, targetInfo.targetId);
        }
      } catch { /* leave it on a per-connection handle */ }
      finally { try { await session?.detach(); } catch {} }
    }));
  }
```

`AMBIGUOUS_RESOLUTION_LIMIT = 8` caps the cost when something has gone wrong and
half the listing is unmatched — degrading to renumbering beats opening forty
alias sessions. Call it from `listIdentifiedPages` after matching, before caching.

```js
test('duplicate-URL tabs keep their handles across a reconnect', async () => {
  // The acceptance criterion, unqualified: two about:blank tabs must still be
  // t1 and t2 after the idle disconnect.
  const { runtime, __fireDisconnect } = tabRuntimeEnv({
    pages: [fakePage({ url: 'about:blank' }), fakePage({ url: 'about:blank' })],
  });
  const before = (await runtime.listTabRows()).map((r) => r.handle);
  __fireDisconnect();
  const after = (await runtime.listTabRows()).map((r) => r.handle);
  assert.deepEqual(after, before);
});

test('resolution is skipped when the ambiguous set is large', async () => {
  // Cost guard: a broken match degrades to renumbering rather than opening
  // dozens of alias sessions on the relay.
  const pages = Array.from({ length: 20 }, () => fakePage({ url: 'about:blank' }));
  const { runtime, cdpSessions } = tabRuntimeEnv({ pages });
  await runtime.listTabRows();
  assert.equal(cdpSessions.length, 0);
});
```

The fixture needs `newCDPSession` on its fake context, recording calls in
`cdpSessions` and answering `Target.getTargetInfo` with a per-page id.

## Residual risk

**Duplicate-URL tabs are resolved exactly, not left to renumber.** See
"Resolving ambiguous groups exactly": the URL matcher fails closed, then
`Target.getTargetInfo` identifies the small unmatched set precisely.

**Duplicate-URL swapping is eliminated, not accepted.** An earlier draft paired
duplicate-URL tabs positionally and accepted the swap risk; review rejected that
against the same-tab acceptance criterion. `matchPagesToTargets` now pairs a URL
group only when it is complete on both sides, so a page is never bound to a
target unless the pairing is unambiguous. The cost is that tabs sharing a URL
fall back to per-connection handles whenever the group is incomplete — those
tabs renumber across a reconnect, which is honest degradation rather than a
silent wrong-tab action.

The remaining exposure is a **complete** group whose two lists are ordered
differently. Both derive from the relay's target map in insertion order, so this
requires a reordering bug on one side; the invariant test in Task 3 pins the
bound (a page is only ever paired with a target of its exact URL). If a real
session shows it, the escalation is `Target.getTargetInfo` over a per-page CDP
session — rejected here because the relay mints an alias session per
`attachToTarget` (`relay/src/index.js:1390-1408`) and a 72-tab listing would
mint 72.
