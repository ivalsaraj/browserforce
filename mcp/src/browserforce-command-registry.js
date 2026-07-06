// browserforce-command-registry.js — shared command surface for BrowserForce.
//
// One command language, three transports: the MCP `browserforce` tool, the CLI
// direct verbs (`browserforce click @e2`), and the sessiond HTTP verbs all
// parse and execute here so behavior can never drift between surfaces.
//
// The registry is transport-agnostic: it receives a `runtime`
// (createBrowserSessionRuntime instance) and routes every page action through
// `runtime.runCommand()` → the guarded `runCode()` boundary. It never calls
// raw Playwright page/locator methods itself; raw calls are reserved for the
// runtime's explicit tab-management APIs (open/page selection).

// ─── Structured command error ────────────────────────────────────────────────

/**
 * Structured, agent-friendly command failure. `suggestion` tells the agent the
 * next command to run; `resetHintAllowed` gates whether callers may append
 * reset guidance (only true for connection/internal failures — never for
 * selector, stale-ref, tab-lookup, or parse errors).
 */
export class BrowserforceCommandError extends Error {
  constructor(message, { code = 'COMMAND_ERROR', suggestion = null, resetHintAllowed = false } = {}) {
    super(message);
    this.name = 'BrowserforceCommandError';
    this.code = code;
    this.suggestion = suggestion;
    this.resetHintAllowed = resetHintAllowed;
  }
}

const HELP_SUGGESTION = 'Run browserforce "help" to see available commands.';

// ─── Command language ────────────────────────────────────────────────────────
// Flag spec per verb: value flags consume the next token (or =value); boolean
// flags do not. Unknown flags and missing values fail loudly (agent-browser
// lesson: never silently ignore typos).

export const COMMAND_SPECS = Object.freeze({
  open: { flags: { as: 'value', replace: 'boolean' } },
  tabs: { flags: {} },
  use: { flags: {} },
  snapshot: { flags: { tab: 'value', selector: 'value', search: 'value', interactive: 'boolean' } },
  click: { flags: { tab: 'value' } },
  hover: { flags: { tab: 'value' } },
  fill: { flags: { tab: 'value' } },
  type: { flags: { tab: 'value' } },
  press: { flags: { tab: 'value' } },
  // `wait text <value>` is the primary form; the kind flags (--text <value>,
  // --url, --load, --fn, --selector) are an accepted alias kept for CLI
  // compatibility, valid on every surface.
  wait: { flags: { tab: 'value', text: 'value', url: 'value', load: 'value', fn: 'value', selector: 'value' } },
  get: { flags: { tab: 'value' } },
  eval: { flags: { tab: 'value' } },
  rename: { flags: { replace: 'boolean' } },
  forget: { flags: {} },
  help: { flags: {} },
});

// ─── Tokenizer ───────────────────────────────────────────────────────────────
// Minimal shell-like tokenizer: whitespace-separated tokens, double/single
// quotes group text, backslash escapes the next char inside double quotes and
// outside quotes. No dependency.

function tokenize(command) {
  const tokens = [];
  let current = '';
  let hasCurrent = false;
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        i += 1;
        current += command[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      i += 1;
      current += command[i];
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasCurrent) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  if (quote) {
    throw new BrowserforceCommandError(`Unterminated ${quote === '"' ? 'double' : 'single'} quote in command.`, {
      code: 'BAD_QUOTING',
      suggestion: 'Close the quote or escape it, e.g. fill @e3 "hello world".',
    });
  }
  if (hasCurrent) tokens.push(current);
  return tokens;
}

// Scan one fully-quoted group at the start of `text`. Honors backslash
// escapes inside double quotes only (mirror of tokenize's rules — the CLI
// builder emits \" and \\ inside double-quoted code). Returns
// { inner, endIndex } for a terminated group, or null when the group never
// closes.
function matchQuotedGroup(text) {
  const quote = text[0];
  let inner = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === quote) return { inner, endIndex: i + 1 };
    if (ch === '\\' && quote === '"' && i + 1 < text.length) {
      i += 1;
      inner += text[i];
      continue;
    }
    inner += ch;
  }
  return null;
}

// Legacy quoted shapes (CLI-built): `eval "<code>"` with optional trailing
// --tab — recognized ONLY when the remainder is one fully-quoted group
// followed by end-of-input or a valid --tab. Everything else is raw code
// with an optional LEADING --tab. Trailing flag extraction on raw code is
// deliberately unsupported — code may legitimately contain "--tab", and
// guessing wrong corrupts the snippet. Quote-leading JS that continues past
// its closing quote (`'text'.length`) is raw, never unwrapped.
function parseEvalRemainder(remainder) {
  if (remainder.startsWith('"') || remainder.startsWith("'")) {
    const group = matchQuotedGroup(remainder);
    if (group) {
      const rest = remainder.slice(group.endIndex).trim();
      if (rest === '') return { args: [group.inner], flags: {} };
      const tabMatch = rest.match(/^--tab(?:=(\S+)|\s+(\S+))$/);
      if (tabMatch) return { args: [group.inner], flags: { tab: tabMatch[1] ?? tabMatch[2] } };
    }
  }
  const flags = {};
  let code = remainder;
  const leadingTab = code.match(/^--tab(?:=(\S+)|\s+(\S+))\s*/);
  if (leadingTab) {
    flags.tab = leadingTab[1] ?? leadingTab[2];
    code = code.slice(leadingTab[0].length);
  }
  return { args: [code], flags };
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a CLI-compatible command string into `{ verb, args, flags, command }`.
 * Throws BrowserforceCommandError (never returns a partial parse) for unknown
 * verbs, unknown flags, missing flag values, or bad quoting.
 */
export function parseBrowserforceCommand(command) {
  const text = typeof command === 'string' ? command.trim() : '';
  if (!text) {
    throw new BrowserforceCommandError('Empty command.', {
      code: 'EMPTY_COMMAND',
      suggestion: HELP_SUGGESTION,
    });
  }

  // `eval` carries raw JS: tokenizing it strips quotes and collapses
  // whitespace, silently turning valid code into different code
  // (getByRole('button') became getByRole(button) — ReferenceError). Take the
  // remainder verbatim; only the legacy fully-quoted forms (what the CLI
  // direct-verb builder emits) keep tokenized semantics.
  const firstWord = text.match(/^(\S+)/)[1];
  if (firstWord.toLowerCase() === 'eval') {
    const remainder = text.slice(firstWord.length).trim();
    const { args, flags } = parseEvalRemainder(remainder);
    return { verb: 'eval', args, flags, command: text };
  }

  const tokens = tokenize(text);
  const verb = String(tokens[0] || '').toLowerCase();
  const spec = COMMAND_SPECS[verb];
  if (!spec) {
    throw new BrowserforceCommandError(`Unknown command: ${verb}`, {
      code: 'UNKNOWN_COMMAND',
      suggestion: HELP_SUGGESTION,
    });
  }

  const args = [];
  const flags = {};
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }

    const eqIdx = token.indexOf('=');
    const name = (eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx)).toLowerCase();
    const kind = spec.flags[name];
    if (!kind) {
      throw new BrowserforceCommandError(`Unknown flag --${name} for "${verb}".`, {
        code: 'UNKNOWN_FLAG',
        suggestion: HELP_SUGGESTION,
      });
    }

    if (kind === 'boolean') {
      if (eqIdx !== -1) {
        throw new BrowserforceCommandError(`Flag --${name} does not take a value.`, {
          code: 'UNEXPECTED_FLAG_VALUE',
          suggestion: HELP_SUGGESTION,
        });
      }
      flags[name] = true;
      continue;
    }

    // value flag: --flag=value or --flag value
    if (eqIdx !== -1) {
      const value = token.slice(eqIdx + 1);
      if (!value) {
        throw new BrowserforceCommandError(`Flag --${name} requires a value.`, {
          code: 'MISSING_FLAG_VALUE',
          suggestion: HELP_SUGGESTION,
        });
      }
      flags[name] = value;
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new BrowserforceCommandError(`Flag --${name} requires a value.`, {
        code: 'MISSING_FLAG_VALUE',
        suggestion: HELP_SUGGESTION,
      });
    }
    flags[name] = next;
    i += 1;
  }

  return { verb, args, flags, command: text };
}

// ─── Snippet builders (moved from cli/sessiond.js) ───────────────────────────
// Every page action is a generated snippet routed through runtime.runCommand()
// → runCode(). Untrusted input is embedded ONLY as JSON literals, never as
// executable code.

/**
 * Canonical ref normalization. The command surface accepts the
 * agent-browser-style aliases `@e1`, `ref=e1`, and bare `e1`; all map to `e1`.
 * Kept as a local copy on purpose: this registry is import-free by design and
 * `cli/session-client.js` (the other copy) must stay loadable without mcp/src.
 * Keep the two in sync.
 */
export function normalizeRef(input) {
  if (input == null) return '';
  let s = String(input).trim();
  if (s.startsWith('@')) s = s.slice(1);
  else if (s.slice(0, 4).toLowerCase() === 'ref=') s = s.slice(4);
  return s.trim();
}

// Build a ref-interaction snippet that resolves a stored ref via locatorForRef()
// inside runCode(), then runs `actionLine` (already containing JSON-encoded
// literals) and returns `returnExpr`.
function refLocatorSnippet(ref, actionLine, returnExpr) {
  const unknown = `Unknown ref: ${ref}. Run snapshot again to refresh refs.`;
  return [
    `const locator = locatorForRef({ ref: ${JSON.stringify(ref)} });`,
    `if (!locator) throw new Error(${JSON.stringify(unknown)});`,
    actionLine,
    `return ${returnExpr};`,
  ].join('\n');
}

// Build a `wait` snippet using Playwright's own waiters (their internal polling
// + the passed timeout keep it abort-safe). The value is always a JSON literal.
function waitSnippet(kind, value, timeout) {
  const v = JSON.stringify(value ?? '');
  const t = Number(timeout) || 30000;
  switch (kind) {
    case 'text':
      return `await page.waitForFunction((s) => !!document.body && document.body.innerText.toLocaleLowerCase().includes(String(s).toLocaleLowerCase()), ${v}, { timeout: ${t}, polling: 100 });\nreturn { waited: 'text', text: ${v} };`;
    case 'url':
      return `await page.waitForURL(${v}, { timeout: ${t} });\nreturn { waited: 'url', url: page.url() };`;
    case 'load': {
      const state = value || 'load';
      return `await page.waitForLoadState(${JSON.stringify(state)}, { timeout: ${t} });\nreturn { waited: 'load', state: ${JSON.stringify(state)} };`;
    }
    case 'selector':
      return `await page.waitForSelector(${v}, { timeout: ${t} });\nreturn { waited: 'selector', selector: ${v} };`;
    case 'fn':
      return `await page.waitForFunction(${v}, undefined, { timeout: ${t}, polling: 100 });\nreturn { waited: 'fn' };`;
    default:
      return null;
  }
}

// Give runCode headroom beyond the inner Playwright waiter so the waiter times
// out first with a precise message before the hard run abort.
const WAIT_RUN_HEADROOM_MS = 5000;

function usageError(message, { code = 'BAD_COMMAND_USAGE' } = {}) {
  return new BrowserforceCommandError(message, { code, suggestion: HELP_SUGGESTION });
}

// Map the runtime's plain tab-state errors (code-only, import-free by design)
// to agent-facing structured command errors with actionable suggestions.
// None of these are connection failures, so reset hints are never allowed.
const TAB_ERROR_SUGGESTIONS = {
  TAB_NAME_IN_USE: 'Pass --replace to move the name to this tab.',
  TAB_NAME_NOT_FOUND: 'Run "tabs" to see named tabs.',
  TAB_NOT_FOUND: 'Run "tabs" to list open tabs and their stable handles.',
  TAB_AMBIGUOUS: 'Use a stable t<N> handle or a more specific query.',
  TAB_NOT_USABLE: 'That tab is closed. Run "tabs" to list open tabs.',
  BAD_TAB_NAME: 'Use an identifier-like name such as docs or api-docs (t<N> is reserved for handles).',
};

function wrapTabStateError(err) {
  if (err instanceof BrowserforceCommandError) return err;
  const suggestion = TAB_ERROR_SUGGESTIONS[err?.code];
  if (!suggestion) return err;
  return new BrowserforceCommandError(err.message, { code: err.code, suggestion });
}

// Normalize an `open` target: keep anything with an explicit scheme
// (https:, about:, chrome:), default the rest to https://.
function normalizeOpenUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s}`;
}

async function activeTabRow(runtime) {
  const rows = await runtime.listTabRows();
  return rows.find((row) => row.active) ?? null;
}

/**
 * Resolve a verb's optional `--tab` target to a page for per-run pinning.
 * Returns null when no tab was requested (the run uses the active page).
 * Unknown targets fail with the documented teaching error — no reset hint.
 */
async function resolveVerbPage({ body, runtime }) {
  const tab = String(body?.tab ?? '').trim();
  if (!tab) return null;
  try {
    const { page } = await runtime.resolveTabTarget(tab);
    return page;
  } catch (err) {
    if (err?.code === 'TAB_NOT_FOUND') {
      throw new BrowserforceCommandError(`No tab named "${tab}". Run browserforce "tabs" to see available tabs.`, {
        code: 'TAB_NOT_FOUND',
        suggestion: 'Run "tabs" to list open tabs and their stable handles.',
      });
    }
    throw wrapTabStateError(err);
  }
}

// ─── Verb executors ──────────────────────────────────────────────────────────
// Normalized input shape per verb (shared by the sessiond JSON body path and
// the parsed command-string path): each executor validates, builds a snippet,
// and runs it through runtime.runCommand().

function resolveTimeout(requested, fallback = 30000) {
  const value = Number(requested);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ─── Run-failure shaping ─────────────────────────────────────────────────────
// agent-browser lesson: agents over-reset. Only bridge/session failures may
// carry reset guidance; selector timeouts, stale refs, and user-code errors
// must teach the actual next step instead.

// Failures of the bridge/session itself (relay down, extension gone, page or
// browser closed mid-command). These pass through RAW so transport callers
// (the MCP handler's generic branch) may append reset guidance.
const CONNECTION_ERROR_PATTERN =
  /not connected|target closed|has been closed|browser.*disconnected|websocket|econnrefused/i;

/**
 * Classify a runtime.runCommand() failure into an agent-actionable command
 * error. Stale refs teach re-snapshot; other page/action failures (selector
 * timeouts, strict-mode violations, user eval code) become COMMAND_FAILED
 * with no reset hint. Connection failures and run timeouts pass through raw.
 */
function wrapRunCommandError(err) {
  if (err instanceof BrowserforceCommandError) return err;
  // Timeouts are rendered specially by callers (never with a reset hint) —
  // matched by name because this registry is import-free by design.
  if (err?.name === 'CodeExecutionTimeoutError') return err;
  const message = String(err?.message || err);
  if (/^Unknown ref\b/i.test(message)) {
    return new BrowserforceCommandError(message, {
      code: 'STALE_REF',
      suggestion: 'Run browserforce "snapshot" again to refresh refs, then retry with a fresh ref.',
    });
  }
  if (CONNECTION_ERROR_PATTERN.test(message)) return err;
  return new BrowserforceCommandError(message, {
    code: 'COMMAND_FAILED',
    suggestion: 'If the page changed, run browserforce "snapshot" to see its current state and retry.',
  });
}

// Every snippet-backed verb runs through this guard so failures are shaped
// identically on all surfaces (MCP tool, CLI, sessiond).
async function runCommandGuarded(runtime, params) {
  try {
    return await runtime.runCommand(params);
  } catch (err) {
    throw wrapRunCommandError(err);
  }
}

const VERB_EXECUTORS = {
  async tabs({ runtime }) {
    return { tabs: await runtime.listTabRows() };
  },

  async use({ body, runtime }) {
    const target = String(body?.target ?? '').trim();
    if (!target) throw usageError('use requires a tab target (e.g. use t2, use docs, or use part-of-a-title)');
    try {
      const { page, matchedBy, warning } = await runtime.resolveTabTarget(target);
      runtime.setActivePage(page);
      const active = await activeTabRow(runtime);
      return { active, matchedBy, ...(warning ? { warning } : {}) };
    } catch (err) {
      throw wrapTabStateError(err);
    }
  },

  async open({ body, runtime, timeout }) {
    const url = normalizeOpenUrl(body?.url);
    if (!url) throw usageError('open requires a url (e.g. open https://example.com)');
    const name = String(body?.as ?? '').trim();
    const replace = body?.replace === true;

    // Preflight BEFORE creating anything, mirroring the MCP execute flow:
    // restrictions come from relay HTTP (no CDP), so attached-only sessions
    // fail here without a new tab ever being created.
    const restrictions = await runtime.getBrowserforceRestrictionsForSession();
    if (restrictions?.mode === 'manual' || restrictions?.noNewTabs) {
      throw new BrowserforceCommandError('New tabs are disabled in this BrowserForce session.', {
        code: 'NEW_TABS_DISABLED',
        suggestion: 'Attach a tab with the BrowserForce extension, then target it with "tabs" and "use".',
      });
    }
    // Name preflights so a losing open never leaves an orphan tab: shape
    // first (identifier-like, t<N> reserved), then uniqueness.
    if (name) {
      try {
        runtime.assertValidTabName(name);
      } catch (err) {
        throw wrapTabStateError(err);
      }
      if (runtime.getNamedPage(name) && !replace) {
        throw new BrowserforceCommandError(`Tab name "${name}" is already in use.`, {
          code: 'TAB_NAME_IN_USE',
          suggestion: 'Pass --replace to move the name to the new tab.',
        });
      }
    }

    try {
      const page = await runtime.openNewPage({ url, timeout });
      if (name) runtime.setNamedPage(name, page, { replace });
      const active = await activeTabRow(runtime);
      return { opened: url, tab: active };
    } catch (err) {
      throw wrapTabStateError(err);
    }
  },

  async rename({ body, runtime }) {
    const from = String(body?.from ?? '').trim();
    const to = String(body?.to ?? '').trim();
    if (!from || !to) throw usageError('rename requires the current and new name (e.g. rename docs api-docs)');
    try {
      const result = runtime.renamePageName(from, to, { replace: body?.replace === true });
      return { renamed: { from, to: result.name, replaced: result.replaced } };
    } catch (err) {
      throw wrapTabStateError(err);
    }
  },

  async forget({ body, runtime }) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw usageError('forget requires a name (e.g. forget docs)');
    const removed = runtime.forgetPageName(name);
    if (!removed) {
      throw new BrowserforceCommandError(`No tab named "${name}".`, {
        code: 'TAB_NAME_NOT_FOUND',
        suggestion: 'Run "tabs" to see named tabs.',
      });
    }
    return { forgot: name };
  },

  async snapshot({ body, runtime, timeout }) {
    const page = await resolveVerbPage({ body, runtime });
    const args = {
      selector: body?.selector,
      search: body?.search,
      interactiveOnly: body?.interactiveOnly === true,
    };
    const code = `return await snapshotData(${JSON.stringify(args)});`;
    return runCommandGuarded(runtime, { code, timeout, page });
  },

  async click({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref) throw usageError('click requires a ref (e.g. click @e2)');
    const page = await resolveVerbPage({ body, runtime });
    const code = refLocatorSnippet(ref, 'await locator.click();', `{ clicked: ${JSON.stringify(ref)} }`);
    return runCommandGuarded(runtime, { code, timeout, page });
  },

  async hover({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref) throw usageError('hover requires a ref (e.g. hover @e2)');
    const page = await resolveVerbPage({ body, runtime });
    const code = refLocatorSnippet(ref, 'await locator.hover();', `{ hovered: ${JSON.stringify(ref)} }`);
    return runCommandGuarded(runtime, { code, timeout, page });
  },

  async fill({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref || body?.text === undefined) throw usageError('fill requires a ref and text (e.g. fill @e3 "hello")');
    const page = await resolveVerbPage({ body, runtime });
    const text = String(body.text ?? '');
    const code = refLocatorSnippet(ref, `await locator.fill(${JSON.stringify(text)});`, `{ filled: ${JSON.stringify(ref)} }`);
    return runCommandGuarded(runtime, { code, timeout, page });
  },

  async type({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref || body?.text === undefined) throw usageError('type requires a ref and text (e.g. type @e4 "abc")');
    const page = await resolveVerbPage({ body, runtime });
    const text = String(body.text ?? '');
    const code = refLocatorSnippet(ref, `await locator.pressSequentially(${JSON.stringify(text)});`, `{ typed: ${JSON.stringify(ref)} }`);
    return runCommandGuarded(runtime, { code, timeout, page });
  },

  async press({ body, runtime, timeout }) {
    const key = String(body?.key ?? '');
    if (!key) throw usageError('press requires a key');
    const page = await resolveVerbPage({ body, runtime });
    const code = `await page.keyboard.press(${JSON.stringify(key)});\nreturn { pressed: ${JSON.stringify(key)} };`;
    return runCommandGuarded(runtime, { code, timeout, page });
  },

  async wait({ body, runtime, timeout }) {
    const kind = String(body?.kind ?? '');
    const code = waitSnippet(kind, body?.value, timeout);
    if (!code) throw usageError(`unknown wait kind: ${kind}`);
    const page = await resolveVerbPage({ body, runtime });
    return runCommandGuarded(runtime, { code, timeout: timeout + WAIT_RUN_HEADROOM_MS, page });
  },

  async get({ body, runtime, timeout }) {
    const what = String(body?.what ?? '');
    if (what === 'url' || what === 'title') {
      const page = await resolveVerbPage({ body, runtime });
      // page.title() hangs forever on a lazily-attached real-Chrome tab (no JS
      // execution context is ever announced for it), so bound it and degrade
      // with a teaching note instead of burning the whole run timeout.
      const code = what === 'url'
        ? 'return { url: page.url() };'
        : `const title = await Promise.race([
  page.title(),
  new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
]);
if (title === null) {
  return { title: '', url: page.url(), note: 'Title unavailable: this tab has no JS execution context yet (BrowserForce lazy attach). Use snapshot to read the page instead.' };
}
return { title };`;
      return runCommandGuarded(runtime, { code, timeout, page });
    }
    if (what === 'text' || what === 'html') {
      const ref = normalizeRef(body?.ref);
      if (!ref) throw usageError(`get ${what} requires a ref (e.g. get ${what} @e2)`);
      const page = await resolveVerbPage({ body, runtime });
      const expr = what === 'text' ? '{ text: await locator.textContent() }' : '{ html: await locator.innerHTML() }';
      const code = refLocatorSnippet(ref, '', expr);
      return runCommandGuarded(runtime, { code, timeout, page });
    }
    throw usageError(`unknown get target: ${what}`);
  },

  async eval({ body, runtime, timeout }) {
    const code = String(body?.code ?? '');
    if (!code.trim()) throw usageError('eval requires code');
    const page = await resolveVerbPage({ body, runtime });
    // The user's code IS the snippet — same guarded runCode() boundary as MCP
    // exec / CLI -e. Never eval()/new Function() at the caller.
    return runCommandGuarded(runtime, { code, timeout, page });
  },
};

/**
 * Execute a sessiond-style verb with a JSON body. This preserves the existing
 * `POST /command/<verb>` contract: returns the raw data payload; throws
 * BrowserforceCommandError with code UNKNOWN_VERB for unimplemented verbs
 * (mapped to HTTP 501 by sessiond) and other structured errors for validation
 * failures (mapped to `success:false` envelopes).
 */
export async function executeBrowserforceVerb({ verb, body = {}, runtime, timeout } = {}) {
  const executor = VERB_EXECUTORS[verb];
  if (!executor) {
    throw new BrowserforceCommandError(`command not implemented: ${verb}`, {
      code: 'UNKNOWN_VERB',
      suggestion: HELP_SUGGESTION,
    });
  }
  const effectiveTimeout = resolveTimeout(timeout ?? body?.timeout);
  return executor({ body, runtime, timeout: effectiveTimeout });
}

// ─── Command-string execution (MCP `browserforce` tool + CLI direct verbs) ───

export const COMMAND_HELP_TEXT = `BrowserForce commands:
  open <url> [--as name] [--replace]   Open a URL in a new tab (optionally named)
  tabs                                 List tabs with stable handles (t1, t2, ...)
  use <t handle|name|url/title text>   Switch the active tab
  snapshot [--tab name] [--selector css] [--search re] [--interactive]
                                       Accessibility snapshot with @eN refs
  click <ref> [--tab name]             Click a ref from the last snapshot
  hover <ref> [--tab name]             Hover a ref
  fill <ref> <text> [--tab name]       Clear + fill text into a ref
  type <ref> <text> [--tab name]       Type text key-by-key into a ref
  press <key> [--tab name]             Press a keyboard key (e.g. Enter)
  wait <text|selector|url|load|fn> <value> [--tab name]
                                       Wait for text/selector/url/load-state
                                       (flag form also works: wait --text <s>)
  get <url|title> [--tab name]         Read page url/title
  get <text|html> <ref> [--tab name]   Read element text/innerHTML
  eval [--tab name] <js>               Run raw Playwright JS in the session.
                                       Code is taken VERBATIM to the end of the
                                       command (quotes/newlines preserved) —
                                       put --tab BEFORE the code
  rename <old> <new> [--replace]       Rename a tab name
  forget <name>                        Remove a tab name
  help                                 Show this help

Refs (@e1, @e2, ...) come from snapshot and go stale when the page changes —
run snapshot again after navigation or UI changes.`;

const WAIT_KIND_FLAGS = ['text', 'url', 'load', 'fn', 'selector'];

// Convert parsed command-string args/flags into the normalized verb body used
// by the sessiond JSON path, so both surfaces execute identically. Exported so
// the CLI can turn a parsed direct command into the sessiond JSON body without
// re-implementing any mapping.
export function commandToBody({ verb, args, flags }) {
  switch (verb) {
    case 'tabs':
      return {};
    case 'use':
      // Multiword soft-match targets ("use quarterly reports") join back up.
      return { target: args.join(' ') };
    case 'open':
      return { url: args[0], as: flags.as, replace: flags.replace === true };
    case 'rename':
      return { from: args[0], to: args[1], replace: flags.replace === true };
    case 'forget':
      return { name: args[0] };
    case 'snapshot':
      if (args.length > 0) {
        throw usageError(
          `snapshot takes no positional arguments (got "${args.join(' ')}"). Target a tab with --tab, e.g. snapshot --tab t2.`
        );
      }
      return {
        selector: flags.selector,
        search: flags.search,
        interactiveOnly: flags.interactive === true,
        tab: flags.tab,
      };
    case 'click':
    case 'hover':
      return { ref: args[0], tab: flags.tab };
    case 'fill':
    case 'type':
      return { ref: args[0], text: args.length > 1 ? args.slice(1).join(' ') : undefined, tab: flags.tab };
    case 'press':
      return { key: args[0], tab: flags.tab };
    case 'wait': {
      const kindFlags = WAIT_KIND_FLAGS.filter((k) => flags[k] !== undefined);
      if (kindFlags.length > 1) {
        throw usageError(`wait accepts one kind flag, got --${kindFlags.join(' --')}.`);
      }
      if (kindFlags.length === 1) {
        if (args.length > 0) {
          throw usageError(`wait accepts either a positional kind or --${kindFlags[0]}, not both.`);
        }
        return { kind: kindFlags[0], value: flags[kindFlags[0]], tab: flags.tab };
      }
      return { kind: args[0], value: args.length > 1 ? args.slice(1).join(' ') : undefined, tab: flags.tab };
    }
    case 'get':
      return { what: args[0], ref: args[1], tab: flags.tab };
    case 'eval':
      return { code: args.join(' '), tab: flags.tab };
    default:
      return {};
  }
}

// ─── Shared text rendering ────────────────────────────────────────────────────
// One renderer for MCP text content and CLI human output, driven by the SAME
// structured data as --json / sessiond envelopes — stable handles and names can
// never exist in one surface's output and not another's.

function renderTabRowsText(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'No tabs open.';
  return rows
    .map((row) => {
      const marker = row.active ? '*' : ' ';
      const name = row.name ? ` (${row.name})` : '';
      return `${marker} ${row.handle}${name} ${row.title || '(untitled)'}\n    ${row.url}`;
    })
    .join('\n');
}

function renderSnapshotDataText(data) {
  const refs = Array.isArray(data?.refs) ? data.refs : [];
  const refTable = refs.length > 0
    ? '\n\n--- Ref → Locator ---\n' + refs.map((r) => `${r.ref} (${r.role}${r.name ? ` "${r.name}"` : ''}): ${r.locator ?? '(frame-scoped; use locatorForRef)'}`).join('\n')
    : '';
  return `Page: ${data?.title ?? ''} (${data?.url ?? ''})\nRefs: ${refs.length} interactive elements\n\n${data?.tree || ''}${refTable}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeTabRow(row) {
  if (!row) return '(no active tab)';
  const name = row.name ? ` (${row.name})` : '';
  return `${row.handle}${name} "${row.title || '(untitled)'}" ${row.url}`;
}

/** Render a command's structured result as agent-facing text. */
export function renderBrowserforceCommandText(verb, data) {
  if (typeof data === 'string') return data;
  switch (verb) {
    case 'tabs':
      return renderTabRowsText(data?.tabs);
    case 'snapshot':
      return renderSnapshotDataText(data);
    case 'use': {
      const line = `Active tab: ${describeTabRow(data?.active)} [matched by ${data?.matchedBy}]`;
      return data?.warning ? `${line}\n⚠ ${data.warning}` : line;
    }
    case 'open': {
      const target = data?.tab ? describeTabRow(data.tab) : '(unknown tab)';
      return `Opened ${data?.opened} — now active: ${target}`;
    }
    case 'rename':
      return `Renamed tab "${data?.renamed?.from}" → "${data?.renamed?.to}"${data?.renamed?.replaced ? ' (replaced the previous holder)' : ''}`;
    case 'forget':
      return `Removed tab name "${data?.forgot}".`;
    default:
      return safeStringify(data);
  }
}

/**
 * Execute a CLI-compatible command string against a browser session runtime.
 * This is the single entry point for the MCP `browserforce` tool and the CLI
 * direct/`run` paths. Returns `{ data, warning, text }` — `data` for JSON
 * surfaces, `text` rendered from that same data for human/MCP surfaces.
 * Throws BrowserforceCommandError for parse/validation/lookup failures.
 */
export async function executeBrowserforceCommand({ command, runtime, timeout } = {}) {
  const parsed = parseBrowserforceCommand(command);
  const { verb } = parsed;

  if (verb === 'help') {
    return { data: COMMAND_HELP_TEXT, warning: null, text: COMMAND_HELP_TEXT };
  }

  const body = commandToBody(parsed);
  const data = await executeBrowserforceVerb({
    verb,
    body,
    runtime,
    timeout: resolveTimeout(timeout),
  });
  const warning = verb === 'eval' ? fireAndForgetIifeHint(body.code, data) : null;
  return { data, warning, text: renderBrowserforceCommandText(verb, data) };
}

/**
 * Detect the fire-and-forget foot-gun: a snippet whose entire body is a
 * top-level `(async () => { ... })()` expression statement. The exec wrapper
 * awaits only the completion value — a non-returned IIFE runs DETACHED, the
 * tool reports `undefined`, and a later rejection is invisible to the agent
 * (and, before the process crash guard, fatal to the server). Narrow by
 * design: only the observed shape triggers, so normal `await ...;` snippets
 * that legitimately produce undefined stay hint-free.
 */
export function fireAndForgetIifeHint(code, result) {
  if (result !== undefined) return null;
  const trimmed = String(code ?? '').trim();
  if (!/^\(\s*async\b/.test(trimmed)) return null;
  if (!/\)\s*\(\s*\)\s*;?$/.test(trimmed)) return null;
  return 'Result was undefined: the top-level async IIFE ran detached (fire-and-forget). Prefix it with "return" to await its value and surface its errors.';
}
