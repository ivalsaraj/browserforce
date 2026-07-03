const PLUGIN_HELPER_NAME_RE = /^[A-Za-z_$][\w$]{0,127}$/;
const PLUGIN_HELPER_PREFIX_RE = /^[a-z][a-z0-9]{1,31}$/;

export function normalizePluginHelperName(value) {
  const text = String(value || '').trim();
  if (!text || !PLUGIN_HELPER_NAME_RE.test(text)) return '';
  return text;
}

export function normalizePluginHelperNames(input) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = [];
  for (const rawValue of source) {
    const helperName = normalizePluginHelperName(rawValue);
    if (!helperName) continue;
    const key = helperName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(helperName);
  }
  return normalized;
}

export function normalizePluginHelperPrefix(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || !PLUGIN_HELPER_PREFIX_RE.test(text)) return '';
  return text;
}
