import assert from 'node:assert/strict';
import { test } from 'vitest';

/**
 * R20 export-surface test for the Pull/Ack/recovery cluster move.
 *
 * R20 moves eight files into modules/sync/{application,domain} and
 * infrastructure/sync/postgres. This test pins the public surface in three
 * ways so a move or rename cannot silently change the API:
 *
 *  1. Binding identity: every moved export must still be re-exported from the
 *     SAME binding by its public barrel (module barrel for the pure module
 *     layer, infrastructure barrel for the Postgres adapters). `export *`
 *     forwards the same object, so identity asserts that a barrel is not
 *     shadowing the moved module with a copy.
 *  2. Value contracts: the moved pure constants and functions still behave as
 *     documented (frozen shapes, deterministic digests, metric names).
 *  3. Type identity: a value that satisfies a moved-path type must also satisfy
 *     the barrel re-export of that type, and vice versa. A missing or
 *     structurally-different re-export breaks compilation, so the typecheck
 *     (not the runtime assert) is the gate.
 */

import {
  createSyncPullCursorKeyring,
  INITIAL_SYNC_PULL_PURGE_BOUNDARY,
  SyncPullReadError,
  SYNC_PULL_STREAM_KIND_ORDER,
  syncPullStableIdHash,
} from '../../../src/modules/sync/application/sync-pull.js';
import {
  canonicalSyncAckDigest,
  SyncAckError,
  validateSyncAckInput,
  type SyncAckApplicationInput,
} from '../../../src/modules/sync/application/sync-ack.js';
import {
  createSyncRecoveryCapabilityKeyring,
  type SyncRecoveryBoundary,
} from '../../../src/modules/sync/domain/sync-recovery-capability.js';
import {
  applySyncEvidenceMaintenanceMetrics,
  SYNC_EVIDENCE_MAINTENANCE_METRICS,
  type SyncEvidenceMaintenanceMetricName,
} from '../../../src/modules/sync/application/sync-evidence-maintenance.js';

import {
  applySyncEvidenceMaintenanceMetrics as barrelApplyEvidenceMetrics,
  canonicalSyncAckDigest as barrelCanonicalSyncAckDigest,
  createSyncPullCursorKeyring as barrelCreateSyncPullCursorKeyring,
  createSyncRecoveryCapabilityKeyring as barrelCreateRecoveryCapabilityKeyring,
  SyncAckError as barrelSyncAckError,
  SyncPullReadError as barrelSyncPullReadError,
  validateSyncAckInput as barrelValidateSyncAckInput,
} from '../../../src/modules/sync/index.js';

import {
  byteAwareEventCount as movedByteAwareEventCount,
  createPostgresSyncPullReadPort as movedCreatePostgresSyncPullReadPort,
} from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import {
  createPostgresSyncAckApplication as movedCreatePostgresSyncAckApplication,
} from '../../../src/infrastructure/sync/postgres/sync-ack-postgres.js';
import {
  createPostgresSyncRecoveryApplication as movedCreatePostgresSyncRecoveryApplication,
} from '../../../src/infrastructure/sync/postgres/sync-recovery-postgres.js';
import {
  PostgresSyncEvidenceMaintenanceCoordinator as movedPostgresEvidenceCoordinator,
} from '../../../src/infrastructure/sync/postgres/sync-evidence-maintenance-postgres.js';

import {
  byteAwareEventCount as barrelByteAwareEventCount,
  createPostgresSyncAckApplication as barrelCreatePostgresSyncAckApplication,
  createPostgresSyncPullReadPort as barrelCreatePostgresSyncPullReadPort,
  createPostgresSyncRecoveryApplication as barrelCreatePostgresSyncRecoveryApplication,
  createSyncPullCursorKeyring as barrelInfraCreateSyncPullCursorKeyring,
  createSyncRecoveryCapabilityKeyring as barrelInfraCreateRecoveryCapabilityKeyring,
  PostgresSyncEvidenceMaintenanceCoordinator as barrelPostgresEvidenceCoordinator,
} from '../../../src/infrastructure/sync/index.js';

import type {
  SyncPullCursorAnchor as MovedSyncPullCursorAnchor,
  SyncPullReadPort as MovedSyncPullReadPort,
} from '../../../src/modules/sync/application/sync-pull.js';
import type {
  SyncPullCursorAnchor as BarrelSyncPullCursorAnchor,
  SyncPullReadPort as BarrelSyncPullReadPort,
} from '../../../src/modules/sync/index.js';
import type {
  SyncRecoveryBoundary as MovedRecoveryBoundary,
} from '../../../src/modules/sync/domain/sync-recovery-capability.js';
import type {
  SyncEvidenceMaintenanceMetricName as MovedEvidenceMetricName,
} from '../../../src/modules/sync/application/sync-evidence-maintenance.js';
import type {
  SyncPullAuthorityPhase as MovedPullAuthorityPhase,
} from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import type {
  SyncPullAuthorityPhase as BarrelPullAuthorityPhase,
} from '../../../src/infrastructure/sync/index.js';
import type {
  PostgresSyncAckOptions as MovedAckOptions,
} from '../../../src/infrastructure/sync/postgres/sync-ack-postgres.js';
import type {
  PostgresSyncAckOptions as BarrelAckOptions,
} from '../../../src/infrastructure/sync/index.js';
import type {
  SyncRecoveryFaultPhase as MovedRecoveryFaultPhase,
} from '../../../src/infrastructure/sync/postgres/sync-recovery-postgres.js';
import type {
  SyncRecoveryFaultPhase as BarrelRecoveryFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import type {
  SyncEvidenceMaintenanceJobOptions as MovedEvidenceJobOptions,
} from '../../../src/infrastructure/sync/postgres/sync-evidence-maintenance-postgres.js';
import type {
  SyncEvidenceMaintenanceJobOptions as BarrelEvidenceJobOptions,
} from '../../../src/infrastructure/sync/index.js';
import { createAttachmentExposurePolicyAdapter as barrelCreateAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import {
  createAttachmentExposurePolicyAdapter as movedCreateAttachmentExposurePolicyAdapter,
} from '../../../src/infrastructure/database/attachment-exposure-policy-adapter.js';
import type {
  AttachmentExposurePolicyPort as MovedAttachmentExposurePolicyPort,
} from '../../../src/modules/sync/sync-bootstrap-snapshot.js';
import type {
  AttachmentExposurePolicyPort as BarrelAttachmentExposurePolicyPort,
} from '../../../src/modules/sync/index.js';
import type {
  AttachmentExposurePolicyPort as InfraBarrelAttachmentExposurePolicyPort,
} from '../../../src/infrastructure/sync/index.js';

test('R20 module barrel re-exports the moved Pull/Ack/recovery/evidence bindings', () => {
  assert.equal(barrelCreateSyncPullCursorKeyring, createSyncPullCursorKeyring,
    'the module barrel must forward the moved sync-pull createSyncPullCursorKeyring binding');
  assert.equal(barrelCreateRecoveryCapabilityKeyring, createSyncRecoveryCapabilityKeyring,
    'the module barrel must forward the moved domain createSyncRecoveryCapabilityKeyring binding');
  assert.equal(barrelApplyEvidenceMetrics, applySyncEvidenceMaintenanceMetrics,
    'the module barrel must forward the moved applySyncEvidenceMaintenanceMetrics binding');
  assert.equal(barrelSyncAckError, SyncAckError,
    'the module barrel must forward the moved SyncAckError class');
  assert.equal(barrelSyncPullReadError, SyncPullReadError,
    'the module barrel must forward the moved SyncPullReadError class');
  assert.equal(barrelCanonicalSyncAckDigest, canonicalSyncAckDigest,
    'the module barrel must forward the moved canonicalSyncAckDigest binding');
  assert.equal(barrelValidateSyncAckInput, validateSyncAckInput,
    'the module barrel must forward the moved validateSyncAckInput binding');
});

test('R20 infrastructure barrel re-exports the moved Postgres adapter bindings', () => {
  assert.equal(barrelCreatePostgresSyncAckApplication, movedCreatePostgresSyncAckApplication,
    'the infrastructure barrel must forward the moved sync-ack-postgres factory');
  assert.equal(barrelCreatePostgresSyncRecoveryApplication, movedCreatePostgresSyncRecoveryApplication,
    'the infrastructure barrel must forward the moved sync-recovery-postgres factory');
  assert.equal(barrelCreatePostgresSyncPullReadPort, movedCreatePostgresSyncPullReadPort,
    'the infrastructure barrel must forward the moved sync-pull-postgres read port factory');
  assert.equal(barrelByteAwareEventCount, movedByteAwareEventCount,
    'the infrastructure barrel must forward the moved byteAwareEventCount binding');
  assert.equal(barrelPostgresEvidenceCoordinator, movedPostgresEvidenceCoordinator,
    'the infrastructure barrel must forward the moved evidence-maintenance coordinator class');
  assert.equal(barrelInfraCreateSyncPullCursorKeyring, createSyncPullCursorKeyring,
    'the infrastructure barrel must re-export the module barrel createSyncPullCursorKeyring binding');
  assert.equal(barrelInfraCreateRecoveryCapabilityKeyring, createSyncRecoveryCapabilityKeyring,
    'the infrastructure barrel must re-export the module barrel createSyncRecoveryCapabilityKeyring binding');
});

test('R20 moved cluster pure exports keep their documented contracts', () => {
  assert.ok(Object.isFrozen(INITIAL_SYNC_PULL_PURGE_BOUNDARY));
  assert.deepEqual(INITIAL_SYNC_PULL_PURGE_BOUNDARY, { commitOrdinal: '0', streamKind: 'operation', stableId: '' });
  assert.ok(Object.isFrozen(SYNC_PULL_STREAM_KIND_ORDER));
  assert.deepEqual(SYNC_PULL_STREAM_KIND_ORDER, { operation: 0, conflict: 1 });

  assert.ok(Object.isFrozen(SYNC_EVIDENCE_MAINTENANCE_METRICS));
  assert.deepEqual(SYNC_EVIDENCE_MAINTENANCE_METRICS, {
    runs: 'sync.evidence_maintenance.runs',
    attempted: 'sync.evidence_maintenance.attempted',
    deleted: 'sync.evidence_maintenance.deleted',
    redacted: 'sync.evidence_maintenance.redacted',
    skipped: 'sync.evidence_maintenance.skipped',
    errors: 'sync.evidence_maintenance.errors',
    oldestExpiredAge: 'sync.evidence_maintenance.oldest_expired_age',
  });

  const digest = syncPullStableIdHash('stable-1');
  assert.match(digest, /^[A-Za-z0-9_-]{43}$/u, 'syncPullStableIdHash must be a sha256 base64url digest');
  assert.equal(syncPullStableIdHash('stable-1'), digest, 'the stable-id hash must be deterministic');

  assert.equal(movedByteAwareEventCount([], 1_024), 0, 'an empty event page counts zero bytes');

  const recorded: string[] = [];
  const gauged: string[] = [];
  applySyncEvidenceMaintenanceMetrics(
    {
      increment(name, value) { recorded.push(value === undefined ? name : `${name}:${value}`); },
      gauge(name, value) { gauged.push(`${name}:${value}`); },
    },
    { attempted: 3, deleted: 1, redacted: 0, skipped: 0, errors: 0, oldestExpiredAgeMs: 42 },
  );
  assert.equal(recorded.length, 6, 'the metrics sink must receive every counter (runs + 5 named counters)');
  assert.equal(gauged.length, 1, 'the oldest-expired-age gauge must be recorded once');
  assert.ok(recorded.includes(SYNC_EVIDENCE_MAINTENANCE_METRICS.runs), 'a run counter must be recorded');
  assert.ok(recorded.includes(`${SYNC_EVIDENCE_MAINTENANCE_METRICS.attempted}:3`));
  assert.ok(recorded.includes(`${SYNC_EVIDENCE_MAINTENANCE_METRICS.deleted}:1`));
  assert.ok(recorded.includes(`${SYNC_EVIDENCE_MAINTENANCE_METRICS.redacted}:0`));
  assert.ok(recorded.includes(`${SYNC_EVIDENCE_MAINTENANCE_METRICS.skipped}:0`));
  assert.ok(recorded.includes(`${SYNC_EVIDENCE_MAINTENANCE_METRICS.errors}:0`));
  assert.ok(gauged.includes(`${SYNC_EVIDENCE_MAINTENANCE_METRICS.oldestExpiredAge}:42`));

  const first = canonicalSyncAckDigest({ request: { cursor: 'c1' }, origin: 'https://example.test', mediaType: 'application/json', endpointIdentity: 'sync' } as SyncAckApplicationInput);
  const second = canonicalSyncAckDigest({ request: { cursor: 'c1' }, origin: 'https://example.test', mediaType: 'application/json', endpointIdentity: 'sync' } as SyncAckApplicationInput);
  const other = canonicalSyncAckDigest({ request: { cursor: 'c2' }, origin: 'https://example.test', mediaType: 'application/json', endpointIdentity: 'sync' } as SyncAckApplicationInput);
  assert.equal(second, first, 'canonicalSyncAckDigest must be deterministic');
  assert.notEqual(other, first, 'canonicalSyncAckDigest must distinguish different requests');

  assert.throws(
    () => validateSyncAckInput({ request: { sessionId: '', cursor: '', warnings: [] }, origin: 'https://example.test', mediaType: 'application/json', endpointIdentity: 'sync', idempotencyKey: 'k' } as SyncAckApplicationInput),
    (error: unknown) => error instanceof SyncAckError && error.code === 'invalid_document',
  );

  const pullError = new SyncPullReadError('integrity_failure');
  assert.equal(pullError.name, 'SyncPullReadError');
  assert.equal(pullError.code, 'integrity_failure');
  const ackError = new SyncAckError('invalid_cursor_scope');
  assert.equal(ackError.name, 'SyncAckError');
  assert.equal(ackError.code, 'invalid_cursor_scope');
});

test('R20 moved exports survive the re-export chain type-for-type', () => {
  // A value typed against the moved path must also satisfy the barrel
  // re-export, and the barrel value must flow back. Missing or structurally
  // different barrel re-exports break compilation of these assignments.
  const anchor: MovedSyncPullCursorAnchor = { commitOrdinal: '1', streamKind: 'operation', stableIdHash: 'hash' };
  const barrelAnchor: BarrelSyncPullCursorAnchor = anchor;
  const movedAnchor: MovedSyncPullCursorAnchor = barrelAnchor;
  assert.equal(movedAnchor.stableIdHash, 'hash');

  const boundary: MovedRecoveryBoundary = { commitOrdinal: '2', streamKind: 'conflict', stableId: 'stable' };
  assert.equal(boundary.streamKind, 'conflict');

  const metricName: MovedEvidenceMetricName = SYNC_EVIDENCE_MAINTENANCE_METRICS.deleted;
  assert.equal(metricName, 'sync.evidence_maintenance.deleted');

  const readPort: MovedSyncPullReadPort = {
    read: async (input) => {
      assert.equal(typeof input.limit, 'number');
      return {
        events: [],
        nextCursor: 'cursor',
        nextTuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
        hasMore: false,
        collectionRevision: 'rev',
      };
    },
  };
  const barrelReadPort: BarrelSyncPullReadPort = readPort;
  assert.equal(typeof barrelReadPort.read, 'function');

  const phase: MovedPullAuthorityPhase = 'before_finalization';
  const barrelPhase: BarrelPullAuthorityPhase = phase;
  assert.equal(barrelPhase, 'before_finalization');

  const ackOptions: MovedAckOptions = { leaseExtensionSeconds: 300, maxLeaseLifetimeSeconds: 3_600 };
  const barrelAckOptions: BarrelAckOptions = ackOptions;
  assert.equal(barrelAckOptions.maxLeaseLifetimeSeconds, 3_600);

  const recoveryPhase: MovedRecoveryFaultPhase = 'generation';
  const barrelRecoveryPhase: BarrelRecoveryFaultPhase = recoveryPhase;
  assert.equal(barrelRecoveryPhase, 'generation');

  const jobOptions: MovedEvidenceJobOptions = { intervalMs: 60_000 };
  const barrelJobOptions: BarrelEvidenceJobOptions = jobOptions;
  assert.equal(barrelJobOptions.intervalMs, 60_000);
});

test('FIX-L-033 the minimal attachment-exposure policy port survives the sync barrels type-for-type', () => {
  // A value typed against the moved path must also satisfy the module barrel
  // and the infrastructure barrel re-exports, and vice versa. A missing or
  // structurally-different re-export breaks compilation of these assignments
  // (the typecheck, not the runtime assert, is the gate).
  const policy: MovedAttachmentExposurePolicyPort = {
    async assertAttachmentsDenied() { return undefined; },
  };
  const barrelPolicy: BarrelAttachmentExposurePolicyPort = policy;
  const infraBarrelPolicy: InfraBarrelAttachmentExposurePolicyPort = barrelPolicy;
  assert.equal(typeof infraBarrelPolicy.assertAttachmentsDenied, 'function');
  // The port is minimal: Sync understands ONLY the allow/deny projection
  // decision — no blob facts, keys or bodies surface on the port.
  assert.deepEqual(Object.keys(infraBarrelPolicy), ['assertAttachmentsDenied']);
});

test('FIX-L-033 the exposure-policy adapter delegates the gate through the database barrel', async () => {
  assert.equal(barrelCreateAttachmentExposurePolicyAdapter, movedCreateAttachmentExposurePolicyAdapter,
    'the database barrel must forward the moved exposure-policy adapter binding');
  const adapter = barrelCreateAttachmentExposurePolicyAdapter({
    async listBlobFacts(scope) {
      assert.equal(scope.collectionId, 'col_1');
      return Object.freeze([Object.freeze({ blobId: 'blob_1', logicalState: 'stored_private',
        currentGenerationState: 'active' })]);
    },
  });
  // Deny-by-default: a private logical blob is explicitly ineligible, so the
  // policy resolves — the gate verdict denies the projection (no logic is
  // copied into Sync).
  await adapter.assertAttachmentsDenied({ collectionId: 'col_1' });
  // Sync has no attachment output candidates. The adapter denies that empty
  // projection without scanning unrelated attachment history.
  let factsRead = false;
  await barrelCreateAttachmentExposurePolicyAdapter({
    async listBlobFacts() { factsRead = true; throw new Error('must not read'); },
  }).assertAttachmentsDenied({ collectionId: 'col_1' });
  assert.equal(factsRead, false);
});
