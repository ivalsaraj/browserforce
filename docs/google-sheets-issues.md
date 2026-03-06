# Google Sheets Automation Issue Log

Append-only log for BrowserForce Google Sheets workflow failures, root causes, and fixes.

Use this format for each new entry:

## YYYY-MM-DD — [TAG] Short Title
- Symptom:
- Root cause:
- Fix:
- Rule:

---

## 2026-03-01 — [SCAN] Overscan Loop Beyond Used Rows
- Symptom: Automation loop kept scanning up to row 80 while the table only had data through row 9.
- Root cause: Fixed upper-bound scanning was used without detecting the contiguous used range first.
- Fix: Added contiguous scanning with early-stop using empty streak detection.
- Rule: Discover used rows first; never default to high hardcoded row caps.

## 2026-03-01 — [FORMAT] Over-Highlighting Reduced Signal
- Symptom: Too many bold segments made the full column look uniformly emphasized.
- Root cause: Highlight heuristic selected many phrases per line without a density limit.
- Fix: Reduced to one key bold phrase per bullet line.
- Rule: Emphasis must stay sparse and intentional; cap highlights per line.

## 2026-03-01 — [DOM] Trusted Types Blocked innerHTML Assignment
- Symptom: Direct `innerHTML` rewrite failed with Trusted Types enforcement.
- Root cause: Google Sheets editor enforces TrustedHTML assignment policies.
- Fix: Switched to DOM node construction via `createElement` and `createTextNode`.
- Rule: Prefer node-based DOM updates over raw HTML assignment in locked editors.

## 2026-03-01 — [DISCOVERY] Prior-Art Check Before New Skill Logic
- Symptom: Risk of rebuilding behavior that already exists in official integrations or MCP servers.
- Root cause: Feature work started before surveying existing Claude and MCP Google Sheets solutions.
- Fix: Added a mandatory pre-build lookup step against official docs + known MCP repositories.
- Rule: Before expanding Sheets automation behavior, check official support and existing MCP implementations.

## 2026-03-04 — [SUMMARY] Export Drift During Simple Read Requests
- Symptom: Agent attempted gviz/CSV export and extra-tab fetch flows when the user only asked for a page summary.
- Root cause: Skill guidance did not enforce a summary-first path for Google Sheets and lacked anti-export guardrails.
- Fix: Added `gsSummarizeSheet()` helper plus strict skill rules to summarize directly from active-sheet helpers first.
- Rule: For "summarize/read this sheet" requests, use helper-driven page reads and answer directly before any export path.

## 2026-03-06 — [WRITE] Formula-Bar Drift During Literal Cell Updates
- Symptom: Agent left the plugin helper path, tried formula-bar DOM writes, and spiraled through `UNICHAR`, invisible-prefix, and fallback-text hacks when asked to add `₹`.
- Root cause: The plugin exposed read and formatting helpers but no first-class literal write helper for exact cell updates.
- Fix: Added `gsWriteCell()` / `gsWriteCells()` plus guardrails to keep plain-text writes on the in-cell editor path and stop on verification failure.
- Rule: For exact cell values, use literal write helpers and verification; never improvise formula-bar DOM mutation.
