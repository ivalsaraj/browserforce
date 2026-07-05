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
