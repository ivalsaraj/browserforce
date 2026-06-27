# Execute Timeout Cancellation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `execute` timeouts stop the in-flight run cleanly so a timed-out script cannot keep mutating BrowserForce state or destabilize the MCP session.

**Architecture:** Leave `waitForPageLoad()` heuristics alone for now. The bug is at the execution boundary: `runCode()` currently races user code against a timeout, but the losing async work keeps running. The fix should make timeout a real cancellation boundary, drain or ignore late completion safely, and keep the MCP session reusable after the timeout. If a helper can block for a long time, it should observe the same cancellation signal rather than relying only on the outer 30s race.

**Tech Stack:** Node.js, Playwright, MCP server, Node test runner.

---

### Task 1: Reproduce the timeout leak with a focused regression test

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js`

**Step 1: Write the failing test**

Add a small `runCode` harness that:
- starts a script which waits longer than the timeout
- sets an observable side effect after the wait
- asserts the timeout is raised
- asserts the late side effect does not leak into the test process, or at minimum is visible as an unwanted late completion

Prefer a test that also proves the next `runCode` call still succeeds in the same process, because that is the user-facing failure mode.

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
```

Expected: the new timeout test fails because the late async work still runs or leaves the process in an unsafe state.

**Step 3: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
git commit -m "test(mcp): pin execute timeout leak"
```

### Task 2: Add cancellation plumbing to `runCode`

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js`
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/src/index.js` if the execute handler needs to pass through a signal or cancellation-aware context

**Step 1: Write the minimal implementation**

Make `runCode()` own a cancellation mechanism instead of only racing promises:
- create a per-run cancellation controller
- pass the cancellation signal into the execution context
- when the timeout wins, mark the run as aborted and prevent late completion from surfacing as a second failure
- ensure any long-running helper that waits on the page can observe the same signal

Keep the change minimal. Do not redesign page-load heuristics or add unrelated recovery logic.

**Step 2: Run the focused test again**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
```

Expected: the timeout regression now passes, and the next `runCode` invocation in the same test process still works.

**Step 3: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js /Users/valsaraj/Documents/projects/browserforce/mcp/src/index.js /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
git commit -m "fix(mcp): cancel timed out execute runs cleanly"
```

### Task 3: Prove the MCP surface stays usable after timeout

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js`

**Step 1: Write the failing test**

Add a JSON-RPC or tools-call regression that:
- runs `execute` with a deliberately slow script and a short timeout
- asserts the returned error is the timeout error
- immediately runs a second harmless `execute`
- asserts the second call succeeds

This catches the real user impact: a timeout should not poison the MCP session.

**Step 2: Run the test to verify it fails before the fix**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js
```

Expected: the new test fails until cancellation is wired correctly.

**Step 3: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js
git commit -m "test(mcp): cover execute reuse after timeout"
```

### Task 4: Update the docs and verify the cleanup

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/docs/BROWSERFORCE_AGENT.md`
- Modify: `/Users/valsaraj/Documents/projects/browserforce/docs/USE_CASES.md` if the timeout behavior is documented there

**Step 1: Update the docs**

Add a short note that `execute` timeouts are cancellation boundaries, not just late error responses, so users know a timed-out script will not continue mutating the browser in the background.

**Step 2: Run the targeted tests**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js
```

Expected: both pass.

**Step 3: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/docs/BROWSERFORCE_AGENT.md /Users/valsaraj/Documents/projects/browserforce/docs/USE_CASES.md
git commit -m "docs(mcp): describe execute timeout cancellation"
```
