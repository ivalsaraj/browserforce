import { createCodexProvider } from './codex-provider.js';
import { createClaudeProvider } from './claude-provider.js';
import { DEFAULT_PROVIDER, PROVIDER_ALLOWLIST } from '../provider-constants.js';

const PROVIDER_SET = new Set(PROVIDER_ALLOWLIST);

export { DEFAULT_PROVIDER, PROVIDER_ALLOWLIST };

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function isAllowedProvider(provider) {
  const normalized = normalizeText(provider);
  return !!normalized && PROVIDER_SET.has(normalized);
}

export function normalizeProvider(provider, fallback = null) {
  const normalized = normalizeText(provider);
  if (!normalized) return fallback;
  return isAllowedProvider(normalized) ? normalized : fallback;
}

export function resolveSessionProvider(session) {
  return normalizeProvider(session?.provider, DEFAULT_PROVIDER);
}

export function createProviderRegistry(opts = {}) {
  const providers = new Map();

  const codex = createCodexProvider({
    codexCwd: opts.codexCwd,
    runExecutor: opts.codexRunExecutor || opts.runExecutor,
    modelFetcher: opts.codexModelFetcher || opts.modelFetcher,
    codexCommand: opts.codexCommand,
    modelListTimeoutMs: opts.modelListTimeoutMs,
  });
  providers.set(codex.id, codex);

  const claude = createClaudeProvider({
    claudeCwd: opts.claudeCwd || opts.codexCwd,
    runExecutor: opts.claudeRunExecutor,
    modelFetcher: opts.claudeModelFetcher,
    claudeCommand: opts.claudeCommand,
  });
  providers.set(claude.id, claude);

  if (opts.providerOverrides && typeof opts.providerOverrides === 'object') {
    for (const [id, override] of Object.entries(opts.providerOverrides)) {
      const normalizedId = normalizeProvider(id);
      if (!normalizedId || !override || typeof override !== 'object') continue;
      providers.set(normalizedId, {
        id: normalizedId,
        label: String(override.label || normalizedId).trim() || normalizedId,
        ...override,
      });
    }
  }

  return {
    getProvider(id) {
      const normalized = normalizeProvider(id);
      if (!normalized) return null;
      return providers.get(normalized) || null;
    },
    listProviders() {
      return PROVIDER_ALLOWLIST
        .map((id) => providers.get(id))
        .filter(Boolean)
        .map((provider) => ({
          id: provider.id,
          label: provider.label || provider.id,
        }));
    },
  };
}
