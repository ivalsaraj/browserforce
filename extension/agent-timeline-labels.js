const SHELL_LC_WRAPPER_RE = /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i;

export function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function isBrowserForceExecutePayload(payload = {}) {
  const name = String(firstString([
    payload.name,
    payload.toolName,
    payload.tool,
  ]) || '').trim().toLowerCase();

  if (name === 'browserforce:execute' || name === 'mcp__browserforce__execute') return true;
  if (name !== 'execute') return false;

  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
  if (args && typeof args.code === 'string') return true;
  if (typeof payload.code === 'string') return true;

  const rawArgs = String(firstString([payload.arguments, payload.input]) || '').trim();
  return /"code"\s*:/.test(rawArgs);
}

export function isBrowserForceResetPayload(payload = {}) {
  const name = String(firstString([
    payload.name,
    payload.toolName,
    payload.tool,
  ]) || '').trim().toLowerCase();

  if (name === 'browserforce:reset' || name === 'mcp__browserforce__reset') return true;
  if (name !== 'reset') return false;

  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
  if (args && Object.keys(args).length > 0) return false;

  const rawArgs = String(firstString([payload.arguments, payload.input]) || '').trim();
  return !rawArgs || rawArgs === '{}' || rawArgs === 'null';
}

export function normalizeToolLabel(label, payload = {}) {
  const raw = String(label || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();

  if (
    isBrowserForceExecutePayload(payload)
    && (normalized === 'execute' || normalized === 'mcp__browserforce__execute' || normalized === 'browserforce:execute')
  ) {
    return 'BrowserForce:execute';
  }

  if (
    isBrowserForceResetPayload(payload)
    && (normalized === 'reset' || normalized === 'mcp__browserforce__reset' || normalized === 'browserforce:reset')
  ) {
    return 'BrowserForce:reset';
  }

  return raw;
}

export function unwrapShellLcCommand(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(SHELL_LC_WRAPPER_RE);
  if (!match) return text;
  let command = String(match[1] || '').trim();
  if (!command) return text;
  if (command.length >= 2 && command.startsWith("'") && command.endsWith("'")) {
    command = command.slice(1, -1).replace(/'"'"'/g, "'");
  } else if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) {
    command = command.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return command.trim() || text;
}

export function normalizeStepDetails(details, label = '', options = {}) {
  const resolvedOptions = options && typeof options === 'object' ? options : {};
  const maxLines = Number.isFinite(resolvedOptions.maxLines) && resolvedOptions.maxLines > 0
    ? Math.floor(resolvedOptions.maxLines)
    : null;
  const maxLineLength = Number.isFinite(resolvedOptions.maxLineLength) && resolvedOptions.maxLineLength > 3
    ? Math.floor(resolvedOptions.maxLineLength)
    : null;
  const preserveIndentation = resolvedOptions.preserveIndentation === true;
  const normalizedLabel = String(label || '').trim();
  const lines = [];
  const pushLine = (value) => {
    const parts = unwrapShellLcCommand(value)
      .split('\n')
      .map((part) => (preserveIndentation ? part.replace(/\s+$/g, '') : part.trim()));
    for (const rawPart of parts) {
      const part = preserveIndentation ? rawPart : rawPart.replace(/^[-*]\s+/, '').trim();
      const comparablePart = preserveIndentation ? part.trim() : part;
      if (!comparablePart) continue;
      if (normalizedLabel && comparablePart === normalizedLabel) continue;
      if (lines.includes(part)) continue;
      lines.push(maxLineLength && part.length > maxLineLength
        ? `${part.slice(0, maxLineLength - 3)}...`
        : part);
      if (maxLines && lines.length >= maxLines) return;
    }
  };
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (maxLines && lines.length >= maxLines) return;
        visit(item);
      }
      return;
    }
    if (typeof value === 'object') {
      visit(value.text);
      visit(value.message);
      visit(value.output);
      visit(value.command);
      visit(value.cmd);
      visit(value.code);
      visit(value.input);
      visit(value.args);
      visit(value.parameters);
      visit(value.params);
      visit(value.payload);
      visit(value.arguments);
      visit(value.path);
      visit(value.query);
      visit(value.pattern);
      return;
    }
    pushLine(value);
  };
  visit(details);
  return lines;
}

export function stepDetailsForRunEvent(evt, label) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  const normalizedPayload = {
    ...payload,
    ...item,
    name: firstString([item.name, payload.name]),
    toolName: firstString([item.toolName, payload.toolName]),
    tool: firstString([item.tool, payload.tool]),
    args: item.args || payload.args,
    arguments: firstString([item.arguments, payload.arguments]),
    input: item.input || payload.input,
    code: firstString([item.code, payload.code]),
  };
  const preserveExecuteScript = isBrowserForceExecutePayload(normalizedPayload);
  return normalizeStepDetails([
    payload.details,
    payload.text,
    payload.message,
    payload.delta,
    payload.command,
    payload.path,
    payload.query,
    payload.pattern,
    payload.args,
    payload.paths,
    payload.items,
    payload.item,
    item?.details,
    item?.text,
    item?.message,
    item?.summary,
    item?.command,
    item?.path,
    item?.query,
    item?.pattern,
    item?.args,
    item?.paths,
    item?.input,
    item?.arguments,
    item?.code,
  ], label, preserveExecuteScript
    ? { maxLines: null, maxLineLength: null, preserveIndentation: true }
    : undefined);
}

export function stepKeyForRunEvent(evt) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  const key = firstString([
    payload.stepKey,
    payload.step_key,
    item.stepKey,
    item.step_key,
    payload.callId,
    payload.call_id,
    item.callId,
    item.call_id,
    item.id,
    payload.id,
  ]);
  if (!key) return '';
  return key.startsWith('tool:') ? key : `tool:${key}`;
}

export function stepDetailsForToolEvent(evt, label) {
  const payload = evt?.payload || {};
  if (String(payload.type || '').toLowerCase() === 'reasoning') return [];
  const preserveExecuteScript = isBrowserForceExecutePayload(payload);
  return normalizeStepDetails([
    payload.details,
    payload.text,
    payload.message,
    payload.delta,
    payload.command,
    payload.cmd,
    payload.code,
    payload.arguments,
    payload.path,
    payload.query,
    payload.pattern,
    payload.args,
    payload.paths,
    payload.items,
    payload.item,
  ], label, preserveExecuteScript
    ? { maxLines: null, maxLineLength: null, preserveIndentation: true }
    : undefined);
}

function stripInlineMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^>\s*/gm, '')
    .trim();
}

function clipHeadingAtClauseBoundary(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const clauseMatch = source.match(
    /^(.{24,}?)(?:\s*;\s+|\s*,\s*(?:then|so|because|while|after)\b|\s+(?:and then|and i['’]?ll|and i am|then|so that|so i can|so we can|in order to|while|after that)\b)/i,
  );
  if (!clauseMatch) return source;
  return String(clauseMatch[1] || '').trim();
}

export function commentaryHeadingFromDelta(delta) {
  const source = String(delta || '').trim();
  if (!source) return '';
  const firstLine = source
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  if (!firstLine) return '';

  let heading = stripInlineMarkdown(firstLine)
    .replace(/^[\-*•\d.)\s]+/, '')
    .replace(/^\s*(?:i['’]?m|i am|i['’]?ll|i will)\s+/i, '')
    .replace(/^\s*(?:going to|about to|trying to|plan(?:ning)? to|want to)\s+/i, '')
    .replace(/^let me\s+/i, '')
    .replace(/^(?:next|now)\s*,?\s+/i, '')
    .replace(/[.?!:;,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  heading = clipHeadingAtClauseBoundary(heading);
  if (!heading) return '';
  if (/^(browserforce|recovery action|error[:\s])/i.test(heading)) return '';
  if (/^[`'"]?\//.test(heading) || /^[a-z]:\\/i.test(heading)) return '';
  if (heading.length > 72) {
    const clipped = heading.slice(0, 69).trimEnd();
    const wordBoundary = clipped.lastIndexOf(' ');
    const base = wordBoundary >= 56 ? clipped.slice(0, wordBoundary).trimEnd() : clipped;
    heading = `${base}...`;
  }
  return heading.charAt(0).toUpperCase() + heading.slice(1);
}
