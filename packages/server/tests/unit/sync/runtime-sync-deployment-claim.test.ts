import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VerifiedDeploymentConformanceEvidence } from '@know-n/colp/conformance';

import { listRegisteredMigrationNames } from '../../../src/infrastructure/database/migrations.js';
import {
  PHASE3_SYNC_ENDPOINTS,
  PHASE3_SYNC_PORTS,
  claimRuntimeSyncProfiles,
  digestMigrationChain,
  verifyPhase3SyncPrerequisites,
  verifyRuntimeSyncDeploymentEvidence,
  type Phase3SyncDeploymentBinding,
  type RuntimeSyncDeploymentEvidence,
} from '../../../src/modules/sync/sync-profile-claim-gate.js';
import {
  createPublicationManifestCandidate,
  type PublicationManifestConfig,
} from '../../../src/modules/publication/index.js';

const digest = 'a'.repeat(64);

function historicalBinding(maxBatchOperations: 1 | 50): Phase3SyncDeploymentBinding {
  return {
    sourceRevision: 'b'.repeat(40),
    sourceDigest: digest,
    configDigest: digest,
    migrationDigest: digest,
    extensionConfigDigest: digest,
    extensionMigrationDigest: digest,
    colpVersion: '0.2',
    colpDigest: digest,
    backendArtifactDigest: digest,
    extensionArtifactDigest: digest,
    browserVersion: 'test-browser',
    protocolVersions: ['0.1', '0.2'],
    maxBatchOperations,
    credentialVerifier: 'extension-oauth-jwks',
    endpoints: [...PHASE3_SYNC_ENDPOINTS],
    ports: [...PHASE3_SYNC_PORTS],
  } as Phase3SyncDeploymentBinding;
}

function runtimeEvidence(names: readonly string[], maxBatchOperations: number): RuntimeSyncDeploymentEvidence {
  return {
    format: 'known.runtime.sync-deployment.v1',
    maxBatchOperations,
    configDigest: digest,
    buildDigest: 'c'.repeat(64),
    migrationDigest: digestMigrationChain(names),
  };
}

test('historical Phase 3 evidence still requires maxBatchOperations 1', () => {
  assert.throws(() => verifyPhase3SyncPrerequisites({
    binding: historicalBinding(50),
    serverSync: {} as never,
    authoritativePull: {} as never,
    multiDevice: {} as never,
    taskGates: [],
  }), /maxBatchOperations must remain 1/u);
});

test('current runtime evidence must match the configured batch limit and registered migrations', async () => {
  const registered = await listRegisteredMigrationNames();
  assert.ok(registered.length > 0);
  assert.deepEqual([...registered].sort((left, right) => left.localeCompare(right, 'en-US')), [...registered]);

  assert.throws(() => verifyRuntimeSyncDeploymentEvidence({
    evidence: runtimeEvidence(registered, 1),
    runtimeMaxBatchOperations: 50,
    runtimeConfigDigest: digest,
    runtimeBuildDigest: 'c'.repeat(64),
    registeredMigrationNames: registered,
  }), /maxBatchOperations does not match/u);

  assert.doesNotThrow(() => verifyRuntimeSyncDeploymentEvidence({
    evidence: runtimeEvidence(registered, 50),
    runtimeMaxBatchOperations: 50,
    runtimeConfigDigest: digest,
    runtimeBuildDigest: 'c'.repeat(64),
    registeredMigrationNames: registered,
  }));

  assert.throws(() => verifyRuntimeSyncDeploymentEvidence({
    evidence: runtimeEvidence(registered, 50),
    runtimeMaxBatchOperations: 50,
    runtimeConfigDigest: digest,
    runtimeBuildDigest: 'c'.repeat(64),
    registeredMigrationNames: [...registered, '99999999999999_new_migration'],
  }), /migrationDigest does not match/u);

  assert.throws(() => claimRuntimeSyncProfiles({
    evidence: runtimeEvidence(registered, 50),
    runtimeMaxBatchOperations: 50,
    runtimeConfigDigest: digest,
    runtimeBuildDigest: 'c'.repeat(64),
    registeredMigrationNames: registered,
    deploymentEvidence: {
      profiles: [],
      capabilities: [],
      passedProbeIds: [],
    } as unknown as VerifiedDeploymentConformanceEvidence,
  }), /conformance evidence is incomplete/u);
});

test('a default publication manifest does not declare the sync profile', () => {
  const config: PublicationManifestConfig = {
    origin: 'https://collections.example.test',
    mountPath: '/colp/v0.1/',
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    title: 'Known Collections',
    maxPageSize: 200,
    maxSnapshotNodes: 100_000,
    endpoints: {
      directory: 'https://collections.example.test/colp/v0.1/directory',
      collection: 'https://collections.example.test/colp/v0.1/collections/{collectionId}',
      snapshot: 'https://collections.example.test/colp/v0.1/collections/{collectionId}/snapshot',
      syncPush: 'https://collections.example.test/colp/v0.1/sync/push',
    },
    sync: {
      multiCollectionSessions: false,
      maxBatchOperations: 50,
      cursorRetentionSeconds: 2_592_000,
    },
  };
  const candidate = createPublicationManifestCandidate(config, ['syncPush']);
  assert.deepEqual(candidate.manifest.mounts[0]?.profiles, ['core']);
  assert.equal(candidate.manifest.mounts[0]?.features.sync, undefined);
  assert.equal(candidate.manifest.mounts[0]?.limits.maxSyncBatchOperations, 50);
});
