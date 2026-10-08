import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { appendAuditEvent, createUnitOfWork, DatabaseOperationError, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  claimSyncResolutionLaneSlot,
  createPostgresReplicaStore,
  createPostgresSyncSequencePort,
  createPostgresSyncSessionIssuer,
  SyncSequencePersistenceError,
  type PostgresSyncSequenceTransaction,
} from '../../../src/infrastructure/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../src/modules/identity/index.js';
import {
  canonicalSyncSequenceDigest,
  canonicalSyncSequenceResultDigest,
  type SyncSequenceAdmissionInput,
} from '../../../src/modules/sync/index.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  productionMigrationNamesFromInclusive,
  productionMigrationNamesNewestFirstUntil,
} from '../../../scripts/lexical-migration-head.mjs';
import {
  appliedSequenceResult,
  deferredSequenceResult,
  syncSequenceAdmission,
} from '../../fixtures/phase3/sync-sequence.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const COLLECTION = 'sequence-collection';
const ACCOUNT = 'sequence-account';
const SUBJECT = 'sequence-subject';
const execFileAsync = promisify(execFile);
type FixtureSequenceResult = ReturnType<typeof appliedSequenceResult>
  | ReturnType<typeof deferredSequenceResult>;

describeWithPostgres('P3-10 durable PostgreSQL Sequence lanes and immutable receipts', () => {
  let isolated: IsolatedPostgresRuntime;
  let credential: VerifiedExtensionCredential;
  let minted: Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>;
  let identity = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_sequence', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query(
        'insert into account_identities(id,account_id,issuer,subject) values ($1,$2,$3,$4)',
        ['sequence-identity', ACCOUNT, ISSUER, 'sequence-oidc'],
      );
      await client.query("insert into profile_handles(handle,account_id) values ('sync_sequence',$1)", [ACCOUNT]);
      await client.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [COLLECTION, 'sequence-root'],
      );
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'Sequence','bookmarks',$3,'collection-r1','content-r1','policy-r1')`,
      [COLLECTION, SUBJECT, 'sequence-root']);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ($1,$2,'folder',true,'Root','root-r1','children-r1')`, ['sequence-root', COLLECTION]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'sequence-oidc', credentialId: 'sequence-credential',
      evidenceTtlSeconds: 3_600,
    });
    credential = minted.credential;
  }, 20_000);

  afterAll(async () => isolated?.close());

  async function context() {
    const suffix = `${++identity}-${randomUUID()}`;
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `sequence-device-${suffix}`,
      replicaId: () => `sequence-replica-${suffix}`,
      leaseId: () => `sequence-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Sequence device',
      replicaName: 'Sequence replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `sequence-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `sequence-installation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 31), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    }).issue({
      credential, idempotencyKey: `sequence-session-${suffix}`,
      requestFingerprint: `sequence-fingerprint-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push'],
      origin: ORIGIN,
    });
    return {
      replica,
      session: issued.session,
      request: syncSequenceAdmission(issued.session, replica.replicaId, {
        transactionalAuthority: { credential, origin: ORIGIN },
      }),
    };
  }

  const execute = async (
    request: SyncSequenceAdmissionInput,
    result: FixtureSequenceResult = appliedSequenceResult(request.operationId, request.sequence),
  ) => createPostgresSyncSequencePort(isolated.runtime.db).coordinate(request, async () => ({
    status: result.status,
    result,
  }));

  test('migrates empty/upgrade schemas, rolls down explicitly, and latest is idempotent', async () => {
    const tables = await isolated.runtime.pool.query<{ table_name: string }>(`
      select table_name from information_schema.tables where table_schema=current_schema()
      and table_name like 'sync_sequence_%' order by table_name`);
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'sync_sequence_lanes', 'sync_sequence_operation_claims', 'sync_sequence_receipts',
    ]);
    const constraints = await isolated.runtime.pool.query<{ conname: string }>(`
      select conname from pg_constraint where connamespace=current_schema()::regnamespace
      and conname=any($1::text[]) order by conname`, [[
      'sync_sequence_claim_lane_unique', 'sync_sequence_receipt_lane_unique',
    ]]);
    assert.deepEqual(constraints.rows.map((row) => row.conname), [
      'sync_sequence_claim_lane_unique', 'sync_sequence_receipt_lane_unique',
    ]);

    const upgrade = await createIsolatedPostgresRuntime('p3_sequence_upgrade');
    try {
      let latest = '';
      while (latest !== '202607251500_sync_bootstrap_snapshots') {
        const step = await runMigrations(upgrade.runtime.db, 'up');
        latest = step.results[0]?.migrationName ?? '';
        assert.notEqual(latest, '');
      }
      assert.equal((await upgrade.runtime.pool.query(
        "select to_regclass('sync_sequence_lanes')::text name",
      )).rows[0]?.name, null);
      const up = await runMigrations(upgrade.runtime.db, 'up');
      assert.deepEqual(up.results.map((item) => item.migrationName), ['202607251600_sync_sequence_lanes']);
      const historical = createHistoricalMigrator(upgrade, '202609070100_publication_insights');
      const bounded = await historical.migrateToLatest();
      if (bounded.error) throw bounded.error;
      assert.deepEqual(bounded.results?.map((item) => item.migrationName),
        productionMigrationNamesFromInclusive('202607251700_sync_node_create')
          .filter(name => name <= '202609070100_publication_insights'));
      for (const name of ['202609070100_publication_insights']) {
        assert.deepEqual((await runMigrations(upgrade.runtime.db, 'down')).results.map(
          (item) => item.migrationName), [name]);
      }
      const identityProfileAboutDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(identityProfileAboutDown.results.map((item) => item.migrationName), [
        '202609060100_identity_profile_about',
      ]);
      const betterAuthMfaSchemaDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(betterAuthMfaSchemaDown.results.map((item) => item.migrationName), [
        '202609051000_better_auth_mfa_schema',
      ]);
      const legacyOidcIdentityArchiveDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(legacyOidcIdentityArchiveDown.results.map((item) => item.migrationName), [
        '202609050930_legacy_oidc_identity_archive',
      ]);
      const knownAuthSessionMetadataDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(knownAuthSessionMetadataDown.results.map((item) => item.migrationName), [
        '202609050920_known_auth_session_metadata',
      ]);
      const betterAuthAccountMappingDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(betterAuthAccountMappingDown.results.map((item) => item.migrationName), [
        '202609050910_better_auth_account_mapping',
      ]);
      const betterAuthSchemaDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(betterAuthSchemaDown.results.map((item) => item.migrationName), [
        '202609050900_better_auth_schema',
      ]);
      const seedVersionsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(seedVersionsDown.results.map((item) => item.migrationName), [
        '202609040100_seed_versions',
      ]);
      const tombstoneRetentionContractDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(tombstoneRetentionContractDown.results.map((item) => item.migrationName), [
        '202609030100_sync_tombstone_retention_contract',
      ]);
      const syncPullCursorLineageDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(syncPullCursorLineageDown.results.map((item) => item.migrationName), [
        '202609020100_sync_pull_cursor_lineage',
      ]);
      const mcpOauthRevocationStoreDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(mcpOauthRevocationStoreDown.results.map((item) => item.migrationName), [
        '202609010100_mcp_oauth_revocation_store',
      ]);
      const newestMigrationDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(newestMigrationDown.results.map((item) => item.migrationName), [
        '202608220100_delivery_callback_retryable_delivered',
      ]);
      const deliveryCallbackRetryableDeliveredDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(deliveryCallbackRetryableDeliveredDown.results.map((item) => item.migrationName), [
        '202608200100_social_feed_rebuild_continuation',
      ]);
      const socialFeedRebuildContinuationDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(socialFeedRebuildContinuationDown.results.map((item) => item.migrationName), [
        '202608151000_social_feed_follow_activity',
      ]);
      const socialFeedFollowActivityDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(socialFeedFollowActivityDown.results.map((item) => item.migrationName), [
        '202608150200_mcp_low_risk_ready_claim',
      ]);
      const mcpLowRiskReadyClaimDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(mcpLowRiskReadyClaimDown.results.map((item) => item.migrationName), [
        '202608150100_sync_conflict_delete_update_dismiss',
      ]);
      const syncConflictDeleteUpdateDismissDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(syncConflictDeleteUpdateDismissDown.results.map((item) => item.migrationName), [
        '202608100100_sync_bootstrap_snapshot_nodes',
      ]);
      const syncConflictKeyringReencryptDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(syncConflictKeyringReencryptDown.results.map((item) => item.migrationName), [
        '202608090300_sync_conflict_keyring_reencrypt',
      ]);
      const identityAvatarUrlBackfillDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(identityAvatarUrlBackfillDown.results.map((item) => item.migrationName), [
        '202608090200_identity_avatar_url_backfill',
      ]);
      const notificationRetentionStateContractDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(notificationRetentionStateContractDown.results.map((item) => item.migrationName), [
        '202608090100_notification_retention_state_contract',
      ]);
      const phase4aP02Down = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(phase4aP02Down.results.map((item) => item.migrationName), [
        '202608080500_phase4a_p02_attachment_metadata',
      ]);
      const phase4aI15OperationsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(phase4aI15OperationsDown.results.map((item) => item.migrationName), [
        '202608080400_phase4a_i15_operations',
      ]);
      const phase4aI14CleanupRetentionDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(phase4aI14CleanupRetentionDown.results.map((item) => item.migrationName), [
        '202608080300_phase4a_i14_cleanup_retention',
      ]);
      const phase4aI13FinalizeBindingDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(phase4aI13FinalizeBindingDown.results.map((item) => item.migrationName), [
        '202608080200_phase4a_i13_finalize_binding',
      ]);
      const phase4aI09VerificationDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(phase4aI09VerificationDown.results.map((item) => item.migrationName), [
        '202608080100_phase4a_i09_verification',
      ]);
      const phase4aAttachmentsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(phase4aAttachmentsDown.results.map((item) => item.migrationName), [
        '202608080000_phase4a_attachments',
      ]);
      const recursiveSessionGuardDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(recursiveSessionGuardDown.results.map((item) => item.migrationName), [
        '202608061000_mcp_recursive_session_guard',
      ]);
      const writeChangePlansDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(writeChangePlansDown.results.map((item) => item.migrationName), [
        '202608051000_mcp_write_change_plans',
      ]);
      const emailSuppressionsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(emailSuppressionsDown.results.map((item) => item.migrationName), [
        '202608020800_notification_email_suppressions',
      ]);
      const evidenceMaintenanceDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(evidenceMaintenanceDown.results.map((item) => item.migrationName), [
        '202608020100_sync_evidence_maintenance',
      ]);
      const searchRecallDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(searchRecallDown.results.map((item) => item.migrationName), [
        '202608011200_search_member_recall_indexes',
      ]);
      const directoryFilterDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(directoryFilterDown.results.map((item) => item.migrationName), [
        '202608011100_collections_directory_filter_indexes',
      ]);
      const siblingIndexDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(siblingIndexDown.results.map((item) => item.migrationName), [
        '202608011000_nodes_live_sibling_position_c_idx',
      ]);
      const fanoutContinuationDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(fanoutContinuationDown.results.map((item) => item.migrationName), [
        '202607311000_social_feed_fanout_continuation',
      ]);
      const retentionDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(retentionDown.results.map((item) => item.migrationName), [
        '202607310100_sync_tombstone_retention_config',
      ]);
      const recoveryProofDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(recoveryProofDown.results.map((item) => item.migrationName), [
        '202607300100_sync_pull_recovery_proofs',
      ]);
      const notificationOperationsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(notificationOperationsDown.results.map((item) => item.migrationName), [
        '202607291500_notification_operations',
      ]);
      const notificationAuthorityDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(notificationAuthorityDown.results.map((item) => item.migrationName), [
        '202607290200_notification_authority',
      ]);
      const socialFeedDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(socialFeedDown.results.map((item) => item.migrationName), [
        '202607290100_social_feed_projections',
      ]);
      const followsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(followsDown.results.map((item) => item.migrationName), [
        '202607280200_follows',
      ]);
      const productSyncCenterDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(productSyncCenterDown.results.map((item) => item.migrationName), [
        '202607280100_product_sync_center_reads',
      ]);
      const identityInvariantDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(identityInvariantDown.results.map((item) => item.migrationName), [
        '202607270100_oidc_profile_handle_invariant',
      ]);
      const ownedCollectionsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(ownedCollectionsDown.results.map((item) => item.migrationName), [
        '202607260100_owned_collections_keyset',
      ]);
      const effectsDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(effectsDown.results.map((item) => item.migrationName), [
        '202607252700_sync_operation_effects',
      ]);
      const retirementDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(retirementDown.results.map((item) => item.migrationName), [
        '202607252600_sync_replica_retirement',
      ]);
      const recoveryDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(recoveryDown.results.map((item) => item.migrationName), [
        '202607252500_sync_snapshot_recovery',
      ]);
      const purgeDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(purgeDown.results.map((item) => item.migrationName), [
        '202607252400_sync_tombstone_purge',
      ]);
      const ackDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(ackDown.results.map((item) => item.migrationName), [
        '202607252300_sync_acknowledgements',
      ]);
      const pullDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(pullDown.results.map((item) => item.migrationName), [
        '202607252200_sync_pull_stream',
      ]);
      const resolutionDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(resolutionDown.results.map((item) => item.migrationName), [
        '202607252100_sync_conflict_resolution',
      ]);
      const conflictDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(conflictDown.results.map((item) => item.migrationName), [
        '202607252000_sync_conflicts',
      ]);
      const tombstoneDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(tombstoneDown.results.map((item) => item.migrationName), [
        '202607251900_sync_node_tombstones',
      ]);
      const historyDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(historyDown.results.map((item) => item.migrationName), [
        '202607251800_sync_node_revision_history',
      ]);
      const createDown = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(createDown.results.map((item) => item.migrationName), ['202607251700_sync_node_create']);
      const down = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(down.results.map((item) => item.migrationName), ['202607251600_sync_sequence_lanes']);
      assert.equal((await upgrade.runtime.pool.query(
        "select to_regclass('sync_sequence_lanes')::text name",
      )).rows[0]?.name, null);
      const restored = await runMigrations(upgrade.runtime.db, 'latest');
      assert.deepEqual(restored.results.map((item) => item.migrationName), productionMigrationNamesFromInclusive('202607251600_sync_sequence_lanes'));
    } finally { await upgrade.close(); }
  }, 180_000);

  test('starts each Replica Collection lane at one and isolates its durable scope', async () => {
    const left = await context();
    const right = await context();
    await execute(left.request);
    await execute(right.request);
    const lanes = await isolated.runtime.pool.query(
      `select replica_id,sequence_scope,next_sequence::text,retention_policy,retained_through_retirement
       from sync_sequence_lanes where replica_id=any($1::text[]) order by replica_id`,
      [[left.replica.replicaId, right.replica.replicaId]],
    );
    assert.equal(lanes.rowCount, 2);
    assert.deepEqual(lanes.rows.map((row) => ({ ...row, replica_id: '<isolated>' })), [
      { replica_id: '<isolated>', sequence_scope: `collection:${COLLECTION}`, next_sequence: '2',
        retention_policy: 'replica_lifetime', retained_through_retirement: true },
      { replica_id: '<isolated>', sequence_scope: `collection:${COLLECTION}`, next_sequence: '2',
        retention_policy: 'replica_lifetime', retained_through_retirement: true },
    ]);
  });

  test('persists deferred unchanged, conditionally finalizes it, and exact-replays the full stable result', async () => {
    const value = await context();
    const deferred = deferredSequenceResult(value.request.operationId);
    const first = await execute(value.request, deferred);
    assert.equal(first.result.kind, 'executed');
    const replay = await execute(value.request, appliedSequenceResult(value.request.operationId));
    assert.equal(replay.result.kind, 'replayed');
    assert.deepEqual(replay.result.receipt, first.result.receipt);
    const reuse = await createPostgresSyncSequencePort(isolated.runtime.db).coordinate({
      ...value.request, payload: { changed: 'cannot replace deferred binding' },
    }, async () => assert.fail('different deferred digest reached evaluator'));
    assert.equal(reuse.result.kind, 'sequence_reuse');
    const terminal = appliedSequenceResult(value.request.operationId);
    const finalized = await createPostgresSyncSequencePort(isolated.runtime.db).coordinate(
      { ...value.request, reevaluateDeferred: true },
      async ({ previousDeferredReceipt }) => {
        assert.deepEqual({ ...previousDeferredReceipt?.result }, deferred);
        return { status: 'applied', result: terminal };
      },
    );
    assert.equal(finalized.result.kind, 'executed');
    const childPath = fileURLToPath(new URL('../../fixtures/phase3/sync-sequence-replay-child.ts', import.meta.url));
    const child = await execFileAsync(process.execPath, ['--import', 'tsx', childPath], {
      env: {
        ...process.env,
        DATABASE_URL: isolated.databaseUrl,
        KNOWN_TEST_DATABASE_URL: isolated.databaseUrl,
        KNOWN_SEQUENCE_SESSION_ID: value.session.sessionId,
        KNOWN_SEQUENCE_REPLICA_ID: value.replica.replicaId,
        KNOWN_SEQUENCE_AUTHORITY: JSON.stringify({
          authorization: minted.authorization,
          jwk: minted.jwk,
          issuer: ISSUER,
          audience: 'known-api',
          clientId: 'known-extension',
        }),
        NODE_ENV: 'test',
      },
      timeout: 15_000,
      windowsHide: true,
    });
    const exact = JSON.parse(child.stdout) as {
      readonly kind: string;
      readonly result: { readonly kind: string; readonly receipt?: { readonly result?: unknown } };
    };
    assert.equal(exact.kind, 'replayed');
    assert.equal(exact.result.kind, 'replayed');
    assert.deepEqual(exact.result.receipt?.result, terminal);
    const row = await isolated.runtime.pool.query(
      `select status,result_json,result_digest,canonical_digest,session_id,lease_generation::text,
        server_batch_id,media_type,endpoint_identity,finalized_at is not null terminal
       from sync_sequence_receipts where replica_id=$1 and sequence_scope=$2 and sequence_number=1`,
      [value.replica.replicaId, value.request.sequenceScope],
    );
    assert.deepEqual(row.rows[0], {
      status: 'applied', result_json: terminal,
      result_digest: canonicalSyncSequenceResultDigest(terminal),
      canonical_digest: canonicalSyncSequenceDigest(value.request),
      session_id: value.session.sessionId, lease_generation: '1',
      server_batch_id: value.request.serverBatchId, media_type: value.request.mediaType,
      endpoint_identity: value.request.endpointIdentity, terminal: true,
    });
  });

  test('serializes two real connections: same digest evaluates once and different digest is stable reuse', async () => {
    const value = await context();
    const leftRuntime = createPostgresSyncSequencePort(isolated.runtime.db);
    const secondRuntime = await import('../../../src/infrastructure/database/index.js').then(({ createDatabaseRuntime }) =>
      createDatabaseRuntime(isolated.databaseUrl, { maxConnections: 1, applicationName: 'p3-sequence-racer' }));
    let evaluations = 0;
    try {
      const rightRuntime = createPostgresSyncSequencePort(secondRuntime.db);
      let releaseEvaluation!: () => void;
      const evaluationGate = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
      const evaluate = async () => {
        evaluations += 1;
        await evaluationGate;
        const result = appliedSequenceResult(value.request.operationId);
        return { status: 'applied' as const, result };
      };
      const leftPromise = leftRuntime.coordinate(value.request, evaluate);
      const rightPromise = rightRuntime.coordinate(value.request, evaluate);
      try {
        await waitForCondition(async () => {
          const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
            select exists(select 1 from pg_stat_activity
              where application_name in ('known-test-p3_sync_sequence','p3-sequence-racer')
                and cardinality(pg_blocking_pids(pid)) > 0) waiting
          `);
          return blocked.rows[0]?.waiting === true;
        }, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
          description: 'the duplicate sequence coordinator to wait on the winning transaction',
        });
      } finally {
        releaseEvaluation();
      }
      const [left, right] = await Promise.all([leftPromise, rightPromise]);
      assert.deepEqual(new Set([left.result.kind, right.result.kind]), new Set(['executed', 'replayed']));
      assert.equal(evaluations, 1);
      const different = await rightRuntime.coordinate({
        ...value.request, payload: { changed: 'different digest' },
      }, async () => assert.fail('reuse reached evaluator'));
      assert.equal(different.result.kind, 'sequence_reuse');
      assert.equal((await isolated.runtime.pool.query(
        'select count(*)::int count from sync_sequence_receipts where replica_id=$1',
        [value.replica.replicaId],
      )).rows[0]?.count, 1);

      const differentValue = await context();
      let competingEvaluations = 0;
      let releaseDifferentEvaluation!: () => void;
      const differentEvaluationGate = new Promise<void>((resolve) => { releaseDifferentEvaluation = resolve; });
      const evaluateDifferent = async () => {
        competingEvaluations += 1;
        await differentEvaluationGate;
        const result = appliedSequenceResult(differentValue.request.operationId);
        return { status: 'applied' as const, result };
      };
      const competingLeft = leftRuntime.coordinate(differentValue.request, evaluateDifferent);
      const competingRight = rightRuntime.coordinate({
          ...differentValue.request, payload: { changed: 'concurrent different digest' },
        }, evaluateDifferent);
      try {
        await waitForCondition(async () => {
          const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
            select exists(select 1 from pg_stat_activity
              where application_name in ('known-test-p3_sync_sequence','p3-sequence-racer')
                and cardinality(pg_blocking_pids(pid)) > 0) waiting
          `);
          return blocked.rows[0]?.waiting === true;
        }, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
          description: 'the conflicting sequence coordinator to wait on the winning transaction',
        });
      } finally {
        releaseDifferentEvaluation();
      }
      const competing = await Promise.all([competingLeft, competingRight]);
      assert.deepEqual(new Set(competing.map((item) => item.result.kind)),
        new Set(['executed', 'sequence_reuse']));
      assert.equal(competingEvaluations, 1);
    } finally { await secondRuntime.close(); }
  });

  test('persists distinct gap and blocked lane states without claiming or advancing', async () => {
    const gapValue = await context();
    const gap = await createPostgresSyncSequencePort(isolated.runtime.db).coordinate({
      ...gapValue.request, sequence: 2, operationId: `${gapValue.replica.replicaId}.operation.2`,
      payload: { sequence: 2 },
    }, async () => assert.fail('gap reached evaluator'));
    assert.deepEqual(gap.result, { kind: 'sequence_gap', expectedSequence: 1 });
    const gapRows = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [gapValue.replica.replicaId]);
    assert.deepEqual(gapRows.rows[0], { next_sequence: '1', claims: 0, receipts: 0 });

    const blockedValue = await context();
    await execute(blockedValue.request, deferredSequenceResult(blockedValue.request.operationId));
    const restartedRuntime = await import('../../../src/infrastructure/database/index.js').then(({ createDatabaseRuntime }) =>
      createDatabaseRuntime(isolated.databaseUrl, { maxConnections: 1, applicationName: 'p3-sequence-blocked-restart' }));
    try {
      const blocked = await createPostgresSyncSequencePort(restartedRuntime.db).coordinate({
        ...blockedValue.request, sequence: 2,
        operationId: `${blockedValue.replica.replicaId}.operation.2`, payload: { sequence: 2 },
      }, async () => assert.fail('blocked Sequence reached evaluator'));
      assert.deepEqual(blocked.result, { kind: 'sequence_blocked', expectedSequence: 1 });
    } finally { await restartedRuntime.close(); }
    const blockedRows = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [blockedValue.replica.replicaId]);
    assert.deepEqual(blockedRows.rows[0], { next_sequence: '1', claims: 1, receipts: 1 });
  });

  test('enforces lifecycle opId uniqueness and preserves exact state across rollback and unknown commit', async () => {
    const first = await context();
    const second = await context();
    await execute(first.request);
    const reused = await createPostgresSyncSequencePort(isolated.runtime.db).coordinate({
      ...second.request,
      operationId: first.request.operationId,
      payload: { ...second.request.payload, operationId: first.request.operationId },
    }, async () => assert.fail('opId reuse reached evaluator'));
    assert.equal(reused.result.kind, 'op_id_reused');

    const rollback = await context();
    const failing = createPostgresSyncSequencePort(isolated.runtime.db, {
      faultInjector: { afterPhase(phase) { if (phase === 'before_commit') throw new Error('sequence-rollback'); } },
    });
    await assert.rejects(failing.coordinate(rollback.request, async (_context, transaction: PostgresSyncSequenceTransaction<ReturnType<typeof appliedSequenceResult>>) => {
      await appendAuditEvent(transaction.databaseTransaction, {
        operationId: null, collectionId: null, principalId: ACCOUNT,
        eventType: 'sync.sequence.rollback-marker', details: {},
      });
      const result = appliedSequenceResult(rollback.request.operationId);
      return { status: 'applied', result };
    }), /sequence-rollback/);
    const absent = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts,
      (select count(*)::int from audit_events where event_type='sync.sequence.rollback-marker') markers`,
    [rollback.replica.replicaId]);
    assert.deepEqual(absent.rows[0], { lanes: 0, claims: 0, receipts: 0, markers: 0 });

    const unknown = await context();
    const lostAcknowledgement = createPostgresSyncSequencePort(isolated.runtime.db, {
      faultInjector: {
        afterPhase(phase) {
          if (phase === 'after_commit') throw new Error('sequence-lost-commit-acknowledgement');
        },
      },
    });
    await assert.rejects(lostAcknowledgement.coordinate(unknown.request, async () => {
      const result = appliedSequenceResult(unknown.request.operationId);
      return { status: 'applied', result };
    }), (error: unknown) => error instanceof DatabaseOperationError
      && error.kind === 'commit_outcome_unknown');
    const recovered = await createPostgresSyncSequencePort(isolated.runtime.db).coordinate(
      unknown.request,
      async () => assert.fail('unknown commit exact retry reached evaluator'),
    );
    assert.equal(recovered.result.kind, 'replayed');
    const committed = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [unknown.replica.replicaId]);
    assert.deepEqual(committed.rows[0], { next_sequence: '2', claims: 1, receipts: 1 });
  });

  test('database rejects terminal/claim/lane mutation and deferred binding substitution through direct SQL', async () => {
    const terminal = await context();
    await assert.rejects(isolated.runtime.pool.query(
      `insert into sync_sequence_lanes(replica_id,collection_id,sequence_scope,next_sequence)
       values ($1,$2,$3,2)`,
      [terminal.replica.replicaId, COLLECTION, terminal.request.sequenceScope],
    ), (error: unknown) => (error as { code?: string }).code === '23514');
    await execute(terminal.request);
    for (const [statement, parameters] of [
      ["update sync_sequence_receipts set result_json='{}'::jsonb where replica_id=$1", [terminal.replica.replicaId]],
      ['delete from sync_sequence_receipts where replica_id=$1', [terminal.replica.replicaId]],
      ['update sync_sequence_operation_claims set canonical_digest=$2 where replica_id=$1', [terminal.replica.replicaId, '0'.repeat(64)]],
      ['delete from sync_sequence_operation_claims where replica_id=$1', [terminal.replica.replicaId]],
      ['update sync_sequence_lanes set next_sequence=4 where replica_id=$1', [terminal.replica.replicaId]],
      ['delete from sync_sequence_lanes where replica_id=$1', [terminal.replica.replicaId]],
    ] as const) await assert.rejects(isolated.runtime.pool.query(statement, parameters),
      (error: unknown) => (error as { code?: string }).code === '23514');

    const deferred = await context();
    await execute(deferred.request, deferredSequenceResult(deferred.request.operationId));
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_sequence_receipts set server_batch_id='other-session.other-batch' where replica_id=$1",
      [deferred.replica.replicaId],
    ), (error: unknown) => (error as { code?: string }).code === '23514');
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_sequence_receipts where replica_id=$1',
      [deferred.replica.replicaId],
    ), (error: unknown) => (error as { code?: string }).code === '23514');
  });

  test('retirement cannot delete or reuse the durable lane, claim, or receipt identity', async () => {
    const value = await context();
    await execute(value.request);
    await isolated.runtime.pool.query(`update sync_replicas set status='retired',retired_at=current_timestamp,
      wire_json=jsonb_set(wire_json,'{status}','\"retired\"') where replica_id=$1`,
    [value.replica.replicaId]);
    await assert.rejects(execute(value.request),
      (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'replica_retired');
    await assert.rejects(createPostgresSyncSequencePort(isolated.runtime.db).coordinate({
      ...value.request, sequence: 2,
      operationId: `${value.replica.replicaId}.operation.after-retirement`,
      payload: { sequence: 2, forbidden: 'retired identity reuse' },
    }, async () => assert.fail('retired Replica reached evaluator')),
    (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'replica_retired');
    const retained = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [value.replica.replicaId]);
    assert.deepEqual(retained.rows[0], { lanes: 1, claims: 1, receipts: 1 });
  });

  test('omitting transactionalAuthority on coordinate fail-closes the write', async () => {
    const value = await context();
    const { transactionalAuthority, ...withoutAuthority } = value.request;
    void transactionalAuthority;
    await assert.rejects(
      createPostgresSyncSequencePort(isolated.runtime.db).coordinate(
        withoutAuthority,
        async () => assert.fail('missing authority reached the evaluator'),
      ),
      (error: unknown) => error instanceof SyncSequencePersistenceError
        && error.code === 'authorization_denied',
    );
    const residue = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [value.replica.replicaId]);
    assert.deepEqual(residue.rows[0], { lanes: 0, claims: 0, receipts: 0 });
  });

  test('FIX-L-032 classifies a superseded lease generation from locked rows instead of concealing not_found', async () => {
    // A concurrent resume advanced the Replica to generation 2 and the Session
    // was minted against it, while the admission input still claims the
    // superseded generation 1 — the exact state a pre-read creates when the
    // resume lands between the read and the Sequence transaction. Both
    // admission paths must report the stable stale_replica classification,
    // never a concealment not_found, and must leave zero Sequence residue.
    const suffix = `${++identity}-${randomUUID()}`;
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `sequence-device-${suffix}`,
      replicaId: () => `sequence-replica-${suffix}`,
      leaseId: () => `sequence-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Sequence device',
      replicaName: 'Sequence replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `sequence-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `sequence-installation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    // FIX-L-032 resume simulation: advance the generation ledger (new lease ID)
    // and the Replica row together so the FK and wire facts stay consistent —
    // exactly what a real resume commits before the client's next Push.
    await isolated.runtime.pool.query(`with advanced as (
        insert into sync_replica_generations (replica_id, lease_generation, lease_id)
        values ($1, 2, $2)
        returning replica_id, lease_generation, lease_id
      )
      update sync_replicas replica set
        lease_generation = advanced.lease_generation,
        lease_id = advanced.lease_id,
        wire_json = jsonb_set(
          jsonb_set(replica.wire_json, '{leaseGeneration}', to_jsonb(advanced.lease_generation::text)),
          '{leaseId}', to_jsonb(advanced.lease_id)
        )
      from advanced
      where replica.replica_id = $1`,
    [replica.replicaId, `sequence-resumed-lease-${suffix}`]);
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 31), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    }).issue({
      credential, idempotencyKey: `sequence-resumed-session-${suffix}`,
      requestFingerprint: `sequence-resumed-fingerprint-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: '2',
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push'],
      origin: ORIGIN,
    });
    const port = createPostgresSyncSequencePort(isolated.runtime.db);
    const stale = syncSequenceAdmission(issued.session, replica.replicaId, {
      leaseGeneration: '1',
      transactionalAuthority: { credential, origin: ORIGIN },
    });
    await assert.rejects(port.coordinate(stale,
      async () => assert.fail('superseded generation reached the evaluator')),
    (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'stale_replica');
    await assert.rejects(port.coordinateAuthorized({
      ...stale, transactionalAuthority: { credential, origin: stale.session.origin },
    }, async () => assert.fail('superseded generation reached the evaluator')),
    (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'stale_replica');
    const residue = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [replica.replicaId]);
    assert.deepEqual(residue.rows[0], { lanes: 0, claims: 0, receipts: 0 });

    // The same Session admitted with its actual generation still succeeds: the
    // classification is precise and never over-blocks current evidence.
    const current = syncSequenceAdmission(issued.session, replica.replicaId, {
      leaseGeneration: '2',
      transactionalAuthority: { credential, origin: ORIGIN },
    });
    const executed = await port.coordinate(current,
      async () => ({ status: 'applied' as const, result: appliedSequenceResult(current.operationId) }));
    assert.equal(executed.result.kind, 'executed');

    // A Replica that advanced past an already-issued Session (resume completed
    // after the Session was minted) is stale even when the claimed generation
    // still matches the Session row: the Replica is the current authority.
    const superseded = await context();
    await isolated.runtime.pool.query(`with advanced as (
        insert into sync_replica_generations (replica_id, lease_generation, lease_id)
        values ($1, 2, $2)
        returning replica_id, lease_generation, lease_id
      )
      update sync_replicas replica set
        lease_generation = advanced.lease_generation,
        lease_id = advanced.lease_id,
        wire_json = jsonb_set(
          jsonb_set(replica.wire_json, '{leaseGeneration}', to_jsonb(advanced.lease_generation::text)),
          '{leaseId}', to_jsonb(advanced.lease_id)
        )
      from advanced
      where replica.replica_id = $1`,
    [superseded.replica.replicaId, `sequence-superseded-lease-${randomUUID()}`]);
    await assert.rejects(port.coordinate(superseded.request,
      async () => assert.fail('resumed Replica reached the evaluator')),
    (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'stale_replica');
  });
});
