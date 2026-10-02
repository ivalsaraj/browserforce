# Orphaned Debugger Pauses — Plan

> **Scope as shipped (2026-10-02).** The first PR implements only the
> paused-child-target parts below:
> - relay `pausedChildren`, with per-client engagement, grace, bounded retry
>   and cleanup;
> - extension local resolution, child-session resume on relay socket close,
>   and the pure helper.
>
> The `Fetch` ownership design (`fetchOwners`, serialized transitions, epochs,
> and the extension's `fetchEnabledDebuggees` / generation fence) went through
> six rounds of Codex plan review without converging. It is deferred to a
> follow-up. The extension helper still continues paused requests locally when
> the relay cannot see them, because no client can own them then.

## Symptom

A user tab that an agent has driven stops loading when reloaded: the tab stays
blank or spinning. It recovers as soon as the user clicks **Cancel** on
Chrome's "BrowserForce started debugging this browser" infobar, which detaches
every debugger session.

## Root cause (verified)

1. When Playwright learns about a page, it sends a page-session
   `Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`.
   `Target.setAutoAttach` is in `INIT_ONLY_METHODS`, so the relay synthesizes it
   while the tab is unattached. Once `debuggerAttached` is true, every later
   init storm (each MCP idle-reconnect, each one-shot CLI run, each sessiond
   start) **forwards it to Chrome for real**.
   `~/.browserforce/cdp.jsonl` contains that exact forwarded command.
2. From then on Chrome **pauses every new child target** of that tab at start:
   OOPIFs, dedicated workers, and the service workers the frame auto-attacher
   picks up. It releases a paused target only on `Runtime.runIfWaitingForDebugger`.
   Playwright sends that resume while it is connected.
3. The debugger stays attached after the CDP client leaves: MCP disconnects
   after 15s idle, and a one-shot CLI exits after a single command. Nothing resets
   or resolves the Chrome-side state. The relay's `/cdp` `close` handler
   (`relay/src/index.js`) only cleans up relay bookkeeping.
4. When the user reloads, the new child targets come up paused. Chrome reports
   `Target.attachedToTarget { waitingForDebugger: true }`, which the log also
   shows. The relay broadcasts that event to zero clients, and nobody resumes
   the target. A paused service worker blocks the navigation request, so the
   page stays blank. A paused OOPIF leaves the frame empty and holds the page's
   `load` event.
5. Clicking Cancel detaches the debugger, which drops all of this state and
   releases the paused targets. The page then loads.

The same shape exists for request interception. After a snippet has used
`page.route`/`context.route`, `Fetch.enable` is live in Chrome.
Playwright never sends `Fetch.disable` on disconnect, so every later request
pauses in `Fetch.requestPaused` with no one to continue it.

It also happens while the **relay is down**. The extension keeps its debugger
sessions attached, but `onDebuggerEvent` returns early whenever the relay WS is
not open, so it drops these events.

## Invariant

> Nothing Chrome holds waiting on a debugger reply may stay held when no
> connected agent is going to send that reply, whatever the surface: MCP
> (connected or idle-disconnected), the one-shot CLI/skill, sessiond, or relay
> down.

## Design

The fix resolves orphaned pauses and leaves Playwright's settings alone while
their owner is connected. It does **not** blanket-send
`Target.setAutoAttach { autoAttach: false }` or `Fetch.disable` on every
disconnect. That approach was rejected for three reasons:

- It changes Chrome state that another connected client may depend on. All
  clients share one Chrome session per tab.
- `autoAttach: false` detaches existing OOPIF sessions, which churns the
  relay's `oopifTargets` and hurts snapshot stitching after a reconnect.
- It does not cover a connected client that is unaware of a target.

The one targeted exception is `Fetch.disable`, sent on a debuggee only once
**no open client owns Fetch there**. It is described below.

"Awareness" is always tracked **per client**. "Some client is connected" is
never enough evidence that a specific pause will be handled.

### Layer 1: relay (`relay/src/index.js`), the common path

The relay knows which agents are connected and which commands each one sends.

**Paused child targets (auto-attach)**

- New constant `ORPHAN_PAUSE_GRACE_MS = 2000`, used to set the instance field
  `this.orphanPauseGraceMs`. This follows the instance-field pattern of
  `cdpLogBufferLimit`, so tests can shorten the grace period with no env var
  and no flag.
- New state `this.pausedChildren = new Map()`, mapping
  `childSessionId → { tabId, timer, engagedClients: Set<clientId> }`.
- In `_handleCdpEventFromExt`, all orphan handling runs **before** the
  `!sessionId` early return. After a relay restart the relay may not know the
  tab yet, and a resolution needs only `tabId` + `childSessionId`.
  - `Target.attachedToTarget` with `params.waitingForDebugger === true`:
    - With no open client, resume immediately.
    - Otherwise track the child as unengaged and arm the grace timer.
  - `Target.detachedFromTarget`: forget the child, and delete that child's
    `fetchOwners` record, because the debuggee is gone.
- **Engagement.** In the `_forwardToTab` child-session branch, when a client
  sends any command on a tracked paused child:
  - `Runtime.runIfWaitingForDebugger` forgets the child only **after** the
    forward succeeds, because only then has the client actually resumed it.
    Every post-await update checks that the map still holds the **same entry
    object**. A child that was detached, or already resolved, in the meantime
    is left alone.
  - If `_sendToExt` rejects, the client is dropped from `engagedClients`. The
    grace timer is re-armed only when `engagedClients` is now empty; another
    engaged client still owns the resume otherwise.
  - Any other command adds that client to `engagedClients` and **cancels** the
    grace timer. From then on no deadline applies: an aware client's init can
    take as long as it needs, so the relay never races Playwright's child init
    scripts.
  - Playwright sends its first command to a new child within milliseconds of
    the event, so the grace timer only ever fires for clients that never
    learned of the target: one still mid-connect, a non-Playwright CDP client,
    or an event for a page session the client dropped.
- **On `/cdp` close** for client C:
  - If no open client remains, resume every pending child now.
  - Otherwise, remove C from each child's `engagedClients`. A child whose
    engaged set becomes empty is resumed now, because the only aware client
    left without resuming it. An unengaged child keeps its timer.

**Request interception (Fetch)**

- New state `this.fetchOwners = new Map()`, mapping a debuggee key
  (`${tabId}:${childSessionId || ''}`) to a **record object**
  `{ owners: Set<clientId>, tail: Promise }`. The record's object identity is
  its epoch.
  - Every transition captures the record when it is queued. Before each
    post-await mutation, and before the queued cleanup `Fetch.disable` is
    actually sent, it checks `this.fetchOwners.get(key) === record`.
  - Only **debuggee teardown** (child detach, tab detach, extension cleanup)
    deletes a record outright. A tab id is
    reused when the same tab detaches and is lazily re-attached, and that
    re-attach creates a fresh record. Transitions still in flight from the old
    epoch then neither mutate the new owners nor send a stale disable. Alias sessions map
  to the tab's main debuggee key. Fetch is one switch per debuggee in Chrome,
  and any client can flip it, so the relay mirrors that switch:
  - It tracks only Fetch commands **actually forwarded** to the extension, in
    the main, alias and child branches of `_forwardToTab`. A synthesized init
    response on an unattached tab records nothing, because Chrome never saw it.
  - **Per-debuggee serialization.** Every Fetch transition on a key, whether a
    client's `Fetch.enable` / `Fetch.disable` or the relay's own cleanup
    `Fetch.disable`, is chained on `record.tail`. Chrome therefore sees them in
    the order the relay decided them. The extension's async `checkRestriction`
    step cannot reorder commands that are never in flight together.
  - **Rejection-safe chain.** Each step is appended as
    `record.tail = record.tail.then(step, step)`, where `step` catches and logs
    its own failure and always resolves. A rejected or timed-out enable
    therefore never poisons the transitions after it. The client's own command
    still receives its real result or error through a separate promise
    returned to `_handleCdpClientMessage`.
  - **Optimistic ownership.** A client's `Fetch.enable` adds that client to the
    owner set **before** it is forwarded. A `requestPaused` that overtakes the
    enable's response then already sees an owner, so connected routing and
    auth handling are never bypassed.
    - If the enable is rejected, the client is removed again. If the set is
      then empty, a cleanup disable is chained. The disable is harmless when
      Chrome never enabled Fetch.
  - A successful client `Fetch.disable` deletes the whole key, because Chrome
    interception on that debuggee is now off for everyone.
- `Fetch.requestPaused` / `Fetch.authRequired` on a key with **no open
  owner** is resolved immediately on the event's own debuggee
  (`childSessionId` when present):
  - `Fetch.requestPaused`: `Fetch.continueRequest { requestId }`.
  - `Fetch.authRequired`:
    `Fetch.continueWithAuth { requestId, authChallengeResponse: { response: 'Default' } }`.
    `Default` hands the challenge back to Chrome's own auth prompt.
  - An empty owner set also covers interception left over from before a relay
    restart, when relay memory was wiped.
  - When an open owner exists, the relay never touches the request. A route
    handler can legitimately hold it for as long as it likes, so there is no
    grace timer.
- **On `/cdp` close**, remove the client from every owner set. For each record
  whose set becomes empty, **chain** a cleanup `Fetch.disable` to that debuggee
  through `_resolveOrphanedPause`, so it is passive and logged.
  - The record stays in the map, and current, while the cleanup is queued.
  - When the step runs, it sends only if the record is still current **and**
    still ownerless. A new owner that enabled Fetch in the meantime wins.
  - After the send settles, the record is retired, again only if it is still
    current and ownerless.
  - Because the disable is chained, it runs after any enable of that client
    still in flight.
  - This is safe because no open client enabled interception there.
  - It stops future pauses and releases requests the departed owner left
    paused. Fetch has no list API for them.
  - The release is consistent with the reported behaviour: the user's Cancel,
    a full debugger detach that disables Fetch, clears the hang.
  - A later `Fetch.enable` from a new client makes that client the owner
    again.

**Shared mechanics**

- `_hasOpenCdpClient()` and an `_isClientOpen(clientId)` lookup via
  `clientById`.
- `_resolveOrphanedPause(tabId, childSessionId, method, params)` is the single
  send path:
  - It sends `cdpCommand` with `passive: true` and no `agentName`, which keeps
    it off the auto-close idle clock.
  - It writes to the CDP log (`direction: 'to-extension'`,
    `origin: 'relay-orphan-resolve'`).
  - Failures are logged with `logErr`, never thrown, and must never create an
    unhandled rejection.
  - It is skipped when `this.ext` is null; Layer 2 handles that case.
  - **Bounded retry.** A failed child resume re-arms that child's timer with an
    attempt counter, up to `ORPHAN_RESOLVE_MAX_ATTEMPTS = 3`. The same bound
    applies to a failed cleanup `Fetch.disable`, which re-chains on the same
    record under the same currency checks. A transient extension error
    therefore does not leave Chrome paused.
    - After the last attempt the relay logs and gives up. The usual cause is a
      target that no longer exists.
    - A per-event `Fetch.continueRequest` / `continueWithAuth` is not retried:
      its `requestId` dies with the request, and a reload issues fresh
      requests that are resolved on their own.
- Cleanup:
  - `_handleTabDetached` clears `pausedChildren` timers and `fetchOwners`
    records **by `tabId` first**, before its existing
    unknown-session early return. A reused tab id or session id therefore
    never inherits stale ownership.
  - `_cleanupExtension` and `stop()` clear everything.
  - Timers are `unref()`'d.
- There is **no protocol change**. It reuses `cdpCommand` with the existing
  optional `passive` flag.

### Layer 2: extension (`extension/background.js`), relay unreachable

- New pure helper `extension/orphan-pause-policy.js`, in the same pattern as
  `tab-update-policy.js`:
  - `resolveOrphanedPause(method, params)` returns
    `{ method, params, sessionId }` or `null`. `sessionId` is the debuggee
    override: the new child's session for `attachedToTarget`, and `undefined`
    (meaning the event's own source session) for Fetch.
  - It is the single source for which events are orphaned pauses and how
    they are resolved on the extension side.
  - It validates the exact event shape and returns `null` for anything
    malformed:
    - a non-object `params`;
    - a missing, empty or non-string `requestId`;
    - for `attachedToTarget`, a missing, empty or non-string `sessionId`.
      Without this check the resume would fall back to the parent session, a
      top-level resume.
  - The relay applies the **same predicate** with its own
    `isNonEmptyString()`. Relay and extension ship separately, CommonJS
    versus MV3 module, so the predicate is duplicated and each copy is
    tested. Malformed events there are never tracked or resolved, and are
    broadcast unchanged as today.
- `onDebuggerEvent`, reordered so that `childSessions` tracking and orphan
  resolution run **before both** existing guards: the WS-open return and the
  `attachedTabs.get(source.tabId)` return.
  - Resolve locally when **either** guard would drop the event: the relay WS is
    not open, **or** the tab has no `attachedTabs` entry. After a
    service-worker restart `attachedTabs` can be empty while Chrome still
    holds the debugger session, and the relay cannot route an event it is
    never sent.
  - The resolution from `resolveOrphanedPause` is sent best-effort and logged
    to `{ tabId: source.tabId, sessionId: resolution.sessionId ?? source.sessionId }`,
    then the handler returns.
- New in-memory set `fetchEnabledDebuggees`, holding `tabId:childSessionId`
  keys, plus a module-level `relayConnectionGeneration` that is incremented on
  every socket `open`. In `cdpCommand`, the command also captures its
  **attachment epoch**: the `attachedTabs` entry object for `tabId`, which is
  a fresh object on every attach. The fence below also rejects when the
  current entry is no longer that same object. A command that straddled a
  detach and re-attach of the same tab therefore never reaches the new
  debuggee and never mutates `fetchEnabledDebuggees` for it.
  - Capture the generation on entry. Recheck it with a small
    `assertRelayConnectionCurrent(generation)` **immediately before every
    Chrome send that follows an await**. That covers the send after
    `checkRestriction`, and also the final send after the existing
    `Runtime.enable` disable-and-sleep sequence. It throws if the generation
    changed, the WS is no longer open, or the attachment epoch changed. A
    command from a dead relay connection, or for a replaced attachment, is
    never sent to Chrome.
  - `fetchEnabledDebuggees` is updated only after the same check passes.
  - For `Fetch.enable`, add the key **synchronously right before**
    `chrome.debugger.sendCommand`. Calls on one debuggee reach Chrome in call
    order, so a later close-time `Fetch.disable` always lands after it.
  - Remove the key if the enable rejects. For `Fetch.disable`, delete the key
    after success.
- Cleanup of extension child and Fetch state:
  - `Target.detachedFromTarget` deletes that child's `childSessions` and
    `fetchEnabledDebuggees` entries.
  - Tab detach, tab removal and `canceled_by_user` clear everything for the
    tab. This runs in the same pre-guard block as the tracking, so state
    created for a tab without an `attachedTabs` entry is cleaned up too.
- On socket `close`, best-effort and logged:
  - Send `Runtime.runIfWaitingForDebugger` to every known child session. It is
    idempotent: a no-op on running targets. This covers the relay dying after
    it forwarded an attach event but before it resumed the child.
  - Send `Fetch.disable` to every `fetchEnabledDebuggees` entry, then clear the
    set. This releases requests that were already paused when the relay died.
    Later pauses are resolved by the event path above.

### Accepted residuals (documented, not fixed)

- An aware, engaged client that stays connected but never resumes a child
  behaves exactly as it would against real Chrome. That is the client's bug,
  not an orphan.
- An owner-connected Fetch pause held forever by a buggy route handler is
  likewise the handler's bug.
- A paused `Debugger` statement (`Debugger.paused`) is out of scope. Playwright
  never enables the Debugger domain, and the relay does not track it.
- Leftover cosmetic overrides from Playwright's init (emulation, focus emulation)
  are out of scope.

## Tests

In `relay/test/relay-server.test.js`, using the fake-extension WS pattern and
`relay.orphanPauseGraceMs = 50`:

1. With no clients, a waiting child gets a resume `cdpCommand` with the right
   `childSessionId` and `passive: true`.
2. With no clients, `waitingForDebugger: false` produces no resume.
3. A connected client that resumes the child itself: the relay sends no resume
   of its own, even after the grace period.
4. A connected, silent (unaware) client: the relay resumes after the grace
   period.
5. **Delayed init.** A client sends one command on the child, then waits well
   past the grace period. The relay does not resume.
6. When an engaged client disconnects while another, unaware client stays
   connected, the relay resumes the child immediately.
7. When the last client disconnects with a pending child, the relay resumes it
   immediately.
8. `Target.detachedFromTarget` cancels a pending resume.
9. An event for a tab the relay does not know yet, with no clients, is still
   resumed.
10. A tab detach for a session the relay does not know still clears that tab's
    paused-child timers, so no stale resume fires.
11. `Fetch.requestPaused` with no clients is continued. `Fetch.authRequired` is
    resolved with `Default`.
12. `Fetch.requestPaused` while the owner (the client that forwarded
    `Fetch.enable` on an attached tab) is connected is **not** touched.
13. The owner of `Fetch.enable` disconnects while an unrelated client stays
    connected:
    - The relay sends `Fetch.disable` on that debuggee.
    - A later `requestPaused` there is continued.
14. A `Fetch.enable` synthesized on an unattached tab records no owner.
15. When the extension answers a resolution with an error, the relay stays up
    and keeps serving.
16. When a client's own `Runtime.runIfWaitingForDebugger` is rejected by the
    extension, the relay keeps tracking the child and resumes it after the
    grace period.
17. A `Fetch.disable` from a non-owner client clears ownership, so a later
    `requestPaused` there is continued.
18. A rejected `Fetch.enable` records no owner.
19. When the owner closes while its `Fetch.enable` is still in flight, the
    relay's `Fetch.disable` reaches the extension only after the enable
    settles. The test asserts the order.
20. **Event before response.** A `requestPaused` that arrives while the owner's
    `Fetch.enable` is still pending is not touched.
21. **Failed resume with multiple clients.** A rejected resume from client A,
    while client B is still engaged, re-arms nothing. A rejected resume after
    `Target.detachedFromTarget` does not resurrect the entry.
22. `Target.detachedFromTarget` on a child clears that child's Fetch ownership.

New `test/agent/orphan-pause-policy.test.js` covers the pure helper for each
event type, a non-pause event, and the malformed cases:

- `null` params;
- a missing, empty or numeric `requestId`;
- a missing, empty or numeric child `sessionId`.

Relay tests 23–24:

23. A malformed `attachedToTarget` with an empty or numeric `sessionId`, and a
    `requestPaused` with an empty `requestId`, produce no resolution
    command.
25. **Close cleanup actually disables.** When the sole owner disconnects,
    exactly one `Fetch.disable` is sent, then the record is retired.
26. **Rejected enable does not poison the chain.** A `Fetch.enable` rejected
    by the extension is followed by a queued cleanup disable, and then a
    new client's enable. Both are still forwarded, in order.
27. **Retry.** The extension rejects the first orphan resume. The relay
    retries and the second attempt succeeds. With continuous rejection it
    stops after 3 attempts.
24. **Stale epoch.** Enable Fetch as client A on a tab, detach the tab, lazily
    re-attach it, and enable Fetch as client B while A's old cleanup is
    still queued. B stays the owner and no stale `Fetch.disable` is sent. A static contract test on
`extension/background.js`, in the style of `debugger-resume-contract.test.js`,
checks three things:

- Orphan resolution and `childSessions` tracking run before **both** the
  WS-open and the `attachedTabs` returns.
- Resolution runs when either the WS is closed or the entry is missing.
- `cdpCommand` tracks `fetchEnabledDebuggees` before `sendCommand`.
- `assertRelayConnectionCurrent` precedes every post-await Chrome send in
  `cdpCommand`, including the `Runtime.enable` re-enable, and checks the
  attachment epoch.
- Socket close resumes child sessions and sends `Fetch.disable` to the tracked
  debuggees.
- The helper is imported.

Register the new test files in `package.json` `test` and `test:agent`.

Live checks in real Chrome. Each check isolates one layer, and none of them
reloads the extension as part of the check itself, because an extension
reload detaches debuggers and would mask a broken path.

**Every** check asserts two things:

- The reloaded page reaches `load`: its content is visible and a
  `document.readyState === 'complete'` read succeeds.
- The debugger is **still attached** afterwards, so a pass never comes from
  an accidental detach. The evidence is the infobar still shown on the tab,
  plus the relay's `GET /attached-tabs` still listing the tab.
  - In check 2 the relay is down, so the evidence is the infobar plus the
    extension popup's attached count. Restart the relay afterwards and
    confirm that `/attached-tabs` lists the tab.

0. **Connected MCP (regression guard).** While an MCP client is actively
   connected, reload a service-worker or OOPIF page and then run a
   `snapshot` against it. It must load, its OOPIF content must be stitched,
   and there must be no relay-originated resolution in `cdp.jsonl`. This proves
   Playwright still resumes the children itself.

1. **Relay path.** Restart the relay and reload the extension once, as setup.
   Then drive a service-worker site or an OOPIF page with MCP, wait more than
   15s for the idle disconnect, and reload the page. It must load with the
   infobar still present. Repeat after a one-shot CLI command.
2. **Extension path.** With the new extension loaded and a tab already
   agent-driven, stop only the relay, leaving the extension loaded, and reload
   that tab. It must load with the infobar still present.
3. **Relay restart and reconnect.** Restart the relay with the extension
   loaded. After the extension reconnects, and before any agent connects,
   reload a previously driven tab. It must load.
4. **sessiond.** Start the daemon (`snapshot --sessiond`) and drive the tab.
   With the daemon still connected, reload the tab: Playwright resumes the
   children. Stop the daemon and reload again. Both loads must succeed.
5. **Fetch.** Run an MCP `exec` that calls `page.route('**/*', r => r.continue())`,
   wait for the idle disconnect, then reload. It must load.

**Final gate:** full `pnpm test` green, with the output read, before any
commit claims completion.

## Docs

- Add an `AGENTS.md` Critical Pattern, "Orphaned Debugger Pauses", written
  symptom first. It should name the wrong fixes: disabling auto-attach on every
  disconnect, and gating on "any client connected".
- Add a key-files row for `extension/orphan-pause-policy.js`.
- Add a `docs/knowledge/timeline2.md` entry.
- Add a `docs/knowledge/critical-patterns.md` entry.
