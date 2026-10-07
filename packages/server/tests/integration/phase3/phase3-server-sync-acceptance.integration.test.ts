import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createPhase3ServerSyncAcceptanceDeployment } from '../../../scripts/phase3-server-sync-acceptance-adapter.js';
import { runPhase3ServerSyncAcceptance } from '../../../scripts/acceptance/phase3-server-sync-acceptance.js';

describe('P3-26 real HTTP/PostgreSQL server Sync acceptance', () => {
  let deployment: Awaited<ReturnType<typeof createPhase3ServerSyncAcceptanceDeployment>>;
  beforeAll(async () => { deployment = await createPhase3ServerSyncAcceptanceDeployment({ env: process.env }); }, 30_000);
  afterAll(async () => deployment?.close());

  test('accepts the complete server surface without claiming the Sync Profile', async () => {
    const evidence = await runPhase3ServerSyncAcceptance(deployment.probe);
    assert.equal(evidence.accepted, true);
    assert.equal(evidence.profileClaimed, false);
    assert.equal(evidence.deploymentProven, false);
    assert.equal(evidence.stepCount, evidence.steps.length);
    assert.equal(new Set(evidence.steps.map((step) => step.runtimeNonce)).size, 1);
    assert.equal(evidence.steps[0]?.runtimeNonce, evidence.runtime.nonce);
    assert.equal(evidence.routes.every((route) => !route.routeTemplate.startsWith('manifest-discovered:')), true);
    assert.equal(evidence.ports.every((port) => port.source !== undefined), true);
    assert.equal(evidence.probes.every((probe) => probe.outcome === 'passed'), true);
    assert.equal(evidence.telemetry.leaks, 0);
  }, 600_000);

  test('every production dependency and evidence sink has an isolated fail-closed control', async () => {
    const controls = await deployment.verifyNegativeControls();
    assert.deepEqual(controls, (await runPhase3ServerSyncAcceptance(deployment.probe)).negativeControls);
    assert.equal(controls.every((control) => control.outcome === 'failed_closed'), true);
    assert.equal(new Set(controls.map((control) => control.id)).size, controls.length);
  }, 60_000);
});
