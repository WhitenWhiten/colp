import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createPhase3AuthoritativePullAcceptanceDeployment } from '../../../scripts/phase3-authoritative-pull-acceptance-adapter.js';
import { runPhase3AuthoritativePullAcceptance } from '../../../scripts/acceptance/phase3-authoritative-pull-acceptance.js';

describe('P3-32C real TLS HTTP/PostgreSQL authoritative Pull acceptance', () => {
  let deployment: Awaited<ReturnType<typeof createPhase3AuthoritativePullAcceptanceDeployment>>;

  beforeAll(async () => {
    deployment = await createPhase3AuthoritativePullAcceptanceDeployment({ env: process.env });
  }, 30_000);
  afterAll(async () => deployment?.close());

  test('a genuinely independent second Replica reconstructs public server state from Pull', async () => {
    const evidence = await runPhase3AuthoritativePullAcceptance(deployment.probe);
    assert.equal(evidence.accepted, true);
    assert.equal(evidence.transport, 'tls');
    assert.equal(new Set(evidence.replicas.map((replica) => replica.replicaIdDigest)).size, 2);
    assert.equal(evidence.effects.every((effect) => effect.matched), true);
    assert.equal(evidence.ordering.stable && evidence.ordering.paged
      && evidence.ordering.cursorContinued && evidence.ordering.byteAware, true);
    assert.equal(evidence.immutableDelete.receiverEventCursorsDiffer, true);
    assert.equal(evidence.immutableDelete.receiverOneVerified
      && evidence.immutableDelete.receiverTwoVerified, true);
    assert.equal(evidence.redaction.leaks, 0);
    assert.equal('database' in deployment.publicEvidence, false);
    assert.equal('repository' in deployment.publicEvidence, false);
    assert.equal(deployment.publicEvidence.scenarioModule, 'repository-production');
    assert.equal(deployment.publicEvidence.oracle, 'public-http-only');
    assert.equal(deployment.publicEvidence.replicaTransportCount, 2);
    assert.equal(new Set(deployment.publicEvidence.replicaTransportDigests).size, 2);
    assert.ok(deployment.publicEvidence.httpsExchangeCount > evidence.negativeControls.length);
  }, 600_000);

  test('executes every isolated malformed/scope/transport/redaction control', async () => {
    const evidence = await runPhase3AuthoritativePullAcceptance(deployment.probe);
    assert.deepEqual(await deployment.verifyNegativeControls(), evidence.negativeControls);
    assert.equal(evidence.negativeControls.every((control) => control.outcome === 'failed_closed'), true);
    assert.equal(evidence.negativeControls.every((control) => control.proof.transport === 'https'), true);
    assert.equal(evidence.negativeControls.every((control) => control.proof.requestOrdinal > 0), true);
    assert.equal(evidence.negativeControls.every((control) => control.proof.clientOutcome === 'rejected'), true);
    assert.equal(evidence.negativeControls.every((control) => control.preparation !== 'oracle_read'), true);
  }, 120_000);
});
