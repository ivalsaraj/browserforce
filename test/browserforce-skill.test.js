import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertBrowserforceCoreSkill } from './browserforce-skill-contract.js';

test('source BrowserForce skill is the complete core guide', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  assertBrowserforceCoreSkill(readFileSync(join(root, '..', 'skills/browserforce/SKILL.md'), 'utf8'), 'source skill');
});
