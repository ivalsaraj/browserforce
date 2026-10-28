# QA — shared browserforce group labels

Build: `fix/shared-browserforce-tab-group`. Environment: local Node tests executing the real planner and background sync function with a Chrome API fixture. The user's Chrome still needs the changed extension reloaded.

## Fixed behavior and affected surfaces

| Case | Steps and expected result | Result | Evidence |
|---|---|---|---|
| Different owners | Create tabs for two owner IDs in one window; reuse one managed group. | PASS | `tab-group-sync-plan.test.js`: shared managed group and background checkpoint cases. |
| Names and missing owners | Same/different display names and a null owner still share a group. | PASS | Display-name and unlabeled-agent cases. |
| Group label | Execute background sync; Chrome receives `browserforce`, orange. | PASS | Background shared-group case. |
| Existing groups | Sync restored assignments without creating tabs; rename only, no empty `tabs.group` call. | PASS | Rename-only planner and background cases. |
| Process restart | Restore saved assignments and create a tab with a different owner; reuse the group. | PASS | Next-owner-after-restart case. |
| User choices | Move or ungroup old tabs; sync must not put them back or adopt an unrelated matching-title group. | PASS | Removed-tab, moved-tab and matching-title cases. |
| Windows and closed tabs | Keep tabs in their original windows; skip missing/already-grouped new tabs. | PASS | Separate-window, closed-window and closed-tab cases. |
| Live Chrome | Reload the changed extension, check old labels and create tabs from separate clients; verify group IDs and selected tab. | PENDING | User reload required by local live-verification skill. |

## Must stay unchanged

Manual-attachment reconciliation, popup inheritance and focus, persisted membership, ownership close checks, and window placement: PASS in the focused 87-test run across grouping, popup policy, auto-manage state, background window plans and affinity.

Full package test script: all 48 serial test commands PASS using the dot reporter. No lint or build scripts are defined. A reproducible 100-sample probe (seed 5218) also passed: one plan per window, every new tab assigned exactly once, no tab crossing windows, and owner metadata unchanged.

Plan and code reviews: GPT-6.1-Sol, medium effort, one round each; approved with no actionable findings. The code reviewer also ran the 17 snapshot grouping cases successfully. No security or ownership findings were rejected.

Harness: unchanged manual-group cases passed before implementation. The background harness calls the actual extracted `syncTabGroup` with real planners; Chrome calls and persisted assignments are asserted.

Red run: `node --test --test-reporter=spec test/agent/tab-group-sync-plan.test.js` before implementation: 17 cases, 8 pass, 9 fail. It observed separate owner groups, old titles/colors, absent rename plans and a new group after owner change. After implementation, all 17 passed.

Sweep: no page layout, form, keyboard, network, permission or dependency changes. Multi-owner/window and restored-state cases are covered. Native tab-strip rendering and real Chrome event ordering remain pending reload; fixture tests do not prove them.

Known limits: existing groups are renamed in place rather than merged; manually attached tabs retain their separate reconciliation. Every managed group uses the same label. Ownership stays separate internally.
