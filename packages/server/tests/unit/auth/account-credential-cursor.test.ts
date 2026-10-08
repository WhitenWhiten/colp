import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AccountCredentialCursorError,
  createAccountCredentialCursorCodec,
} from '../../../src/modules/auth/application/account-credentials/cursor.js';

const KEY = Buffer.alloc(32, 9).toString('base64url');
const NOW = new Date('2026-09-14T00:00:00.000Z');

function payload() {
  return {
    endpoint: 'listMyCredentials' as const,
    viewer: 'acct_viewer',
    kind: 'parent' as const,
    state: 'active' as const,
    afterCreatedAt: '2026-09-14T00:00:00.000Z',
    afterId: 'cred_1',
    issuedAt: '2026-09-14T00:00:00.000Z',
  };
}

test('credential cursors are HMAC v1 tokens bound to endpoint, viewer, and filters', () => {
  const codec = createAccountCredentialCursorCodec(KEY);
  const token = codec.sign(payload(), NOW);
  assert.match(token, /^[A-Za-z0-9_-]+$/u);
  assert.ok(token.length >= 1 && token.length <= 2048);
  const verified = codec.verify(token, NOW, {
    endpoint: 'listMyCredentials',
    viewer: 'acct_viewer',
    kind: 'parent',
    state: 'active',
  });
  assert.equal(verified.afterId, 'cred_1');
  assert.throws(() => codec.verify(token, NOW, {
    endpoint: 'listChildrenWithParentKey',
    viewer: 'acct_viewer',
    kind: 'parent',
    state: 'active',
  }), AccountCredentialCursorError);
  assert.throws(() => codec.verify(`${token}x`, NOW, {
    endpoint: 'listMyCredentials',
    viewer: 'acct_viewer',
    kind: 'parent',
    state: 'active',
  }), (error: unknown) => error instanceof AccountCredentialCursorError && error.code === 'invalid_cursor');
  codec.destroy();
});

test('expired credential cursors are snapshot_expired rather than silently restarted', () => {
  const codec = createAccountCredentialCursorCodec(KEY);
  const token = codec.sign(payload(), NOW);
  const later = new Date(NOW.getTime() + 901_000);
  assert.throws(() => codec.verify(token, later, {
    endpoint: 'listMyCredentials',
    viewer: 'acct_viewer',
    kind: 'parent',
    state: 'active',
  }), (error: unknown) => error instanceof AccountCredentialCursorError && error.code === 'snapshot_expired');
  codec.destroy();
});
