# Ghost Cursor Agent Label — Design

**Date:** 2026-09-11
**Status:** Proposed (Codex round 1 findings folded in)

**Scope — art:** `extension/assets/ghost-cursor.png` (see §8)
**Scope — code:** `extension/ghost-cursor.js`, `extension/background.js`,
`relay/src/index.js`, `mcp/src/client-label.js`, `mcp/src/index.js`, `bin.js`,
`cli/sessiond.js`
**Scope — tests:** `test/agent/ghost-cursor.test.js`,
`relay/test/relay-server.test.js`, `mcp/test/client-label.test.js`
**Scope — docs:** `AGENTS.md` (incl. the `cdpCommand` protocol row and the
extension-protocol non-goal — see §6), `skills/browserforce/SKILL.md`

`pnpm test` must be green at the end (995 tests pass on `main` today).

## Problem

BrowserForce supports several concurrent CDP clients driving one real Chrome
(per-client active tabs, per-agent windows). When a cursor moves on a page the
user has no way to tell *which* agent is driving — Claude, Codex, a subagent, or
a script they started an hour ago. The ghost cursor is the one surface already
rendering agent activity in the page, and it renders anonymously.

## Goal

An agent can declare a short display name. When the ghost cursor is on, that name
renders in a small chip attached to the cursor, so the user can attribute every
movement to a named agent.

## Non-goals

- **Not a security control.** Any CDP client can already run arbitrary JS in any
  page; a client can therefore draw or remove any overlay, this one included. The
  chip is attribution for a cooperating agent, not attestation.
- **Not the only "who is driving" surface, and not the best one.** The ghost
  cursor is **default OFF**, so the chip reaches only users who opted in.
  Always-on surfaces (Chrome tab-group title, popup "currently driving" line) are
  the right primary answer and are deliberately deferred to a follow-up — they
  are independent of this change and should not be bundled into it.
- **No auto-detection of the agent's identity.** No UA sniffing, no
  `CLAUDECODE`-style env probing. Those are guesses that go stale; the agent
  states its own name or gets no chip.
- **No agent-name reporting in `browserforce status`.** Considered and dropped:
  the limit is documented and deterministic, and the chip itself is the feedback
  loop. Adding it would need the sanitizer in two runtimes (relay is CJS, the CLI
  is ESM) and buys a round-trip the agent does not need.

## Design

### Wire path

```
BROWSERFORCE_AGENT_NAME=Claude          (agent process env)
  → withAgentName(cdpUrl)               mcp/src/client-label.js
  → ws://…/cdp?token=…&agentName=Claude
  → relay: sanitizeAgentName() at connect → clientMeta.agentName
  → relay: payload.agentName on forwarded cdpCommand (omitted when absent)
  → extension: cdpCommand({ …, agentName }) → handleGhostCursorInput
  → ghost-cursor: action.label (key omitted when absent)
  → page: Runtime.evaluate(applyMouseAction({…, label})) → chip textContent
```

### 1. Agent side — `withAgentName(cdpUrl)`

New export in `mcp/src/client-label.js`, beside the existing `withClientLabel`:

```js
export function withAgentName(cdpUrl) {
  const agentName = process.env.BROWSERFORCE_AGENT_NAME;
  if (!agentName) return cdpUrl;
  try {
    const url = new URL(cdpUrl);
    if (!url.searchParams.get('agentName')) url.searchParams.set('agentName', agentName);
    return url.toString();
  } catch {
    return cdpUrl;
  }
}
```

The composition is **not** left to three hand-written call sites. A second
export in the same module owns it:

```js
// The one place that decides which wrappers a connect URL gets.
export function agentCdpUrl(cdpUrl, { durableLabel = true } = {}) {
  return withAgentName(durableLabel ? withClientLabel(cdpUrl) : cdpUrl);
}
```

Call sites become one line each, and none of them composes anything:

```js
// mcp/src/index.js:67, cli/sessiond.js:67
const cdpUrl = agentCdpUrl(await getCdpUrl());
// bin.js#connectBrowser — one-shot path, no durable affinity label
const cdpUrl = agentCdpUrl(await getCdpUrl(), { durableLabel: false });
```

**Why the helper rather than `withAgentName(withClientLabel(url))` spelled out
three times.** Three hand-composed sites are three places the composition can
drift, and the only thing a test could check at each is that the right text is
present. With `agentCdpUrl` the composition itself is a pure function with a
behavioural test (both modes × env set/unset), and what remains per call site is
a single call whose presence a grep genuinely can prove.

Dropping `withClientLabel` from the MCP or sessiond path would delete the durable
window-affinity key and put back the reconnect-spawns-a-new-window bug that
`mcp/src/client-label.js` exists to prevent; `durableLabel: false` is the one
deliberate exception, for `bin.js`'s one-shot path (see below).

**Why a separate helper rather than folding it into `withClientLabel`:** the
`label` param is the *durable window-affinity key* (AGENTS.md "Affinity
keying"). `bin.js`'s one-shot path deliberately does not send one, and making it
send one would silently change which Chrome window one-shot commands open tabs
in. `agentName` is display-only and is never read by `_affinityKey`, so it can
be added to all three sites with no behavioural change.

The value is passed **raw**. The relay sanitizes; a hand-crafted query param must
never bypass the policy, so the relay is the single authority.

**The label identifies a CDP connection, not a CLI invocation.** This matters at
exactly one entrypoint:

| Entrypoint | Connection lifetime | Attribution |
|---|---|---|
| MCP (`mcp/src/index.js`) | one per MCP process | per agent — correct |
| one-shot CLI (`bin.js -e`, `screenshot`, …) | one per invocation | per invocation — correct |
| session daemon (`cli/sessiond.js`) | **one, shared, long-lived** | per **daemon**, not per caller |

The daemon opens a single CDP connection and reads `BROWSERFORCE_AGENT_NAME`
from *its own* environment at connect time. A second agent whose
`browserforce click` is served by that already-running daemon is therefore
labelled with the daemon's name — the first agent's, or none — no matter what
its own environment says. Per-invocation labelling is not reachable from here:
Playwright offers no way to attach per-command metadata to an established CDP
connection, so the only alternative would be a connection per CLI call, which is
the cost the daemon exists to avoid.

This is documented, not worked around. `skills/browserforce/SKILL.md` already
teaches the fix for the adjacent problem (a subagent that needs its own session
exports `BF_SESSIOND_LOCK_PATH=/tmp/bf-<name>.json`), and that same flag gives it
its own daemon and therefore its own label. The SKILL.md block added in §7 states
both halves: export `BROWSERFORCE_AGENT_NAME`, and if you share a machine with
other agents and want your own name on the cursor, export a distinct
`BF_SESSIOND_LOCK_PATH` too.

Acceptance criterion 7 (two agents on one tab, chip names whoever moved) holds
for MCP and one-shot CLI. Under a shared daemon the two agents *are* one CDP
client, so the chip names the daemon — coarse, but never wrong about which
connection is driving.

### 2. Relay — sanitize at the connect boundary (the only authority)

New pure function beside the existing `sanitizeClientLabel` in
`relay/src/index.js`:

```js
const AGENT_NAME_MAX_LENGTH = 24;

// Display-only agent name rendered into a real page by the ghost cursor.
// Bidi controls are stripped explicitly: they visually reverse the text that
// follows and would let a name reorder the fixed "BrowserForce" prefix it is
// supposed to sit behind.
function sanitizeAgentName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, AGENT_NAME_MAX_LENGTH);
}
```

Read at `/cdp` connect from `?agentName=`, stored on `clientMeta.agentName`.

`sanitizeAgentName` is added to `relay/src/index.js`'s `module.exports`
(currently `{ RelayServer, DEFAULT_PORT, BF_DIR, TOKEN_FILE, CDP_URL_FILE }`) so
its edge-case contract can be unit-tested directly. Its non-string and
whitespace-only cases are unreachable through a WebSocket URL, so testing them
through the server would mean either duplicating the function in the test or
leaving the contract unverified.

**`AGENT_NAME_MAX_LENGTH` exists in exactly one place.** No component downstream
of the relay re-applies the length rule. Truncating twice with two constants is
how the documented limit silently becomes something else.

**Sanitize, never reject.** A cosmetic label must not fail a click: an
unrepresentable name degrades to a shorter name or to no chip, and the command
proceeds either way.

### 3. Relay — annotate forwarded commands

`_forwardToTab()` already conditionally tags payloads (`payload.passive`). Add,
at each of its **three** payload construction sites (primary target, alias
session, child session).

`_agentNameFor(clientId)` returns
`this.clientById.get(clientId)?.agentName || null`, and is called **exactly
once** — in a `const agentName = this._agentNameFor(clientId);` on the first line
of `_forwardToTab()`, before any branch and before any `await`. The three
branches read that local; none of them calls `_agentNameFor` again.

**Why the single pre-await capture.** The
unattached path awaits `_ensureDebuggerAttached()`, and a client that disconnects
during that await has already been erased from `clientById` by the close handler
(`relay/src/index.js:1251-1260`) — a live lookup afterwards returns `null` and
the in-flight command reaches the extension unattributed. Capture the sanitized
name into a local at function entry and pass that local to all three branches.

**The traffic log must carry it too**, or the field is invisible in
`~/.browserforce/cdp.jsonl` and the browser verification below has nothing to
check. All three branches today build `payload` *after* calling `_logCdp()`, so
each one must be reordered into this exact sequence — building the payload first
and deriving the log line from it is what makes the log evidence about the
**forwarded payload** rather than about the connection:

```js
// 1. Build the payload (unchanged fields first).
const payload = { tabId: target.tabId, method, params: params || {} };
if (INIT_ONLY_METHODS.has(method)) payload.passive = true;

// 2. Attach the optional agent name — `agentName` is the local captured on
//    the first line of _forwardToTab(), NOT a fresh lookup here.
if (agentName) payload.agentName = agentName;

// 3. Log, deriving the new field from the payload that is about to be sent.
this._logCdp({
  direction: 'to-extension',
  clientId,
  message: {
    id,
    method,
    params: params || {},
    sessionId,
    tabId: target.tabId,
    ...(payload.agentName ? { agentName: payload.agentName } : {}),
  },
});

// 4. Forward.
return this._sendToExt('cdpCommand', payload);
```

`passive` is deliberately **not** spread into the log message: the existing log
shape stays exactly as it is apart from the one new optional field.

All three sites get it so command provenance does not depend on which session
kind a command happened to route through. Annotating every forwarded command
(rather than only `Input.dispatchMouseEvent`) keeps the relay free of
cursor-specific knowledge: it states provenance, the extension decides what to do
with it. The added payload is ≤24 bytes.

**Absent means absent.** A client with no name adds no key, so the payload is
byte-identical to today's — which is also what keeps an old extension working
against a new relay.

### 4. Extension — thread the name through

- `cdpCommand({ tabId, method, params, childSessionId, agentName })` passes
  `agentName` into `handleGhostCursorInput({ …, agentName })`.
- `handleGhostCursorInput` passes it to `buildGhostCursorAction({ type, params,
  agentName })`.
- `buildGhostCursorAction` returns the existing `{ type, x, y, button }` and adds
  `label: agentName` **only when `agentName` is a non-empty string**. No
  truncation, no character filtering — that policy lives once, in the relay
  (§2).

Omitting the key rather than emitting `label: ''` is load-bearing twice: the
unlabelled wire payload stays byte-identical to today's, and the existing
`deepEqual` assertions in `test/agent/ghost-cursor.test.js:143-159` keep passing
unchanged instead of being rewritten around a field that carries no information.

`handleGhostCursorInput` keeps its existing guards unchanged: child sessions and
non-mouse methods still return `false` before any cursor work.

### 5. In-page renderer — the chip

#### Structure

Three new constants beside `CURSOR_ID`:

Every geometry and typography value is a named constant beside the renderer's
existing `CURSOR_SIZE_PX` / `CURSOR_Z_INDEX` block — no literals inline in the
style writes:

```
CHIP_ID            = '__browserforce_ghost_cursor_label__'
AGENT_ID           = '__browserforce_ghost_cursor_agent__'
CHIP_PREFIX_TEXT   = 'BrowserForce ·'
CHIP_PREFIX_GAP_PX = 4
CHIP_OFFSET_X_PX   = CURSOR_SIZE_PX - 4
CHIP_OFFSET_Y_PX   = CURSOR_SIZE_PX + 2
CHIP_MAX_WIDTH_PX  = 360   // see width arithmetic below
CHIP_PADDING       = '2px 6px'
CHIP_RADIUS_PX     = 4
CHIP_FONT          = '500 11px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
CHIP_BACKGROUND    = 'rgba(17, 17, 17, 0.9)'
CHIP_SHADOW        = '0 1px 3px rgba(0, 0, 0, 0.45)'
CHIP_PREFIX_COLOR  = 'rgba(255, 255, 255, 0.62)'
CHIP_NAME_COLOR    = '#ffffff'
```

The chip is a child of the **outer** element and a **sibling** of the scaling
`inner` element, so a press animation scales the arrow and not the text. It holds
exactly two inline spans: a renderer-owned prefix whose `textContent` is exactly
`CHIP_PREFIX_TEXT`, and the agent name (id `AGENT_ID`). Both are written with
`textContent`, never `innerHTML`.

**`CHIP_MAX_WIDTH_PX` is sized so the documented 24-character limit survives
intact**, rather than being a round number the limit can exceed. Worst case at
`500 11px` in the system stack: 24 capital `W`s ≈ 9px each ≈ 216px, plus the
`BrowserForce ·` prefix ≈ 84px, plus `CHIP_PREFIX_GAP_PX`, plus 12px horizontal
padding ≈ 316px. 360px clears that with margin for a wider fallback face. The
`overflow: hidden` + `text-overflow: ellipsis` below is therefore a backstop for
an exotic fallback font, not the normal path — an agent that respects the
documented limit never sees its name clipped. Because the name span is last, a
clip that does happen eats the name, never the prefix, which keeps the
attribution honest.

Separation between them is a **`CHIP_PREFIX_GAP_PX` right margin on the prefix
span**, not a trailing space in the text. `all: initial` (below) resets
`white-space` on each span, so a trailing space would be collapsible and the chip
could render `BrowserForce ·Claude`. A margin cannot collapse away.

Because it lives inside `outer`, it inherits the cursor's translation and
`aria-hidden="true"` for free.

#### Lifecycle — lazy, and rebindable

`runtime.labelText` (a string, default `''`) is the **single source of truth**;
the DOM is a reflection of it:

- `setLabelText(text)` — returns early when unchanged, else stores and calls
  `syncLabel()`.
- `syncLabel()` — reflects `runtime.labelText` into the DOM:
  - empty text → remove the chip element if present, null the refs, return.
    A client that sends no name therefore leaves **no extra DOM at all**, not a
    hidden node.
  - non-empty and `runtime.outerElement` exists → create the chip if missing,
    then set the agent span's `textContent`.
  - non-empty and no outer element yet → do nothing; the state is retained and
    replayed on mount.
- `applyMouseAction(action)` calls `setLabelText(action.label || '')` first, so
  an unlabelled client's event clears a chip a labelled client left behind.
  Two agents on one tab: the chip names whoever dispatched the current event.
- `disable()` removes `outer` (chip included), nulls the chip refs and resets
  `runtime.labelText = ''`.

Three failure modes this shape exists to close, all found in review:

1. **Upgrade over an already-mounted legacy cursor.** `ensureCursorElement()`
   reuses an existing element found by `CURSOR_ID` (`extension/ghost-cursor.js:95-101`).
   A cursor mounted by the previous extension build has no chip, and a naive
   implementation would reuse it forever and never show a label. So
   `ensureCursorElement()` **rebinds** `runtime.labelElement` /
   `runtime.labelTextElement` by id from the reused subtree (both `null` when
   absent — `syncLabel()` then creates them on demand), and calls `syncLabel()`
   after any mount or reuse.
2. **Downgrade after a labelled cursor was injected.** The reuse-by-id path runs
   in the *old* renderer too, and it never removes children it does not
   recognise. Roll back to a pre-label extension build while a chip is mounted
   and the old renderer will reuse the outer element, leaving a frozen chip
   naming an agent that is no longer driving — false attribution, which is worse
   than none. The new code cannot fix the old code, so this is a documented
   procedure rather than a code path: **turn the ghost cursor off in the popup
   before downgrading** (`disable()` removes the whole outer element, chip
   included, on every attached tab), or reload the affected tabs afterwards.
   Recorded in `AGENTS.md`; the mechanism it relies on is covered by the
   `disable` test below, which asserts no element with `CHIP_ID` survives
   anywhere in the document.
3. **Mount deferred to `DOMContentLoaded`.** The existing code roots the cursor
   at `document.documentElement || document.body` and only defers when **both**
   are absent — keep that fallback exactly as it is. In that window
   `ensureCursorElement()` returns `null` and defers. A mouse event
   arriving in that window must not lose its name — which is exactly why the
   label lives in `runtime.labelText` rather than being written straight to the
   DOM, and why mount ends with `syncLabel()`.

#### Styling — isolated from the page

The chip is bare light DOM inside a page whose CSS it does not control. Reset
first, then style:

```
el.style.all = 'initial';      // MUST be the first assignment — CSSOM order
el.style.position = 'absolute';
el.style.display = 'block';    // `all: initial` resets display to `inline`
el.style.boxSizing = 'border-box';
el.style.direction = 'ltr';
el.style.unicodeBidi = 'isolate';
```

`all: initial` must be the first property written on **each** element: in an
inline style block a later longhand overrides the earlier `all` shorthand, and
the reverse order would wipe every style set before it.

The chip and its spans then take **different** style sets — they are not
interchangeable, and applying the chip's box properties to the spans would stack
the prefix above the name instead of running them inline:

- **Chip element** (after the reset): `position: absolute`, `display: block`,
  `left: CHIP_OFFSET_X_PX`, `top: CHIP_OFFSET_Y_PX`, `pointer-events: none`,
  `white-space: nowrap`, `max-width: CHIP_MAX_WIDTH_PX`, `overflow: hidden`,
  `text-overflow: ellipsis`, `padding: CHIP_PADDING`,
  `border-radius: CHIP_RADIUS_PX`, `background: CHIP_BACKGROUND`,
  `box-shadow: CHIP_SHADOW`, `font: CHIP_FONT`.
- **Both spans** (after the reset): `display: inline` — never `block` and never
  `position: absolute` — plus their own `font`, `color` and
  `white-space: nowrap` and `pointer-events: none`, because `all: initial`
  blocks inheritance from the chip. The `pointer-events` reset is the dangerous
  one: `all: initial` restores `auto`, and a `pointer-events: auto` child inside
  a `pointer-events: none` parent **is** hit-testable, so an unset span would
  swallow real clicks landing under the label — breaking the cursor's
  cosmetic-only contract.
  Without the span-level `nowrap`, a name containing a space (`Claude Opus 5`)
  wraps inside a chip whose own `nowrap` no longer reaches it, and the one-line
  chip plus its ellipsis behaviour break. Prefix:
  `color: CHIP_PREFIX_COLOR`, `margin-right: CHIP_PREFIX_GAP_PX`. Name:
  `color: CHIP_NAME_COLOR`.

`box-sizing: border-box`, `direction: ltr`, `unicode-bidi: isolate`,
`white-space: nowrap` and `pointer-events: none` are set on the chip and on both
spans.

**Isolation limit (explicit).** Inline styles, `all: initial` included, lose to a
page rule carrying `!important`. A page with `div, span { display: none
!important }` can hide the chip, and one with `pointer-events: auto !important`
can make it clickable. This is **not** hardened here, and `!important` is
deliberately not used: the existing arrow renderer (`outer` / `inner`) has the
identical exposure today, so hardening the chip alone would buy nothing — a page
that can hide the chip can hide the cursor it labels. The guarantee this design
makes is against *accidental* page CSS (broad `div`/`span` rules, global RTL,
inherited fonts), not against a page actively fighting the overlay. Hardening
both elements is a separate change.

`direction: ltr` + `unicode-bidi: isolate` are not cosmetic: a page with a global
RTL direction would otherwise reorder the chip so the agent name renders *before*
the `BrowserForce` prefix, defeating §5's anti-impersonation property from the
page side rather than the agent side.

**Why inline resets and not a shadow root.** A shadow root is stronger against
page CSS, but attaching one to `outer` changes the element tree that the existing
arrow renderer depends on (`ensureCursorElement()` re-acquires `inner` via
`existing.firstElementChild`). That is a restructure of working, shipped code to
harden a cosmetic overlay that is explicitly not a security control. Inline
resets are scoped to the new elements and touch nothing that renders today.
Revisit if a real page is found that defeats them.

#### Idle fade and press scale

Idle-hide currently animates `inner.style.opacity` directly. The chip must fade
and wake with the arrow, so **every** opacity write — idle fade, wake, and the
`opacity = 1` inside `setPressed()` — goes through one helper that applies
opacity and transition to `inner` **and** the chip when it exists. No exemption:
an exempted write is how the arrow and the chip drift to different opacities.
The *scale* transform stays on `inner` alone, because the chip must not grow and
shrink with a click.

#### Anti-impersonation

**The fixed prefix is not optional.** Free agent-supplied text painted over a
logged-in page is a phishing primitive — a prompt-injected agent would label
itself `Chrome — confirm your password`. Rendering the agent's string *alone* is
what makes that work. Renderer-owned BrowserForce chrome always wraps it, with
the agent name as a secondary chip. Never render the agent string as the whole
chip.

### 6. Protocol change — must be authorised, not slipped in

`agentName` is a **new field on the Relay→Extension `cdpCommand` message**, and
`AGENTS.md:453` currently reads "No extension protocol changes beyond the
`ownerKey` field on `createTab`/`closeTab`". Implementing this spec without
amending that line ships a change the project's own rules forbid. Two edits, in
the same commit as the code:

- `AGENTS.md:75` — the `cdpCommand` row becomes
  `{ tabId, method, params, childSessionId?, passive?, agentName? }`. (`passive`
  is already sent today and was never added to the table; fixing that is part of
  making the row true.)
- `AGENTS.md:453` — the non-goal is amended to name this carve-out explicitly:
  optional, additive, display-only fields on `cdpCommand` that an older
  extension ignores. The non-goal's intent — no *structural* protocol change, no
  new message types, no required fields — is preserved and restated.

The carve-out is defensible precisely because the field is optional and absent
when unused: an old extension ignores it, and a new extension against an old
relay simply never sees it (§3).

### 7. Docs

- `AGENTS.md` — extend the "Ghost Cursor" section with the label path, the
  sanitize-once-in-the-relay rule, the omit-when-absent wire contract, the
  fixed-prefix rationale, the downgrade procedure from §5, and the per-daemon
  attribution limit from §1.
- `skills/browserforce/SKILL.md` — a short block with **both** halves:
  1. Export `BROWSERFORCE_AGENT_NAME` with your own name. Limit **24
     characters**, allowlist `A–Z a–z 0–9 space . _ -`. Anything outside the
     allowlist is **stripped, not rejected**; runs of whitespace collapse to a
     single space and the result is trimmed; anything still longer than 24
     characters is truncated; and a name that sanitizes to nothing (emoji-only,
     whitespace-only) yields **no chip at all** rather than an empty one. Pick a
     name that survives intact rather than one that gets rewritten.
  2. If other agents share this machine and you want **your own** name on the
     cursor, export a distinct `BF_SESSIOND_LOCK_PATH=/tmp/bf-<name>.json` too.
     The session daemon holds one shared CDP connection and takes its name from
     whichever environment started it, so without your own daemon your commands
     are attributed to the daemon's name — the first agent's, or none (§1).
     This is the same flag SKILL.md already teaches for a subagent that needs
     its own session state.

### 8. New cursor art (owner-supplied, same commit)

`extension/assets/ghost-cursor.png` is replaced with the owner's
`browserforce-cursor.png`. **No code change** — the file name, the manifest
`web_accessible_resources` entry and `GHOST_CURSOR_IMAGE_URL` are all unchanged.

The source art is 512×512 with the arrow occupying only its centre
(alpha bbox `(166,126)-(352,372)`). Dropped in as-is it would render at roughly
60% scale inside the 22px box and point about 7px down-right of the actual click
coordinate, because the renderer places the element's **top-left** at the click
point (`MINIMAL_HOTSPOT_X_PX`/`Y_PX` are both `0`) and paints the image
`background-size: contain`. So the art is normalised to the existing 128×128
convention: crop to the alpha bounding box, scale height-limited to
`128 − 4`, and paste at the canvas top-left with a 4px top margin so the drop
shadow is not clipped. Result: content bbox `(0,4)-(94,128)`, tip at `(5,4)`.

**Reproducible derivation.** The 512×512 source is the owner's file and is not
committed (nothing in the build reads it). It is pinned here instead:

| | |
|---|---|
| source | `~/Downloads/browserforce-cursor.png`, 512×512 RGBA |
| source sha256 | `7658fe1cdd1ffeb2eef5e347fd2aef8fb68586b884adc0714e930aa7569461a4` |
| crop | alpha bounding box at threshold `>8` → `(166,126)-(352,372)` |
| scale | height-limited to `128 - 4 = 124`, Lanczos |
| paste | `(0, 4)` on a 128×128 fully transparent RGBA canvas |
| output | `extension/assets/ghost-cursor.png`, 128×128 RGBA, content bbox `(0,4)-(94,128)`, tip `(5,4)` |
| output sha256 | `d020a34b284ecfb1d795abd492a4067df7a2e0b9676317323ea85d783cfd5e05` |

Anyone with the source can regenerate a byte-identical file from those
parameters, and the output hash is checkable without it.

This moves the visible tip closer to the true click point than the outgoing art,
whose tip sat at `(43,0)` — a third of the way across the canvas — visually
offset because that art carried decorative sparkles to the left of the arrow.
The new art has none, so keeping the old framing would have left the arrow
right-shifted and overflowing the canvas. Called out because it is a visible
change to where the cursor appears to point, not a pure asset swap.

## Testing

The renderer is already executable in tests: `test/agent/ghost-cursor.test.js`
runs `GHOST_CURSOR_SOURCE` through `node:vm` against a fake DOM
(`createFakeRendererRuntime`). The new tests are **behavioural**, driving
`applyMouseAction` and asserting DOM state — not string matching on the source.

The fake DOM needs two small extensions, both in the test file: record
`document.addEventListener` listeners so the deferred-mount case can be fired,
and allow `documentElement` to be absent.

### Renderer behaviour

| Test | Assertion |
|---|---|
| no label ever sent | no element with `CHIP_ID` exists anywhere in the tree |
| labelled action | chip exists; agent span `textContent` is the name; prefix span `textContent` is exactly `CHIP_PREFIX_TEXT`; prefix span carries the `CHIP_PREFIX_GAP_PX` right margin, so `BrowserForce ·Claude` cannot render |
| label switches agent | second action with a different name updates the span in place, still one chip |
| labelled → unlabelled action | chip element is **removed**, not hidden |
| repeated identical label | no redundant DOM write (chip element identity unchanged) |
| upgrade over legacy cursor | hand-build an outer element with `CURSOR_ID` and a single child, run the new source, dispatch a labelled action → chip is created |
| deferred mount | **both** `documentElement` and `body` null (the code roots at `documentElement || body`), dispatch a labelled action, then fire the recorded `DOMContentLoaded` → chip mounts carrying the name |
| CSS isolation | chip and both spans write `all: initial` **first**, plus `direction: ltr`, `unicode-bidi: isolate`, `box-sizing`. Chip is `position: absolute` / `display: block`; **both spans are `display: inline` and set no `position`** — the regression this guards is the prefix stacking above the name. Both spans also set `white-space: nowrap` and `pointer-events: none` — an unset span would be hit-testable inside the `pointer-events: none` chip and swallow real clicks |
| idle fade | after the idle timer fires, chip opacity matches `inner` opacity (`0`); after a wake action both are `1` |
| press scale | `down` action scales `inner` only; chip has no scale transform |
| press after idle | fire the idle timer (both `inner` and chip at opacity `0`), then dispatch a `down` action → both are back at `1`; the arrow and the chip never hold different opacities |
| disable | no element with `CHIP_ID` survives anywhere in the document and label state is cleared; a later labelled action after re-enable re-creates it. This is the mechanism the documented downgrade procedure relies on |

### Unit / wire

| Area | Test |
|---|---|
| `sanitizeAgentName` (exported from `relay/src/index.js`) | plain name passes; `>24` truncates to 24; bidi and control chars stripped; emoji stripped; whitespace-only → `null`; non-string → `null`; internal whitespace collapsed |
| `withAgentName` | env unset → url unchanged; env set → param added; pre-existing param preserved; malformed url returned as-is |
| relay forwarding | a client connected with `?agentName=` gets `payload.agentName` on a forwarded `cdpCommand`; a client without one produces a payload with **no** `agentName` key. Asserted on **all three** branches of `_forwardToTab`: primary target, alias session (driven by `Target.attachToTarget` against an already-attached page, `relay/src/index.js:1830-1871`), and child session. Every one of the three payload sites is a place attribution can silently regress. |
| `buildGhostCursorAction` | `label` present with a name; **key absent** with none; absent for a non-string; no truncation applied |
| existing action tests | `test/agent/ghost-cursor.test.js:143-159` `deepEqual`s pass **unchanged** |
| `handleGhostCursorInput` | child session and non-mouse methods still return `false` (unchanged) |
| in-flight disconnect | a labelled client sends a command that triggers lazy attach, then disconnects during the attach await → the forwarded payload still carries `agentName`, proving the pre-await capture |
| `agentCdpUrl` composition | **behavioural**, on the exported pure function: default mode applies both `withClientLabel` and `withAgentName`; `{ durableLabel: false }` applies only `withAgentName`; asserted with the env var both set and unset, and with a url that already carries a `label` param |
| entrypoint wiring | each of the three connect factories — `mcp/src/index.js`, `cli/sessiond.js`, `bin.js#connectBrowser` — routes its CDP URL through `agentCdpUrl`, and only `bin.js` passes `{ durableLabel: false }`. With composition now behaviourally covered above, what is left per file is a single call site whose presence this assertion genuinely proves. Asserted per file, so one entrypoint silently losing the wrapper cannot leave the suite green. `scripts/repro-tab-handles.mjs` is **intentionally excluded**: it is a developer repro script, not a user entrypoint |

### Browser verification (real Chrome, ghost cursor enabled in the popup)

1. Labelled agent drives a page → chip reads `BrowserForce · <name>`, follows the
   cursor, fades with it.
2. Unlabelled client on the same page → no chip in the DOM (verified by
   evaluating for `CHIP_ID`, not by eye).
3. A name longer than 24 characters → truncated at 24 by the relay.
4. A 24-character worst-case-wide name (`WWWWWWWWWWWWWWWWWWWWWWWW`) → renders in
   full, no ellipsis: `chip.scrollWidth <= chip.clientWidth`.
5. A page with `html { direction: rtl }` → prefix still renders before the name.
6. Wire-level evidence: with the `_logCdp()` change in §3, grep
   `~/.browserforce/cdp.jsonl` for a `to-extension` entry whose `message` carries
   `agentName` for the labelled client, and confirm entries for the unlabelled
   client carry no such key.

## Rejected alternatives

- **Label injected into `GHOST_CURSOR_SOURCE` at controller creation.**
  `createGhostCursorController` builds `cursorSource` once per extension boot; a
  per-agent source would force re-injection per client and break a tab driven by
  two agents. The label rides the per-action payload instead.
- **UA-derived default name.** MCP connects through playwright-core, so the UA
  says `playwright`/`node`, never `claude`. A default that is wrong most of the
  time is worse than no chip.
- **Extension-side re-sanitization or re-truncation.** No security value (the
  same client already forwards arbitrary CDP through the extension) and a second
  copy of the policy drifts from the relay's.
- **Shadow root for the chip.** See §5 — restructures working arrow-rendering
  code to harden a non-security overlay.
- **Hiding the chip with `display: none` when unlabelled.** Leaves DOM in every
  page for every user who never names an agent.
