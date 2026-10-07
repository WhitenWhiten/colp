/**
 * T-05 / F006: the recovery capability lifetime must be anchored on the instant
 * the capability is actually issued (server `now`), never on the Snapshot's
 * `generated_at`. A Snapshot materialised more than one TTL before its final page
 * is acked (slow, paged recovery of a large collection) must still mint a
 * capability that verifies immediately and that the recovery Ack accepts.
 *
 * The tests also pin the two guard rails the fix must keep:
 *  - re-issuing for the same (session, snapshot, generation) replays the exact
 *    persisted capability, because the capability row is immutable and the Ack
 *    looks the token up by digest (a discard-and-refetch rebuild must not dead-end);
 *  - once the persisted window has lapsed, re-issuance still fails closed instead
 *    of minting a token that no Ack could ever consume.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresSyncRecoveryApplication,
  createSyncRecoveryCapabilityKeyring,
  type PostgresSyncRecoveryOptions,
} from '../../../src/infrastructure/sync/index.js';
import { SyncAckError } from '../../../src/modules/sync/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

/** The fixture signs with the same key id/secret, so a rotated keyring still interops. */
const CAPABILITY_SECRET = Buffer.alloc(32, 92).toString('base64');

function recoveryOptions(ttlMs: number, leaseId: string): PostgresSyncRecoveryOptions {
  return {
    capabilityKeys: createSyncRecoveryCapabilityKeyring({
      active: { id: 'recovery-key-v1', secret: CAPABILITY_SECRET }, retained: [], ttlMs,
    }),
    leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600, leaseId: () => leaseId,
  };
}

/** `src1.<keyId>.<expiry base36 seconds>.<claimsDigest>.<mac>` */
function expiryOf(capability: string): number {
  const parts = capability.split('.');
  assert.equal(parts[0], 'src1', 'a recovery capability must carry the src1 prefix');
  assert.ok(parts[1] && parts[2] && parts[3] && parts[4], `malformed capability: ${capability}`);
  assert.equal(parts[5], undefined, `malformed capability: ${capability}`);
  const expiry = Number.parseInt(parts[2], 36) * 1_000;
  assert.ok(Number.isSafeInteger(expiry) && expiry > 0, `malformed capability expiry: ${capability}`);
  return expiry;
}

const sleep = (milliseconds: number) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

describeWithPostgres('T-05 F006 recovery capability issuance anchor', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t05_recovery_capability_anchor', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 20_000);
  afterAll(async () => isolated?.close());

  test('a Snapshot older than one TTL still mints a capability anchored at issuance', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'issuance-anchor');
    const ttlMs = 5_000;
    const application = createPostgresSyncRecoveryApplication(isolated.runtime.db,
      recoveryOptions(ttlMs, 'issuance-anchor-lease'));
    await application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const snapshot = await isolated.runtime.db.selectFrom('sync_bootstrap_snapshots')
      .select(['generated_at', 'expires_at']).where('snapshot_id', '=', fixture.snapshotId)
      .executeTakeFirstOrThrow();
    assert.ok(snapshot.expires_at.getTime() > Date.now(), 'the Snapshot row must still be loadable');
    // Slow paging: the final page is acked more than one full TTL after materialisation.
    const pagedUntil = snapshot.generated_at.getTime() + ttlMs + 500;
    if (Date.now() < pagedUntil) await sleep(pagedUntil - Date.now());

    const issuedAfter = Date.now();
    const capability = await application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    const expiry = expiryOf(capability);
    assert.ok(expiry > issuedAfter, `the capability must outlive its own issuance (${expiry} <= ${issuedAfter})`);
    const row = await isolated.runtime.db.selectFrom('sync_recovery_capabilities')
      .select(['issued_at', 'expires_at', 'key_version']).where('session_id', '=', fixture.sessionId)
      .where('snapshot_id', '=', fixture.snapshotId).executeTakeFirstOrThrow();
    assert.equal(row.expires_at.getTime(), expiry, 'the persisted expiry is the signed expiry');
    assert.ok(row.expires_at.getTime() >= row.issued_at.getTime() + ttlMs - 1_000,
      'expires_at must be the issuance instant plus the TTL');
    assert.ok(row.expires_at.getTime() > snapshot.generated_at.getTime() + ttlMs,
      'generated_at must no longer anchor the TTL');
    assert.equal(row.key_version, 'recovery-key-v1');

    // A capability that verifies at issuance must also be consumable by the Ack.
    const acked = await application.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: 'issuance-anchor-ack', sessionId: fixture.sessionId, capability,
      requestFingerprint: 'issuance-anchor-ack' });
    assert.equal(acked.ackedCursor, capability);
    assert.equal((await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow()).status, 'active');
  }, 30_000);

  test('re-issuing for one identity replays the identical capability across the second boundary', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'issuance-replay');
    const application = createPostgresSyncRecoveryApplication(isolated.runtime.db,
      recoveryOptions(300_000, 'issuance-replay-lease'));
    await application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const issue = () => application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    const first = await issue();
    // A discard-and-refetch rebuild asks again; land the retry in a later wall-clock
    // second so a fresh `now()` anchor would mint a different expiry (and therefore a
    // digest the immutable capability row can never store).
    const second0 = Math.floor(Date.now() / 1_000);
    while (Math.floor(Date.now() / 1_000) === second0) await sleep(25);
    const replay = await issue();
    assert.equal(replay, first, 'the persisted capability must be replayed byte for byte');
    assert.equal(expiryOf(replay), expiryOf(first));
    assert.equal(await isolated.runtime.db.selectFrom('sync_recovery_capabilities').select('snapshot_id')
      .where('session_id', '=', fixture.sessionId).execute().then((rows) => rows.length), 1);
  }, 30_000);

  test('a capability row minted under the pre-fix generated_at anchor still validates and acks', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'issuance-legacy');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const snapshot = await isolated.runtime.db.selectFrom('sync_bootstrap_snapshots')
      .select('generated_at').where('snapshot_id', '=', fixture.snapshotId).executeTakeFirstOrThrow();
    // HEAD (pre-fix) anchored `expires_at` on the Snapshot's `generated_at`; the token line
    // format, claims digest and MAC are untouched by the fix, so a row written by the old code
    // must keep validating and acking. The row is inserted exactly as the old application
    // would have left it (the table is append-only, so an upgrade cannot rewrite it).
    const legacyKeys = createSyncRecoveryCapabilityKeyring({ active: { id: 'recovery-key-v1',
      secret: CAPABILITY_SECRET }, retained: [], ttlMs: 300_000 });
    const claims = { purpose: 'sync-recovery-bootstrap-ack' as const, version: 1 as const,
      sessionId: fixture.sessionId, accountId: fixture.accountId, replicaId: fixture.replicaId,
      collectionId: fixture.collectionId, oldLeaseGeneration: fixture.oldGeneration,
      purgeBoundary: { commitOrdinal: '42', streamKind: 'conflict' as const, stableId: 'conflict-42' },
      snapshotId: fixture.snapshotId, snapshotRevision: 'content-r43', snapshotPageCount: 3,
      snapshotNodeCount: 401, snapshotCursor: fixture.snapshotCursor };
    const legacyToken = legacyKeys.sign(claims, snapshot.generated_at.getTime());
    const legacyVerified = legacyKeys.verify(legacyToken, claims);
    assert.equal(legacyVerified.valid, true);
    if (!legacyVerified.valid) throw new Error('legacy token must verify');
    await isolated.runtime.pool.query(`insert into sync_recovery_capabilities(capability_digest,session_id,
      account_id,replica_id,collection_id,old_lease_generation,purge_commit_ordinal,purge_stream_kind,
      purge_stable_id,snapshot_id,snapshot_revision,snapshot_page_count,snapshot_node_count,snapshot_cursor,
      purpose,version,key_version,expires_at) values ($1,$2,$3,$4,$5,$6,42,1,'conflict-42',$7,'content-r43',
      3,401,$8,'sync-recovery-bootstrap-ack',1,'recovery-key-v1',$9)`, [createHash('sha256')
      .update(legacyToken, 'utf8').digest('hex'), fixture.sessionId, fixture.accountId, fixture.replicaId,
      fixture.collectionId, BigInt(fixture.oldGeneration), fixture.snapshotId, fixture.snapshotCursor,
      new Date(legacyVerified.expiresAt)]);
    const acked = await fixture.application.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: 'issuance-legacy-ack', sessionId: fixture.sessionId, capability: legacyToken,
      requestFingerprint: 'issuance-legacy-ack' });
    assert.equal(acked.ackedCursor, legacyToken);
    assert.equal((await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow()).status, 'active');
  }, 30_000);

  test('re-issuing after the persisted window lapsed fails closed without a second row', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'issuance-lapsed');
    const application = createPostgresSyncRecoveryApplication(isolated.runtime.db,
      recoveryOptions(1_000, 'issuance-lapsed-lease'));
    await application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const issue = () => application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    const expiry = expiryOf(await issue());
    while (Date.now() <= expiry + 100) await sleep(50);
    await assert.rejects(issue(), (error: unknown) =>
      error instanceof SyncAckError && error.code === 'sync_cursor_expired');
    assert.equal(await isolated.runtime.db.selectFrom('sync_recovery_capabilities').select('snapshot_id')
      .where('session_id', '=', fixture.sessionId).execute().then((rows) => rows.length), 1);
  }, 30_000);
});
