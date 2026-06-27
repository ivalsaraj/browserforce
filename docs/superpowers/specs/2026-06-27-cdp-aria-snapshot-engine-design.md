# CDP Accessibility Snapshot Engine — Design

**Date:** 2026-06-27
**Status:** Approved (design) → ready for implementation plan
**Author:** @ivalsaraj (via Claude)
**Area:** `mcp/` (MCP server — `snapshot()` and supporting AX pipeline)

## 1. Problem

BrowserForce's `snapshot()` is built on a **hand-rolled in-page DOM walker**
(`getAccessibilityTree()` / `getStableIds()` in `mcp/src/exec-engine.js`). It was
adopted on 2026-02-22 (`f84cad7`) only because Playwright removed
`page.accessibility.snapshot()` in v1.58. It has structural weaknesses:

- **No `backendNodeId` anchor** — refs are matched to stable IDs by accessible-name
  string, which collides and breaks when DOM text ≠ AX name.
- **No cross-frame coverage** — the walker never crosses `<iframe>` boundaries
  (neither same-origin nor cross-origin OOPIF). Open Shadow DOM only.
- **Bespoke, partial computation** — hand-written role map, partial accessible-name
  algorithm, partial visibility checks (`display`/`visibility` only).
- **No scoping** — no `frame`, `locator`, or `interactiveOnly` targeting; large
  pages are silently truncated at 2000 nodes.

Playwriter (`/Users/valsaraj/Documents/projects/playwriter/playwriter/src/aria-snapshot.ts`)
solves all of these with a CDP-based engine: `Accessibility.getFullAXTree` +
`DOM.getFlattenedDocument`, cross-referenced by `backendNodeId`, with frame/locator/
interactiveOnly scoping and OOPIF stitching.

## 2. Goal

Replace BrowserForce's DOM-walker snapshot with a **CDP `Accessibility.getFullAXTree`
engine** ported from Playwriter, using **standard `playwright-core` only** (no
`@xmorse` fork, no `async-sema`, no new dependencies), delivering:

- `backendNodeId`-anchored refs and robust locator generation,
- `frame`, `locator`, and `interactiveOnly` scoping,
- **same-origin AND cross-origin (OOPIF) iframe content**,
- Playwriter's richer output format.

**Done when:** `snapshot({ frame })`, `snapshot({ locator })`, and iframe content
(same-origin + cross-origin) work reliably, and a ref discovered inside a frame can
be acted on (click/type) round-trip.

## 3. Non-Goals

- No relay/extension **protocol** changes for the common path. (Verified: the relay
  already routes CDP commands to child sessions via `childSessions` →
  `cdpCommand{ childSessionId }`, `relay/src/index.js:1589-1616`; the extension
  forwards to the child debuggee, `extension/background.js:572-576`. A *small* relay
  tweak to `Target.attachToTarget` for OOPIF session acquisition may be required —
  see §9 spike.)
- No change to `a11y-labels.js` (the `screenshot_with_labels` CDP path). The new
  engine is designed so that path *could* adopt it later, but that refactor is out
  of scope.
- No new npm dependencies (AGENTS.md hard rule: relay = `ws` only; MCP =
  `playwright-core` only).
- No second/fallback snapshot engine (see §4, Decision 1).

## 4. Decisions (resolved with user)

1. **Hard replace, no fallback engine.** The DOM walker is removed, not retained as
   a fallback. Analysis showed no durable case where the walker beats CDP AX: both
   require the debugger; CDP injects nothing (better under strict CSP); AX nodes
   carry `value`/`checked`/`expanded`/`disabled` (form state, the original 2026-02
   rationale, is covered). The only real risk — an empty/not-yet-computed AX tree —
   is handled *inside* the engine (`Accessibility.enable` → empty-tree detection →
   bounded retry → explicit error), not by a parallel engine that would silently
   degrade to weaker output and mask AX failures.
2. **Cross-origin OOPIF is in v1**, built as Phase 2 after same-origin (Phase 1).
3. **Do not unify `a11y-labels.js`.** Protect the working screenshot-label feature;
   keep its CDP path untouched this iteration.
4. **Adopt Playwriter's richer output format** (inline locators, `>> nth=N`
   disambiguation, frame breadcrumbs). This is a breaking change to agent-facing
   text → `help-docs.js` and the execute prompt are updated in lockstep.

## 5. Architecture

New module: **`mcp/src/aria-snapshot-engine.js`** (pure CDP + logic). `snapshot.js`
**stays** — it still owns shared constants (`INTERACTIVE_ROLES`, `CONTEXT_ROLES`,
`TEST_ID_ATTRS`), `createSmartDiff`, and `parseSearchPattern`, which are consumed by
`clean-html.js`, `page-markdown.js`, and `a11y-labels.js`. The DOM-walker tree
builder (`buildSnapshotText`, `annotateStableAttrs`, `walkAxTree`, `buildLocator`,
`hasInteractiveDescendant`) is replaced by the new engine's renderer.

```
snapshot()/buildSnapshotData()  (exec-engine.js)
        │
        ▼
aria-snapshot-engine.js  ── getAriaSnapshot({ page, frame, locator, interactiveOnly, search })
        │  1. acquire CDP session (reuse getCDPSession / context.newCDPSession(page))
        │  2. Accessibility.enable + DOM.enable
        │  3. DOM.getFlattenedDocument({ depth:-1, pierce:true })  → domByBackendId
        │  4. Accessibility.getFullAXTree([{ frameId }])           → axByBackendId
        │  5. (Phase 2) for each cross-origin OOPIF: child session → fetch + stitch
        │  6. filter (interactiveOnly | full), scope (locator data-pw-scope)
        │  7. generate refs + locators (stable test-id/id → CSS attr; else role+name; nth)
        │  8. render Playwriter-style text + return { text, refs, getLocatorForRef }
        ▼
exec-engine: store ref→{locator, frameChain} map; expose refToLocator + locatorForRef
        │
        ▼ (transparent through relay → extension → chrome.debugger)
Chrome
```

## 6. Component Design

### 6.1 Session acquisition
Reuse the existing `getCDPSession` helper / `page.context().newCDPSession(page)`
(already proven in `a11y-labels.js:430`). All AX/DOM CDP commands flow transparently
through the relay (they are not in `INIT_ONLY_METHODS`, so they forward to the
extension as generic `cdpCommand`s).

### 6.2 Data fetch + cross-reference
- `DOM.getFlattenedDocument({ depth:-1, pierce:true })` → array of DOM nodes with
  `backendNodeId`, attributes, `parentId`. Build `domByBackendId` and a
  `childrenByParent` index.
- `Accessibility.getFullAXTree([{ frameId }])` → AX nodes with `backendDOMNodeId`,
  `role`, `name`, `properties`. Build `axByBackendId`.
- Fetch the two **back-to-back with no awaits between** to minimise backendNodeId
  staleness on mutating pages.

### 6.3 Filtering
Port Playwriter's two filters using BrowserForce's existing role sets:
- `interactiveOnly: true` → interactive + label + context roles; collapse unnamed
  wrappers (`generic`/`none`/`presentation`/`group` without name).
- `interactiveOnly: false` → everything with a name or relevant children.

### 6.4 Ref + locator generation
- Walk DOM attributes (via `backendNodeId` → `domByBackendId`) for stable IDs in
  `TEST_ID_ATTRS` order, then `id`. Found → `ref = value`, `selector =
  [attr="value"]`. Duplicate stable values → `-2`, `-3` suffix.
- No stable attr → sequential `e1`, `e2`, … (`shortRef`).
- Fallback locator → `role=<role>[name="<escaped>"]`; contenteditable →
  `[contenteditable="true"]`.
- Duplicate final locators → append `>> nth=N`.

### 6.5 Scoping
- **`frame`** (`Frame` | `FrameLocator`): resolve to a `Frame`. Same-origin →
  pass `{ frameId }` to `getFullAXTree`. Cross-origin OOPIF → §6.6.
- **`locator`**: `locator.evaluate(el => el.setAttribute('data-pw-scope', <uuid>))`,
  find that node in the flattened DOM, compute the set of `backendNodeId`s beneath
  it, filter the AX tree to that set, and **remove the attribute in `finally`**.
- **`interactiveOnly`**: selects the filter in §6.3.

### 6.6 Cross-frame strategy (phased)
- **Phase 1 — same-origin:** A single `getFullAXTree` on the page session already
  includes same-process subframes; `pierce:true` covers their DOM. No stitching
  needed beyond honouring `frameId` nodes.
- **Phase 2 — cross-origin OOPIF:** Enumerate OOPIF frames (`page.frames()` filtered,
  or AX iframe nodes whose content lives in another target). For each: obtain a CDP
  session bound to that child target (`context.newCDPSession(frame)` — see §9 spike),
  fetch its AX + flattened DOM, and **stitch** the child root at the parent's
  `<iframe>` AX node. Record each in-frame ref's **frame chain** for action
  resolution (§6.8).

### 6.7 Output format (Playwriter-style)
Inline locator per node, `:` for parents with relevant children, `>> nth=N`
disambiguation, and a frame breadcrumb when a subtree belongs to a child frame.
Each interactive node keeps a trailing `[ref=eN]` token so agents retain a stable,
**frame-safe** handle (a bare locator string cannot reach into a frame). Header
(`Page: <title> (<url>)` + ref count) and `createSmartDiff` behaviour are preserved.

### 6.8 Acting on refs (frame-aware)
- `refToLocator({ ref })` → **string** (unchanged contract for top-frame refs;
  returns `null`/top-frame locator for in-frame refs).
- **New** `locatorForRef({ ref })` → a ready Playwright `Locator`, built through the
  `frameLocator(<iframe-selector>)` chain when the ref lives in a subframe. This is
  the robust path for cross-frame actions. Both are exposed in the execute context.

### 6.9 Robustness
`Accessibility.enable` before `getFullAXTree`; if the tree is empty/sparse, one
bounded retry after a short delay; if still unavailable, throw a descriptive error
(no silent fallback). OOPIF child sessions are detached in `finally`.

## 7. Integration Points (files touched)

| File | Change |
|---|---|
| `mcp/src/aria-snapshot-engine.js` | **New** — the CDP AX engine. |
| `mcp/src/exec-engine.js` | Remove `getAccessibilityTree` + `getStableIds`; re-point `snapshot()`, `buildSnapshotData()`, `screenshotWithAccessibilityLabels()` to the engine; add `frame`/`locator`/`interactiveOnly` options; add `locatorForRef`; store frame chain in the ref map; expose `locatorForRef` in `buildExecContext`. |
| `mcp/src/snapshot.js` | Keep shared constants, `createSmartDiff`, `parseSearchPattern`. Remove DOM-walker-specific builders now owned by the engine. |
| `mcp/src/help-docs.js` | Rewrite the `snapshot` help section for the new format + `frame`/`locator`/`interactiveOnly` + `locatorForRef`. |
| `mcp/src/index.js` | Update `EXECUTE_PROMPT` if it references snapshot shape/usage. |
| `docs/knowledge/` + `AGENTS.md` | Timeline entry; AGENTS.md "Critical Patterns" updated (engine swap, new contract). |

## 8. Testing

Relay integration tests (real Chrome via relay; **all** `relay.start({ writeCdpUrl:false })`):
- Main-frame snapshot renders interactive elements with refs + inline locators.
- `interactiveOnly: true` vs full differ as expected.
- `locator` scoping limits output to the subtree; `data-pw-scope` attr is cleaned up.
- `frame` scoping (same-origin) returns only that frame.
- **Same-origin iframe** content appears in a page snapshot.
- **Cross-origin OOPIF** content appears and is stitched at the iframe node.
- **Ref→action round-trip across a frame boundary**: snapshot → `locatorForRef` →
  click → observable effect.
- `refToLocator` back-compat for top-frame refs.
- Empty-AX retry path throws a clear error rather than degrading.

## 9. Risks & Mitigations

1. **OOPIF session acquisition over `connectOverCDP`** (primary risk). The relay's
   `Target.attachToTarget` handler (`relay/src/index.js:1273`) only knows main
   targets; child sessions live in `childSessions`. **Mitigation: a focused spike
   first** — confirm `context.newCDPSession(frame)` yields a session whose commands
   the relay routes to the child session; if not, add a minimal relay branch that
   resolves `Target.attachToTarget` for known OOPIF targets. This spike gates Phase 2
   and may add the *only* relay change.
2. **backendNodeId staleness** between the AX and DOM calls on mutating pages →
   fetch back-to-back; tolerate missing matches gracefully.
3. **Format change breaks agent expectations** → update `help-docs.js` +
   `EXECUTE_PROMPT` in the same change; keep the `[ref=eN]` handle and header so the
   action model is stable.
4. **`screenshotWithAccessibilityLabels` box positioning** currently uses
   `locator.boundingBox()`; refs still carry locators, so it keeps working —
   verified as a test assertion.

## 10. Phasing

- **Phase 0 — spike:** OOPIF session acquisition (Risk 1). Decide engine-only vs.
  small relay tweak.
- **Phase 1:** Engine + main-frame + same-origin frames + `interactiveOnly`/`locator`/
  `frame` scoping + robust refs/locators + new output format + docs. Hard-replace the
  DOM walker. Full test suite green.
- **Phase 2:** Cross-origin OOPIF stitching + frame-aware `locatorForRef` +
  cross-frame action tests.
