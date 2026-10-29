# QA — mouse press/release ordering

During the minimized-window test, trusted DOM events hit the correct button but arrived `pointerup/mouseup` before `pointerdown/mousedown`; no click fired. A programmatic click control succeeded. This identified the asynchronous forwarding path, not an absent element or broken handler.

`cdpCommand` now queues `Input.dispatchMouseEvent` per tab before asynchronous restriction/cursor work. The forwarding implementation, child routing, restrictions, cursor rendering and badge handling remain unchanged. Non-mouse commands and different tabs remain independent.

## Evidence

- New regression test failed before the fix: a release reached the fake debugger while cursor arrival still held the press. After the fix, all three tests pass: FIFO during a held press, independence across tabs, and continuation/cleanup after a rejected command.
- Codex GPT-6.1-Sol high approved the delta in one round, independently passing the three snapshot cases and additional in-memory checks for restriction waits, non-mouse independence and tail cleanup.
- Existing authenticated `POST /extension/reload` returned `200 {reloaded:true}` and the extension reconnected. No Chrome restart or new permission was needed.
- Real BrowserForce repeat: both owned buttons changed to `Background action completed`; trusted pointerdown/mousedown preceded pointerup/mouseup/click. Both rAF ticks and screenshots passed; two tabs shared one agent window.
- Native observation during that repeat: T3 Code, its front CG window6036 and Space1 remained unchanged. No new Chrome window ≥400 × 200 appeared on screen. Both owned pages were closed in finally.

Before/after workflow JSON, native summaries and successful screenshots are in `2026-10-29-minimized-agent-window/`. Full package test script: all49 serial commands passed. No dependency, permission or relay-protocol change.
