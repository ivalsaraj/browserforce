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
  wait: { flags: { tab: 'value' } },
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

// ─── Verb executors ──────────────────────────────────────────────────────────
// Normalized input shape per verb (shared by the sessiond JSON body path and
// the parsed command-string path): each executor validates, builds a snippet,
// and runs it through runtime.runCommand().

function resolveTimeout(requested, fallback = 30000) {
  const value = Number(requested);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const VERB_EXECUTORS = {
  async snapshot({ body, runtime, timeout }) {
    const args = {
      selector: body?.selector,
      search: body?.search,
      interactiveOnly: body?.interactiveOnly === true,
    };
    const code = `return await snapshotData(${JSON.stringify(args)});`;
    return runtime.runCommand({ code, timeout });
  },

  async click({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref) throw usageError('click requires a ref (e.g. click @e2)');
    const code = refLocatorSnippet(ref, 'await locator.click();', `{ clicked: ${JSON.stringify(ref)} }`);
    return runtime.runCommand({ code, timeout });
  },

  async hover({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref) throw usageError('hover requires a ref (e.g. hover @e2)');
    const code = refLocatorSnippet(ref, 'await locator.hover();', `{ hovered: ${JSON.stringify(ref)} }`);
    return runtime.runCommand({ code, timeout });
  },

  async fill({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref || body?.text === undefined) throw usageError('fill requires a ref and text (e.g. fill @e3 "hello")');
    const text = String(body.text ?? '');
    const code = refLocatorSnippet(ref, `await locator.fill(${JSON.stringify(text)});`, `{ filled: ${JSON.stringify(ref)} }`);
    return runtime.runCommand({ code, timeout });
  },

  async type({ body, runtime, timeout }) {
    const ref = normalizeRef(body?.ref);
    if (!ref || body?.text === undefined) throw usageError('type requires a ref and text (e.g. type @e4 "abc")');
    const text = String(body.text ?? '');
    const code = refLocatorSnippet(ref, `await locator.pressSequentially(${JSON.stringify(text)});`, `{ typed: ${JSON.stringify(ref)} }`);
    return runtime.runCommand({ code, timeout });
  },

  async press({ body, runtime, timeout }) {
    const key = String(body?.key ?? '');
    if (!key) throw usageError('press requires a key');
    const code = `await page.keyboard.press(${JSON.stringify(key)});\nreturn { pressed: ${JSON.stringify(key)} };`;
    return runtime.runCommand({ code, timeout });
  },

  async wait({ body, runtime, timeout }) {
    const kind = String(body?.kind ?? '');
    const code = waitSnippet(kind, body?.value, timeout);
    if (!code) throw usageError(`unknown wait kind: ${kind}`);
    return runtime.runCommand({ code, timeout: timeout + WAIT_RUN_HEADROOM_MS });
  },

  async get({ body, runtime, timeout }) {
    const what = String(body?.what ?? '');
    if (what === 'url') {
      return runtime.runCommand({ code: 'return { url: page.url() };', timeout });
    }
    if (what === 'title') {
      return runtime.runCommand({ code: 'return { title: await page.title() };', timeout });
    }
    if (what === 'text' || what === 'html') {
      const ref = normalizeRef(body?.ref);
      if (!ref) throw usageError(`get ${what} requires a ref (e.g. get ${what} @e2)`);
      const expr = what === 'text' ? '{ text: await locator.textContent() }' : '{ html: await locator.innerHTML() }';
      const code = refLocatorSnippet(ref, '', expr);
      return runtime.runCommand({ code, timeout });
    }
    throw usageError(`unknown get target: ${what}`);
  },

  async eval({ body, runtime, timeout }) {
    const code = String(body?.code ?? '');
    if (!code.trim()) throw usageError('eval requires code');
    // The user's code IS the snippet — same guarded runCode() boundary as MCP
    // exec / CLI -e. Never eval()/new Function() at the caller.
    return runtime.runCommand({ code, timeout });
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

const COMMAND_HELP_TEXT = `BrowserForce commands:
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
  get <url|title> [--tab name]         Read page url/title
  get <text|html> <ref> [--tab name]   Read element text/innerHTML
  eval <js> [--tab name]               Run raw Playwright JS in the session
  rename <old> <new> [--replace]       Rename a tab name
  forget <name>                        Remove a tab name
  help                                 Show this help

Refs (@e1, @e2, ...) come from snapshot and go stale when the page changes —
run snapshot again after navigation or UI changes.`;

// Convert parsed command-string args/flags into the normalized verb body used
// by the sessiond JSON path, so both surfaces execute identically.
function commandToBody({ verb, args, flags }) {
  switch (verb) {
    case 'snapshot':
      return {
        selector: flags.selector,
        search: flags.search,
        interactiveOnly: flags.interactive === true,
      };
    case 'click':
    case 'hover':
      return { ref: args[0] };
    case 'fill':
    case 'type':
      return { ref: args[0], text: args.length > 1 ? args.slice(1).join(' ') : undefined };
    case 'press':
      return { key: args[0] };
    case 'wait':
      return { kind: args[0], value: args.length > 1 ? args.slice(1).join(' ') : undefined };
    case 'get':
      return { what: args[0], ref: args[1] };
    case 'eval':
      return { code: args.join(' ') };
    default:
      return {};
  }
}

/**
 * Execute a CLI-compatible command string against a browser session runtime.
 * This is the single entry point for the MCP `browserforce` tool and the CLI
 * direct/`run` paths. Returns `{ data, warning }`; throws
 * BrowserforceCommandError for parse/validation/lookup failures.
 */
export async function executeBrowserforceCommand({ command, runtime, timeout } = {}) {
  const parsed = parseBrowserforceCommand(command);
  const { verb } = parsed;

  if (verb === 'help') {
    return { data: COMMAND_HELP_TEXT, warning: null };
  }

  if (verb === 'tabs' || verb === 'use' || verb === 'open' || verb === 'rename' || verb === 'forget') {
    throw new BrowserforceCommandError(`Command "${verb}" is not implemented yet.`, {
      code: 'NOT_IMPLEMENTED',
      suggestion: HELP_SUGGESTION,
    });
  }

  const body = commandToBody(parsed);
  const data = await executeBrowserforceVerb({
    verb,
    body,
    runtime,
    timeout: resolveTimeout(timeout),
  });
  return { data, warning: null };
}
