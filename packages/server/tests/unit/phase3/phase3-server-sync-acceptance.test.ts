import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  P3_26_REQUIRED_PORTS, P3_26_REQUIRED_PROBES, P3_26_REQUIRED_ROUTES,
  P3_26_PRODUCTION_MIGRATIONS,
  P3_26_SERVER_SYNC_SCENARIOS, appendPhase3ServerSyncStep,
  createPhase3ServerSyncAcceptanceProbe, runPhase3ServerSyncAcceptance,
  validatePhase3ServerSyncAcceptanceArtifact, validatePhase3ServerSyncAcceptanceEvidence,
  type Phase3ServerSyncNegativeFact, type Phase3ServerSyncStepFact,
} from '../../../scripts/acceptance/phase3-server-sync-acceptance.js';

describe('P3-26 fail-closed server Sync acceptance', () => {
  test('requires runtime-observed routes, ports, probes and every ordered scenario', () => {
    assert.equal(P3_26_REQUIRED_ROUTES.length, 8);
    assert.equal(P3_26_REQUIRED_PORTS.length, 11);
    assert.equal(P3_26_REQUIRED_PROBES.length, 8);
    assert.equal(P3_26_SERVER_SYNC_SCENARIOS.length, 18);
  });

  test('recomputes the runtime-nonce step chain and rejects omission, reorder and forgery', () => {
    const valid = candidate();
    assert.doesNotThrow(() => validatePhase3ServerSyncAcceptanceEvidence(valid));
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, steps: valid.steps.slice(1), stepCount: valid.stepCount - 1 }), /step|scenario/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, steps: [valid.steps[1]!, valid.steps[0]!, ...valid.steps.slice(2)] }), /sequence|digest/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, steps: valid.steps.map((step, index) => index === 3 ? { ...step, counts: { writes: 99 } } : step) }), /digest/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, runtime: { ...valid.runtime, nonce: 'different-runtime-nonce' } }), /nonce/iu);
  });

  test('rejects placeholder composition, incomplete controls, digest tamper and claims', () => {
    const valid = candidate();
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, routes: valid.routes.map((route, index) => index === 0 ? { ...route, routeTemplate: 'manifest-discovered:manifest' } : route) }), /placeholder/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, negativeControls: valid.negativeControls.slice(1) }), /negative control/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, profileClaimed: true as never }), /Profile/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, migrations: { ...valid.migrations, files: valid.migrations.files.slice(1) } }), /migration/iu);
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({ ...valid, telemetry: { ...valid.telemetry, leaks: 1 as never } }), /leak/iu);
  });

  test('accepts later ordered migrations without weakening the P3-26 baseline', () => {
    const valid = candidate();
    const later = '202607270100_oidc_profile_handle_invariant.ts';
    const migrations = {
      ...valid.migrations,
      latest: later.replace(/\.ts$/u, ''),
      files: [...valid.migrations.files, later],
    };
    const negativeControls = [...valid.negativeControls, {
      ...valid.negativeControls[0]!, id: 'control:later-migration',
      targetKind: 'migration' as const, target: later,
    }];
    assert.doesNotThrow(() => validatePhase3ServerSyncAcceptanceEvidence({
      ...valid, migrations, negativeControls,
    }));
    assert.throws(() => validatePhase3ServerSyncAcceptanceEvidence({
      ...valid, negativeControls,
      migrations: { ...migrations, latest: '202607252700_sync_operation_effects' },
    }), /migration/iu);
  });

  test('recomputes the top-level digest when reading an artifact', async () => {
    const evidence = await runPhase3ServerSyncAcceptance(createPhase3ServerSyncAcceptanceProbe(async () => candidate()));
    assert.doesNotThrow(() => validatePhase3ServerSyncAcceptanceArtifact(evidence));
    assert.throws(() => validatePhase3ServerSyncAcceptanceArtifact({ ...evidence, evidenceDigest: 'A'.repeat(43) }), /evidence digest/iu);
  });

  test('runner directly executes one scenario and has bounded abort/cleanup; no Vitest aggregation or recorder labels', () => {
    const runner = readFileSync(resolve('scripts/phase3-server-sync-acceptance.mjs'), 'utf8');
    const adapter = readFileSync(resolve('scripts/phase3-server-sync-acceptance-adapter.ts'), 'utf8');
    assert.doesNotMatch(adapter, /vitest|runSuites|SUITES|manifest-discovered/u);
    assert.doesNotMatch(adapter, /\[port, true\]|\[name, true\]/u);
    assert.match(adapter, /runPhase3ServerSyncBlackBoxScenario/u);
    assert.match(adapter, /AbortController|timeout/iu);
    assert.match(runner, /SIGTERM|SIGKILL|AbortController|timeout/iu);
    assert.match(runner, /FAIL-CLOSED/u);
  });
});

function candidate() {
  const nonce = 'p3-26-one-runtime-nonce';
  let steps: readonly Phase3ServerSyncStepFact[] = [];
  for (const [index, scenario] of P3_26_SERVER_SYNC_SCENARIOS.entries()) {
    steps = appendPhase3ServerSyncStep(steps, nonce, {
      id: `step_${index + 1}`, scenario, endpoint: { key: index === 0 ? 'manifest' : 'syncPush', method: 'POST', routeTemplate: index === 0 ? '/.well-known/collection-protocol' : '/runtime/push', uriDigest: '1'.repeat(64) },
      outcome: 'success', problem: null, transaction: '2'.repeat(64), generationBefore: '1', generationAfter: '1', boundaryBefore: '0', boundaryAfter: String(index + 1),
      startedAt: '2026-07-27T00:00:00.000Z', finishedAt: '2026-07-27T00:00:01.000Z', counts: { responses: 1 },
    });
  }
  const now = '2026-07-27T00:00:00.000Z';
  const requiredTargets = [
    ...P3_26_REQUIRED_ROUTES.map((target) => ['route', target] as const),
    ...P3_26_REQUIRED_PORTS.map((target) => ['port', target] as const),
    ...P3_26_PRODUCTION_MIGRATIONS.map((migration) => ['migration', migration] as const),
    ['credential', 'adapter'], ['database', 'disconnect'], ['artifact', 'unwritable'], ['source', 'digest'],
    ['colp', 'digest'], ['config', 'digest'], ['step', 'omission'],
  ] as const;
  const paddedTargets = [...requiredTargets, ...Array.from({ length: 32 - requiredTargets.length }, (_, index) => ['database', `extra-${index}`] as const)];
  const negativeControls: readonly Phase3ServerSyncNegativeFact[] = paddedTargets.map(([targetKind, target], index) => ({ id: `control:${index}`, targetKind, target, injection: 'isolated runtime fault', outcome: 'failed_closed', observationDigest: '3'.repeat(64), startedAt: now, finishedAt: now }));
  return {
    runnerVersion: '2.0.0', probeVersion: '2.0.0', source: { commit: 'a'.repeat(40), treeDigest: 'b'.repeat(64) },
    migrations: { latest: '202607252700_sync_operation_effects' as const, files: P3_26_PRODUCTION_MIGRATIONS, chainDigest: 'c'.repeat(64) },
    colp: { packageVersion: '0.1.0', packageDigest: 'd'.repeat(64), lockDigest: 'e'.repeat(64), conformanceDigest: 'f'.repeat(64) },
    runtime: { engine: 'postgresql' as const, instanceId: 'single-fastify-runtime-id', nonce, configDigest: '0'.repeat(64), startedAt: now, finishedAt: '2026-07-27T00:01:00.000Z' },
    routes: P3_26_REQUIRED_ROUTES.map((key) => ({ key, method: key === 'syncRetire' ? 'DELETE' as const : key === 'manifest' || key === 'syncSnapshot' || key === 'syncPull' ? 'GET' as const : 'POST' as const, routeTemplate: key === 'manifest' ? '/.well-known/collection-protocol' : `/runtime/${key}`, uriDigest: '1'.repeat(64), discoveredAt: now })),
    ports: P3_26_REQUIRED_PORTS.map((name) => ({ name, source: 'runtime-composition' as const, observationDigest: '5'.repeat(64), observedAt: now })),
    probes: P3_26_REQUIRED_PROBES.map((name) => ({ name, outcome: 'passed' as const, observationDigest: '2'.repeat(64), startedAt: now, finishedAt: now })),
    steps, stepCount: steps.length, negativeControls,
    telemetry: { endpoints: ['manifest', 'session', 'snapshot', 'push', 'conflict', 'pull', 'ack', 'purge', 'recovery', 'retire'] as const, outcomes: ['success', 'problem', 'internal', 'timeout', 'abort', 'retry', 'replay', 'concurrency'] as const, surfaces: ['logs', 'traces', 'metrics', 'problems', 'artifact'] as const, sentinelDigest: '4'.repeat(64), scannedBytes: 1, leaks: 0 as const },
    profileClaimed: false as const, deploymentProven: false as const,
  };
}
