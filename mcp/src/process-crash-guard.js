// process-crash-guard.js — keep long-lived BrowserForce servers alive when
// user snippet code misbehaves.
//
// Why this exists: exec/eval snippets run arbitrary Playwright JS. A snippet
// like `(async () => { ... })()` (expression statement, never returned) runs
// DETACHED from runCode()'s awaited promise — when it rejects, nothing
// observes the rejection. On Node 22 the default policy
// (--unhandled-rejections=throw) turns that into a fatal crash: the MCP
// server dies, every MCP client in every window gets "Not connected", and
// `reset` cannot recover because reset runs inside the dead process
// (incident: Cursor session a0eab22b, 2026-07-06). Same exposure for
// synchronous throws from user timer callbacks (uncaughtException).
//
// The guard logs and survives. It must write to stderr ONLY — stdout is the
// MCP stdio protocol channel and a stray line there corrupts the transport.
// Risk accepted: after an uncaught exception the process state is officially
// "unknown" — but this server's state is browser handles + maps, all
// recoverable via the reset tool, whereas the default (process death) loses
// everything unconditionally.

let installed = false;

function formatError(kind, err) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err);
  return `${kind} (survived): ${detail}`;
}

/**
 * Install process-level unhandledRejection/uncaughtException listeners that
 * log and continue. Idempotent per process: the first install wins, repeat
 * calls are no-ops (`alreadyInstalled: true`). `writeLine` is injectable for
 * tests; production default writes to stderr.
 */
export function installProcessCrashGuard({
  logPrefix = '[bf]',
  writeLine = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (installed) return { alreadyInstalled: true };
  installed = true;

  process.on('unhandledRejection', (reason) => {
    try {
      writeLine(`${logPrefix} ${formatError('Unhandled rejection', reason)}`);
    } catch { /* logging must never throw */ }
  });

  process.on('uncaughtException', (err) => {
    try {
      writeLine(`${logPrefix} ${formatError('Uncaught exception', err)}`);
    } catch { /* logging must never throw */ }
  });

  return { alreadyInstalled: false };
}
