import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AccountCredentialInputError,
  parseAuthorizePlanBody,
  parseGrantInput,
  parseGrantListQuery,
  parseGrantRevokeBody,
} from '../../../src/modules/auth/application/account-credentials/index.js';

const FUTURE = '2026-09-15T00:00:00.000Z';
const DIGEST = 'sha-256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('grant input is closed, kind-matched, and rejects extra/null/missing fields', () => {
  const ok = parseGrantInput({
    credentialId: 'cred_1',
    resource: { kind: 'collection', id: 'col_1' },
    actions: ['collection.content.write'],
    expiresAt: FUTURE,
  });
  assert.equal(ok.resource.kind, 'collection');
  assert.throws(() => parseGrantInput({
    credentialId: 'cred_1',
    resource: { kind: 'collection', id: 'col_1' },
    actions: ['collection.content.write'],
    expiresAt: FUTURE,
    extra: true,
  }), AccountCredentialInputError);
  assert.throws(() => parseGrantInput({
    credentialId: null,
    resource: { kind: 'collection', id: 'col_1' },
    actions: ['collection.content.write'],
    expiresAt: FUTURE,
  }), AccountCredentialInputError);
  assert.throws(() => parseGrantInput({
    credentialId: 'cred_1',
    resource: { kind: 'collection', id: 'col_1' },
    actions: ['report.issue.write'],
    expiresAt: FUTURE,
  }), AccountCredentialInputError);
  assert.throws(() => parseGrantInput({
    credentialId: 'cred_1',
    resource: { kind: 'report', id: 'rep_1' },
    actions: ['collection.publish'],
    expiresAt: FUTURE,
  }), AccountCredentialInputError);
  const report = parseGrantInput({
    credentialId: 'cred_1',
    resource: { kind: 'report', id: 'rep_1' },
    actions: ['report.issue.publish', 'report.metadata.write'],
    expiresAt: FUTURE,
  });
  assert.equal(report.resource.kind, 'report');
});

test('grant list query rejects unknown keys and illegal bounds', () => {
  assert.deepEqual(parseGrantListQuery({}), { limit: 20 });
  assert.equal(parseGrantListQuery({ credentialId: 'cred_1', limit: '2' }).limit, 2);
  assert.throws(() => parseGrantListQuery({ extra: '1' }), AccountCredentialInputError);
  assert.throws(() => parseGrantListQuery({ limit: '0' }), AccountCredentialInputError);
  assert.throws(() => parseGrantListQuery({ limit: '101' }), AccountCredentialInputError);
  assert.throws(() => parseGrantListQuery({ cursor: '' }), AccountCredentialInputError);
});

test('authorize-plan and revoke bodies are closed objects', () => {
  assert.deepEqual(parseAuthorizePlanBody({
    planKind: 'collection', planId: 'plan_1', planDigest: DIGEST,
  }), { planKind: 'collection', planId: 'plan_1', planDigest: DIGEST });
  assert.throws(() => parseAuthorizePlanBody({
    planKind: 'collection', planId: 'plan_1', planDigest: DIGEST, extra: 1,
  }), AccountCredentialInputError);
  assert.throws(() => parseAuthorizePlanBody({
    planKind: 'other', planId: 'plan_1', planDigest: DIGEST,
  }), AccountCredentialInputError);
  assert.throws(() => parseAuthorizePlanBody({
    planKind: 'collection', planId: 'plan_1', planDigest: 'sha-256:short',
  }), AccountCredentialInputError);
  assert.equal(parseGrantRevokeBody({ reason: '  leaked  ' }).reason, 'leaked');
  assert.throws(() => parseGrantRevokeBody({}), AccountCredentialInputError);
});
