# CDP Accessibility Snapshot Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this repo runs `/hard-implement-loop`, which prefers executing-plans over subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BrowserForce's hand-rolled in-page DOM-walker snapshot with a CDP `Accessibility.getFullAXTree` engine ported from Playwriter (standard `playwright-core` only), delivering `backendNodeId`-anchored refs, `frame`/`locator`/`interactiveOnly` scoping, same-origin + cross-origin (OOPIF) iframe content, and Playwriter's richer output format.

**Architecture:** A new pure-logic module `mcp/src/aria-snapshot-engine.js` fetches `DOM.getFlattenedDocument` + `Accessibility.getFullAXTree` over a relay-routed CDP session, cross-references nodes by `backendNodeId`, filters/scopes, and renders inline-locator text. `exec-engine.js` re-points `snapshot()`/`buildSnapshotData()`/`screenshotWithAccessibilityLabels()` to it and exposes a frame-aware `locatorForRef()`. `snapshot.js` keeps only shared constants/helpers still consumed elsewhere. Cross-origin OOPIFs require a small additive relay change to resolve `Target.attachToTarget`/`Target.getTargets` for iframe targets.

**Tech Stack:** Node ESM, `playwright-core@^1.60`, CDP (`Accessibility`/`DOM`/`Target` domains), `node:crypto`, `node --test`. Relay is CommonJS (`ws` only). No new dependencies (AGENTS.md hard rule).

**Source spec:** `docs/superpowers/specs/2026-06-27-cdp-aria-snapshot-engine-design.md`
**Port reference:** `/Users/valsaraj/Documents/projects/playwriter/playwriter/src/aria-snapshot.ts` (external repo; this plan inlines the full adapted JS so it is self-contained).

---

## Codex Plan Review — Round 1 (REVISE → addressed)

Round 1 returned **REVISE** (1 CRITICAL, 3 IMPORTANT, 2 MINOR). All are folded in:

1. **CRITICAL — explicit `frame`/OOPIF scoping used a page session.** Fixed in Task 1 `getAriaSnapshot` (session ownership) + Reconciliation 7, **grounded in the installed Playwright source** (`coreBundle.js:38176`): `newCDPSession(frame)` throws for same-origin frames and only succeeds for OOPIFs. So: OOPIF frame → engine-owned `newCDPSession(frame)` (root = frame, no frameId); same-origin frame → page session scoped to the frame root via attribute injection. DOM+AX always come from the same session. `getCDPSession` gains an optional `frame` (Task 3 Step 2b).
2. **IMPORTANT — Phase 2 underspecified (placeholders `__refCtx`/`mainDomNodes`/`renderInline`/`childFrame._id`).** Task 13 fully rewritten with concrete, public-API-only mechanics: `createRefContext()` + `assembleSnapshot({ refCtx, frameBoundaryBackendIds }) → { …, refCtx }`; iframes are leaves in the parent tree and every child frame is filled by the walk (no dup); re-render via the existing `buildSnapshotLines`/`finalizeSnapshotOutput`/`renderRefLines`; owner/content matching via public `frame.frameElement()`/`frame.locator()` + attribute tokens. **No `frame._id`, no `frameId()`** (confirmed absent from `types.d.ts`).
3. **IMPORTANT — CI didn't exercise the runtime path.** New **Task 7b** integration test drives the real `buildExecContext().snapshot()` over a fake CDP session (ref storage, `locatorForRef`, enable order, detach, empty-AX throw); wired into the Task 10 gate + `node --check bin.js`.
4. **IMPORTANT — raw OOPIF targetInfo.** Task 11 adds `buildOopifTargetInfo` (normalizes `type:'iframe'` + `browserContextId` invariant), stores normalized info, and Task 12 asserts the relay fills `browserContextId` when the extension omits it.
5. **MINOR — `index.js` wording.** File table + constraints now state `EXECUTE_PROMPT` is explicitly unchanged. **MINOR — locator-inside-OOPIF.** Documented in Task 13 Step 4 (explicit-frame scope assumes the caller acts within that frame).

### Round 2 (REVISE → addressed)

Round 2 confirmed all four Round-1 blockers RESOLVED, with one new IMPORTANT + two MINOR — all folded in:
- **IMPORTANT — shared-`refCtx` test contradicted finalize-once.** The Task 13 Step 5 test called `assembleSnapshot()` twice with a shared `refCtx` (which finalizes per call). Rewritten to use `buildScopedNodes` twice → `stitchFrameTree` → single `finalizeSnapshotOutput`/`reconcileRefLocators`, and Step 2 now carries an explicit **usage rule**: never call `assembleSnapshot` twice with a shared `refCtx`; multi-frame uses `buildScopedNodes` + finalize-once.
- **MINOR — `mainDomNodes` vs `domNodes` naming.** The Task 13 walk now consistently uses the in-scope `domNodes` (the fetched var inside `getAriaSnapshot`) and returns it as `mainDomNodes`.
- **MINOR — explicit-`frame` empty `frameChain`.** Reviewer accepted as documented (Task 13 Step 4); no change required.

---

## Reconciliations With the Design Spec (read first)

Context-first reading found gaps between the spec's §7 file table and the real code. These are folded into the tasks below and must be honored:

1. **`bin.js:172-197` (`cmdSnapshot`) is an unlisted consumer.** It imports `getAccessibilityTree`/`getStableIds` from `exec-engine.js` and `buildSnapshotText`/`annotateStableAttrs` from `snapshot.js` — exactly the functions being removed. Task 6 re-points it to the engine.
2. **`buildLocator` + `escapeLocatorName` must stay exported from `snapshot.js`.** `a11y-labels.js:5-8,144,150` (the explicitly-protected screenshot path) imports them, plus `INTERACTIVE_ROLES`/`CONTEXT_ROLES`/`SKIP_ROLES`. Spec §5 lists `buildLocator` among "replaced" builders, but it cannot be deleted. Only the DOM-walker tree builder/annotator is removed: `walkAxTree`, `hasInteractiveDescendant`, `hasMatchingDescendant`, `buildSnapshotText`, `annotateStableAttrs`.
3. **`mcp-tools.test.js` unit tests break on removal.** The `Snapshot Tree Building` (lines ~629-779) and `annotateStableAttrs` (lines ~858-879) describe blocks directly test `buildSnapshotText`/`annotateStableAttrs`. Task 7 removes them (engine logic is covered by the Task 2 pure-fixture suite + the Task 7b wired-path integration test); the `createSmartDiff`/`parseSearchPattern` blocks stay.
4. **Test harness reality: `pnpm test` uses a MockExtension WebSocket, not real Chrome.** Real Chrome only runs in `mcp/test/e2e-smoke.mjs` (`test:e2e`, not in CI). Therefore: engine logic is verified by **pure-fixture unit tests** (fabricated CDP `AXNode`/`DOM.Node` arrays), relay OOPIF routing is verified by **MockExtension relay tests** (pattern at `relay/test/relay-server.test.js:1896-1947`), and real-Chrome round-trips (same-origin iframe, cross-origin OOPIF, ref→action) go in `e2e-smoke.mjs` and are documented as manual/local.
5. **`DOM.enable` is intercepted (`INIT_ONLY_METHODS`, relay line 155).** On an unattached tab the relay returns synthetic `{}` without enabling DOM. The engine MUST issue a non-init command that triggers lazy attach **before** relying on the DOM domain. Order: `Accessibility.enable` (NOT init-only → triggers `_ensureDebuggerAttached`) first, then `DOM.enable`, then the back-to-back `DOM.getFlattenedDocument` + `Accessibility.getFullAXTree`.
6. **OOPIF spike is real (relay).** `Target.getTargets` (relay line 1248) and `Target.attachToTarget` (relay line 1273) only resolve main `this.targets`; iframe targets are invisible/unresolvable. Playwriter discovers iframe targets via `Target.getTargets` then `Target.attachToTarget({targetId, flatten:true})`. Phase 2 adds an additive relay branch that tracks iframe `targetId → child sessionId` (captured in the existing `Target.attachedToTarget` handler at relay line 1057) and resolves both commands for known OOPIF targets. The child session is already auto-attached via `chrome.debugger`, so the relay returns the existing child sessionId rather than attaching anew.
7. **Session acquisition is `newCDPSession(page|frame)`, and `newCDPSession(frame)` is OOPIF-only by design.** Per spec §6.1, reuse the existing `getCDPSession` helper. **Verified against the installed implementation** (`node_modules/playwright-core/lib/coreBundle.js:38176`, not just the `.d.ts`): `newCDPSession(frame)` looks up `frame._page.delegate._sessions.get(frame._id)` and, if absent, **throws `"This frame does not have a separate CDP session, it is a part of the parent frame's session"`**. Only OOPIFs populate `_sessions`. Consequences the engine relies on (Task 1 `getAriaSnapshot`):
   - **OOPIF frame** → `newCDPSession(frame)` succeeds (sends `Target.attachToTarget({ targetId })` for the iframe target — hence the mandatory Phase 2 relay resolution; without it this throws `Target <id> not found or not attached`, relay `:1280`). The frame session's root IS the frame, so fetch DOM+AX on it with **no** `frameId`.
   - **Same-origin in-process frame** → `newCDPSession(frame)` THROWS. The engine catches and falls back to the **page session**, scoping to the frame's content root via the same `data-attr` mechanism as `locator` scoping.
   - There is **no public `Frame.frameId()`** in std `playwright-core` (confirmed absent from `types.d.ts`; Playwright matches by private `frame._id`). The engine therefore NEVER passes `getFullAXTree({ frameId })` and NEVER reads `frame._id`; same-origin scope + owner-iframe matching both use public `Frame.frameElement()`/`Frame.locator()` + attribute injection.
   - `getExistingCDPSession` **does not exist** in std core (it is a `@xmorse/playwright-core` fork addition).
   - `getCDPSession` gains an optional `frame` param (Task 3) for callers that want a frame session directly; the engine itself acquires/detaches frame sessions for the explicit-`frame` scope and the Phase 2 walk via `page.context().newCDPSession(frame)`.

### Verified API/relay facts (resolve the Phase 0 fork up front)

| Fact | Evidence | Consequence |
|---|---|---|
| `newCDPSession(frame)` is OOPIF-only (throws for same-origin) | impl `coreBundle.js:38176-38190` (`_sessions.get(frame._id)` → throws if absent) | OOPIF scope = own frame session (no frameId); same-origin scope = page session + attr scope |
| No public `Frame.frameId()` | absent from `types.d.ts` (matching is private `frame._id`) | Engine never sends `getFullAXTree({ frameId })`; owner/scope matching uses `frameElement()`/`locator()` + attr injection |
| No `getExistingCDPSession` in std core | absent from `types.d.ts` (only `newCDPSession`) | Cannot avoid `Target.attachToTarget`; relay must resolve it |
| `Target.attachToTarget` resolves only `this.targets` | relay `:1273-1281` (throws otherwise) | Task 11 adds OOPIF `targetId` resolution |
| `Target.getTargets`/`getTargetInfo` resolve only `this.targets` | relay `:1248-1271` | Task 11 also exposes OOPIF targets (normalized via `buildOopifTargetInfo`) |
| OOPIF child session already exists server-side | relay `:1057` records `childSessions` on `Target.attachedToTarget`, but never indexes `targetInfo.targetId` | Task 11 adds the `targetId → {childSessionId, tabId, targetInfo}` index in that same handler |
| Same-origin subframe content is in the parent AX tree | same-process iframes nest under the iframe AX node | Engine treats `<iframe>` nodes as leaves in the parent tree and (re)assembles each frame in the walk so every in-frame ref gets a `frameChain` (needed because page locators do NOT pierce iframes) |

8. **Keep `[ref=eN]` line markers; deliver "richer output" via locator quality, not format overhaul (DEVIATION from spec Decision 4 — flagged for Codex).** Spec Decision 4 calls for Playwriter's inline-locator-only line format. BrowserForce's entire action surface is **ref-keyed**: `refToLocator`/`locatorForRef`, click-by-ref agent flows, `screenshotWithAccessibilityLabels` overlays (`exec-engine.js:856-909`), `help-docs.js` snapshot section, `EXECUTE_PROMPT` (`mcp/src/index.js`), and `mcp-tools.test.js`/`a11y-labels.test.js`. Dropping refs for inline-only locators would rewrite the whole MCP tool contract — out of scope for an engine swap and a "don't break working consumers" violation. **Decision:** the engine emits `- role "name" [ref=eN]:` lines (via exported `renderRefLines(tree)`); the *richness* (spec Decision 4 intent) is delivered by the CDP-built ref→locator table being `backendNodeId`-anchored, `>> nth=N`-disambiguated, same-origin + OOPIF iframe-aware, and contenteditable-promoted. The engine still computes its full inline-locator `snapshot` string (kept for unit tests + e2e). **If Codex plan review rejects this deviation, the fix is a follow-up MCP-contract migration, not a silent inline switch here.**

---

## Constraints & Non-Negotiables

- **No new npm dependencies.** MCP = `playwright-core`/`@modelcontextprotocol/sdk`/`diff`/`zod`; relay = `ws`. Drop Playwriter's `@xmorse/playwright-core`, `async-sema`, `devtools-protocol`, `sharp`.
- **Do not modify `a11y-labels.js` behavior.** Keep its CDP screenshot path and all `snapshot.js` symbols it imports.
- **Relay security invariants unchanged:** binds `127.0.0.1` only; token + Origin checks intact; single extension slot; `Target.*` interception model preserved. Phase 2 only *adds* target resolution; it never forwards iframe attach to the extension as a new debugger attach.
- **Test isolation:** every `relay.start(...)` in tests passes `{ writeCdpUrl: false }`.
- **Hard replace, no fallback engine** (spec Decision 1). Empty/sparse AX tree → one bounded retry → descriptive throw (no silent degrade).
- **Output format: `[ref=eN]` markers are KEPT** (Reconciliation 8 — a deliberate deviation from spec Decision 4's inline-only format). The richness comes from the CDP-built, frame-aware ref→locator table, not a line-format overhaul. `help-docs.js` snapshot section is updated for the new options/`locatorForRef` (Task 8); `EXECUTE_PROMPT` (`mcp/src/index.js`) is **unchanged**.
- **8-FOLD / docs:** `docs/knowledge/` does not yet exist; Task 9 creates `docs/knowledge/INDEX.md` + `timeline1.md` + `critical-patterns.md` and updates `AGENTS.md` Critical Patterns. Atomic commits per task.

## Test Strategy (what runs where)

- **Pure unit (CI, `node --test`):** new `mcp/test/aria-snapshot-engine.test.js` exercises the engine's exported pure functions with hand-built `AXNode`/`DOM.Node` fixtures — tree build, interactive vs full filter, ref/stable-id/dedup, `>> nth=N`, locator escaping, contenteditable promotion, `locator`-scope backend-id set, empty-tree throw. No browser.
- **Relay unit (CI, MockExtension):** extend `relay/test/relay-server.test.js` for the Phase 2 additive `Target.getTargets`/`Target.attachToTarget` OOPIF resolution, using the existing child-session mock pattern.
- **Wired-path integration (CI, no browser):** new `mcp/test/exec-engine-snapshot.test.js` drives the real `buildExecContext().snapshot()` over a fake `page`/`context`/`CDPSession` returning fabricated CDP payloads — asserts ref storage, `refToLocator`/`locatorForRef`, the `Accessibility.enable`-before-`DOM.enable` order, session detach, and the empty-AX throw. Closes the test-vs-runtime gap (Codex Round-1 IMPORTANT-3).
- **MCP contract (CI):** keep `mcp/test/mcp-tools.test.js` green by removing the deleted-function describes (engine logic now lives in the two suites above); `a11y-labels.test.js` stays untouched and green.
- **E2E (manual/local, `pnpm test:e2e`):** `mcp/test/e2e-smoke.mjs` gains same-origin-iframe, cross-origin-OOPIF, `frame`/`locator` scoping, and ref→`locatorForRef`→click round-trip checks against a live relay+extension+Chrome.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `mcp/src/aria-snapshot-engine.js` | **New.** Pure CDP AX engine: data fetch, cross-ref, filter, scope, ref/locator gen, render, OOPIF stitch, frame-aware locator builder. Exports `getAriaSnapshot` + pure helpers for unit tests. |
| `mcp/src/exec-engine.js` | Remove `getAccessibilityTree`/`getStableIds`; `snapshot()`/`buildSnapshotData()`/`screenshotWithAccessibilityLabels()` call the engine; add `frame`/`locator`/`interactiveOnly`; store `{locator, frameChain}` per ref; add `locatorForRef`; expose it in `buildExecContext`. |
| `mcp/src/snapshot.js` | Keep `INTERACTIVE_ROLES`, `CONTEXT_ROLES`, `SKIP_ROLES`, `TEST_ID_ATTRS`, `escapeLocatorName`, `buildLocator`, `createSmartDiff`, `parseSearchPattern`. Remove `walkAxTree`, `hasInteractiveDescendant`, `hasMatchingDescendant`, `buildSnapshotText`, `annotateStableAttrs`. |
| `relay/src/index.js` | Phase 2 only: track iframe `targetId → {childSessionId, tabId, targetInfo}`; include OOPIF targets in `Target.getTargets`; resolve `Target.attachToTarget` for OOPIF targets to the existing child sessionId. |
| `bin.js` | `cmdSnapshot` re-pointed to the engine. |
| `mcp/src/help-docs.js` | Snapshot **help text** updated for new options (`frame`/`locator`/`interactiveOnly`) + `locatorForRef`. |
| `mcp/src/index.js` | **No change** — `EXECUTE_PROMPT` stays as-is because the `[ref=eN]` contract is preserved (Reconciliation 8). Listed only to record it was reviewed and intentionally left untouched. |
| `mcp/test/aria-snapshot-engine.test.js` | **New** pure-function unit tests. |
| `mcp/test/mcp-tools.test.js`, `relay/test/relay-server.test.js`, `mcp/test/e2e-smoke.mjs` | Test migration + additions. |
| `docs/knowledge/timeline1.md`, `docs/knowledge/INDEX.md`, `AGENTS.md` | Docs + knowledge timeline + critical pattern. |

---

## Phase 0 — Spike: OOPIF Session Acquisition (gates Phase 2 only)

### Task 0: Confirm how a cross-origin iframe AX tree is reachable through the relay

**Files:**
- Create (temporary, deleted at end of task): `mcp/test/_spike-oopif.mjs`
- Reference: `relay/src/index.js:1046-1074` (`_handleCdpEventFromExt`), `:1248` (`Target.getTargets`), `:1273` (`Target.attachToTarget`), `:1550-1620` (`_forwardToTab`)

**Why:** Spec §9 Risk 1. Phase 1 needs no answer here (same-origin content is already in the page session's AX tree; the engine scopes to a frame via attribute injection, never `frameId` — Reconciliation 7). Phase 2 (cross-origin OOPIF) does. This spike decides whether the engine can reach an OOPIF and what minimal relay change is required.

- [x] **Step 1: Confirm the (already-resolved) acquisition path**

The fork is resolved analytically by the "Verified API/relay facts" table above — this step just records confirmation:
- **Path (only viable one):** `context.newCDPSession(oopifFrame)` (std `playwright-core@1.61.1` supports `Page|Frame`). It sends `Target.attachToTarget({ targetId, flatten:true })` for the OOPIF target.
- **Why no alternative:** `getExistingCDPSession` does not exist in std core; raw `Target.getTargets`→`attachToTarget` from the page session would require the engine to drive raw sessionIds Playwright doesn't expose. So `newCDPSession(frame)` is the path, and it depends on the Task 11 relay resolution.
- The OOPIF child session **already exists** server-side: when Playwright sends `Target.setAutoAttach`, the extension's `chrome.debugger` auto-attaches OOPIFs and forwards `Target.attachedToTarget` (Chrome child `sessionId`, `targetInfo.type:'iframe'`), recorded in `this.childSessions` (relay `:1057`). The relay just doesn't expose that target by `targetId`.

Minimal relay change (Phase 2, Task 11): index iframe `targetId → { childSessionId, tabId, targetInfo }` in the existing `Target.attachedToTarget` handler; include OOPIF targets in `Target.getTargets`/`getTargetInfo`; resolve `Target.attachToTarget({ targetId })` for those to the **existing** child sessionId (no new `chrome.debugger` attach).

- [x] **Step 2: If a live stack is available, empirically confirm; else record the analytic decision**

Run only if a relay + extension + Chrome are live (`~/.browserforce/cdp-url` present and `GET /extension/status` shows `connected:true`). Otherwise skip and record the analytic decision below.

```bash
ls ~/.browserforce/cdp-url 2>/dev/null && curl -s http://127.0.0.1:19222/extension/status | head -c 400
```

If live, `mcp/test/_spike-oopif.mjs` connects via `chromium.connectOverCDP(cdpUrl)`, opens a page with a known cross-origin iframe, locates the OOPIF via `page.frames()`, and tries `context.newCDPSession(oopifFrame)` (the only std-core path — Reconciliation 7) plus a page-session `Target.getTargets`/`Target.attachToTarget` probe; logs whether the iframe is listed/resolvable. Expected (pre-relay-change): iframe absent from `getTargets`, and `newCDPSession(oopifFrame)`/`attachToTarget` throw `Target <id> not found`.

Run: `node mcp/test/_spike-oopif.mjs` — Expected: confirms iframe target is not reachable until the Task 11 relay change.

- [x] **Step 3: Record the decision and delete the spike script**

Append the outcome to this plan under "Spike Result" (below) and to `docs/knowledge/timeline1.md` (created in Task 9). Decision is fixed: **engine + additive relay change** (not engine-only). Delete `mcp/test/_spike-oopif.mjs`.

```bash
rm -f mcp/test/_spike-oopif.mjs
```

> **Spike Result (2026-06-27, empirical):** Ran `_spike-oopif.mjs` against a **live** stack (relay + extension + Chrome, `connected:true`, 36 targets).
> - **Positive signal:** `page.setContent('<iframe src=https://example.com>')` → after settle, `page.frames()` **surfaced the cross-origin frame** (`['about:blank','https://example.com/']`). So Playwright's frame tree already sees the OOPIF through the current relay — `resolveFrame`/`frame.frameElement()` matching (Task 13) has a real frame object to work with.
> - **Observed crash (confounded):** the probe ran as a **second concurrent `/cdp` client** against the user's already-connected browser (relay default `multi-client`). During OOPIF settle it tripped Playwright's `_CRSession._onMessage` assertion `assert(!object.id, …)` (coreBundle `:33780`) — a CDP **response** (has `id`) reaching a session with no matching pending callback. This is the signature of **multi-client response cross-talk** (a response for the other client's command id landing on the spike's session), **not** an OOPIF-specific engine/relay defect. It crashed before the `newCDPSession(oopifFrame)` probe could run.
> - **Decision (unchanged, analytically grounded):** **engine + additive relay change** (not engine-only). Path = `context.newCDPSession(oopifFrame)` (only std-core OOPIF acquisition path — Reconciliation 7) + Task 11 relay resolution of its `Target.attachToTarget` to the existing child sessionId. Same-origin subframes need no child session (page-session scope + attribute injection).
> - **Phase-2 risk carried forward:** clean **single-client** OOPIF acquisition (`newCDPSession(oopifFrame)` → `Accessibility.getFullAXTree`) is **deferred to Task 14 e2e**, run as the sole MCP client after the Task 11 relay change, where the multi-client confound does not apply. If that e2e reproduces an id-routing assertion as the sole client, escalate to relay child-session response/event routing (out of current plan scope) before claiming Phase 2 complete.

---

## Phase 1 — Engine, Main-Frame + Same-Origin, Scoping, Hard Replace, New Format, Docs

### Task 1: Create the CDP AX engine module (Phase 1 — no OOPIF yet)

**Files:**
- Create: `mcp/src/aria-snapshot-engine.js`
- Reference (port source): Playwriter `aria-snapshot.ts` pure functions + `getAriaSnapshot`

This is a faithful JS port: TypeScript types stripped; `@xmorse/playwright-core`/`async-sema`/`devtools-protocol`/`sharp` removed; role sets imported from `snapshot.js`; `escapeLocatorName` reused; `node:crypto` for the scope UUID; **`Accessibility.enable` issued before `DOM.enable`** (Reconciliation 5); empty-AX bounded retry then throw (spec §6.9); each ref carries `frameChain` (empty in Phase 1, populated in Phase 2). The OOPIF block is intentionally **absent** here and added in Task 13.

- [ ] **Step 1: Write the full module**

```javascript
// BrowserForce — CDP Accessibility Snapshot Engine
// Ported from Playwriter (aria-snapshot.ts) to standard playwright-core. Builds an
// AX snapshot via CDP Accessibility.getFullAXTree + DOM.getFlattenedDocument,
// cross-referenced by backendNodeId, with frame/locator/interactiveOnly scoping.
// Cross-origin OOPIF stitching is added in Phase 2.

import crypto from 'node:crypto';
import {
  INTERACTIVE_ROLES, CONTEXT_ROLES, TEST_ID_ATTRS, escapeLocatorName,
} from './snapshot.js';

// Unnamed wrapper roles are collapsed. Includes 'group', which snapshot.js
// SKIP_ROLES (consumed by a11y-labels.js) intentionally omits — keep a local set
// rather than widening the shared constant.
const SKIP_WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation']);
const LABEL_ROLES = new Set(['labeltext']);
const EMPTY_AX_RETRY_DELAY_MS = 150;

function toAttributeMap(attributes) {
  const result = new Map();
  if (!attributes) return result;
  for (let i = 0; i < attributes.length; i += 2) {
    const name = attributes[i];
    if (name) result.set(name, attributes[i + 1] ?? '');
  }
  return result;
}

function getStableRefFromAttributes(attributes) {
  for (const attr of TEST_ID_ATTRS) {
    const value = attributes.get(attr);
    if (value) return { value, attr };
  }
  const id = attributes.get('id');
  if (id) return { value: id, attr: 'id' };
  return null;
}

function buildLocatorFromStable(stable) {
  return `[${stable.attr}="${escapeLocatorName(stable.value)}"]`;
}

function buildBaseLocator({ role, name, stable, isPromotedContentEditable }) {
  if (stable) return buildLocatorFromStable(stable);
  // Bare <div contenteditable="true"> (ProseMirror/Tiptap/etc.) is promoted to
  // textbox below; Playwright's role=textbox won't match it, so use a CSS attr.
  if (isPromotedContentEditable) return `[contenteditable="true"]`;
  const trimmed = name.trim();
  if (trimmed.length > 0) return `role=${role}[name="${escapeLocatorName(trimmed)}"]`;
  return `role=${role}`;
}

function getAxValueString(value) {
  if (!value) return '';
  const raw = value.value;
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

function getAxRole(node) {
  return getAxValueString(node.role).toLowerCase();
}

function isTextRole(role) {
  return role === 'statictext' || role === 'inlinetextbox';
}

// Per HTML spec, contenteditable is editable for "", "true", or "plaintext-only".
function isContentEditable(value) {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === '' || v === 'true' || v === 'plaintext-only';
}

function isSubstringOfAny(needle, haystack) {
  for (const str of haystack) {
    if (str.includes(needle)) return true;
  }
  return false;
}

function isTruthy(value) {
  return Boolean(value);
}

function buildSnapshotLine({ role, name, baseLocator, indent, hasChildren }) {
  const prefix = '  '.repeat(indent);
  let text = `${prefix}- ${role}`;
  if (name) text += ` "${escapeLocatorName(name)}"`;
  return { text, baseLocator, hasChildren, role, name, indent };
}

function buildTextLine(text, indent) {
  const prefix = '  '.repeat(indent);
  return { text: `${prefix}- text: "${escapeLocatorName(text)}"` };
}

export function buildSnapshotLines(nodes, indent = 0) {
  return nodes.flatMap((node) => {
    const nodeIndent = indent + (node.indentOffset ?? 0);
    const line = node.role === 'text'
      ? buildTextLine(node.name, nodeIndent)
      : buildSnapshotLine({
          role: node.role, name: node.name, baseLocator: node.baseLocator,
          indent: nodeIndent, hasChildren: node.children.length > 0,
        });
    return [line, ...buildSnapshotLines(node.children, nodeIndent + 1)];
  });
}

function shiftIndent(nodes, offset) {
  return nodes.map((node) => ({ ...node, indentOffset: (node.indentOffset ?? 0) + offset }));
}

export function buildRawSnapshotTree({ nodeId, axById, isNodeInScope }) {
  const node = axById.get(nodeId);
  if (!node) return null;
  const role = getAxRole(node);
  const name = getAxValueString(node.name).trim();
  const children = (node.childIds ?? [])
    .map((childId) => buildRawSnapshotTree({ nodeId: childId, axById, isNodeInScope }))
    .filter(isTruthy);
  const inScope = isNodeInScope(node) || children.length > 0;
  if (!inScope) return null;
  return { role, name, backendNodeId: node.backendDOMNodeId, ignored: node.ignored, children };
}

export function filterInteractiveSnapshotTree(options) {
  const { node, ancestorNames, labelContext, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode } = options;
  const role = node.role;
  const name = node.name;
  const hasName = name.length > 0;
  const nextAncestors = hasName ? [...ancestorNames, name] : ancestorNames;
  const isLabel = LABEL_ROLES.has(role);
  const nextLabelContext = labelContext || isLabel;

  const childResults = node.children.map((child) => filterInteractiveSnapshotTree({
    node: child, ancestorNames: nextAncestors, labelContext: nextLabelContext,
    refFilter, domByBackendId, promotedContentEditableIds, createRefForNode,
  }));
  const childNodes = childResults.flatMap((r) => r.nodes);
  const childNames = childResults.reduce((acc, r) => { r.names.forEach((n) => acc.add(n)); return acc; }, new Set());

  if (node.ignored) return { nodes: shiftIndent(childNodes, 1), names: childNames };

  if (isTextRole(role)) {
    if (!hasName || !labelContext) return { nodes: childNodes, names: childNames };
    const isRedundant = ancestorNames.some((a) => a.includes(name) || name.includes(a));
    if (isRedundant) return { nodes: childNodes, names: childNames };
    const names = new Set(childNames); names.add(name);
    return { nodes: [{ role: 'text', name, children: [] }], names };
  }

  const hasChildren = childNodes.length > 0;
  const nameToUse = hasName && (childNames.has(name) || isSubstringOfAny(name, childNames)) ? '' : name;
  const hasNameToUse = nameToUse.length > 0;
  const isWrapper = SKIP_WRAPPER_ROLES.has(role);
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isContext = CONTEXT_ROLES.has(role);
  const passesRefFilter = !refFilter || refFilter({ role, name });
  const includeInteractive = isInteractive && passesRefFilter;
  const shouldInclude = includeInteractive || isLabel || isContext || hasChildren;
  if (!shouldInclude) return { nodes: childNodes, names: childNames };

  if (!includeInteractive && !isLabel && !isContext) {
    return hasChildren ? { nodes: childNodes, names: childNames } : { nodes: [], names: childNames };
  }
  if (isWrapper && !hasNameToUse) {
    return hasChildren ? { nodes: childNodes, names: childNames } : { nodes: [], names: childNames };
  }

  let baseLocator;
  let ref = null;
  if (includeInteractive) {
    const domInfo = node.backendNodeId ? domByBackendId.get(node.backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    const isPromoted = node.backendNodeId != null && (promotedContentEditableIds?.has(node.backendNodeId) ?? false);
    baseLocator = buildBaseLocator({ role, name, stable, isPromotedContentEditable: isPromoted });
    ref = createRefForNode({ backendNodeId: node.backendNodeId, role, name });
  }

  const nodeEntry = { role, name: nameToUse, baseLocator, ref: ref ?? undefined, backendNodeId: node.backendNodeId, children: childNodes };
  const names = new Set(childNames);
  if (hasNameToUse) names.add(nameToUse);
  return { nodes: [nodeEntry], names };
}

export function filterFullSnapshotTree(options) {
  const { node, ancestorNames, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode } = options;
  const role = node.role;
  const name = node.name;
  const hasName = name.length > 0;
  const nextAncestors = hasName ? [...ancestorNames, name] : ancestorNames;

  const childResults = node.children.map((child) => filterFullSnapshotTree({
    node: child, ancestorNames: nextAncestors, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode,
  }));
  const childNodes = childResults.flatMap((r) => r.nodes);
  const childNames = childResults.reduce((acc, r) => { r.names.forEach((n) => acc.add(n)); return acc; }, new Set());

  if (node.ignored) return { nodes: shiftIndent(childNodes, 1), names: childNames };

  if (isTextRole(role)) {
    if (!hasName) return { nodes: childNodes, names: childNames };
    const isRedundant = ancestorNames.some((a) => a.includes(name) || name.includes(a));
    if (isRedundant) return { nodes: childNodes, names: childNames };
    const names = new Set(childNames); names.add(name);
    return { nodes: [{ role: 'text', name, children: [] }], names };
  }

  const hasChildren = childNodes.length > 0;
  const nameToUse = hasName && (childNames.has(name) || isSubstringOfAny(name, childNames)) ? '' : name;
  const hasNameToUse = nameToUse.length > 0;
  const isWrapper = SKIP_WRAPPER_ROLES.has(role);
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const passesRefFilter = !refFilter || refFilter({ role, name });
  const includeInteractive = isInteractive && passesRefFilter;
  const shouldInclude = includeInteractive || hasNameToUse || hasChildren;
  if (!shouldInclude) return { nodes: childNodes, names: childNames };

  if (isWrapper && !hasNameToUse) {
    return hasChildren ? { nodes: childNodes, names: childNames } : { nodes: [], names: childNames };
  }

  let baseLocator;
  let ref = null;
  if (includeInteractive) {
    const domInfo = node.backendNodeId ? domByBackendId.get(node.backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    const isPromoted = node.backendNodeId != null && (promotedContentEditableIds?.has(node.backendNodeId) ?? false);
    baseLocator = buildBaseLocator({ role, name, stable, isPromotedContentEditable: isPromoted });
    ref = createRefForNode({ backendNodeId: node.backendNodeId, role, name });
  }

  const nodeEntry = { role, name: nameToUse, baseLocator, ref: ref ?? undefined, backendNodeId: node.backendNodeId, children: childNodes };
  const names = new Set(childNames);
  if (hasNameToUse) names.add(nameToUse);
  return { nodes: [nodeEntry], names };
}

function buildLocatorLineText({ line, locator }) {
  const prefix = '  '.repeat(line.indent ?? 0);
  const role = line.role ?? '';
  const name = line.name ?? '';
  const escapedName = escapeLocatorName(name);
  const hasRoleInLocator = role ? locator.includes(role) : false;
  const hasNameInLocator = name ? locator.includes(escapedName) : false;
  const parts = [];
  if (role && !hasRoleInLocator) parts.push(role);
  if (name && !hasNameInLocator) parts.push(`"${escapedName}"`);
  const base = parts.length > 0 ? `${prefix}- ${parts.join(' ')}` : `${prefix}-`;
  return `${base} ${locator}`;
}

export function finalizeSnapshotOutput(lines, nodes, shortRefMap) {
  const locatorCounts = lines.reduce((acc, line) => {
    if (line.baseLocator) acc.set(line.baseLocator, (acc.get(line.baseLocator) ?? 0) + 1);
    return acc;
  }, new Map());

  const locatorIndices = new Map();
  const locatorSequence = lines.reduce((acc, line) => {
    if (!line.baseLocator) return acc;
    const count = locatorCounts.get(line.baseLocator) ?? 0;
    const index = locatorIndices.get(line.baseLocator) ?? 0;
    locatorIndices.set(line.baseLocator, index + 1);
    acc.push(count > 1 ? `${line.baseLocator} >> nth=${index}` : line.baseLocator);
    return acc;
  }, []);

  let lineLocatorIndex = 0;
  const snapshot = lines.map((line) => {
    let text = line.text;
    if (line.baseLocator) {
      text = buildLocatorLineText({ line, locator: locatorSequence[lineLocatorIndex] });
      lineLocatorIndex += 1;
    }
    if (line.hasChildren) text += ':';
    return text;
  }).join('\n');

  let nodeLocatorIndex = 0;
  const applyLocators = (items) => items.map((item) => {
    const locator = item.baseLocator ? locatorSequence[nodeLocatorIndex++] : undefined;
    const children = applyLocators(item.children);
    return {
      role: item.role, name: item.name, locator, ref: item.ref,
      shortRef: item.ref ? (shortRefMap.get(item.ref) ?? item.ref) : undefined,
      backendNodeId: item.backendNodeId, children,
    };
  });

  return { snapshot, tree: applyLocators(nodes) };
}

// BrowserForce-specific renderer: keeps the existing `[ref=eN]` line contract
// (Reconciliation 8) while sourcing roles/names/refs from the CDP-built tree.
// The CDP-accurate, frame-aware locator lives in the ref table (exec-engine),
// not inline — so the MCP tool contract and ref-keyed consumers stay intact.
export function renderRefLines(tree) {
  const walk = (nodes, indent) => nodes.flatMap((node) => {
    const prefix = '  '.repeat(indent);
    if (node.role === 'text') return [`${prefix}- text: "${escapeLocatorName(node.name)}"`];
    let line = `${prefix}- ${node.role}`;
    if (node.name) line += ` "${escapeLocatorName(node.name)}"`;
    if (node.ref) line += ` [ref=${node.shortRef ?? node.ref}]`;
    const childLines = walk(node.children ?? [], indent + 1);
    if (childLines.length > 0) line += ':';
    return [line, ...childLines];
  });
  return walk(tree, 0).join('\n');
}

export function buildDomIndex(nodes) {
  const domById = new Map();
  const domByBackendId = new Map();
  const childrenByParent = new Map();
  for (const node of nodes) {
    const info = {
      nodeId: node.nodeId, parentId: node.parentId, backendNodeId: node.backendNodeId,
      nodeName: node.nodeName, attributes: toAttributeMap(node.attributes),
    };
    domById.set(node.nodeId, info);
    domByBackendId.set(node.backendNodeId, info);
    if (node.parentId) {
      if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
      childrenByParent.get(node.parentId).push(node.nodeId);
    }
  }
  return { domById, domByBackendId, childrenByParent };
}

function findScopeRootNodeId(nodes, attrName, attrValue) {
  for (const node of nodes) {
    if (!node.attributes) continue;
    for (let i = 0; i < node.attributes.length; i += 2) {
      if (node.attributes[i] === attrName && node.attributes[i + 1] === attrValue) return node.nodeId;
    }
  }
  return null;
}

function buildBackendIdSet(rootNodeId, childrenByParent, domById) {
  const result = new Set();
  const stack = [rootNodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const node = domById.get(current);
    if (node) result.add(node.backendNodeId);
    const children = childrenByParent.get(current);
    if (children?.length) stack.push(...children);
  }
  return result;
}

export function buildShortRefMap({ refs }) {
  const map = new Map();
  refs.forEach((entry, index) => map.set(entry.ref, `e${index + 1}`));
  return map;
}

// Resolve a Frame | FrameLocator to a real Frame. Detection uses PUBLIC API only:
// a Playwright Frame has childFrames(); a FrameLocator has owner() (a Locator) instead
// (there is no public Frame.frameId() — Reconciliation 7). Used for explicit-frame
// scoping (Phase 1) and OOPIF acquisition (Phase 2).
async function resolveFrame({ frame, page }) {
  if (!frame) return undefined;
  if (typeof frame.childFrames === 'function') return frame;        // already a Frame
  if (typeof frame.owner !== 'function') throw new Error('Unsupported frame argument: expected Frame or FrameLocator');
  const handle = await frame.owner().elementHandle();               // FrameLocator → owning <iframe>
  if (!handle) throw new Error('Could not resolve FrameLocator to a Frame: iframe element not found');
  const resolved = await handle.contentFrame();
  if (!resolved) throw new Error('Could not resolve FrameLocator to a Frame: contentFrame() returned null');
  return resolved;
}

function indexAxNodes(axNodes) {
  const axById = new Map();
  const axByBackendId = new Map();
  for (const node of axNodes) {
    axById.set(node.nodeId, node);
    if (node.backendDOMNodeId) axByBackendId.set(node.backendDOMNodeId, node);
  }
  return { axById, axByBackendId };
}

// Promote bare contenteditable elements Chrome reports as generic so rich-text
// editors appear as interactive textboxes.
function promoteContentEditable(domByBackendId, axByBackendId) {
  const promoted = new Set();
  for (const [, domInfo] of domByBackendId) {
    if (!isContentEditable(domInfo.attributes.get('contenteditable'))) continue;
    const axNode = axByBackendId.get(domInfo.backendNodeId);
    if (!axNode || INTERACTIVE_ROLES.has(getAxRole(axNode))) continue;
    axNode.role = { type: 'role', value: 'textbox' };
    promoted.add(domInfo.backendNodeId);
  }
  return promoted;
}

function findRootAxNodeId(axNodes, scopeRootBackendId, axByBackendId) {
  if (scopeRootBackendId) {
    const scoped = axByBackendId.get(scopeRootBackendId);
    if (scoped) return scoped.nodeId;
  }
  const root = axNodes.find((n) => getAxRole(n) === 'rootwebarea')
    || axNodes.find((n) => getAxRole(n) === 'webarea')
    || axNodes.find((n) => !n.parentId);
  return root ? root.nodeId : null;
}

// Pure assembly from already-fetched CDP arrays. Separated from I/O so it can be
// unit-tested with fabricated fixtures (no browser).
export function assembleSnapshot({ axNodes, domNodes, scopeBackendId = null, interactiveOnly = false, refFilter, frameChain = [] }) {
  const { domById, domByBackendId, childrenByParent } = buildDomIndex(domNodes);
  const { axById, axByBackendId } = indexAxNodes(axNodes);
  const promotedContentEditableIds = promoteContentEditable(domByBackendId, axByBackendId);

  let allowedBackendIds = null;
  if (scopeBackendId != null) {
    // scopeBackendId is a DOM backendNodeId; map to its nodeId then collect subtree.
    let scopeNodeId = null;
    for (const [nodeId, info] of domById) {
      if (info.backendNodeId === scopeBackendId) { scopeNodeId = nodeId; break; }
    }
    allowedBackendIds = scopeNodeId ? buildBackendIdSet(scopeNodeId, childrenByParent, domById) : new Set();
  }

  const rootAxNodeId = findRootAxNodeId(axNodes, scopeBackendId, axByBackendId);
  const isNodeInScope = (node) => {
    if (!allowedBackendIds) return true;
    if (!node.backendDOMNodeId) return false;
    return allowedBackendIds.has(node.backendDOMNodeId);
  };

  const refCounts = new Map();
  let fallbackCounter = 0;
  const refs = [];
  const createRefForNode = ({ backendNodeId, role, name }) => {
    if (!INTERACTIVE_ROLES.has(role)) return null;
    const domInfo = backendNodeId ? domByBackendId.get(backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    let baseRef = stable?.value;
    if (!baseRef) { fallbackCounter += 1; baseRef = `e${fallbackCounter}`; }
    const count = refCounts.get(baseRef) ?? 0;
    refCounts.set(baseRef, count + 1);
    const ref = count === 0 ? baseRef : `${baseRef}-${count + 1}`;
    let locator;
    if (stable && count === 0) locator = buildLocatorFromStable(stable);
    if (!locator && backendNodeId != null && promotedContentEditableIds.has(backendNodeId)) locator = '[contenteditable="true"]';
    refs.push({ ref, role, name, locator, backendNodeId, frameChain });
    return ref;
  };

  let snapshotNodes = [];
  if (rootAxNodeId) {
    const rootNode = axById.get(rootAxNodeId);
    const rootRole = rootNode ? getAxRole(rootNode) : '';
    const rawRoots = (rootNode && (rootRole === 'rootwebarea' || rootRole === 'webarea') && rootNode.childIds)
      ? rootNode.childIds.map((id) => buildRawSnapshotTree({ nodeId: id, axById, isNodeInScope })).filter(isTruthy)
      : [buildRawSnapshotTree({ nodeId: rootAxNodeId, axById, isNodeInScope })].filter(isTruthy);
    snapshotNodes = rawRoots.flatMap((rawNode) => (interactiveOnly
      ? filterInteractiveSnapshotTree({ node: rawNode, ancestorNames: [], labelContext: false, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode }).nodes
      : filterFullSnapshotTree({ node: rawNode, ancestorNames: [], refFilter, domByBackendId, promotedContentEditableIds, createRefForNode }).nodes));
  }

  const lines = buildSnapshotLines(snapshotNodes);
  const shortRefMap = buildShortRefMap({ refs });
  const { snapshot, tree } = finalizeSnapshotOutput(lines, snapshotNodes, shortRefMap);
  // Replace each ref's bare baseLocator with the nth-disambiguated locator from
  // the finalized tree so refs and rendered text agree.
  const finalLocatorByRef = new Map();
  const collect = (items) => items.forEach((it) => { if (it.ref) finalLocatorByRef.set(it.ref, it.locator); collect(it.children); });
  collect(tree);
  const refsOut = refs.map((r) => ({ ...r, locator: finalLocatorByRef.get(r.ref) ?? r.locator, shortRef: shortRefMap.get(r.ref) ?? r.ref }));
  return { snapshot, tree, refs: refsOut };
}

function isEmptyAx(axNodes) {
  if (!Array.isArray(axNodes) || axNodes.length === 0) return true;
  // Only a RootWebArea with no children → tree not computed yet.
  const meaningful = axNodes.filter((n) => {
    const role = getAxRole(n);
    return role && role !== 'rootwebarea' && role !== 'webarea';
  });
  return meaningful.length === 0;
}

/**
 * Get an accessibility snapshot.
 *
 * Session ownership (Codex Round-1 CRITICAL fix — grounded in
 * `node_modules/playwright-core/lib/coreBundle.js:38176` `newCDPSession`):
 *   - main frame: use the page `cdp` session, `getFullAXTree()` (no frameId).
 *   - explicit OOPIF subframe: `newCDPSession(resolvedFrame)` SUCCEEDS (the frame has its
 *     own target in `delegate._sessions`); fetch DOM+AX on that frame session (its root IS
 *     the frame, so no frameId/scope needed). Engine owns + detaches this session.
 *   - explicit same-origin subframe: `newCDPSession(resolvedFrame)` THROWS by design
 *     ("This frame does not have a separate CDP session…"). Fall back to the page session
 *     and scope to the frame's content root via the same data-attr mechanism used for
 *     `locator` (no public `Frame.frameId()` exists in std playwright-core, so we never
 *     pass `getFullAXTree({ frameId })`).
 * DOM + AX are ALWAYS fetched from the SAME session — backendNodeIds are per-process, so
 * mixing a page session's DOM with a frame session's AX would mis-resolve refs.
 * Returns { snapshot, tree, refs, mainDomNodes }. mainDomNodes is the scope session's
 * flattened DOM, consumed by the Phase 2 frame walk (Task 13). refs:
 * { ref, role, name, locator, backendNodeId, frameChain, shortRef }.
 */
export async function getAriaSnapshot({ page, frame, locator, refFilter, interactiveOnly = false, cdp }) {
  if (!cdp) throw new Error('getAriaSnapshot requires a page CDP session (cdp). Pass getCDPSession({ page }).');
  const resolvedFrame = await resolveFrame({ frame, page });
  const isSubframe = !!resolvedFrame && resolvedFrame !== page.mainFrame();

  let scopeCdp = cdp;
  let ownsScopeCdp = false;
  let sameOriginFrame = null; // resolved Frame when we must scope a same-origin subframe
  if (isSubframe) {
    try {
      scopeCdp = await page.context().newCDPSession(resolvedFrame); // OOPIF: own target
      ownsScopeCdp = true;
    } catch {
      scopeCdp = cdp;                 // same-origin in-process frame → page session + scope
      sameOriginFrame = resolvedFrame;
    }
  }

  // A locator scopes within the chosen session's document. For a same-origin frame with no
  // explicit locator, scope to that frame's root element.
  const scopeTarget = locator || (sameOriginFrame ? sameOriginFrame.locator(':root') : null);

  const scopeAttr = 'data-pw-scope';
  const scopeValue = crypto.randomUUID();
  let scopeApplied = false;

  try {
    // Reconciliation 5: Accessibility.enable is NOT in the relay's INIT_ONLY_METHODS, so it
    // triggers lazy debugger attach. DOM.enable IS init-only and would no-op on an
    // unattached tab — enable AX first so the debugger is attached before DOM use.
    await scopeCdp.send('Accessibility.enable');
    await scopeCdp.send('DOM.enable');

    if (scopeTarget) {
      await scopeTarget.evaluate((el, data) => el.setAttribute(data.attr, data.value), { attr: scopeAttr, value: scopeValue });
      scopeApplied = true;
    }

    const fetchData = async () => {
      // Back-to-back, no awaits between, to minimise backendNodeId staleness. Both come
      // from scopeCdp so DOM and AX backendNodeIds agree.
      const domP = scopeCdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
      const axP = scopeCdp.send('Accessibility.getFullAXTree');
      const [{ nodes: domNodes }, { nodes: axNodes }] = await Promise.all([domP, axP]);
      return { domNodes, axNodes };
    };

    let { domNodes, axNodes } = await fetchData();
    if (isEmptyAx(axNodes)) {
      await new Promise((r) => setTimeout(r, EMPTY_AX_RETRY_DELAY_MS));
      ({ domNodes, axNodes } = await fetchData());
      if (isEmptyAx(axNodes)) {
        throw new Error('Accessibility tree is empty after retry — the page may still be loading or has no accessible content. Wait for load and retry; do not fall back to a weaker engine.');
      }
    }

    let scopeBackendId = null;
    if (scopeTarget) {
      const scopeNodeId = findScopeRootNodeId(domNodes, scopeAttr, scopeValue);
      if (scopeNodeId != null) {
        const { domById } = buildDomIndex(domNodes);
        scopeBackendId = domById.get(scopeNodeId)?.backendNodeId ?? null;
      }
    }

    const assembled = assembleSnapshot({ axNodes, domNodes, scopeBackendId, interactiveOnly, refFilter, frameChain: [] });
    return { ...assembled, mainDomNodes: domNodes };
  } finally {
    if (scopeApplied && scopeTarget) {
      await scopeTarget.evaluate((el, attr) => el.removeAttribute(attr), scopeAttr).catch(() => {});
    }
    if (ownsScopeCdp) await scopeCdp.detach().catch(() => {});
  }
}
```

> **Phase 2 extension contract (implemented in Task 13; stated here so the API is fixed up front).** Task 13 makes three *additive* changes to the functions above, with no change to their Phase-1 behavior:
> 1. `assembleSnapshot` gains two optional params and one return field: `assembleSnapshot({ …, refCtx, frameBoundaryBackendIds })` → `{ snapshot, tree, refs, refCtx }`. `refCtx` (from `createRefContext(frameChain)`) carries the shared `refCounts`/`fallbackCounter`/`refs`/`createRefForNode` so refs and `>> nth=N` dedup stay globally unique across frames; when omitted a fresh context is created (Phase-1 behavior identical). `frameBoundaryBackendIds` is a `Set` of `<iframe>`/`<frame>` element backendNodeIds at which `buildRawSnapshotTree` stops descending (so in-frame content is contributed only by the per-frame walk, never duplicated by the parent tree).
> 2. `getAriaSnapshot` already returns `mainDomNodes`; Task 13 also threads the shared `refCtx` through the per-frame assembly and re-renders the stitched tree with the **existing** `buildSnapshotLines` → `finalizeSnapshotOutput` → `renderRefLines` helpers (no new renderer).
> 3. Owner-iframe matching uses the **public** `Frame.frameElement()` + the same `data-attr` injection as `locator` scoping (there is no public `Frame.frameId()`), so it never reads private fields.

- [ ] **Step 2: Lint-check the new module resolves and parses**

Run: `node -e "import('./mcp/src/aria-snapshot-engine.js').then(()=>console.log('resolved'))"`
Expected: `resolved` (no import/syntax errors).

- [ ] **Step 3: Commit**

```bash
git add mcp/src/aria-snapshot-engine.js
git commit -m "feat(mcp): add CDP accessibility snapshot engine (phase 1, no OOPIF)"
```

---

### Task 2: Pure-fixture unit tests for the engine

**Files:**
- Create: `mcp/test/aria-snapshot-engine.test.js`

Verifies engine logic with fabricated CDP `AXNode`/`DOM.Node` arrays — no browser (Reconciliation 4). Covers happy + unhappy paths (AGENTS.md TESTS rule): stable-id ref + inline locator, fallback ref + `>> nth=N` dedup, interactive-vs-full filtering, contenteditable promotion, `locator`-scope subtree restriction, ref-marked rendering, and the empty-AX retry→throw.

- [ ] **Step 1: Write the test file**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSnapshot, renderRefLines, getAriaSnapshot,
} from '../src/aria-snapshot-engine.js';

// ── fixture builders ─────────────────────────────────────────────────────────
const ax = (nodeId, role, name, backendDOMNodeId, childIds = []) => ({
  nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId, childIds,
});
const dom = (nodeId, backendNodeId, nodeName, attributes = [], parentId) => ({
  nodeId, parentId, backendNodeId, nodeName, attributes,
});

test('stable-id interactive node yields data-attr locator + e1 short ref', () => {
  const axNodes = [ax('1', 'RootWebArea', 'T', 1, ['2']), ax('2', 'button', 'Submit', 2)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'BUTTON', ['data-testid', 'submit-btn'], 1)];
  const { snapshot, refs } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, 'submit-btn');
  assert.equal(refs[0].locator, '[data-testid="submit-btn"]');
  assert.equal(refs[0].shortRef, 'e1');
  assert.match(snapshot, /button "Submit"/);
  assert.match(snapshot, /\[data-testid="submit-btn"\]/);
});

test('duplicate locators get >> nth=N disambiguation', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2', '3']), ax('2', 'button', 'Go', 2), ax('3', 'button', 'Go', 3)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'BUTTON', [], 1), dom(3, 3, 'BUTTON', [], 1)];
  const { refs } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.equal(refs.length, 2);
  assert.ok(refs[0].locator.endsWith('nth=0'), refs[0].locator);
  assert.ok(refs[1].locator.endsWith('nth=1'), refs[1].locator);
});

test('full mode keeps text; interactive mode drops non-label text', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2']), ax('2', 'paragraph', '', 2, ['3']), ax('3', 'StaticText', 'Hello world', 3)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'P', [], 1), dom(3, 3, '#text', [], 2)];
  const full = assembleSnapshot({ axNodes, domNodes, interactiveOnly: false });
  const interactive = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.match(full.snapshot, /Hello world/);
  assert.doesNotMatch(interactive.snapshot, /Hello world/);
  assert.equal(interactive.refs.length, 0);
});

test('bare contenteditable is promoted to textbox with [contenteditable] locator', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2']), ax('2', 'generic', '', 2)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'DIV', ['contenteditable', 'true'], 1)];
  const { refs } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, 'textbox');
  assert.equal(refs[0].locator, '[contenteditable="true"]');
});

test('locator scope restricts refs to the scoped subtree', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2', '3']), ax('2', 'button', 'Inside', 2), ax('3', 'button', 'Outside', 3)];
  const domNodes = [
    dom(1, 1, 'BODY'), dom(10, 10, 'DIV', ['id', 'scope'], 1),
    dom(2, 2, 'BUTTON', ['data-testid', 'inside'], 10),
    dom(3, 3, 'BUTTON', ['data-testid', 'outside'], 1),
  ];
  const { snapshot, refs } = assembleSnapshot({ axNodes, domNodes, scopeBackendId: 10, interactiveOnly: true });
  assert.match(snapshot, /Inside/);
  assert.doesNotMatch(snapshot, /Outside/);
  assert.deepEqual(refs.map((r) => r.ref), ['inside']);
});

test('renderRefLines emits [ref=eN] markers from the tree', () => {
  const axNodes = [ax('1', 'RootWebArea', '', 1, ['2']), ax('2', 'button', 'Save', 2)];
  const domNodes = [dom(1, 1, 'BODY'), dom(2, 2, 'BUTTON', [], 1)];
  const { tree } = assembleSnapshot({ axNodes, domNodes, interactiveOnly: true });
  const text = renderRefLines(tree);
  assert.match(text, /- button "Save" \[ref=e1\]/);
});

test('getAriaSnapshot throws without a CDP session', async () => {
  await assert.rejects(() => getAriaSnapshot({ page: {} }), /requires a page CDP session/);
});

test('getAriaSnapshot throws on empty AX tree after one retry', async () => {
  const fakeCdp = { send: async (method) => (method.startsWith('DOM.getFlattenedDocument') || method.startsWith('Accessibility.getFullAXTree') ? { nodes: [] } : {}) };
  await assert.rejects(() => getAriaSnapshot({ page: {}, cdp: fakeCdp }), /empty after retry/);
});
```

- [ ] **Step 2: Run the engine tests green**

Run: `node --test mcp/test/aria-snapshot-engine.test.js`
Expected: all tests pass. If a filter/dedup assertion fails, fix the **engine** (Task 1), not the test (tests encode intended behavior).

- [ ] **Step 3: Commit**

```bash
git add mcp/test/aria-snapshot-engine.test.js
git commit -m "test(mcp): pure-fixture unit tests for CDP aria snapshot engine"
```

---

### Task 3: Re-point `exec-engine.js` `snapshot()`/`buildSnapshotData()` + add frame-aware `locatorForRef()`

**Files:**
- Edit: `mcp/src/exec-engine.js`
- Reference signatures (verified): imports `:9-12`; `snapshot` `:705-755`; `buildSnapshotData` `:757-785`; `refToLocator` `:787-792`; `getCDPSession` `:809-815`; `reservedContextNames` `:975-1005`; returned context `:1021-1035`. `lastRefToLocator` is `WeakMap<page, Map<ref,string>>` `:640`.

The ref map changes from `Map<ref, string>` to `Map<refOrShortRef, { locator, frameChain }>`. `refToLocator` returns the string (back-compat); the new `locatorForRef` returns a real Playwright `Locator`, piercing `frameChain` via `frameLocator`.

- [ ] **Step 1: Swap imports (line 9-12)**

Replace the removed DOM-walker imports with the engine + retained helpers:

```javascript
import {
  createSmartDiff, parseSearchPattern,
} from './snapshot.js';
import { getAriaSnapshot, renderRefLines } from './aria-snapshot-engine.js';
```

(`TEST_ID_ATTRS` import drops here — it was only used by `getStableIds`, removed in this task; the engine imports it from `snapshot.js` itself. `buildSnapshotText`/`annotateStableAttrs` drop.)

- [ ] **Step 2: Delete `getAccessibilityTree` (`:421-582`) and `getStableIds` (`:586-615`)**

Both are the in-page DOM walker the engine replaces. Remove the whole `// ─── Accessibility Tree via DOM ───` and `// ─── Snapshot Helper ───` blocks. `bin.js` (Task 6) is the only external importer and is re-pointed.

- [ ] **Step 2b: Extend `getCDPSession` (`:809-815`) to accept an optional `frame`**

```javascript
  const getCDPSession = async ({ page: targetPage, frame } = {}) => {
    const p = targetPage || activePage();
    if (!p || p.isClosed()) {
      throw new Error('Cannot create CDP session for closed page');
    }
    // newCDPSession(frame) is OOPIF-only and throws for same-origin frames (Reconciliation 7).
    // The engine handles that fallback itself; this param is for callers that explicitly want
    // a frame session.
    return p.context().newCDPSession(frame || p);
  };
```

`snapshot()`/`buildSnapshotData()` still pass `getCDPSession({ page })` (the page session); the engine internally acquires/detaches the OOPIF frame session for an explicit `frame` scope and for the Phase 2 walk. This keeps a single detach owner per session and avoids double-detach.

- [ ] **Step 3: Add a private ref-map + locator helper inside `buildExecContext` (near `lastRefToLocator`, `:640`)**

```javascript
  // ref → { locator, frameChain } (engine-built; frameChain pierces OOPIF/same-origin frames)
  const lastRefToLocator = userState.__lastRefToLocator || (userState.__lastRefToLocator = new WeakMap());

  const buildRefLocator = (rootPage, entry) => {
    if (!entry || !entry.locator) return null;
    let scope = rootPage;
    for (const frameSelector of entry.frameChain || []) scope = scope.frameLocator(frameSelector);
    return scope.locator(entry.locator);
  };

  const storeRefs = (page, refs) => {
    const map = new Map();
    for (const r of refs) {
      const entry = { locator: r.locator ?? null, frameChain: r.frameChain || [] };
      map.set(r.ref, entry);
      if (r.shortRef) map.set(r.shortRef, entry);
    }
    lastRefToLocator.set(page, map);
  };

  const searchToRefFilter = (search) => {
    const pattern = parseSearchPattern(search);
    if (!pattern) return undefined;
    return ({ role, name }) => pattern.test(`${role} ${name || ''}`);
  };
```

(Replace the existing `lastRefToLocator` declaration at `:640` with the commented version above; the others are new.)

- [ ] **Step 4: Replace `snapshot()` (`:705-755`)**

```javascript
  const snapshot = async ({ frame, locator, selector, interactiveOnly = false, search, showDiffSinceLastCall = true } = {}) => {
    const page = activePage();
    // When a frame is given, resolve the CSS selector inside that frame so the scope/locator
    // is in the right document (the engine evaluates it on the frame's session).
    const scopeRoot = frame || page;
    const scopeLocator = locator || (selector ? scopeRoot.locator(selector).first() : null);
    const cdp = await getCDPSession({ page });
    let result;
    try {
      result = await getAriaSnapshot({
        page, frame, locator: scopeLocator, interactiveOnly,
        refFilter: searchToRefFilter(search), cdp,
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
    storeRefs(page, result.refs);

    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    const refTable = result.refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + result.refs.map((r) => `${r.shortRef} (${r.role}${r.name ? ` "${r.name}"` : ''}): ${r.locator ?? '(frame-scoped; use locatorForRef)'}`).join('\n')
      : '';
    const fullSnapshot = `Page: ${title} (${pageUrl})\nRefs: ${result.refs.length} interactive elements\n\n${renderRefLines(result.tree)}${refTable}`;

    let pageSnapshots = lastSnapshots.get(page);
    if (!(pageSnapshots instanceof Map)) {
      const migrated = new Map();
      if (typeof pageSnapshots === 'string') migrated.set('__full_page__', pageSnapshots);
      pageSnapshots = migrated;
      lastSnapshots.set(page, pageSnapshots);
    }
    const snapshotKey = selector || (locator ? '__locator__' : '__full_page__');
    const previousSnapshot = pageSnapshots.get(snapshotKey);
    pageSnapshots.set(snapshotKey, fullSnapshot);

    if (!selector && !locator && !frame && !search && showDiffSinceLastCall && previousSnapshot) {
      const diffResult = createSmartDiff(previousSnapshot, fullSnapshot);
      if (diffResult.type === 'no-change') {
        return 'No changes since last snapshot. Use showDiffSinceLastCall: false to see full content.';
      }
      return diffResult.content;
    }
    return fullSnapshot;
  };
```

- [ ] **Step 5: Replace `buildSnapshotData()` (`:757-785`)**

```javascript
  const buildSnapshotData = async ({ frame, locator, selector, search, interactiveOnly = true } = {}) => {
    const page = activePage();
    const scopeRoot = frame || page;
    const scopeLocator = locator || (selector ? scopeRoot.locator(selector).first() : null);
    const cdp = await getCDPSession({ page });
    let result;
    try {
      result = await getAriaSnapshot({
        page, frame, locator: scopeLocator, interactiveOnly,
        refFilter: searchToRefFilter(search), cdp,
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
    storeRefs(page, result.refs);
    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    const refTable = result.refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + result.refs.map((r) => `${r.shortRef} (${r.role}): ${r.locator ?? '(frame-scoped)'}`).join('\n')
      : '';
    return {
      text: `Page: ${title} (${pageUrl})\nRefs: ${result.refs.length} labeled elements\n\n${renderRefLines(result.tree)}${refTable}`,
      refs: result.refs,
      page,
    };
  };
```

> **Note:** the old `buildSnapshotData` `refAll` flag (true = include context roles as refs) is replaced by `interactiveOnly` (default `true` here so `screenshotWithAccessibilityLabels` keeps labeling only interactive elements). Task 4 updates the caller.

- [ ] **Step 6: Replace `refToLocator()` (`:787-792`) and add `locatorForRef()`**

```javascript
  const refToLocator = ({ ref, page: targetPage } = {}) => {
    const p = targetPage || activePage();
    const entry = lastRefToLocator.get(p)?.get(ref);
    return entry?.locator ?? null;
  };

  const locatorForRef = ({ ref, page: targetPage } = {}) => {
    const p = targetPage || activePage();
    const entry = lastRefToLocator.get(p)?.get(ref);
    return buildRefLocator(p, entry);
  };
```

- [ ] **Step 7: Register `locatorForRef` in `reservedContextNames` (`:975-1005`) and the returned context (`:1026`)**

Add `'locatorForRef',` to the `reservedContextNames` set, and add `locatorForRef` to the returned object next to `refToLocator`:

```javascript
    snapshot, refToLocator, locatorForRef, waitForPageLoad, getLogs, clearLogs, getCDPSession,
```

- [ ] **Step 8: Verify it resolves and the MCP contract tests still load**

Run: `node -e "import('./mcp/src/exec-engine.js').then(m=>console.log(typeof m.buildExecContext))"`
Expected: `function`. (Full MCP suite runs in Task 10 after Task 7's test migration.)

- [ ] **Step 9: Commit**

```bash
git add mcp/src/exec-engine.js
git commit -m "feat(mcp): re-point snapshot/buildSnapshotData to CDP engine + add locatorForRef"
```

---

### Task 4: Make `screenshotWithAccessibilityLabels()` frame-aware via the ref locator helper

**Files:**
- Edit: `mcp/src/exec-engine.js` (`screenshotWithAccessibilityLabels`, `:856-909`)

The label overlay currently calls `page.locator(candidate.locator).first().boundingBox()` — which cannot reach into frames. Use the in-scope `buildRefLocator(page, entry)` (added in Task 3) so OOPIF/same-origin-frame elements get correct page-relative boxes, and so the `>> nth=N` locators resolve to the right element.

- [ ] **Step 1: Update the label-candidate mapping + box resolution**

Replace the `labelCandidates`/`labels` block (`:863-882`) so each candidate carries its frameChain and boxes resolve through `buildRefLocator`:

```javascript
    const sema = new Semaphore(LABEL_BOX_CONCURRENCY);
    const labelCandidates = refs
      .map((ref) => ({ ref: ref.shortRef ?? ref.ref, role: ref.role, locator: ref.locator, frameChain: ref.frameChain || [] }))
      .filter((c) => c.locator)
      .slice(0, MAX_LABEL_OVERLAY_REFS);
    const labels = (await Promise.all(labelCandidates.map(async (candidate) => {
      await sema.acquire();
      try {
        const loc = buildRefLocator(page, { locator: candidate.locator, frameChain: candidate.frameChain });
        const box = await loc.first().boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) return null;
        return { ref: candidate.ref, role: candidate.role, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
      } catch {
        return null;
      } finally {
        sema.release();
      }
    }))).filter(Boolean);
```

The `buildSnapshotData({ selector, search: null, refAll: !interactiveOnly })` call at `:857-861` becomes `buildSnapshotData({ selector, search: null, interactiveOnly })` (the `refAll`→`interactiveOnly` rename from Task 3 Step 5).

- [ ] **Step 2: Verify resolve + commit**

Run: `node -e "import('./mcp/src/exec-engine.js').then(()=>console.log('ok'))"` → `ok`.

```bash
git add mcp/src/exec-engine.js
git commit -m "feat(mcp): resolve a11y label boxes through frame-aware ref locators"
```

---

### Task 5: Trim `snapshot.js` to shared constants + retained helpers

**Files:**
- Edit: `mcp/src/snapshot.js`

Remove only the DOM-walker tree builder/annotator (Reconciliation 2). Keep everything `a11y-labels.js`, `clean-html.js`, `page-markdown.js`, and the kept tests import.

- [ ] **Step 1: Delete the DOM-walker functions**

Remove `walkAxTree` (`:45-54`), `hasInteractiveDescendant` (`:56-63`), `hasMatchingDescendant` (`:65-73`), `buildSnapshotText` (`:75-148`), and `annotateStableAttrs` (`:178-197`). **Keep** `INTERACTIVE_ROLES`, `CONTEXT_ROLES`, `SKIP_ROLES`, `TEST_ID_ATTRS`, `escapeLocatorName`, `buildLocator`, `createSmartDiff`, `parseSearchPattern`, and the `import { createPatch } from 'diff'`.

- [ ] **Step 2: Update the file header (`:1-3`)** to reflect the narrowed scope:

```javascript
// BrowserForce — Shared Accessibility Constants + Snapshot Diff/Search Helpers
// Role sets and locator/name escaping shared by the CDP snapshot engine and the
// screenshot label path; plus createSmartDiff/parseSearchPattern used by snapshot
// diffing and clean-html/page-markdown.
```

- [ ] **Step 3: Confirm no stale importers of removed symbols**

```bash
rg -n "walkAxTree|hasInteractiveDescendant|hasMatchingDescendant|buildSnapshotText|annotateStableAttrs" mcp/ bin.js
```
Expected after Tasks 3/6/7: matches only inside `docs/` and this plan. Any `src`/`bin`/`test` hit is a stale reference to fix before commit (8-FOLD Step 1).

- [ ] **Step 4: Commit**

```bash
git add mcp/src/snapshot.js
git commit -m "refactor(mcp): drop DOM-walker tree builder from snapshot.js (superseded by CDP engine)"
```

---

### Task 6: Re-point `bin.js` `cmdSnapshot` to the engine

**Files:**
- Edit: `bin.js` (`cmdSnapshot`, `:172-197`)

- [ ] **Step 1: Replace the body (`:174-193`)**

```javascript
  const { getAriaSnapshot, renderRefLines } = await import('./mcp/src/aria-snapshot-engine.js');
  const browser = await connectBrowser();
  try {
    const pages = getFirstContext(browser).pages();
    if (index >= pages.length) {
      console.error(`Tab ${index} not found. ${pages.length} tab(s) available.`);
      process.exit(1);
    }
    const page = pages[index];
    const cdp = await page.context().newCDPSession(page);
    let result;
    try {
      result = await getAriaSnapshot({ page, cdp, interactiveOnly: false });
    } finally {
      await cdp.detach().catch(() => {});
    }
    const refTable = result.refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + result.refs.map((r) => `${r.shortRef} (${r.role}): ${r.locator ?? '(frame-scoped)'}`).join('\n')
      : '';
    const title = await page.title().catch(() => '');
    output(`Page: ${title} (${page.url()})\nRefs: ${result.refs.length} interactive elements\n\n${renderRefLines(result.tree)}${refTable}`, values.json);
  } finally {
    await browser.close().catch(() => {});
  }
```

(The old `if (!axRoot)` early-return is dropped: the engine throws a descriptive error on an empty tree instead of returning null — hard-replace, spec Decision 1.)

- [ ] **Step 2: Verify CLI parses + commit**

Run: `node bin.js --help | rg snapshot` → still lists the snapshot command (no import error).

```bash
git add bin.js
git commit -m "feat(cli): re-point browserforce snapshot to CDP engine"
```

---

### Task 7: Migrate `mcp-tools.test.js` off removed functions

**Files:**
- Edit: `mcp/test/mcp-tools.test.js`

The engine's behavior is now covered by `aria-snapshot-engine.test.js` (Task 2). Remove the tests that exercise the deleted `buildSnapshotText`/`annotateStableAttrs`; keep `createSmartDiff`/`parseSearchPattern` coverage.

- [ ] **Step 1: Narrow the `snapshot.js` import (`:8-11`)**

```javascript
import {
  createSmartDiff, parseSearchPattern,
} from '../src/snapshot.js';
```

(Drops `buildSnapshotText, annotateStableAttrs, buildLocator, escapeLocatorName` — all only used by the two describe blocks being deleted.)

- [ ] **Step 2: Delete the `Snapshot Tree Building` describe (`:627-781`) and the `annotateStableAttrs` describe (`:856-879`)**

Keep `Snapshot Diff Mode` (`:783-833`) and `Search Pattern Validation` (`:834-855`) — they exercise retained helpers.

- [ ] **Step 3: Run + confirm green, then commit**

Run: `node --test mcp/test/mcp-tools.test.js`
Expected: pass with the two describes gone, no unused-import/runtime errors.

```bash
git add mcp/test/mcp-tools.test.js
git commit -m "test(mcp): migrate snapshot unit tests to engine suite"
```

---

### Task 7b: Integration test — real `buildExecContext().snapshot()` over a fake CDP session

**Files:**
- Create: `mcp/test/exec-engine-snapshot.test.js`

**Why (Codex Round-1 IMPORTANT-3):** the pure-fixture engine tests (Task 2) validate helpers but never prove the *wired* runtime path — that `snapshot()` stores refs, that `refToLocator`/`locatorForRef` read them back, that the CDP session is enabled in the right order and **detached**, and that `buildExecContext` exposes `locatorForRef`. This test drives the **real** `buildExecContext(...).snapshot()` with a fake `page`/`context`/`CDPSession` returning fabricated `DOM.getFlattenedDocument` + `Accessibility.getFullAXTree` payloads — no browser, runs in CI.

- [ ] **Step 1: Write the fake harness + assertions**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecContext } from '../src/exec-engine.js';

function makeFakeCdp(domNodes, axNodes) {
  const calls = [];
  return {
    calls,
    detached: false,
    async send(method) {
      calls.push(method);
      if (method === 'DOM.getFlattenedDocument') return { nodes: domNodes };
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
      return {};
    },
    async detach() { this.detached = true; },
  };
}

// Minimal fake Locator/FrameLocator: records the selector/frameChain so we can assert
// locatorForRef built the right thing.
function makeFakeLocator(selector, frameChain = []) {
  return {
    selector, frameChain,
    first() { return this; },
    frameLocator(sel) { return { locator: (s) => makeFakeLocator(s, [...frameChain, sel]) }; },
    async evaluate() {},
  };
}

function makeFakePage(cdp) {
  const page = {
    isClosed: () => false,
    url: () => 'https://fake.test/',
    title: async () => 'Fake',
    locator: (sel) => makeFakeLocator(sel),
    frameLocator: (sel) => ({ locator: (s) => makeFakeLocator(s, [sel]) }),
    context: () => ({ newCDPSession: async () => cdp }),
  };
  page.mainFrame = () => page;       // no subframes in this fixture
  page.frames = () => [page];
  return page;
}

// Fixture: <button data-testid="submit">Submit</button>
const domNodes = [
  { nodeId: 1, backendNodeId: 1, nodeName: 'HTML', attributes: [] },
  { nodeId: 2, parentId: 1, backendNodeId: 20, nodeName: 'BUTTON', attributes: ['data-testid', 'submit'] },
];
const axNodes = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId: 1, childIds: ['2'] },
  { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 20, childIds: [] },
];

test('snapshot() wires the engine: text, refs, locatorForRef, CDP order + detach', async () => {
  const cdp = makeFakeCdp(domNodes, axNodes);
  const page = makeFakePage(cdp);
  const exec = buildExecContext(page, {}, {});

  assert.equal(typeof exec.locatorForRef, 'function', 'buildExecContext exposes locatorForRef');

  const text = await exec.snapshot();
  assert.match(text, /button "Submit"/, 'renders the interactive node');
  assert.match(text, /\[ref=e1\]/, 'keeps the [ref=eN] contract (Reconciliation 8)');
  assert.match(text, /\[data-testid="submit"\]/, 'ref table carries the CDP-built locator');

  // Back-compat string accessor + new Locator accessor both resolve the stored ref.
  assert.equal(exec.refToLocator({ ref: 'e1' }), '[data-testid="submit"]');
  const loc = exec.locatorForRef({ ref: 'e1' });
  assert.equal(loc.selector, '[data-testid="submit"]');
  assert.deepEqual(loc.frameChain, [], 'main-frame ref has empty frameChain');

  // CDP contract: Accessibility.enable BEFORE DOM.enable (Reconciliation 5), and detach ran.
  assert.ok(cdp.calls.indexOf('Accessibility.enable') < cdp.calls.indexOf('DOM.enable'), 'AX enabled before DOM');
  assert.ok(cdp.calls.includes('Accessibility.getFullAXTree') && cdp.calls.includes('DOM.getFlattenedDocument'));
  assert.equal(cdp.detached, true, 'snapshot detaches the CDP session it created');
});

test('snapshot() throws (no silent fallback) on an empty AX tree', async () => {
  const cdp = makeFakeCdp(domNodes, [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId: 1, childIds: [] }]);
  const exec = buildExecContext(makeFakePage(cdp), {}, {});
  await assert.rejects(() => exec.snapshot(), /Accessibility tree is empty after retry/);
  assert.equal(cdp.detached, true, 'session detached even on throw');
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test mcp/test/exec-engine-snapshot.test.js
git add mcp/test/exec-engine-snapshot.test.js
git commit -m "test(mcp): integration-test wired snapshot() path with a fake CDP session"
```

> This test is the CI guardrail for the engine↔exec-engine contract: it fails if `snapshot()` stops storing refs, forgets `locatorForRef`, reorders the enable calls, or leaks the CDP session. Live-Chrome/OOPIF behavior stays in manual `e2e-smoke.mjs` (Task 14).

---

### Task 8: Update `help-docs.js` snapshot section (EXECUTE_PROMPT unchanged)

**Files:**
- Edit: `mcp/src/help-docs.js` (snapshot section, `:40-47`)

The ref model is preserved (Reconciliation 8), so `EXECUTE_PROMPT` (`mcp/src/index.js:362-375`) needs **no change**. Only the snapshot help text gains the new options + `locatorForRef`.

- [ ] **Step 1: Replace the snapshot `text` body (`:40-47`)**

```javascript
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
```

- [ ] **Step 2: Verify the help section test still passes + commit**

Run: `node --test mcp/test/mcp-tools.test.js` (the Tool Definitions/help blocks load `help-docs.js`).

```bash
git add mcp/src/help-docs.js
git commit -m "docs(mcp): document snapshot frame/locator/interactiveOnly + locatorForRef"
```

---

### Task 9: Knowledge timeline + INDEX + AGENTS.md pattern (8-FOLD Step 2)

**Files:**
- Create: `docs/knowledge/INDEX.md`, `docs/knowledge/timeline1.md`, `docs/knowledge/critical-patterns.md`
- Edit: `AGENTS.md` (Critical Patterns — add the CDP snapshot engine entry)

`docs/knowledge/` does not exist yet; the global protocol requires it for every code change. Seed it here.

- [ ] **Step 1: Create `docs/knowledge/INDEX.md`**

```markdown
# Knowledge Index

| File | Status | Range |
|---|---|---|
| `timeline1.md` | ACTIVE | 2026-06-27 → present |
| `critical-patterns.md` | ACTIVE | mandatory patterns |

Search newest-first. `timeline1.md` is the active timeline; `critical-patterns.md` holds promoted gotchas.
```

- [ ] **Step 2: Create `docs/knowledge/timeline1.md`** with the engine-swap entry (changes, reasoning, Phase 0 spike result, the `[ref=eN]` deviation, OOPIF relay change).

- [ ] **Step 3: Create `docs/knowledge/critical-patterns.md`** seeding the two engine gotchas:
  - `Accessibility.enable` before `DOM.enable` (relay `INIT_ONLY_METHODS` swallows `DOM.enable` pre-attach).
  - OOPIF AX requires `newCDPSession(frame)` + relay `Target.attachToTarget` resolution (no `getExistingCDPSession` in std core).

- [ ] **Step 4: Add an `AGENTS.md` Critical Pattern entry** (evergreen) under a new `## Accessibility Snapshot Engine` section: engine location, AX-before-DOM order, ref/`locatorForRef` model, OOPIF relay dependency, "no DOM-walker fallback."

- [ ] **Step 5: Commit**

```bash
git add docs/knowledge/INDEX.md docs/knowledge/timeline1.md docs/knowledge/critical-patterns.md AGENTS.md
git commit -m "docs: seed knowledge base + document CDP snapshot engine patterns"
```

---

### Task 10: Phase 1 verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full MCP + relay suites green (incl. the wired-path integration test)**

```bash
node --test mcp/test/aria-snapshot-engine.test.js mcp/test/exec-engine-snapshot.test.js mcp/test/mcp-tools.test.js
node --check bin.js   # cmdSnapshot re-point parses (CLI runtime covered by e2e, Task 14)
pnpm test:relay
```
Expected: all green. `a11y-labels.test.js` (untouched) still passes. If anything references a removed symbol, fix in the owning task's file (8-FOLD Step 1) before proceeding.

- [ ] **Step 2: Confirm no stale DOM-walker references remain repo-wide**

```bash
rg -n "getAccessibilityTree|getStableIds|buildSnapshotText|annotateStableAttrs" mcp/src bin.js relay/src
```
Expected: no matches in source (only docs/plan/tests-as-migrated).

- [ ] **Step 3: Print the 8-FOLD docs gate** `[DOCS UPDATED: docs/knowledge/*, AGENTS.md, mcp/src/help-docs.js]` and proceed to Phase 2.

---

## Phase 2 — Cross-Origin OOPIF Stitching + Frame-Aware `locatorForRef`

### Task 11: Relay — resolve OOPIF iframe targets (additive)

**Files:**
- Edit: `relay/src/index.js`

The command path already works (`_forwardToTab:1589-1617` routes any inbound child sessionId to the extension with `childSessionId`). The only gap: `Target.attachToTarget`/`getTargets`/`getTargetInfo` don't resolve iframe `targetId`s, and `childSessions` doesn't index `targetId`. All four changes are **purely additive** — no security-boundary or extension-protocol change (Constraints).

- [ ] **Step 1: Add the OOPIF index (constructor, after `:252`)**

```javascript
    this.childSessions = new Map(); // childSessionId -> { tabId, parentSessionId }
    this.oopifTargets = new Map();  // iframe targetId -> { childSessionId, tabId, targetInfo }
```

- [ ] **Step 1b: Add a `buildOopifTargetInfo` normalizer next to `buildTargetInfo` (`:215-227`)**

Codex Round-1 IMPORTANT-4: raw extension `targetInfo` may omit fields Playwright's `CRBrowser._onAttachedToTarget` asserts (notably `browserContextId`, AGENTS.md "browserContextId Requirement"). Mirror `buildTargetInfo` so OOPIF targets carry the same invariants:

```javascript
function buildOopifTargetInfo(rawTargetInfo) {
  return {
    targetId: rawTargetInfo.targetId,
    type: 'iframe',
    title: rawTargetInfo.title || '',
    url: rawTargetInfo.url || '',
    attached: true,
    browserContextId: rawTargetInfo.browserContextId || DEFAULT_BROWSER_CONTEXT_ID,
  };
}
```

- [ ] **Step 2: Index iframe targets in `_handleCdpEventFromExt` (`:1057-1062`)**

```javascript
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      this.childSessions.set(params.sessionId, { tabId, parentSessionId: sessionId });
      if (params.targetInfo?.type === 'iframe' && params.targetInfo.targetId) {
        // Store the NORMALIZED targetInfo (browserContextId etc.) so every command that
        // returns it (getTargets/getTargetInfo) is consistent — Codex IMPORTANT-4.
        this.oopifTargets.set(params.targetInfo.targetId, {
          childSessionId: params.sessionId, tabId,
          targetInfo: buildOopifTargetInfo(params.targetInfo),
        });
      }
    }
    if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      this.childSessions.delete(params.sessionId);
      for (const [targetId, info] of this.oopifTargets) {
        if (info.childSessionId === params.sessionId) this.oopifTargets.delete(targetId);
      }
    }
```

- [ ] **Step 3: Resolve OOPIF in `Target.attachToTarget` (`:1273-1281`)**

```javascript
      case 'Target.attachToTarget': {
        for (const [sessionId, target] of this.targets) {
          if (target.targetId === params.targetId) return { sessionId };
        }
        const oopif = this.oopifTargets.get(params.targetId);
        if (oopif) return { sessionId: oopif.childSessionId };
        throw new Error(`Target ${params.targetId} not found or not attached`);
      }
```

- [ ] **Step 4: Include + resolve OOPIF in `Target.getTargets` (`:1248`) and `Target.getTargetInfo` (`:1253`)**

`getTargets` (`o.targetInfo` is already normalized at store time, Step 2):
```javascript
      case 'Target.getTargets':
        return {
          targetInfos: [
            ...[...this.targets.values()].map((t) => buildTargetInfo(t)),
            ...[...this.oopifTargets.values()].map((o) => o.targetInfo),
          ],
        };
```
`getTargetInfo`: before the browser-target fallback, add an OOPIF lookup (returns the normalized info):
```javascript
        const oopif = params?.targetId ? this.oopifTargets.get(params.targetId) : null;
        if (oopif) return { targetInfo: oopif.targetInfo };
```

- [ ] **Step 5: Purge OOPIF index on tab teardown (`_handleTabDetached:1083`, `_closeTarget:1533`)**

In both per-tab child-session cleanup loops, also drop matching `oopifTargets`:
```javascript
    for (const [targetId, info] of this.oopifTargets) {
      if (info.tabId === tabId) this.oopifTargets.delete(targetId);
    }
```

- [ ] **Step 6: Restart relay + commit**

```bash
pnpm test:relay   # baseline still green before adding the new test
git add relay/src/index.js
git commit -m "feat(relay): resolve cross-origin iframe (OOPIF) targets for CDP attach"
```

---

### Task 12: Relay test — OOPIF `attachToTarget`/`getTargets` resolution (MockExtension)

**Files:**
- Edit: `relay/test/relay-server.test.js`

Mirror the existing child-session test (`:1860-1958`): create a target, simulate an iframe `Target.attachedToTarget` from the extension, then assert the new resolution. Uses `connectWs`, `sendAndReceive`, `relay.authToken`, `relay.start({ writeCdpUrl: false })` (Constraints).

- [ ] **Step 1: Add the test inside the child-session describe block**

```javascript
  it('resolves Target.attachToTarget + getTargets for OOPIF iframe targets', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, { headers: { Origin: 'chrome-extension://test' } });
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id && msg.method === 'getRestrictions') { ext.send(JSON.stringify({ id: msg.id, result: { mode: 'auto', noNewTabs: false, lockUrl: false, readOnly: false, instructions: '' } })); return; }
      if (msg.id !== undefined && msg.method === 'createTab') {
        ext.send(JSON.stringify({ id: msg.id, result: { tabId: 31, targetId: 'real-target-31', sessionId: msg.params.sessionId, targetInfo: { targetId: 'real-target-31', type: 'page', title: 'OOPIF Test', url: msg.params.url || 'about:blank' } } }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://oopif-parent.test' } }));
    await sleep(300);

    // Extension reports an auto-attached cross-origin iframe. NOTE: browserContextId is
    // deliberately OMITTED here — the relay must normalize it (Codex IMPORTANT-4).
    ext.send(JSON.stringify({ method: 'cdpEvent', params: { tabId: 31, method: 'Target.attachedToTarget', params: { sessionId: 'oopif-session-1', targetInfo: { targetId: 'oopif-target-1', type: 'iframe', title: '', url: 'https://cross.test/', attached: true }, waitingForDebugger: false } } }));
    await sleep(100);

    const attachResp = await sendAndReceive(cdp, { id: 2, method: 'Target.attachToTarget', params: { targetId: 'oopif-target-1' } });
    assert.equal(attachResp.result.sessionId, 'oopif-session-1', 'attachToTarget returns the existing child sessionId');

    const targetsResp = await sendAndReceive(cdp, { id: 3, method: 'Target.getTargets', params: {} });
    const oopifInfo = targetsResp.result.targetInfos.find((t) => t.targetId === 'oopif-target-1');
    assert.ok(oopifInfo, 'getTargets includes the OOPIF target');
    assert.equal(oopifInfo.type, 'iframe', 'OOPIF target typed as iframe');
    assert.equal(oopifInfo.browserContextId, 'bf-default-context', 'relay normalizes browserContextId even when the extension omits it');

    const infoResp = await sendAndReceive(cdp, { id: 4, method: 'Target.getTargetInfo', params: { targetId: 'oopif-target-1' } });
    assert.equal(infoResp.result.targetInfo.browserContextId, 'bf-default-context', 'getTargetInfo returns the normalized OOPIF info');

    cdp.close();
    ext.close();
    await sleep(100);
  });
```

- [ ] **Step 2: Add the unhappy-path test (unknown target still throws)**

```javascript
  it('Target.attachToTarget still rejects unknown targets', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, { headers: { Origin: 'chrome-extension://test' } });
    ext.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.method === 'ping') ext.send(JSON.stringify({ method: 'pong' })); else if (m.id && m.method === 'getRestrictions') ext.send(JSON.stringify({ id: m.id, result: { mode: 'auto' } })); });
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const resp = await sendAndReceive(cdp, { id: 1, method: 'Target.attachToTarget', params: { targetId: 'nope' } });
    assert.ok(resp.error, 'unknown target rejected');
    cdp.close(); ext.close(); await sleep(100);
  });
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test:relay
git add relay/test/relay-server.test.js
git commit -m "test(relay): cover OOPIF target resolution + unknown-target rejection"
```

---

### Task 13: Engine — OOPIF stitching + `frameChain` propagation

**Files:**
- Edit: `mcp/src/aria-snapshot-engine.js`
- Edit: `mcp/test/aria-snapshot-engine.test.js`

**Model (revised per Codex Round-1 IMPORTANT-2 — concrete, public-API-only, no placeholders).** Every `<iframe>`/`<frame>` element is a **leaf** in the parent tree (main assembly cuts at frame boundaries), and the frame walk fills each child frame exactly once with a correct `frameChain`:
- The parent AX tree from `getFullAXTree()` *does* nest same-origin iframe content under the iframe node. To avoid duplicate content and to give in-frame refs a `frameChain` (page locators do **not** pierce iframes, so `locatorForRef` needs `frameLocator(...)`), the parent assembly is told to stop at iframe element backendNodeIds; the walk then (re)assembles each frame.
- **Same-origin** child: content already lives in the parent session's already-fetched `axNodes`/`domNodes`; the walk re-assembles it *scoped* to the frame's content root (no extra network fetch). **OOPIF** child: `newCDPSession(childFrame)` succeeds → fetch DOM+AX on the frame session.
- A single shared `refCtx` flows through all per-frame assemblies so `eN` fallbacks and `>> nth=N` dedup stay globally unique. The stitched tree is re-rendered with the **existing** `buildSnapshotLines`/`finalizeSnapshotOutput`/`renderRefLines` (no new renderer).
- Frame identity / owner / content-root are resolved with **public** APIs only — `page.frames()`, `frame.parentFrame()`, `frame.childFrames()`, `frame.frameElement()`, `frame.locator(':root')` — plus the same unique-attribute injection used for `locator` scoping. **No `frame._id`, no `frameId()`, no DOM `frameId` field matching** (Reconciliation 7).

- [ ] **Step 1: Add pure, unit-testable helpers (export them)**

```javascript
// backendNodeIds of <iframe>/<frame> elements — the frame-boundary leaves of an assembly.
export function collectFrameBoundaryBackendIds(domNodes) {
  const ids = new Set();
  for (const n of domNodes) {
    const name = (n.nodeName || '').toUpperCase();
    if ((name === 'IFRAME' || name === 'FRAME') && n.backendNodeId != null) ids.add(n.backendNodeId);
  }
  return ids;
}

// Selector for an <iframe> element from its DOM attributes (a Map), preferring stable
// attributes, then name/title/src, then nth among iframes (computed by caller).
export function deriveIframeSelector(ownerAttrs, nthIndex) {
  const attrs = ownerAttrs instanceof Map ? ownerAttrs : new Map();
  const stable = getStableRefFromAttributes(attrs);
  if (stable) return buildLocatorFromStable(stable);
  for (const attr of ['name', 'title', 'src']) {
    const v = attrs.get(attr);
    if (v) return `iframe[${attr}="${escapeLocatorName(v)}"]`;
  }
  return `iframe >> nth=${nthIndex ?? 0}`;
}

// Attach childNodes under the tree node whose backendNodeId === ownerBackendId. Pure.
// mode 'append' (default) is used for every frame because parent assembly cut iframe
// content (frame boundaries are leaves); the walk supplies the real content.
export function stitchFrameTree(tree, ownerBackendId, childNodes, { mode = 'append' } = {}) {
  const walk = (nodes) => nodes.map((node) => {
    if (node.backendNodeId === ownerBackendId) {
      const base = mode === 'replace' ? [] : (node.children ?? []);
      return { ...node, children: [...base, ...childNodes] };
    }
    return { ...node, children: walk(node.children ?? []) };
  });
  return walk(tree);
}
```

- [ ] **Step 2: Extract ref creation into a shared `createRefContext`; make `assembleSnapshot` accept `refCtx` + `frameBoundaryBackendIds` and return `refCtx`.** Move the `refCounts`/`fallbackCounter`/`refs`/`createRefForNode` block (currently local in `assembleSnapshot`) into:

```javascript
export function createRefContext() {
  const refCounts = new Map();
  let fallbackCounter = 0;
  const refs = [];
  const createRefForNode = ({ backendNodeId, role, name, frameChain, domByBackendId, promotedContentEditableIds }) => {
    if (!INTERACTIVE_ROLES.has(role)) return null;
    const domInfo = backendNodeId ? domByBackendId.get(backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    let baseRef = stable?.value;
    if (!baseRef) { fallbackCounter += 1; baseRef = `e${fallbackCounter}`; }
    const count = refCounts.get(baseRef) ?? 0;
    refCounts.set(baseRef, count + 1);
    const ref = count === 0 ? baseRef : `${baseRef}-${count + 1}`;
    let locator;
    if (stable && count === 0) locator = buildLocatorFromStable(stable);
    if (!locator && backendNodeId != null && promotedContentEditableIds.has(backendNodeId)) locator = '[contenteditable="true"]';
    refs.push({ ref, role, name, locator, backendNodeId, frameChain });
    return ref;
  };
  return { refCounts, refs, createRefForNode };
}
```

**Split `assembleSnapshot` into a pre-finalize builder + a finalize wrapper** so multi-frame stitching finalizes exactly once (finalize assigns `>> nth=N` and converts `baseLocator`→`locator`; running it twice would corrupt locators):

```javascript
// PRE-finalize: filtered/scoped node tree whose nodes still carry `baseLocator` + `ref`,
// with refs pushed into the shared refCtx. Used by the main tree AND every per-frame call.
export function buildScopedNodes({ axNodes, domNodes, scopeBackendId = null, interactiveOnly = false, refFilter, frameChain = [], refCtx, frameBoundaryBackendIds }) {
  refCtx = refCtx ?? createRefContext();
  // …existing index/promote/scope/root logic from assembleSnapshot…
  // - thread `frameBoundaryBackendIds` into buildRawSnapshotTree: if a node's
  //   backendDOMNodeId ∈ frameBoundaryBackendIds, keep the node but DO NOT recurse (leaf).
  // - filter*SnapshotTree calls refCtx.createRefForNode({ …, frameChain, domByBackendId, promotedContentEditableIds }).
  return { nodes: snapshotNodes, refCtx };   // NOT finalized
}

// Standalone single-tree assembly (Phase 1 / explicit scope): build + finalize once.
export function assembleSnapshot(opts) {
  const { nodes, refCtx } = buildScopedNodes(opts);
  const lines = buildSnapshotLines(nodes);
  const shortRefMap = buildShortRefMap({ refs: refCtx.refs });
  const { snapshot, tree } = finalizeSnapshotOutput(lines, nodes, shortRefMap);
  const refs = reconcileRefLocators(refCtx.refs, tree, shortRefMap);
  return { snapshot, tree, refs, refCtx };
}
```

`reconcileRefLocators(refs, finalizedTree, shortRefMap)` is the existing Phase-1 tail (lines ~600-607: map each ref's bare `baseLocator` to the nth-disambiguated `locator` from the finalized tree, attach `shortRef`), extracted so both the standalone and multi-frame paths share it. It only updates locators for refs present in `finalizedTree` (others keep their `baseLocator`-derived locator). `assembleSnapshot` keeps the **exact** Phase-1 return shape `{ snapshot, tree, refs, refCtx }` (the new `refCtx` field is additive).

> **Usage rule (Codex Round-2):** `assembleSnapshot` finalizes its OWN tree per call. **Never call `assembleSnapshot` twice with a shared `refCtx`** — the second call would finalize/reconcile against a partial tree. Multi-frame stitching MUST use `buildScopedNodes` (pre-finalize) for every frame into one shared `refCtx`, then finalize once (Step 3). Passing a `refCtx` to `assembleSnapshot` is supported only for the engine's single explicit-scope assembly.

> Per-frame `frameChain` is computed once for the whole assembly (every interactive node in a frame shares it), so `createRefForNode` takes `frameChain` from the assembly, not per node.

- [ ] **Step 3: Add the frame walk to `getAriaSnapshot`** (only when **no** explicit `frame`/`locator` scope — explicit scope keeps Phase-1 single-region behavior, Step 4). Insert before the Phase-1 `return`, replacing it with the stitched result. Concrete algorithm using public APIs + attribute tokens injected **before** the main fetch so all tokens are present in one pass:

```javascript
  // --- Phase 2: tag every subframe's owner element + content root up front, so the
  //     main fetch already carries the tokens (stable backendNodeIds for matching). ---
  const OWNER_ATTR = 'data-pw-frame-owner';
  const ROOT_ATTR = 'data-pw-frame-root';
  const frameMeta = []; // { frame, ownerToken, rootToken, frameChain, isOopif, frameCdp }
  const tagged = [];    // ElementHandles / locators to clean up
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const ownerToken = crypto.randomUUID();
    const rootToken = crypto.randomUUID();
    let ownerHandle;
    try {
      ownerHandle = await f.frameElement();                                  // public
      await ownerHandle.evaluate((el, t) => el.setAttribute('data-pw-frame-owner', t), ownerToken);
    } catch { continue; }                                                    // frame detached
    await f.locator(':root').evaluate((el, t) => el.setAttribute('data-pw-frame-root', t), rootToken).catch(() => {}); // same-origin only
    tagged.push({ ownerHandle, frame: f, rootToken });
    frameMeta.push({ frame: f, ownerToken, rootToken });
  }
```

Then build the **main** tree as PRE-finalize nodes (sharing one `refCtx`), walk every subframe building **pre-finalize** child nodes into the same `refCtx`, stitch the node trees, and **finalize exactly once** at the end. In Phase 2 the main no-scope path of `getAriaSnapshot` replaces its Phase-1 `assembleSnapshot(...)` call with `buildScopedNodes(...)`:

```javascript
  // NB: inside getAriaSnapshot the scope session's flattened DOM is the local `domNodes`
  // from fetchData(); it is returned to callers as `mainDomNodes`. Use `domNodes` here.
  // Main tree, pre-finalize, with iframes as leaves and a shared refCtx.
  const mainBoundaryIds = collectFrameBoundaryBackendIds(domNodes);
  const { nodes: mainNodes, refCtx } = buildScopedNodes({
    axNodes, domNodes, interactiveOnly, refFilter, frameChain: [],
    frameBoundaryBackendIds: mainBoundaryIds,
  });

  // frameChain for a frame = [...ancestorSelectors, deriveIframeSelector(ownerAttrs, nth)],
  // composed by walking the PUBLIC f.parentFrame() chain; nth = the owner's index among its
  // parent's iframe owners (deterministic via DOM order).
  const ownerByToken = mapTokenToBackendId(domNodes, OWNER_ATTR);   // token -> { backendNodeId, attrs }
  const rootByToken  = mapTokenToBackendId(domNodes, ROOT_ATTR);    // same-origin content roots

  let stitched = mainNodes;
  const childSessions = [];
  try {
    for (const meta of orderFramesParentFirst(frameMeta)) {            // parents before children
      const owner = ownerByToken.get(meta.ownerToken);
      if (!owner) continue;                                            // owner not in this process tree
      meta.frameChain = buildFrameChain(meta.frame, ownerByToken, domNodes);
      let childNodes;
      try {
        const frameCdp = await page.context().newCDPSession(meta.frame);   // OOPIF only (else throws)
        childSessions.push(frameCdp);
        await frameCdp.send('Accessibility.enable');
        await frameCdp.send('DOM.enable');
        const [{ nodes: cDom }, { nodes: cAx }] = await Promise.all([
          frameCdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true }),
          frameCdp.send('Accessibility.getFullAXTree'),
        ]);
        ({ nodes: childNodes } = buildScopedNodes({
          axNodes: cAx, domNodes: cDom, interactiveOnly, refFilter,
          frameChain: meta.frameChain, refCtx,
          frameBoundaryBackendIds: collectFrameBoundaryBackendIds(cDom),
        }));
      } catch {
        // same-origin: re-assemble from the parent session's already-fetched axNodes/domNodes
        // scoped to the frame's content root (tagged above), SAME boundary cutoff so nested
        // iframes stay leaves for their own iteration.
        const rootBackendId = rootByToken.get(meta.rootToken)?.backendNodeId;
        if (rootBackendId == null) continue;
        ({ nodes: childNodes } = buildScopedNodes({
          axNodes, domNodes, scopeBackendId: rootBackendId, interactiveOnly, refFilter,
          frameChain: meta.frameChain, refCtx, frameBoundaryBackendIds: mainBoundaryIds,
        }));
      }
      stitched = stitchFrameTree(stitched, owner.backendNodeId, childNodes);
    }
    // ── finalize ONCE over the fully-stitched pre-finalize node tree ──
    const lines = buildSnapshotLines(stitched);
    const shortRefMap = buildShortRefMap({ refs: refCtx.refs });
    const { snapshot, tree } = finalizeSnapshotOutput(lines, stitched, shortRefMap);
    const refs = reconcileRefLocators(refCtx.refs, tree, shortRefMap);
    return { snapshot, tree, refs, mainDomNodes: domNodes };
  } finally {
    for (const s of childSessions) await s.detach().catch(() => {});
    for (const t of tagged) {
      await t.ownerHandle.evaluate((el, a) => el.removeAttribute(a), OWNER_ATTR).catch(() => {});
      await t.frame.locator(`[data-pw-frame-root="${t.rootToken}"]`).evaluate((el, a) => el.removeAttribute(a), ROOT_ATTR).catch(() => {});
    }
  }
```

The small helpers above are pure and unit-tested: `mapTokenToBackendId(domNodes, attr)` (scan flattened DOM for `attr` → `{token: {backendNodeId, attrs}}`), `orderFramesParentFirst(frameMeta)` (topological by `parentFrame()` depth so a parent is stitched before its child can stitch into it), `buildFrameChain(frame, ownerByToken, domNodes)` (compose `deriveIframeSelector` up the public `parentFrame()` chain), and `reconcileRefLocators(refs, finalizedTree, shortRefMap)` (the existing Phase-1 "replace bare baseLocator with nth-disambiguated locator + attach shortRef" step, extracted so both paths share it).

**Integration into `getAriaSnapshot` (no-explicit-scope path only):** the frame-owner/root tagging loop is inserted **before** the existing `fetchData()` (so `mainDomNodes` carries the tokens); the Phase-1 `return { ...assembleSnapshot(...), mainDomNodes }` is replaced by the `buildScopedNodes` + walk + single-finalize block above; and the tagging `finally` (session detach + attribute removal) is merged with the existing scope-cleanup `finally`. The explicit-`frame`/`locator` path (Step 4) skips all of this and keeps the Phase-1 `assembleSnapshot` return.

**Known limitation (documented, acceptable):** owner elements are matched only in `mainDomNodes` (the page-session pierced DOM). A frame nested **inside an OOPIF** has its owner element in the OOPIF's process DOM, not the page DOM, so `ownerByToken` misses it and it is skipped (`if (!owner) continue`). One level of OOPIF is stitched; iframes nested inside an OOPIF are not. A future enhancement can index owners per-parent-frame DOM. Record this in `docs/knowledge/timeline1.md`.

- [ ] **Step 4: Explicit `frame`/`locator` scope keeps Phase-1 single-region behavior** (no recursive walk). For an explicit **same-origin** `frame`, the engine already scopes the page session to the frame root (Task 1); for an explicit **OOPIF** `frame`, the engine already fetched on the frame session (its root is the frame). In both cases refs inside the explicitly-scoped frame carry an **empty** `frameChain` because the scope session is already rooted at that frame — `locatorForRef` then resolves against the page; document this limitation (explicit-frame refs assume the caller acts within that frame) and prefer the no-scope full snapshot when cross-frame `frameChain`s are needed. (Locators *inside* an explicitly-scoped OOPIF are addressed via this same frame-rooted assumption — Codex MINOR-2.)

- [ ] **Step 5: Add pure unit tests for the new helpers**

```javascript
test('collectFrameBoundaryBackendIds finds iframe/frame elements', () => {
  const ids = collectFrameBoundaryBackendIds([
    { backendNodeId: 1, nodeName: 'DIV' }, { backendNodeId: 2, nodeName: 'IFRAME' }, { backendNodeId: 3, nodeName: 'FRAME' },
  ]);
  assert.deepEqual([...ids].sort(), [2, 3]);
});

test('deriveIframeSelector prefers stable attr, then name, then nth', () => {
  const m = (pairs) => new Map(pairs);
  assert.equal(deriveIframeSelector(m([['id', 'editor']]), 0), '[id="editor"]');
  assert.equal(deriveIframeSelector(m([['name', 'ads']]), 0), 'iframe[name="ads"]');
  assert.equal(deriveIframeSelector(m([]), 2), 'iframe >> nth=2');
});

test('stitchFrameTree appends child nodes under the iframe leaf', () => {
  const tree = [{ role: 'iframe', name: '', backendNodeId: 9, children: [] }];
  const child = [{ role: 'button', name: 'X', backendNodeId: 100, children: [], ref: 'e1', shortRef: 'e1' }];
  const out = stitchFrameTree(tree, 9, child);
  assert.equal(out[0].children.length, 1);
  assert.equal(out[0].children[0].name, 'X');
});

// Multi-frame path: buildScopedNodes twice into ONE shared refCtx, stitch the PRE-finalize
// nodes, then finalize ONCE — mirrors the getAriaSnapshot walk (Step 3). Must NOT call
// assembleSnapshot twice with a shared refCtx (assembleSnapshot finalizes per-call and only
// reconciles its own tree — Codex Round-2).
test('shared refCtx + single finalize keeps eN fallbacks unique and frame-scoped', () => {
  const refCtx = createRefContext();
  // unnamed buttons (no stable attrs) → e1 (main) then e2 (in-frame) across the shared ctx
  const main = buildScopedNodes({ axNodes: [axRoot([10]), ax(10, 'button', '', 501)], domNodes: [dom(10, 501, 'BUTTON')], frameChain: [], refCtx });
  const child = buildScopedNodes({ axNodes: [axRoot([20]), ax(20, 'button', '', 502)], domNodes: [dom(20, 502, 'BUTTON')], frameChain: ['iframe >> nth=0'], refCtx });
  // stitch: put the child button under a fabricated iframe leaf in the main tree
  const stitched = [{ role: 'iframe', name: '', backendNodeId: 999, children: [] }, ...main.nodes];
  const merged = stitchFrameTree(stitched, 999, child.nodes);
  const lines = buildSnapshotLines(merged);
  const shortRefMap = buildShortRefMap({ refs: refCtx.refs });
  const { tree } = finalizeSnapshotOutput(lines, merged, shortRefMap);
  const refs = reconcileRefLocators(refCtx.refs, tree, shortRefMap);

  assert.equal(new Set(refs.map((r) => r.ref)).size, refs.length, 'no duplicate refs across frames');
  const inFrame = refs.find((r) => r.frameChain.length === 1);
  assert.deepEqual(inFrame.frameChain, ['iframe >> nth=0'], 'in-frame ref carries the frameChain');
  assert.equal(refs.filter((r) => r.frameChain.length === 0).length, 1, 'main-frame ref keeps empty frameChain');
});
```
> `axRoot`/`ax`/`dom` are the fixture builders from Task 2; add `axRoot(childIds)` returning a `rootwebarea` node if not already present. `buildScopedNodes`, `stitchFrameTree`, `buildSnapshotLines`, `buildShortRefMap`, `finalizeSnapshotOutput`, and `reconcileRefLocators` are all exported (Step 2 / Task 1).

- [ ] **Step 6: Run engine + relay suites, then commit**

```bash
node --test mcp/test/aria-snapshot-engine.test.js
git add mcp/src/aria-snapshot-engine.js mcp/test/aria-snapshot-engine.test.js
git commit -m "feat(mcp): stitch OOPIF/subframe AX trees with frameChain-aware refs"
```

---

### Task 14: E2E smoke additions + final verification + ship

**Files:**
- Edit: `mcp/test/e2e-smoke.mjs`
- Verification + PR

E2E needs a live relay + extension + Chrome (`pnpm test:e2e`, not CI) — documented as manual/local (Reconciliation 4).

- [ ] **Step 1: Add e2e cases to `e2e-smoke.mjs`** (guarded so they no-op when no live stack):
  - same-origin iframe: `snapshot()` includes in-iframe content; `locatorForRef({ ref })` for an in-iframe ref clicks successfully.
  - cross-origin OOPIF: `snapshot()` includes the OOPIF's interactive elements; `locatorForRef` round-trip acts inside it.
  - `snapshot({ locator })` and `snapshot({ frame })` scope to the expected region.
  - empty/sparse page → descriptive throw (no silent fallback).

- [ ] **Step 2: Full verification gate**

```bash
pnpm test            # mcp + relay unit/contract suites (CI surface)
node bin.js --help >/dev/null && echo "cli ok"
rg -n "getAccessibilityTree|getStableIds|buildSnapshotText|annotateStableAttrs" mcp/src bin.js relay/src   # expect: no matches
```
Expected: `pnpm test` green; no stale references. If a live stack is available, also run `pnpm test:e2e` and record results in `docs/knowledge/timeline1.md`.

- [ ] **Step 3: Update docs for Phase 2** (8-FOLD Step 2): append the OOPIF stitching + relay-resolution entry to `docs/knowledge/timeline1.md`; confirm `AGENTS.md` OOPIF pattern entry is accurate. Print `[DOCS UPDATED: docs/knowledge/timeline1.md, AGENTS.md]`.

- [ ] **Step 4: Commit any remaining docs, then open the PR**

```bash
git add mcp/test/e2e-smoke.mjs docs/knowledge/timeline1.md AGENTS.md
git commit -m "test(e2e): cover same-origin + OOPIF snapshot/locatorForRef round-trips"
git push -u origin feat/cdp-aria-snapshot-engine
gh pr create --base main --title "feat: CDP accessibility snapshot engine (backendNodeId refs, frame/locator scoping, OOPIF)" --body "$(cat <<'EOF'
## Summary
- Replace the in-page DOM-walker snapshot with a CDP `Accessibility.getFullAXTree` engine (`mcp/src/aria-snapshot-engine.js`), backendNodeId-anchored refs, `>> nth=N` dedup, contenteditable promotion.
- Add `frame`/`locator`/`interactiveOnly` scoping and a frame-aware `locatorForRef()` (pierces same-origin + cross-origin iframes).
- Additive relay change resolves OOPIF iframe targets for `Target.attachToTarget`/`getTargets`/`getTargetInfo`.
- Hard replace (no DOM-walker fallback); ref-keyed line format kept; richer locator table.

## Test plan
- [ ] `pnpm test` (mcp + relay) green
- [ ] `node --test mcp/test/aria-snapshot-engine.test.js` green
- [ ] Manual `pnpm test:e2e`: same-origin iframe, cross-origin OOPIF, locator/frame scoping, ref→action round-trip
EOF
)"
```

- [ ] **Step 5: Final report** — PR link, Codex plan + code approval status, checks run, residual risks (OOPIF e2e is manual; same-origin in-frame action now frame-aware), next user action.

---

## Acceptance Criteria (spec §10 "Done when")

- [ ] `snapshot()` returns a CDP-built tree with backendNodeId-anchored refs + a frame-aware locator table.
- [ ] `interactiveOnly`, `locator`, and `frame` scoping work.
- [ ] Same-origin iframe content is present and actionable via `locatorForRef`.
- [ ] Cross-origin OOPIF content is present and actionable via `locatorForRef` (manual e2e).
- [ ] No DOM-walker fallback; empty AX → descriptive throw after one retry.
- [ ] `a11y-labels.js` untouched + green; `pnpm test` green; no stale references.
- [ ] Knowledge timeline + `AGENTS.md` updated; atomic commits per task.

---

## Post-Implementation Amendments (Codex code-review reconciliation)

These were **plan gaps** surfaced by the post-implementation Codex code review (model `gpt-5.5`, session `019f0899…`, APPROVED Round 4). The implementation followed the plan faithfully; the plan simply did not anticipate these edge cases. Recorded so the plan stays a learning artifact.

1. **OOPIF session-acquisition error discrimination (Round 1 CRITICAL).** The plan said "OOPIF via `newCDPSession(frame)`; same-origin throws → fall back to page session", but did not distinguish the *genuine* same-origin error from an *unexpected* acquisition failure. Fix: `isSameOriginFrameSessionError()` keyed on Playwright's exact stable string (`crBrowser.js:507`); explicit `frame` scope now **rethrows** unexpected failures (instead of silently scoping the page session to the whole page); the full-page walk best-effort skips them. Root cause: plan treated all `newCDPSession` throws as same-origin.

2. **Child-frame empty-AX retry contract (Round 1 IMPORTANT).** The plan specified the empty-AX retry/throw only for the main session. Child OOPIF fetches must share it. Fix: extracted `fetchDomAndAxWithRetry(session)` used by both main and child paths. Root cause: plan's retry rule wasn't propagated to the Phase-2 child path.

3. **Scoped-snapshot diff-cache key (Round 1 IMPORTANT).** The plan didn't note that `exec-engine` keys the last-snapshot cache by scope. A `snapshot({ frame })` was overwriting the `__full_page__` baseline. Fix: added a `__frame__` bucket to `snapshotKey`. Root cause: plan didn't enumerate the diff-cache keys vs the new `frame` scope.

4. **Visible degradation for full-page OOPIF failures (Round 2 IMPORTANT).** The plan documented the nested-OOPIF limitation but not the *silent* drop of a first-level OOPIF that fails to acquire/fetch or is empty. Fix: `getAriaSnapshot` returns `frameErrors`, surfaced via `renderFrameErrors` as a `⚠️ N subframe(s) not stitched` block (best-effort skip kept — one flaky/blank cross-origin iframe must not break the whole-page snapshot). Root cause: plan's "best-effort" wasn't paired with a visibility requirement.

5. **Consumer parity for `frameErrors` (Round 3 IMPORTANT).** Surfacing was added to the two `exec-engine` consumers but the plan didn't enumerate the third direct consumer (CLI `bin.js cmdSnapshot`, re-pointed in Task 6). Fix: `cmdSnapshot` now renders `frameErrors` identically. Root cause: plan didn't maintain a canonical list of direct `getAriaSnapshot` consumers.

