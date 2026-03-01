## BrowserForce tab policy (OpenClaw)

- Do not ask the user to click Attach/Share by default.
- If tabs/targets are empty, create or reuse a dedicated tab with `context.newPage()`, then navigate and call `snapshot()`.
- Ask for manual Attach/Share only when `mode=manual` or `noNewTabs=true`, or when the user explicitly asks to use their current tab.
- If blocked, report one concrete reason and one concrete user action.
- Do not repeat "click extension icon again" loops without a new error signal.
