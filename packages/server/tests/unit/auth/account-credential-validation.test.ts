import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AccountCredentialInputError,
  parseCreateChildBody,
  parseCredentialListQuery,
  parseRevokeBody,
  parseRotateBody,
} from '../../../src/modules/auth/application/account-credentials/validation.js';

const FUTURE = '2026-09-15T00:00:00.000Z';

test('create child rejects extra fields, nulls, missing keys, and non-canonical timestamps', () => {
  const parse = (body: Record<string, unknown>) => parseCreateChildBody({ ...body, account: { mode: 'new' } });
  const ok = parse({ label: '  Café  ', expiresAt: FUTURE });
  assert.equal(ok.label, 'Café');
  assert.equal(ok.expiresAt, FUTURE);
  assert.throws(() => parse({ label: 'x', expiresAt: FUTURE, extra: true }), AccountCredentialInputError);
  assert.throws(() => parse({ label: null, expiresAt: FUTURE }), AccountCredentialInputError);
  assert.throws(() => parse({ expiresAt: FUTURE }), AccountCredentialInputError);
  assert.throws(() => parse({ label: '', expiresAt: FUTURE }), AccountCredentialInputError);
  assert.throws(() => parse({ label: 'x', expiresAt: '2026-09-15T00:00:00Z' }), AccountCredentialInputError);
  assert.throws(() => parse({ label: 'x'.repeat(81), expiresAt: FUTURE }), AccountCredentialInputError);
});

test('create child account object is closed and mode-specific', () => {
  const created = parseCreateChildBody({
    label: 'bot',
    expiresAt: FUTURE,
    account: { mode: 'new', displayName: '  Amber  ' },
  });
  assert.deepEqual(created.account, { mode: 'new', displayName: 'Amber' });
  const existing = parseCreateChildBody({
    label: 'bot',
    expiresAt: FUTURE,
    account: { mode: 'existing', accountId: 'acct_1' },
  });
  assert.equal(existing.account.mode, 'existing');
  assert.throws(() => parseCreateChildBody({
    label: 'bot', expiresAt: FUTURE, account: { mode: 'new', accountId: 'acct_1' },
  }), AccountCredentialInputError);
  assert.throws(() => parseCreateChildBody({
    label: 'bot', expiresAt: FUTURE, account: { mode: 'existing' },
  }), AccountCredentialInputError);
  assert.throws(() => parseCreateChildBody({
    label: 'bot', expiresAt: FUTURE, account: { mode: 'other' },
  }), AccountCredentialInputError);
});

test('list query rejects unknown keys, illegal enums, and non-canonical limits', () => {
  assert.deepEqual(parseCredentialListQuery({}), { limit: 20 });
  assert.deepEqual(parseCredentialListQuery({ kind: 'parent', state: 'active', limit: '1' }), {
    kind: 'parent', state: 'active', limit: 1,
  });
  assert.throws(() => parseCredentialListQuery({ kind: 'grandparent' }), AccountCredentialInputError);
  assert.throws(() => parseCredentialListQuery({ limit: '0' }), AccountCredentialInputError);
  assert.throws(() => parseCredentialListQuery({ limit: '01' }), AccountCredentialInputError);
  assert.throws(() => parseCredentialListQuery({ limit: '101' }), AccountCredentialInputError);
  assert.throws(() => parseCredentialListQuery({ extra: '1' }), AccountCredentialInputError);
  assert.throws(() => parseCredentialListQuery({ cursor: '' }), AccountCredentialInputError);
});

test('rotate and revoke bodies are closed objects', () => {
  assert.deepEqual(parseRotateBody({ expiresAt: FUTURE }), { expiresAt: FUTURE });
  assert.equal(parseRevokeBody({ reason: '  leaked  ' }).reason, 'leaked');
  assert.throws(() => parseRotateBody({}), AccountCredentialInputError);
  assert.throws(() => parseRotateBody({ expiresAt: FUTURE, extra: 1 }), AccountCredentialInputError);
  assert.throws(() => parseRevokeBody({ reason: null }), AccountCredentialInputError);
  assert.throws(() => parseRevokeBody({}), AccountCredentialInputError);
});
