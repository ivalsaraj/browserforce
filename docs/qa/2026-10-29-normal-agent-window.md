# QA — explicit normal background agent window

Build: `fix/shared-browserforce-tab-group`, after `466b159`. Native environment: macOS 26.5.2, the user's real Chrome through BrowserForce. The user enabled separate-window mode and authorized a temporary blank-window test.

## Baseline observed

The existing `chrome.windows.create({url, focused:false, type:'normal'})` path was exercised through BrowserForce. Native SkyLight sampling recorded 600 observations at approximately 50 ms intervals. The active Space changed **35 → 232 → 35** during creation and cleanup. See `2026-10-29-normal-agent-window/baseline-spaces.json`. This proves a Space switch for that configuration; it does not prove every normal-state/bounds configuration fails.

The first test's data-URL navigation returned `net::ERR_ABORTED`; its finally block closed its own test page. A second blank-page test completed without navigating, identified its agent-created tab/window, read page geometry, and closed its own page. The recording covers the first creation, not the second. Page `document.hasFocus()` is not treated as native focus evidence because CDP focus emulation can affect it.

The Apple Events JavaScript setting was initially disabled and was never changed. A hidden native diagnostic controller briefly activated Chrome, was discarded as a harness effect, and was closed. The accepted baseline uses BrowserForce actions, not that controller. Native UI automation subsequently timed out; the user enabled separate-window mode directly.

## Candidate and acceptance cases

The rejected candidate explicitly set `state:'normal'`, `focused:false`, width 1000 and height 700. Window affinity, dedicated-mode defaults, cleanup, ownership and focus interception are unchanged. Initial dimensions remain subject to normal Chrome/OS adjustment.

| Case | Expected | Result / evidence |
|---|---|---|
| Dedicated new window | Request normal state, 1000 × 700, no focus request | PASS in real-function Chrome API fixture |
| No existing normal window | Same regular background-window request | PASS in real-function Chrome API fixture |
| Existing dedicated pin | New tabs reuse it; no new window | PASS in affinity/background fixtures |
| Shared mode and focus interception | Existing behavior preserved | PASS in focused fixtures |
| Native full-screen workflow | Separate regular window, unchanged native foreground window and Space throughout creation/attachment | **FAIL** after confirmed reload: native frame1000 × 700 became1470 × 835; Space35 → 242. See candidate-result.json. |
| Native cleanup | Close only test tabs/windows; original selected tab and window preserved | Own test page/window closed in finally; native Space returned to35. Original selected-tab identity was not independently measured. |

Red run: updating the two creation fixtures before implementation produced 27 passes and 2 failures, each missing state/width/height. The actual constant declarations are included in the VM closure, so expected dimensions do not replace production values in the fixture.

Verification: all 75 focused checks and all 48 serial package test commands passed. No lint/build scripts exist. GPT-6.1-Sol at high effort approved the plan and code in one round each, with no actionable findings; the code reviewer independently passed the 40 cases in the changed test files. No security or ownership findings were rejected. Approval covers the candidate request, not the still-pending native outcome.

Unit/contract tests establish request shape and regression behavior, not a native focus fix. Do not publish this as a verified fix until the changed extension has been reloaded and the native acceptance cases pass. If normal creation still switches Space, evaluate another strategy rather than falling back into the user's working window.

## Reloaded candidate result — failed

The user confirmed reload. The test waited until the native foreground app was Chrome on full-screen Space35. BrowserForce created an owned page, set its test content, attempted a button click, captured a page screenshot, and closed the owned page in finally. Native observation recorded the initial requested1000 × 700 frame, proving the candidate loaded; Chrome then converted it to fullscreen content dimensions1470 × 835 and switched Space35 → 242 at approximately0.408 seconds after test start. It returned to35 after cleanup. See `2026-10-29-normal-agent-window/candidate-result.json` and `candidate-page.png`.

The button label did not change after the locator click, so the interaction did not pass either. Inline-script policy versus fullscreen-transition input routing is unestablished. It is not counted as a successful click. The Space switch alone is sufficient to reject this candidate as a no-interruption fix. No success claim or npm publication is authorized by the passing unit/contract tests.

The failed production request and popup-copy changes were reverted in source after this native result. The evidence is retained to prevent another flags-only fix being reported successful. The next strategy awaits the user's minimized-versus-visible-window choice.
