import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

describeWithPostgres('recovery request evidence lifetime', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('recovery_evidence_lifetime');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 30_000);
  afterAll(async () => isolated?.close());

  // Reproduces production: downloading and projecting a Snapshot outlives the
  // evidence cached at Session creation, but this request is freshly verified.
  test('accepts a fresh 0.2 recovery Ack after cached evidence expires', async () => {
    const f = await seedRecoveryFixture(isolated, 'expired-cache', undefined, true, undefined, '0.2');
    await f.application.requireRecoveryForStaleCursor({ credential: f.credential,
      sessionId: f.sessionId, cursor: f.cursorBeforeBoundary });
    await f.recordAllPages();
    const capability = await f.application.issueCapability({ credential: f.credential,
      sessionId: f.sessionId, snapshotId: f.snapshotId });
    await isolated.runtime.db.updateTable('sync_extension_credentials').set({
      last_verified_at: sql`current_timestamp - interval '31 seconds'`,
      evidence_expires_at: sql`current_timestamp - interval '1 second'`,
    }).where('credential_id', '=', f.credential.credentialId).execute();
    assert.ok(f.credential.evidenceExpiresAt.getTime() > Date.now());
    const result = await f.application.bootstrapAcknowledge({ credential: f.credential,
      sessionId: f.sessionId, capability, explicitCapability: true,
      idempotencyKey: 'fresh-request', requestFingerprint: 'fresh-request' });
    assert.equal(result.ackedCursor, capability);
  });

  test.each(['revoked', 'account_disabled', 'epoch_changed'])('still denies %s credentials', async reason => {
    const f = await seedRecoveryFixture(isolated, reason, undefined, true, undefined, '0.2');
    await f.application.requireRecoveryForStaleCursor({ credential: f.credential,
      sessionId: f.sessionId, cursor: f.cursorBeforeBoundary });
    await f.recordAllPages();
    const capability = await f.application.issueCapability({ credential: f.credential,
      sessionId: f.sessionId, snapshotId: f.snapshotId });
    if (reason === 'revoked') {
      await isolated.runtime.db.updateTable('sync_extension_credentials').set({ revoked_at: new Date() })
        .where('credential_id', '=', f.credential.credentialId).execute();
    } else {
      await isolated.runtime.db.updateTable('accounts').set(reason === 'account_disabled'
        ? { status: 'disabled' } : { security_epoch: 1n }).where('id', '=', f.accountId).execute();
    }
    await assert.rejects(f.application.bootstrapAcknowledge({ credential: f.credential,
      sessionId: f.sessionId, capability, explicitCapability: true,
      idempotencyKey: reason, requestFingerprint: reason }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'resource_not_found');
  });
});
