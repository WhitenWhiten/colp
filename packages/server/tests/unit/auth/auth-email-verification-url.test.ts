import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { rewriteAuthEmailVerificationUrl } from '../../../src/infrastructure/auth/better-auth-runtime.js';

const ORIGIN = 'https://app.example.test';

describe('rewriteAuthEmailVerificationUrl', () => {
  test('moves the BA API verification URL onto the product /verify-email page', () => {
    const ba = `${ORIGIN}/api/v1/auth/verify-email?token=tok.en.jwt&callbackURL=${encodeURIComponent('/library')}`;
    const rewritten = rewriteAuthEmailVerificationUrl(ba, ORIGIN);
    const url = new URL(rewritten);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, '/verify-email');
    assert.equal(url.searchParams.get('token'), 'tok.en.jwt');
    assert.equal(url.searchParams.get('returnTo'), '/library');
  });

  test('lifts a nested returnTo off a /verify-email callbackURL', () => {
    const callback = `/verify-email?verified=1&returnTo=${encodeURIComponent('/settings')}`;
    const ba = `${ORIGIN}/api/v1/auth/verify-email?token=abc&callbackURL=${encodeURIComponent(callback)}`;
    const url = new URL(rewriteAuthEmailVerificationUrl(ba, ORIGIN));
    assert.equal(url.searchParams.get('returnTo'), '/settings');
  });

  test('drops a foreign-origin callbackURL', () => {
    const ba = `${ORIGIN}/api/v1/auth/verify-email?token=abc&callbackURL=${encodeURIComponent('https://evil.example/phish')}`;
    const url = new URL(rewriteAuthEmailVerificationUrl(ba, ORIGIN));
    assert.equal(url.searchParams.get('token'), 'abc');
    assert.equal(url.searchParams.get('returnTo'), null);
  });

  test('drops a same-origin callbackURL whose path is `//host` (R15-20)', () => {
    const ba = `${ORIGIN}/api/v1/auth/verify-email?token=abc&callbackURL=${encodeURIComponent(`${ORIGIN}//evil.example`)}`;
    const url = new URL(rewriteAuthEmailVerificationUrl(ba, ORIGIN));
    assert.equal(url.searchParams.get('returnTo'), null);
  });

  test('drops a relative callbackURL that canonicalizes to a // path', () => {
    const ba = `${ORIGIN}/api/v1/auth/verify-email?token=abc&callbackURL=${encodeURIComponent('/.//evil.example')}`;
    const url = new URL(rewriteAuthEmailVerificationUrl(ba, ORIGIN));
    assert.equal(url.searchParams.get('returnTo'), null);
    assert.equal(url.search.includes('evil.example'), false);
  });

  test('leaves a token-less URL unchanged', () => {
    const raw = `${ORIGIN}/api/v1/auth/verify-email`;
    assert.equal(rewriteAuthEmailVerificationUrl(raw, ORIGIN), raw);
  });
});
