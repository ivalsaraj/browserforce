# QA — minimized agent-window trial

The user approved testing a minimized agent window after the normal-window candidate failed. Candidate source: `fix/shared-browserforce-tab-group`, based on `466b159`. Native results below distinguish the fullscreen focus test from the post-ordering-fix functional test. No release has been published by this work.

## Request policy

Only a new window is affected. On macOS, if a normal Chrome window in the connected profile reports `state:'fullscreen'`, create `{url,type:'normal',state:'minimized'}` without a `focused` field or bounds. Otherwise preserve `{url,type:'normal',focused:false}`. Existing dedicated-window selection, pins, ownership, grouping and cleanup remain unchanged.

Chromium's window API uses `ShowInactive()` for `focused:false`, and that widget path ignores the saved minimized state. Omitting `focused` instead uses `Show()`, which honors the initial minimized state. The macOS bridge handles that state with `miniaturize` before window ordering. These source observations motivate the candidate; they are not proof that the native behavior is non-intrusive.

## Checks

| Case | Expected | Result |
|---|---|---|
| macOS fullscreen | Minimized normal-window request; no focused/bounds keys | PASS in real-function fixture |
| macOS desktop | Existing unfocused normal-window request | PASS in real-function fixture |
| Windows/Linux fullscreen | Existing behavior, no macOS fullscreen query | PASS in real-function fixture |
| Existing minimized pin | Next tab uses the same window | PASS in real-function fixture |
| Native focus/Space | Original full-screen Chrome app/window and Space preserved | PASS: full-screen Space267 / Chrome front window20224 unchanged in the controlled test. |
| Native visibility | Agent window remains minimized; no full-size foreground window | PASS: no new Chrome window ≥400 × 200 appeared on screen during either controlled run. Dock/auxiliary thumbnails are excluded from this threshold. |
| Working page | Real click changes label; rAF advances; screenshot succeeds | PASS after mouse-order fix, on both owned pages; trusted down/up/click recorded. |
| Second page | Same agent window; no restore or focus switch | PASS: both pages used one window; native app/Space/front window unchanged. |
| bringToFront | Existing interception does not restore or focus window | PASS: called on second page; native state remained stable. |
| Cleanup | Close only the test pages/window; preserve working page | PASS: owned pages closed in finally, no native foreground window change. Original selected-tab identity was not independently measured. |

Red run: the two macOS-fullscreen creation cases failed on the previous source because it sent `focused:false` without minimized state. After implementation, 92 focused checks (including popup contracts) passed. The fixture proves request shape, not the native result.

The native harness registers a DOM click listener through Playwright rather than relying on an inline handler, records console errors, and uses bounded rAF/action/screenshot waits. This removes an unestablished inline-policy dependency from the earlier test. Native observations use the existing read-only observer; browser actions use BrowserForce. No Apple Events JavaScript setting or other permissions are changed.

## Native runs

- Controlled fullscreen run before the input-order fix: Space267, foreground appChrome and front CG window20224 stayed constant through creation, two tabs, bringToFront and cleanup. rAF and screenshots passed. Native mouse events arrived up-before-down, so clicks failed.
- Post-ordering-fix run: T3 Code remained foreground, Space1 and front window6036 stayed constant. Both real button clicks changed the label; both rAF ticks and screenshots passed; two tabs shared one window; bringToFront and cleanup caused no native change. The fullscreen window-creation policy was unchanged between these runs.
- A first, uncontrolled run is not counted: an app/Space transition began before the browser action.

See the adjacent native summaries, before/after workflow JSON and successful screenshots. CG front-window order and foreground app are observations, not direct Accessibility key-window events. No native group-title inspection was available from the blank page; normal window type and unchanged grouping code preserve the existing group path. Existing site-created popup limitations are not tested here.

Final regression: all49 package test commands passed after the mouse-order fix. The minimized request and ordering delta each received GPT-6.1-Sol high code approval; no security or ownership findings were rejected. The existing authenticated reload endpoint applied the second change without a browser restart or another manual reload.
