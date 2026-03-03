import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBearer, isAllowedOrigin } from '../../agent/src/auth.js';

test('rejects missing bearer token', () => {
  assert.equal(verifyBearer({ headers: {} }, 'secret'), false);
});

test('rejects wrong bearer token', () => {
  assert.equal(verifyBearer({ headers: { authorization: 'Bearer wrong' } }, 'secret'), false);
});

test('accepts valid bearer token', () => {
  assert.equal(verifyBearer({ headers: { authorization: 'Bearer secret' } }, 'secret'), true);
});

test('allows chrome-extension origin', () => {
  assert.equal(isAllowedOrigin('chrome-extension://abc123'), true);
});

test('allows requests with no origin (CLI)', () => {
  assert.equal(isAllowedOrigin(undefined), true);
});

test('allows localhost origins', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
});

test('rejects external origins', () => {
  assert.equal(isAllowedOrigin('https://evil.com'), false);
});

test('rejects deceptive localhost-like origins', () => {
  assert.equal(isAllowedOrigin('http://localhost.evil.com:3000'), false);
  assert.equal(isAllowedOrigin('https://127.0.0.1.attacker.tld'), false);
});
