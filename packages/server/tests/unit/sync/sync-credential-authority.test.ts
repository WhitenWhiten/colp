import assert from 'node:assert/strict';
import { test } from 'vitest';
import { syncCredentialIsAuthorized } from '../../../src/infrastructure/sync/sync-credential-authority.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

test('fresh request evidence preserves durable credential identity, scope, expiry and revocation gates', async () => {
  const credential = await mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example',
    audience: 'known-api', clientId: 'known-extension', subject: 'subject', credentialId: 'credential' });
  const account = { id: 'account', security_epoch: 0n };
  const stored = { issuer: credential.issuer, credential_id: credential.credentialId,
    credential_digest: credential.credentialDigest, subject: credential.subject, account_id: account.id,
    client_id: credential.clientId, audience: 'known-api', scopes_json: ['known.sync'],
    credential_expires_at: credential.credentialExpiresAt, revoked_at: null, security_epoch: 0n,
    evidence_expires_at: new Date(0) };
  const now = new Date();
  assert.equal(syncCredentialIsAuthorized(stored, credential, account, now), true);
  for (const change of [{ revoked_at: now }, { scopes_json: [] }, { security_epoch: 1n },
    { issuer: 'https://other.example' }, { account_id: 'other-account' },
    { credential_digest: 'other-digest' }, { client_id: 'other-client' },
    { audience: 'other-audience' }, { credential_expires_at: new Date(0) }]) {
    assert.equal(syncCredentialIsAuthorized({ ...stored, ...change }, credential, account, now), false);
  }
});

test('an expired request verification is still rejected even when its token is valid', async () => {
  const credential = await mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example',
    audience: 'known-api', clientId: 'known-extension', subject: 'subject', credentialId: 'old-evidence',
    now: new Date(Date.now() - 70_000), evidenceTtlSeconds: 30 });
  const account = { id: 'account', security_epoch: 0n };
  const stored = { issuer: credential.issuer, credential_id: credential.credentialId,
    credential_digest: credential.credentialDigest, subject: credential.subject, account_id: account.id,
    client_id: credential.clientId, audience: 'known-api', scopes_json: ['known.sync'],
    credential_expires_at: credential.credentialExpiresAt, revoked_at: null, security_epoch: 0n };
  assert.ok(credential.credentialExpiresAt > new Date());
  assert.equal(syncCredentialIsAuthorized(stored, credential, account, new Date()), false);
});
