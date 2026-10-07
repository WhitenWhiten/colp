import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  PHASE3_SYNC_CONFORMANCE_PLAN,
  PHASE3_SYNC_CONFORMANCE_SCOPE,
  PHASE3_SYNC_ENDPOINTS,
  PHASE3_SYNC_PORTS,
  PHASE3_SYNC_TASK_GATES,
  assertPhase3SyncProfileClaimController,
  createPhase3SyncProfileClaimController,
  verifyPhase3SyncPrerequisites,
} from '../../../src/modules/sync/index.js';

describe('P3-39 Sync Profile claim gate', () => {
  test('derives the exact official scope and deployment probes', () => {
    assert.deepEqual(PHASE3_SYNC_CONFORMANCE_SCOPE, { profiles: ['core', 'sync'], capabilities: [] });
    assert.deepEqual(PHASE3_SYNC_CONFORMANCE_PLAN.capabilities, [
      'core-authoritative-writes', 'managed-bookmark-writes', 'sync-extension-storage',
    ]);
    assert.deepEqual(PHASE3_SYNC_CONFORMANCE_PLAN.probeIds, [
      'core.id-ledger-persistence',
      'core.sync-extension-persistence',
      'core.pre-write-validation',
      'core.parent-cycle-transaction',
      'core.node-subtree-transaction',
      'core.managed-bookmarks-transaction',
      'sync.transaction-contracts',
    ]);
    assert.deepEqual(PHASE3_SYNC_ENDPOINTS, [
      'syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict',
    ]);
    assert.deepEqual(PHASE3_SYNC_PORTS, ['schema', 'semantic', 'sync', 'transactions', 'outbox']);
    assert.equal(PHASE3_SYNC_TASK_GATES.length, 19);
  });

  test('rejects forged controllers and every deployment binding fault before evidence can claim', () => {
    assert.doesNotThrow(() => assertPhase3SyncProfileClaimController(createPhase3SyncProfileClaimController()));
    assert.throws(() => assertPhase3SyncProfileClaimController({ current: () => undefined,
      activate: () => undefined }), /issued/iu);
    const base = binding();
    for (const [label, mutate] of [
      ['endpoint', (value: ReturnType<typeof binding>) => { value.endpoints = value.endpoints.slice(1); }],
      ['port', (value: ReturnType<typeof binding>) => { value.ports = value.ports.slice(1); }],
      ['credential', (value: ReturnType<typeof binding>) => { value.credentialVerifier = 'decode-only'; }],
      ['batch', (value: ReturnType<typeof binding>) => { value.maxBatchOperations = 2; }],
      ['protocol', (value: ReturnType<typeof binding>) => { value.protocolVersions = ['0.2']; }],
      ['artifact', (value: ReturnType<typeof binding>) => { value.extensionArtifactDigest = 'bad'; }],
    ] as const) {
      const candidate = structuredClone(base); mutate(candidate);
      assert.throws(() => verifyPhase3SyncPrerequisites({ binding: candidate as never,
        serverSync: {} as never, authoritativePull: {} as never, multiDevice: {} as never,
        taskGates: [] }), undefined, label);
    }
  });

  test('keeps the final runner fail closed and requires real Manifest activation', () => {
    const source = readFileSync(resolve('scripts/check-phase3-release.mjs'), 'utf8');
    for (const marker of [
      'runDeploymentConformanceProbes', 'claimPhase3SyncProfiles', 'assertManifestProfile',
      'endpoint:', 'port:', 'credential:verifier', 'migration:digest', 'extension:artifact',
      'task-gate:P3-38', 'telemetry:redaction', 'FAIL-CLOSED',
    ]) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(source, /\bskip(?:ped)?\b|mock/iu);
  });
});

function binding() {
  return {
    sourceRevision: 'a'.repeat(40), sourceDigest: 'b'.repeat(64),
    configDigest: 'c'.repeat(64), migrationDigest: 'd'.repeat(64),
    extensionConfigDigest: 'e'.repeat(64), extensionMigrationDigest: 'f'.repeat(64),
    colpVersion: '0.2' as const, colpDigest: '1'.repeat(64),
    backendArtifactDigest: '2'.repeat(64), extensionArtifactDigest: '3'.repeat(64),
    browserVersion: '149.0.7827.55', protocolVersions: ['0.1', '0.2'] as string[],
    maxBatchOperations: 1, credentialVerifier: 'extension-oauth-jwks',
    endpoints: [...PHASE3_SYNC_ENDPOINTS] as string[], ports: [...PHASE3_SYNC_PORTS] as string[],
  };
}
