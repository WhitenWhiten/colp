import {
  assertVerifiedSyncSession, verifySyncSessionContext,
  type ActiveSyncSessionRecord, type VerifiedSyncSession,
} from '@know-n/colp/sync';
import { createInMemorySyncSessionStore } from '@know-n/colp/testing';

/** Exercise the public verification gate before minting a Session in host tests. */
export async function verifyFixtureSyncSessionRecord(
  record: ActiveSyncSessionRecord,
): Promise<VerifiedSyncSession> {
  const store = createInMemorySyncSessionStore();
  await store.create(record);
  const result = await verifySyncSessionContext(store, {
    sessionId: record.sessionId,
    binding: {
      principal: record.principal,
      credential: record.credential,
      oauthClientId: record.oauthClientId,
      origin: record.origin,
      sessionScope: record.sessionScope,
      protocolVersion: record.protocolVersion,
      collectionId: record.collectionId,
      purpose: record.purpose,
    },
    authorization: { credentialActive: true, authorizationScopes: record.authorizationScopes },
    terminatedAt: new Date().toISOString(),
  });
  return assertVerifiedSyncSession(result);
}
