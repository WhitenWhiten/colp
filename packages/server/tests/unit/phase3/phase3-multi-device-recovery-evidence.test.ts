import { describe, expect, test } from 'vitest';
import {
  PHASE3_MULTI_DEVICE_PREFLIGHTS,
  PHASE3_MULTI_DEVICE_SCENARIOS,
  digestPhase3MultiDeviceEvidence,
  parsePhase3DirtyStatus,
  validatePhase3MultiDeviceEvidence,
} from '../../../scripts/phase3-multi-device-recovery-evidence.mjs';

const digest = 'a'.repeat(64);
const repository = { commit: 'b'.repeat(40), tree: 'c'.repeat(40), dirty: false };
const gate = (name: string) => ({ name, outcome: 'passed' as const, observationDigest: digest });
const boundaries = ['queue-persisted', 'push-commit-response-loss', 'receipt-before-persist', 'receipt-after-persist',
  'pull-intent-persisted', 'chrome-mutation-before', 'chrome-mutation-after', 'cursor-before-persist',
  'cursor-after-persist', 'ack-before', 'ack-after'];

function validEvidence() {
  const value = {
    format: 'known.phase3.multi-device-recovery.v1', schemaVersion: 1, accepted: true,
    mode: 'acceptance', stage: 'full', recoveryWaitMs: 601_000,
    profileClaimed: false, deploymentProven: false,
    startedAt: '2026-07-28T00:00:00.000Z', finishedAt: '2026-07-28T00:10:00.000Z',
    scenarioSeed: 'p3-38-replay-seed',
    source: { backend: { ...repository, dirty: true }, frontend: repository, extension: repository, colp: repository,
      dirtyStateAllowed: true, dirtyFiles: [{ path: 'Known-Backend/example.ts', status: ' M', digest }],
      dirtyManifestDigest: '' },
    runtime: { node: 'v22.0.0', npm: '10.0.0', postgres: 'PostgreSQL 17', browser: 'Chrome/140',
      protocolVersion: '0.2' },
    artifact: { path: 'Known-Extension/dist/production', environment: 'production', sha256: digest,
      manifestDigest: digest, configDigest: digest, migrationDigest: digest },
    preflight: PHASE3_MULTI_DEVICE_PREFLIGHTS.map(gate),
    scenarios: PHASE3_MULTI_DEVICE_SCENARIOS.map(gate),
    faults: { seededCrashSequence: boundaries, requiredBoundaries: boundaries,
      boundaryEvidence: Object.fromEntries(boundaries.map((name) => [name, { point: name,
        triggerEvidence: { surface: 'cdp-or-ingress', digest },
        observationEvidence: [{ surface: 'indexeddb-before', digest },
          { surface: 'indexeddb-after', digest: 'd'.repeat(64) }],
        recoveryEvidence: { surface: 'worker-restart', digest } }])) },
    counts: { operations: 12, sequenceReceipts: 12, productReceipts: 1, tombstones: 0,
      purgeWatermark: `12:1:${digest}` },
    replicas: [
      { identityDigest: digest, generation: 1, status: 'active', oldIdentityRejected: false },
      { identityDigest: 'b'.repeat(64), generation: 1, status: 'active', oldIdentityRejected: false },
      { identityDigest: 'c'.repeat(64), generation: 1, status: 'retired', oldIdentityRejected: true },
    ],
    durableClients: [
      { profileDigest: 'd'.repeat(64), treeDigest: digest, cursorDigest: digest, ackDigest: digest,
        indexedDbDigest: 'e'.repeat(64), checkpointOrdinal: '12' },
      { profileDigest: digest, treeDigest: digest, cursorDigest: 'b'.repeat(64), ackDigest: 'b'.repeat(64),
        indexedDbDigest: digest, checkpointOrdinal: '12' },
    ],
    managedPolicy: { provider: 'linux-container-policy', isolatedProfile: true, sameArtifact: true,
      policySourceDigest: digest, containerImageId: digest, containerImageDigest: `sha256:${digest}`,
      browserVersion: 'Chromium/141.0.0.0', artifactSha256: digest, extensionIdDigest: digest,
      managedStorageDigest: digest, managedTreeDigest: digest, managedNodeCount: 1,
      serviceWorkerObserved: true, writeRejected: true, writeRejectionCode: 'chrome.bookmarks.update-rejected',
      containerRemoved: true, profileRemoved: true },
    redaction: { surfaces: ['backend-log', 'extension-log', 'browser-log', 'problem', 'trace', 'screenshot', 'container-stdout',
      'container-stderr', 'container-profile', 'evidence'],
      markerDigest: digest, scannedBytes: 1024, leaks: 0 },
    evidenceDigest: '',
  };
  value.source.dirtyManifestDigest = digestPhase3MultiDeviceEvidence(value.source.dirtyFiles);
  value.evidenceDigest = digestPhase3MultiDeviceEvidence(value);
  return value;
}

type Evidence = ReturnType<typeof validEvidence>;

describe('P3-38 evidence verifier', () => {
  test('binds the destination of porcelain-z rename/copy records and preserves ordinary paths', () => {
    const status = Buffer.from([
      ' M Known-Backend/ordinary.ts',
      'R  Known-Extension/new-name.ts',
      'Known-Extension/old-name.ts',
      'C  Known-Frontend/copied-name.ts',
      'Known-Frontend/source-name.ts',
      '',
    ].join('\0'));
    expect(parsePhase3DirtyStatus(status)).toEqual([
      { path: 'Known-Backend/ordinary.ts', status: ' M' },
      { path: 'Known-Extension/new-name.ts', status: 'R ' },
      { path: 'Known-Frontend/copied-name.ts', status: 'C ' },
    ]);
  });

  test.each([
    Buffer.from('R  Known-Extension/new-name.ts\0'),
    Buffer.from(' M ../outside.ts\0'),
    Buffer.from('broken\0'),
  ])('rejects malformed or escaping porcelain-z source status', (status) => {
    expect(() => parsePhase3DirtyStatus(status)).toThrow(/status|path/iu);
  });

  test('accepts only a complete current source-bound artifact', () => {
    expect(() => validatePhase3MultiDeviceEvidence(validEvidence(), { artifactSha256: digest })).not.toThrow();
  });

  test.each([
    ['acceptance mode', (value: Evidence) => { value.mode = 'diagnostic'; }],
    ['full stage', (value: Evidence) => { value.stage = 'full-fast'; }],
    ['exact recovery wait', (value: Evidence) => { value.recoveryWaitMs = 121_000; }],
    ['artifact', (value: Evidence) => { value.artifact.environment = 'development'; }],
    ['digest', (value: Evidence) => { value.artifact.sha256 = '0'.repeat(64); }],
    ['chromium', (value: Evidence) => { value.preflight = value.preflight.filter((item) => item.name !== 'chromium'); }],
    ['service worker', (value: Evidence) => { value.preflight = value.preflight.filter((item) => item.name !== 'service-worker'); }],
    ['bookmark permission', (value: Evidence) => { value.preflight = value.preflight.filter((item) => item.name !== 'bookmarks-permission'); }],
    ['PostgreSQL', (value: Evidence) => { value.preflight = value.preflight.filter((item) => item.name !== 'postgresql'); }],
    ['managed policy', (value: Evidence) => { value.preflight = value.preflight.filter((item) => item.name !== 'managed-policy'); }],
    ['managed service worker', (value: Evidence) => { value.managedPolicy.serviceWorkerObserved = false; }],
    ['managed bookmarks', (value: Evidence) => { value.managedPolicy.managedNodeCount = 0; }],
    ['managed write rejection', (value: Evidence) => { value.managedPolicy.writeRejected = false; }],
    ['floating container image', (value: Evidence) => { value.managedPolicy.containerImageDigest = 'latest'; }],
    ['container cleanup', (value: Evidence) => { value.managedPolicy.containerRemoved = false; }],
    ['profile cleanup', (value: Evidence) => { value.managedPolicy.profileRemoved = false; }],
    ['managed artifact mismatch', (value: Evidence) => { value.managedPolicy.artifactSha256 = '0'.repeat(64); }],
    ['provider self-report', (value: Evidence) => { Object.assign(value.managedPolicy, { supported: true }); }],
    ['source field', (value: Evidence) => { Reflect.deleteProperty(value.source, 'colp'); }],
    ['dirty manifest digest', (value: Evidence) => { value.source.dirtyFiles[0].digest = '0'.repeat(64); }],
    ['dirty repository flag', (value: Evidence) => { value.source.backend.dirty = false; }],
    ['tree convergence', (value: Evidence) => { value.durableClients[1].treeDigest = 'f'.repeat(64); }],
    ['cursor Ack convergence', (value: Evidence) => { value.durableClients[1].ackDigest = 'f'.repeat(64); }],
    ['checkpoint convergence', (value: Evidence) => { value.durableClients[1].checkpointOrdinal = '13'; }],
    ['receiver-bound cursor isolation', (value: Evidence) => {
      value.durableClients[1].cursorDigest = value.durableClients[0].cursorDigest;
      value.durableClients[1].ackDigest = value.durableClients[0].ackDigest;
    }],
    ['fresh generation-one Replica', (value: Evidence) => { value.replicas[1].generation = 2; }],
    ['active Replica rejection flag', (value: Evidence) => { value.replicas[0].oldIdentityRejected = true; }],
    ['advanced purge watermark', (value: Evidence) => { value.counts.purgeWatermark = `0:0:${digest}`; }],
    ['marker leak', (value: Evidence) => { value.redaction.leaks = 1; }],
  ])('rejects missing or forged %s evidence', (_name, mutate) => {
    const value = structuredClone(validEvidence()); mutate(value);
    value.evidenceDigest = digestPhase3MultiDeviceEvidence(value);
    expect(() => validatePhase3MultiDeviceEvidence(value, { artifactSha256: digest })).toThrow();
  });

  test('rejects evidence digest tampering', () => {
    const value = validEvidence(); value.evidenceDigest = 'f'.repeat(64);
    expect(() => validatePhase3MultiDeviceEvidence(value)).toThrow(/digest/iu);
  });

  test('rejects diagnostic and failure artifacts as acceptance evidence', () => {
    for (const format of [
      'known.phase3.multi-device-recovery.diagnostic.v1',
      'known.phase3.multi-device-recovery.failure.v1',
    ]) {
      const value = { ...validEvidence(), format, accepted: false };
      expect(() => validatePhase3MultiDeviceEvidence(value)).toThrow(/format|accepted/iu);
    }
  });
});
