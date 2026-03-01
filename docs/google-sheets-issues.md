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
