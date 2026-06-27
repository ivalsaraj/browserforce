# Execute Timeout Cancellation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make BrowserForce `execute` timeouts act as real lifecycle boundaries so timed-out snippets cannot keep driving Chrome, mutating `state`, or destabilizing the next MCP call.

**Architecture:** Borrow the useful parts of Playwriter's runner from `/Users/valsaraj/Documents/projects/playwriter/playwriter/src/executor.ts`: build an explicit execution context, run user code through Node's built-in `vm` with its synchronous timeout, and keep timeout errors clean at the MCP boundary. Do not copy Playwriter's `Promise.race` as the whole fix; Playwriter still races async work after `vm.runInContext()`, so BrowserForce must add per-run abort state, cancellation-aware timers, and guards around exposed async helpers/Playwright handles. Keep `waitForPageLoad()` heuristics unchanged except for observing the same run cancellation signal.

**Tech Stack:** Node.js ESM, built-in `node:vm`, Playwright-core CDP objects, MCP SDK, Node test runner.

---

### Reference Checked: Playwriter

**Files read before this plan:**
- `/Users/valsaraj/Documents/projects/playwriter/playwriter/src/executor.ts`
- `/Users/valsaraj/Documents/projects/playwriter/playwriter/src/executor.unit.test.ts`
- `/Users/valsaraj/Documents/projects/playwriter/playwriter/src/mcp.ts`
- `/Users/valsaraj/Documents/projects/playwriter/playwriter/src/cli.ts`

**What to reuse:**
- Use `node:vm` instead of raw `new Function()` so synchronous runaway code can be stopped with `vm.runInContext(..., { timeout })`.
- Keep the execution context explicit: `page`, `context`, `state`, helpers, console shim, safe globals.
- Keep timeout responses terse and do not suggest `reset` for ordinary timeout errors.

**What not to copy blindly:**
- Playwriter still does:

```ts
return await Promise.race([
  vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true }),
  new Promise((_, reject) => setTimeout(() => reject(new CodeExecutionTimeoutError(timeout)), timeout)),
])
```

That still lets async continuations survive after the race. BrowserForce needs a cancellation/fencing layer around async waits and exposed browser/state objects.

---

### Task 1: Pin the Current Async Timeout Leak

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js`

**Step 1: Add a failing regression for late timer work**

Add a test near the existing `runCode` tests:

```js
test('runCode timeout stops late timer continuations from mutating state', async () => {
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, {});

  await assert.rejects(
    () => runCode(`
      await new Promise((resolve) => setTimeout(resolve, 80));
      state.leakedAfterTimeout = true;
      return 'late';
    `, ctx, 10),
    /Code execution timed out after 10ms/,
  );

  await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
  assert.equal(ctx.state.leakedAfterTimeout, undefined);

  const nextResult = await runCode('return "next-run-ok";', ctx, 1000);
  assert.equal(nextResult, 'next-run-ok');
});
```

The test should fail before implementation because the exposed `setTimeout` is the native timer and the losing async branch resumes after `runCode()` has already returned.

**Step 2: Add a failing regression for guarded async object methods**

Add a fake page method that resolves after the outer timeout, then tries to mutate state:

```js
test('runCode timeout fences async continuations after guarded helper calls', async () => {
  const slowPage = {
    isClosed: () => false,
    url: () => 'about:blank',
    title: async () => 'Slow',
    delayed: async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
      return 'done';
    },
  };
  const ctx = buildExecContext(slowPage, { pages: () => [slowPage] }, {}, {}, {});

  await assert.rejects(
    () => runCode(`
      await page.delayed();
      state.leakedAfterGuardedMethod = true;
    `, ctx, 10),
    /Code execution timed out after 10ms/,
  );

  await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
  assert.equal(ctx.state.leakedAfterGuardedMethod, undefined);
});
```

This captures the BrowserForce-specific risk: a Playwright call may settle after timeout, and the next statement must not run.

**Step 3: Add a failing regression for synchronous runaway code**

This is the Playwriter wheel we should reuse:

```js
test('runCode timeout interrupts synchronous runaway code', async () => {
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, {});

  await assert.rejects(
    () => runCode('while (true) {}', ctx, 10),
    /Code execution timed out after 10ms/,
  );

  const nextResult = await runCode('return "after-sync-timeout";', ctx, 1000);
  assert.equal(nextResult, 'after-sync-timeout');
});
```

This currently hangs or relies on the outer async race in a way that cannot interrupt a CPU-bound loop. After the fix, `node:vm` should stop it.

**Step 4: Run the focused test and confirm failure**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
```

Expected before implementation: at least the late timer mutation test fails. The sync runaway test may time out the test process if implemented naively; keep its test timeout small and run it only once the `vm` path is in progress if needed.

**Step 5: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
git commit -m "test(mcp): pin execute timeout lifecycle leak"
```

---

### Task 2: Move `runCode()` Onto a Playwriter-Style `vm` Boundary

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js`

**Step 1: Import Node's built-in VM module**

Add:

```js
import vm from 'node:vm';
```

Do not add a dependency. BrowserForce already uses JavaScript and Node has the needed primitive.

**Step 2: Replace raw `new Function()` with `vm.runInContext()`**

Implement the same minimal shape Playwriter uses, adapted to BrowserForce's current explicit `return` snippets:

```js
function wrapExecuteCode(code) {
  return `(async function() {\n${code}\n})()`;
}
```

Then in `runCode()`:

```js
const vmContext = vm.createContext(execCtx);
const userPromise = vm.runInContext(wrapExecuteCode(code), vmContext, {
  timeout: timeoutMs,
  displayErrors: true,
});
```

Keep BrowserForce's existing `return ...` semantics. Do not copy Playwriter's auto-return parsing or `acorn` dependency; that is unrelated to cancellation.

**Step 3: Preserve timeout error formatting**

Map VM timeout errors to `CodeExecutionTimeoutError` so callers keep the existing MCP response:

```js
function normalizeRunError(err, timeoutMs) {
  if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /Script execution timed out/.test(String(err?.message || ''))) {
    return new CodeExecutionTimeoutError(timeoutMs);
  }
  return err;
}
```

**Step 4: Run tests**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
```

Expected: the synchronous runaway test passes once VM timeout mapping is correct. The async leak tests still fail until Task 3.

**Step 5: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
git commit -m "fix(mcp): run execute snippets inside vm timeout boundary"
```

---

### Task 3: Add Per-Run Cancellation State and Abortable Timers

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js`

**Step 1: Add a tiny run controller**

Create a local helper near `runCode()`:

```js
function createRunController(timeoutMs) {
  const controller = new AbortController();
  const pendingTimers = new Set();
  let hasTimedOut = false;

  const abort = () => {
    hasTimedOut = true;
    controller.abort(new CodeExecutionTimeoutError(timeoutMs));
    for (const timerId of pendingTimers) globalThis.clearTimeout(timerId);
    pendingTimers.clear();
  };

  const throwIfAborted = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason || new CodeExecutionTimeoutError(timeoutMs);
    }
  };

  return { signal: controller.signal, pendingTimers, abort, throwIfAborted, get hasTimedOut() { return hasTimedOut; } };
}
```

Keep this private to `exec-engine.js` unless tests need a named export.

**Step 2: Add cancellation-aware timer globals**

Use BrowserForce's existing execute-scope timer names, but make them run-scoped:

```js
function createRunTimers(run) {
  const setTimeoutForRun = (callback, delay = 0, ...args) => {
    run.throwIfAborted();
    const timerId = globalThis.setTimeout(() => {
      run.pendingTimers.delete(timerId);
      if (run.signal.aborted) return;
      callback(...args);
    }, delay);
    run.pendingTimers.add(timerId);
    return timerId;
  };

  const clearTimeoutForRun = (timerId) => {
    run.pendingTimers.delete(timerId);
    return globalThis.clearTimeout(timerId);
  };

  return { setTimeout: setTimeoutForRun, clearTimeout: clearTimeoutForRun };
}
```

This directly fixes the verified repro:

```js
await new Promise((resolve) => setTimeout(resolve, 300));
await page.evaluate(...);
```

When the run aborts, the callback never fires, so the late continuation does not resume.

**Step 3: Race async user work against a timeout that aborts the run**

Replace the bare timeout race with:

```js
let timeoutId;
try {
  await Promise.race([
    userPromise.then((value) => {
      run.throwIfAborted();
      result = value;
    }),
    new Promise((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        run.abort();
        reject(new CodeExecutionTimeoutError(timeoutMs));
      }, timeoutMs);
    }),
  ]);
} finally {
  if (timeoutId) globalThis.clearTimeout(timeoutId);
  run.abort();
}
```

The `finally` cleanup should abort only if the run did not already complete successfully. Implementation detail can be:

```js
let isComplete = false;
...
isComplete = true;
...
if (!isComplete) run.abort();
```

Do not abort successful runs, because helper code may have returned handles the caller expects.

**Step 4: Inject run timers and signal into the VM context**

Before `vm.createContext()`:

```js
const run = createRunController(timeoutMs);
const runTimers = createRunTimers(run);
const guardedExecCtx = {
  ...execCtx,
  ...runTimers,
  executeSignal: run.signal,
  throwIfExecutionAborted: run.throwIfAborted,
};
```

Use `executeSignal` as the public name for advanced helpers. It is intentionally additive and does not change existing snippets.

**Step 5: Run focused tests**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
```

Expected: the late timer mutation test now passes. The guarded async object method test still fails until Task 4.

**Step 6: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
git commit -m "fix(mcp): abort execute timers on timeout"
```

---

### Task 4: Fence Exposed Async Helpers and Browser Handles

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js`

**Step 1: Add a small async guard wrapper**

Create a helper that checks the run before calls and after awaited results:

```js
function guardAsyncFunction(fn, run) {
  return function guardedFunction(...args) {
    run.throwIfAborted();
    const value = fn.apply(this, args);
    if (!value || typeof value.then !== 'function') {
      run.throwIfAborted();
      return value;
    }
    return value.then((resolved) => {
      run.throwIfAborted();
      return resolved;
    });
  };
}
```

This prevents code after a long helper call from continuing once the outer `execute` timeout has fired.

**Step 2: Add targeted proxying instead of a broad object membrane**

Avoid an ambitious generic sandbox. Wrap only BrowserForce's exposed async entry points:

- `page`
- `context`
- helper functions returned from `buildExecContext()`
- objects returned by those helper calls when they are known Playwright-like handles, if practical

Use a conservative proxy:

```js
function guardObjectMethods(target, run, seen = new WeakMap()) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
  if (seen.has(target)) return seen.get(target);

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return guardAsyncFunction(value.bind(obj), run);
    },
    set(obj, prop, value, receiver) {
      run.throwIfAborted();
      return Reflect.set(obj, prop, value, receiver);
    },
    deleteProperty(obj, prop) {
      run.throwIfAborted();
      return Reflect.deleteProperty(obj, prop);
    },
  });

  seen.set(target, proxy);
  return proxy;
}
```

Use it for `state`, `page`, and `context`. Do not proxy constructors like `URL`, `URLSearchParams`, `Buffer`, `TextEncoder`, or `TextDecoder`.

**Step 3: Guard built-in helpers in the execute context**

When building `guardedExecCtx`, wrap function values:

```js
for (const [key, value] of Object.entries(execCtx)) {
  if (key === 'state' || key === 'page' || key === 'context') continue;
  guardedExecCtx[key] = typeof value === 'function' ? guardAsyncFunction(value, run) : value;
}
guardedExecCtx.state = guardObjectMethods(execCtx.state, run);
guardedExecCtx.page = guardObjectMethods(execCtx.page, run);
guardedExecCtx.context = guardObjectMethods(execCtx.context, run);
```

Be careful with `console`: keep the existing execute console shim usable, but guard method calls the same way or leave it unproxied if tests show proxying changes formatting.

**Step 4: Update polling helpers to observe cancellation directly**

Modify these helpers to accept or close over `executeSignal` / `throwIfExecutionAborted` where they wait:

- `smartWaitForPageLoad(page, timeout, pollInterval, minWait, { signal } = {})`
- `waitForPageLoad` wrapper inside `buildExecContext()`
- `getBrowserforcePageForTab()`

Add a shared private delay helper:

```js
function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timerId = globalThis.setTimeout(resolve, ms);
    const abort = () => {
      globalThis.clearTimeout(timerId);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
```

Use this only inside BrowserForce helpers. User snippets still receive the run-scoped `setTimeout`.

**Step 5: Run focused tests**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
```

Expected: all new timeout lifecycle tests pass.

**Step 6: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/src/exec-engine.js /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
git commit -m "fix(mcp): fence execute continuations after timeout"
```

---

### Task 5: Cover MCP and CLI Callers That Share `runCode()`

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js`
- Modify: `/Users/valsaraj/Documents/projects/browserforce/test/cli.test.js` if the CLI has a suitable non-live harness
- Inspect: `/Users/valsaraj/Documents/projects/browserforce/bin.js`
- Inspect: `/Users/valsaraj/Documents/projects/browserforce/mcp/src/index.js`

**Step 1: Verify all caller paths still use shared `runCode()`**

Run:

```bash
rg -n "runCode\\(" /Users/valsaraj/Documents/projects/browserforce
```

Expected top matches:

```text
/Users/valsaraj/Documents/projects/browserforce/mcp/src/index.js:...
/Users/valsaraj/Documents/projects/browserforce/bin.js:...
```

No caller should keep a separate timeout race around `runCode()`.

**Step 2: Add static MCP contract coverage**

In `/Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js`, add assertions that:

- `execute` still catches `CodeExecutionTimeoutError`
- timeout errors still omit the reset hint
- `runCode(code, execCtx, timeout)` remains the single execution boundary

This file mostly uses source-level contract tests, so keep it consistent with nearby tests rather than requiring a live extension.

**Step 3: Add CLI coverage only if existing CLI tests can run without a live browser**

If `/Users/valsaraj/Documents/projects/browserforce/test/cli.test.js` already has a mocked `runCode`/process harness, add a timeout assertion there. If it requires live Chrome, skip this addition and document that shared `runCode()` coverage protects the CLI.

**Step 4: Run targeted tests**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js
node --test /Users/valsaraj/Documents/projects/browserforce/test/cli.test.js
```

Expected: both pass, or `cli.test.js` is intentionally skipped from this task with a note in the commit body if it is not relevant.

**Step 5: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js /Users/valsaraj/Documents/projects/browserforce/test/cli.test.js
git commit -m "test(mcp): preserve execute timeout contract at callers"
```

---

### Task 6: Document the Timeout Boundary and Its Limits

**Files:**
- Modify: `/Users/valsaraj/Documents/projects/browserforce/docs/BROWSERFORCE_AGENT.md`
- Modify: `/Users/valsaraj/Documents/projects/browserforce/docs/USE_CASES.md` if execute timeout behavior is described there
- Modify: `/Users/valsaraj/Documents/projects/browserforce/AGENTS.md` only if a new durable gotcha needs to be added

**Step 1: Add user-facing behavior docs**

Document:

- `execute` timeout aborts BrowserForce's run-scoped timers and helper continuations.
- Timed-out snippets should not continue mutating `state` or issuing new BrowserForce helper calls after the timeout.
- `waitForPageLoad()` remains a page-readiness heuristic; timeout cancellation is handled at the execution boundary.

Do not overpromise impossible cancellation of a Chrome action that already reached the browser before the timeout. Phrase the guarantee narrowly:

```md
An `execute` timeout is a cancellation boundary for BrowserForce-controlled continuations: run-scoped timers, helper polling loops, and guarded follow-up calls stop observing the old run after timeout. A browser action already delivered to Chrome before timeout may still have taken effect, so retry code should observe the page before issuing more mutations.
```

**Step 2: Add a short implementation note if needed**

If Task 4 introduces a notable pattern, add a concise `AGENTS.md` note:

```md
### Execute Timeout Cancellation

Any new helper exposed inside `buildExecContext()` must either be wrapped by the run guard in `runCode()` or explicitly observe `executeSignal` while polling/waiting. Do not add raw `Promise.race()` timeout wrappers that leave losing async work alive.
```

Only add this if the implementation creates a clear maintenance rule.

**Step 3: Run docs/reference search**

Run:

```bash
rg -n "timeout|waitForPageLoad|runCode|executeSignal|throwIfExecutionAborted" /Users/valsaraj/Documents/projects/browserforce/docs /Users/valsaraj/Documents/projects/browserforce/AGENTS.md /Users/valsaraj/Documents/projects/browserforce/mcp/src
```

Expected: no stale claims that timeout is merely a late error response.

**Step 4: Commit**

```bash
git add /Users/valsaraj/Documents/projects/browserforce/docs/BROWSERFORCE_AGENT.md /Users/valsaraj/Documents/projects/browserforce/docs/USE_CASES.md /Users/valsaraj/Documents/projects/browserforce/AGENTS.md
git commit -m "docs(mcp): document execute timeout cancellation boundary"
```

---

### Task 7: Final Verification and Live Probe

**Files:**
- No source changes unless verification exposes a bug.

**Step 1: Run the focused MCP test suite**

Run:

```bash
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/exec-engine-plugins.test.js
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-tools.test.js
node --test /Users/valsaraj/Documents/projects/browserforce/mcp/test/mcp-plugin-integration.test.js
```

Expected: all pass.

**Step 2: Run full MCP tests**

Run:

```bash
pnpm test:mcp
```

Expected: all MCP tests pass.

**Step 3: Run the stable browser-level repro**

Use BrowserForce execute against a stable page:

```js
state.timeoutLeakPage = await context.newPage();
await state.timeoutLeakPage.setContent('<!doctype html><title>Timeout Leak Probe</title><main id="status">before</main>');
return await state.timeoutLeakPage.evaluate(() => document.querySelector('#status').textContent);
```

Then run with `timeout: 50`:

```js
const target = state.timeoutLeakPage;
await new Promise((resolve) => setTimeout(resolve, 300));
await target.evaluate(() => {
  window.__bfTimeoutLeak = 'mutated-after-timeout';
  document.querySelector('#status').textContent = window.__bfTimeoutLeak;
});
```

Expected: MCP returns `Code execution timed out after 50ms`.

Then observe after 700ms:

```js
return await state.timeoutLeakPage.evaluate(() => ({
  leak: window.__bfTimeoutLeak || null,
  status: document.querySelector('#status').textContent,
}));
```

Expected:

```json
{
  "leak": null,
  "status": "before"
}
```

**Step 4: Run a live-site sanity check on the reported page**

Open `https://sasi.heymantle.com/` and verify that a page-load timeout no longer leaves BrowserForce-owned continuations running after the MCP response. Do not treat this as the primary regression test because the site's navigation/load behavior is intentionally noisy.

**Step 5: Commit any verification fixes**

If verification required changes:

```bash
git add <specific changed files>
git commit -m "fix(mcp): harden execute timeout cancellation verification"
```

If no changes were needed, do not create an empty commit.

---

### Non-Goals

- Do not redesign `waitForPageLoad()` heuristics in this fix.
- Do not add dependencies such as `acorn`; Playwriter uses it for auto-return parsing, not timeout cancellation.
- Do not move Playwright execution into a worker thread. Playwright `Page`/`BrowserContext` handles are not transferable, and reconnecting inside a worker would be a larger architecture change.
- Do not promise that an already-sent Chrome/CDP command can be rolled back. The fix is to stop late BrowserForce continuations and future helper calls after timeout.

