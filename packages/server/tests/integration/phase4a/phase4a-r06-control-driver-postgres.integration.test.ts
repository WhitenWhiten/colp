/**
 * P4A-R06 PostgreSQL integration: I16 `projection_negatives` control driver.
 *
 * The I16 runner's `projection_negatives` control is replaced by a real
 * per-consumer black-box driver (`executeProjectionNegativeConsumers`):
 * every consumer must serve its control resource (`consumer_not_exercised`
 * otherwise), a consumer that fails to run is reported as a DISTINCT
 * `consumer_outage` (never mistaken for a deny), and any private marker in a
 * consumer output is a `projection_negative_leak` failure. Only when every
 * consumer served its control with zero markers does the control reach
 * `executed:true` with a receipt.
 *
 * This suite drives the REAL production consumers (`buildR06ProjectionConsumers`)
 * over real PostgreSQL and also pins the fail-closed error paths with stubs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  I16NegativeControlExecutor,
  I16_NEGATIVE_CONTROL_CATALOG,
  type I16NegativeControlEvidence,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  ProjectionConsumerNotExercisedError,
  ProjectionConsumerOutageError,
  ProjectionNegativeLeakError,
  buildR06ProjectionConsumers,
  executeProjectionNegativeConsumers,
  type R06ProjectionConsumerRunner,
} from '../../../scripts/evidence/phase4a-r06-projection-control.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const CATALOG = I16_NEGATIVE_CONTROL_CATALOG.find((entry) => entry.control === 'projection_negatives')!;

describeWithPostgres('P4A-R06 I16 projection_negatives control driver', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_r06_control_driver', { maxConnections: 12 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function freshLedger(): { readonly ledger: I16NegativeControlExecutor;
    readonly negativeControls: I16NegativeControlEvidence[]; readonly executed: Set<string> } {
    return {
      ledger: new I16NegativeControlExecutor(`r06-driver-${randomUUID()}`),
      negativeControls: [],
      executed: new Set(),
    };
  }

  test('the real production consumers complete the control with executed:true and a receipt', async () => {
    const { ledger, negativeControls, executed } = freshLedger();
    const set = await buildR06ProjectionConsumers({
      runtime: isolated.runtime,
      bucket: 'r06-control-bucket',
      livePrefix: 'attachments/live/',
      nonce: randomUUID(),
    });
    assert.ok(set.consumers.length >= 6,
      `six consumer legs must exist; got ${set.consumers.length}`);
    assert.equal(new Set(set.consumers.map((consumer) => consumer.kind)).size, set.consumers.length,
      'consumer legs must be distinct');
    assert.ok(set.consumers.some((consumer) => consumer.kind === 'shared_link'),
      'the shared-link gate-contract leg must be part of the control');
    assert.ok(set.privateMarkers.length >= 5,
      'the private fixture blobs must carry distinct markers');

    await executeProjectionNegativeConsumers({
      executionLedger: ledger,
      negativeControls,
      executed,
      consumers: set.consumers,
      privateMarkers: set.privateMarkers,
    });
    assert.ok(executed.has('projection_negatives'), 'the control must be marked executed');
    assert.equal(negativeControls.length, 1);
    assert.equal(negativeControls[0]!.control, 'projection_negatives');
    assert.equal(negativeControls[0]!.verdict, 'pass');
    assert.equal(negativeControls[0]!.executed, true);
    const receipt = ledger.receiptFor('projection_negatives');
    assert.equal(receipt.exitClass, 'clean');
    assert.equal(receipt.stableCode, 'zero');
    assert.equal(receipt.runId, ledger.runId);
    assert.equal(receipt.verificationSource, 'real-r2-postgres');
  }, 120_000);

  test('a consumer that serves no control resource fails as consumer_not_exercised (never a pass)', async () => {
    const { ledger, negativeControls, executed } = freshLedger();
    const consumers: R06ProjectionConsumerRunner[] = [{
      kind: 'publication',
      async run() { return { controlVisible: false, output: { nodes: [] } }; },
    }];
    await assert.rejects(
      () => executeProjectionNegativeConsumers({
        executionLedger: ledger, negativeControls, executed, consumers, privateMarkers: ['marker-1'],
      }),
      (error: unknown) => error instanceof ProjectionConsumerNotExercisedError
        && error.kind === 'publication' && error.code === 'consumer_not_exercised',
      'an empty output without the control resource must fail the control',
    );
    assert.throws(() => ledger.receiptFor('projection_negatives'), /negative_control_not_executed/u,
      'the control must never complete without the control resource');
    assert.equal(executed.has('projection_negatives'), false);
  });

  test('a consumer outage is reported distinctly from a deny (consumer_outage)', async () => {
    const { ledger, negativeControls, executed } = freshLedger();
    const consumers: R06ProjectionConsumerRunner[] = [{
      kind: 'search',
      async run() { throw new Error('postgres connection refused (outage)'); },
    }];
    await assert.rejects(
      () => executeProjectionNegativeConsumers({
        executionLedger: ledger, negativeControls, executed, consumers, privateMarkers: ['marker-1'],
      }),
      (error: unknown) => error instanceof ProjectionConsumerOutageError
        && error.kind === 'search' && error.code === 'consumer_outage',
      'a consumer that cannot run must be reported as an outage, never as a successful deny',
    );
    assert.throws(() => ledger.receiptFor('projection_negatives'), /negative_control_not_executed/u);
  });

  test('a private marker in any consumer output is a projection_negative_leak failure', async () => {
    const { ledger, negativeControls, executed } = freshLedger();
    const consumers: R06ProjectionConsumerRunner[] = [{
      kind: 'mcp',
      async run() { return { controlVisible: true, output: { items: [{ title: 'leak-r06-marker-123' }] } }; },
    }];
    await assert.rejects(
      () => executeProjectionNegativeConsumers({
        executionLedger: ledger, negativeControls, executed, consumers, privateMarkers: ['leak-r06-marker-123'],
      }),
      (error: unknown) => error instanceof ProjectionNegativeLeakError
        && error.kind === 'mcp' && error.code === 'projection_negative_leak',
      'a marker in the output must fail the control even when the control resource is visible',
    );
    assert.throws(() => ledger.receiptFor('projection_negatives'), /negative_control_not_executed/u);
  });

  test('the catalog contract for projection_negatives is unchanged (real-r2-postgres, deny gate)', () => {
    assert.equal(CATALOG.control, 'projection_negatives');
    assert.equal(CATALOG.primarySource, 'real-r2-postgres');
    assert.equal(CATALOG.intendedTarget, 'exposure-eligibility gate (deny-by-default)');
    assert.ok(CATALOG.intendedCode.includes('zero'));
    assert.ok(CATALOG.intendedCode.includes('ineligible'));
  });
});
