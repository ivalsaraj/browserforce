import assert from 'node:assert/strict';

export function assertBrowserforceCoreSkill(content, sourceLabel = 'skill') {
  const text = String(content ?? '');
  assert.ok(text.trim(), `${sourceLabel} must not be empty`);
  assert.match(text, /^---[\s\S]*?^name:\s*browserforce\s*$/m);
  assert.match(text, /^description:\s*\S/m);
  assert.doesNotMatch(text, /^hidden:\s*true\s*$/m);
  for (const marker of ['browserforce snapshot', 'click', 'fill', 'open', 'stable handles', 'names', 'stale', 're-snapshot', 'persistent', 'one-shot', 'real browser', 'Troubleshooting', 'browserforce wait', 'browserforce get', 'browserforce eval', 'browserforce run', '--json', 'fallback']) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${sourceLabel} missing ${marker}`);
  }
  for (const stale of ['browserforce skills get', 'browserforce skills list', 'browserforce skills path', 'skill-data/', '--full', '## Full reference', 'references/commands.md']) {
    assert.doesNotMatch(text, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${sourceLabel} contains ${stale}`);
  }
}
