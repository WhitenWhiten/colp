import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import type { StoredSession } from '../src/types.js';

test('report possession proof survives access-token refresh, Session clearing and replica rotation, with owner and epoch fences', async () => {
  const f = await setup();
  try {
    const session: StoredSession = { sessionId: 'session-device-secret', credentialAuthorityDigest: 'digest',
      expiresAt: '2000-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      collection: { collectionId: f.scope.collectionId, serverCursor: 'c', serverRevision: 'r' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2000-01-01T00:00:00Z' } };
    await f.credentials.saveSession(session);
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), session.sessionId);
    const credential = (await f.credentials.loadCredential())!;
    await f.credentials.saveCredential({ ...credential, accessToken: 'refreshed-access-token' });
    await f.credentials.clearSession();
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), session.sessionId);
    assert.equal(await f.credentials.loadReplicaReportProof({ ...f.scope, accountId: 'other' }), undefined);
    assert.equal(await f.credentials.loadReplicaReportProof({ ...f.scope, serverOrigin: 'https://other.example' }), undefined);
    await f.rebuilder.handle(f.request);
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), session.sessionId, 'old final delivery keeps its own proof');
    const next = await f.deps.currentScope();
    assert.equal(await f.credentials.loadReplicaReportProof(next), undefined);
    await f.credentials.saveSession({ ...session, sessionId: 'new-installation-session' });
    assert.equal(await f.credentials.loadReplicaReportProof(next), 'new-installation-session');
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), session.sessionId);
    await f.credentials.revokeAuthority();
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), undefined);
  } finally { f.store.close(); }
});

test('account switching preserves final-delivery proof but requires fresh matching account authority to read it', async () => {
  const f = await setup();
  try {
    const credential = (await f.credentials.loadCredential())!;
    const session: StoredSession = { sessionId: 'old-replica-report-proof', credentialAuthorityDigest: 'digest',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      collection: { collectionId: f.scope.collectionId, serverCursor: 'c', serverRevision: 'r' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } };
    await f.credentials.saveSession(session);
    await f.credentials.revokeAuthority(); await f.credentials.clearAuthority();
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), undefined);
    const authority = await f.credentials.activateAuthority();
    await f.credentials.saveCredential({ ...credential, subject: 'another-account' }, authority.generation);
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), undefined);
    await f.credentials.saveCredential({ ...credential, accessToken: 'new-matching-account-token' }, authority.generation);
    assert.equal(await f.credentials.loadReplicaReportProof(f.scope), session.sessionId);
  } finally { f.store.close(); }
});
