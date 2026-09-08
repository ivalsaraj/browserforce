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
  // Discovery contract: the description must claim browser work outright and
  // state why a fresh-profile driver cannot substitute. A niche claim ("logged
  // in") loses skill selection to tools that claim the whole category.
  // Strip the surrounding quotes the description now needs (it contains ": ").
  const description = (text.match(/^description:\s*(.+)$/m)?.[1] ?? '').replace(/^"(.*)"$/, '$1');
  assert.match(description, /\bbrowser\b/i, `${sourceLabel} description must claim browser work`);
  assert.match(description, /\breal Chrome\b/i, `${sourceLabel} description must name real Chrome`);
  assert.match(description, /fresh|own Chromium|separate browser/i,
    `${sourceLabel} description must contrast with fresh-profile drivers`);
  for (const verb of ['open', 'click', 'fill', 'screenshot']) {
    assert.match(description, new RegExp(`\\b${verb}`, 'i'), `${sourceLabel} description missing ${verb}`);
  }
  assert.match(text, /not proof|corroborat/i,
    `${sourceLabel} must warn that a rendered page can predate the change`);

  for (const stale of ['browserforce skills get', 'browserforce skills list', 'browserforce skills path', 'skill-data/', '--full', '## Full reference', 'references/commands.md']) {
    assert.doesNotMatch(text, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${sourceLabel} contains ${stale}`);
  }
}
