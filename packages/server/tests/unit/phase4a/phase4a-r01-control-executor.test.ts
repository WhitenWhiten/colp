/**
 * P4A-R01 contract suite: fixed in-run control executor.
 *
 * The acceptance runner may only emit `executed:true` for a negative control
 * when the FIXED executor contract returned the complete per-run execution
 * record for that control: run ID, install point, owning target, expected
 * stable codes, execution source, start/end state, install proof, target hit,
 * observed stable code and cleanup receipt. Only a completed record produces
 * a receipt, and the evidence gate requires an exact executed-entry <-> receipt
 * correspondence for THIS run, so neither the runner nor any caller can
 * declare execution by writing the boolean directly.
 *
 * Anti-false-positive (plan §4.3 mutation control): hardcoding
 * `executed:true` without an executor receipt fails BOTH the runner assertion
 * (`assertCompleteNegativeControls` / `buildI16Evidence`) and the independent
 * validator. Checking only that the 24 IDs exist, treating a focused-suite
 * exit code 0 as execution, or letting the runner fill a default outcome are
 * all rejected.
 *
 * Anti-false-negative: the execution digest binds ONLY run id, control, exit
 * class, stable code, source digest and cleanup facts. stderr, platform paths
 * and durations never enter it — the executor's injected clock proves
 * duration insensitivity, and the canonical digest never contains a path,
 * URL or timestamp.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  I16_NEGATIVE_CONTROL_CATALOG,
  I16NegativeControlExecutor,
  assertCompleteNegativeControls,
  assertI16EvidenceShape,
  buildI16Evidence,
  canonicalizeI16,
  computeI16CanonicalDigest,
  computeI16ControlExecutionDigest,
  sha256HexI16,
  type I16ExecutionReceiptEvidence,
  type I16NegativeControlEvidence,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  I16_TEST_RUN_ID,
  buildI16FixtureEvidence,
  i16BindingFacts,
  i16ExecutionEvidence,
  i16ExecutionLedger,
  i16NegativeControls,
  i16PostRunChecks,
  i16Scenario,
} from '../../support/phase4a-i16-test-helpers.js';

// The validator is plain Node ESM; vitest can import it directly.
const validator = await import('../../../scripts/phase4a-i16-validate-evidence.mjs');

function catalog(control: string): { control: string; intendedTarget: string; intendedCode: readonly string[]; primarySource: string } {
  const entry = I16_NEGATIVE_CONTROL_CATALOG.find((item) => item.control === control);
  assert.ok(entry, `catalog must contain ${control}`);
  return entry!;
}

describe('P4A-R01 control executor state machine', () => {
  test('a complete execution record is the only way to produce executed:true', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    const record = executor.recordFor('size_digest_mismatch');
    assert.equal(record.runId, I16_TEST_RUN_ID);
    assert.equal(record.owningTarget, definition.intendedTarget);
    assert.deepEqual([...record.expectedStableCodes], [...definition.intendedCode]);
    assert.equal(record.installEvidence, null);
    assert.equal(record.targetHit, false);
    assert.equal(record.stableCode, null);
    assert.equal(record.cleanupReceipt, null);

    executor.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    executor.recordTargetHit('size_digest_mismatch');
    executor.recordStableCode('size_digest_mismatch', 'quarantined');
    executor.recordCleanupReceipt('size_digest_mismatch', 'confirmed_absent');
    const receipt = executor.complete('size_digest_mismatch');
    assert.equal(receipt.runId, I16_TEST_RUN_ID);
    assert.equal(receipt.exitClass, 'clean');
    assert.equal(receipt.stableCode, 'quarantined');
    assert.equal(receipt.cleanupReceipt, 'confirmed_absent');
    assert.equal(receipt.verificationSource, 'real-r2-postgres');
    assert.match(receipt.sourceDigest, /^[a-f0-9]{64}$/);
    assert.match(receipt.executionDigest, /^[a-f0-9]{64}$/);
    const completed = executor.recordFor('size_digest_mismatch');
    assert.equal(completed.finishedAt !== null, true, 'complete must stamp the end state');
    assert.equal(completed.installEvidence, 'declared_sha256_of_different_same_size_bytes');
    assert.equal(completed.targetHit, true);
    assert.equal(completed.stableCode, 'quarantined');
    assert.equal(completed.cleanupReceipt, 'confirmed_absent');
    // the receipt is the executor's full return; no other path yields it
    assert.equal(executor.receiptFor('size_digest_mismatch'), receipt);
  });

  test('rejects a duplicated control in the same run', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'boundary-a',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    assert.throws(() => executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'boundary-b',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    }), /negative_control_duplicate/);
  });

  test('rejects an unknown control id', () => {
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    assert.throws(() => executor.begin({
      control: 'not_a_control' as never,
      installPoint: 'boundary-a',
      owningTarget: 'any-target',
      verificationSource: 'real-r2-postgres',
    }), /negative_control_unknown/);
    assert.throws(() => executor.recordInstall('not_a_control' as never, 'proof'), /negative_control_not_started/);
    assert.throws(() => executor.receiptFor('not_a_control' as never), /negative_control_not_started/);
  });

  test('rejects execution without an install proof', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    assert.throws(() => executor.recordTargetHit('size_digest_mismatch'), /negative_control_install_missing/);
    assert.throws(() => executor.complete('size_digest_mismatch'), /negative_control_install_missing/);
  });

  test('rejects execution without a target hit', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    executor.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    assert.throws(() => executor.recordStableCode('size_digest_mismatch', 'quarantined'), /negative_control_target_not_hit/);
    assert.throws(() => executor.complete('size_digest_mismatch'), /negative_control_target_not_hit/);
  });

  test('rejects a stable code outside the expected list', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    executor.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    executor.recordTargetHit('size_digest_mismatch');
    assert.throws(
      () => executor.recordStableCode('size_digest_mismatch', 'not_a_stable_code'),
      /negative_control_wrong_stable_code/,
    );
    // every code the owning boundary may emit is accepted
    for (const code of definition.intendedCode) {
      const probe = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
      probe.begin({
        control: 'size_digest_mismatch',
        installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
        owningTarget: definition.intendedTarget,
        verificationSource: definition.primarySource as 'real-r2-postgres',
      });
      probe.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
      probe.recordTargetHit('size_digest_mismatch');
      assert.doesNotThrow(() => probe.recordStableCode('size_digest_mismatch', code));
    }
  });

  test('rejects execution without a cleanup receipt', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    executor.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    executor.recordTargetHit('size_digest_mismatch');
    executor.recordStableCode('size_digest_mismatch', 'quarantined');
    assert.throws(() => executor.complete('size_digest_mismatch'), /negative_control_cleanup_missing/);
    // a verdict without a cleanup receipt can never become executed:true
    assert.throws(() => executor.receiptFor('size_digest_mismatch'), /negative_control_not_executed/);
  });

  test('rejects a control whose subprocess execution failed abnormally', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    executor.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: definition.intendedTarget,
      verificationSource: definition.primarySource as 'real-r2-postgres',
    });
    executor.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    executor.recordTargetHit('size_digest_mismatch');
    executor.recordStableCode('size_digest_mismatch', 'quarantined');
    executor.recordAbnormalExit('size_digest_mismatch');
    assert.throws(() => executor.complete('size_digest_mismatch'), /negative_control_subprocess_failed/);
    assert.throws(() => executor.receiptFor('size_digest_mismatch'), /negative_control_not_executed/);
    // the executor treats it as unexecuted: the catalog completeness gate stays closed
    assert.throws(() => executor.assertCatalogComplete(), /negative_control_missing/);
  });

  test('the executor owns the run scope and emits receipts in catalog order', () => {
    const execution = i16ExecutionEvidence();
    const controls = execution.receipts.map((receipt) => receipt.control);
    assert.deepEqual(controls, [...controls].sort());
    assert.equal(new Set(controls).size, I16_NEGATIVE_CONTROL_CATALOG.length);
    for (const receipt of execution.receipts) {
      assert.equal(receipt.runId, I16_TEST_RUN_ID);
      assert.equal(receipt.exitClass, 'clean');
    }
    const executor = i16ExecutionLedger();
    assert.doesNotThrow(() => executor.assertCatalogComplete());
  });
});

describe('P4A-R01 evidence gate (runner assertion)', () => {
  test('a fully executed catalog passes the runner gate', () => {
    const execution = i16ExecutionEvidence();
    assert.doesNotThrow(() => assertCompleteNegativeControls(i16NegativeControls(), execution));
    const bundle = buildI16FixtureEvidence();
    assertI16EvidenceShape(bundle);
    assert.equal(bundle.runId, I16_TEST_RUN_ID);
    assert.equal(bundle.executionReceipts.length, I16_NEGATIVE_CONTROL_CATALOG.length);
  });

  test('hardcoded executed:true without an executor receipt fails the runner gate', () => {
    // all 24 IDs exist and every entry says executed:true — but no receipt
    // was produced by the executor, so the gate must fail closed.
    assert.throws(() => buildI16Evidence({
      binding: i16BindingFacts(),
      scenario: i16Scenario(),
      negativeControls: i16NegativeControls(),
      postRunChecks: i16PostRunChecks(),
      runId: I16_TEST_RUN_ID,
      executionReceipts: [],
    }), /negative_control_execution_receipt_missing/);
  });

  test('rejects receipts reused across runs', () => {
    const bundle = buildI16FixtureEvidence();
    assert.throws(() => buildI16Evidence({
      binding: i16BindingFacts(),
      scenario: i16Scenario(),
      negativeControls: i16NegativeControls(),
      postRunChecks: i16PostRunChecks(),
      runId: 'i16-another-run-00000000-0000-4000-8000-000000000001',
      executionReceipts: bundle.executionReceipts,
    }), /negative_control_execution_cross_run/);
    // the same receipts can never be smuggled into a second artifact
    const second = buildI16FixtureEvidence();
    const result = validator.validateEvidenceBundle({ ...second, runId: 'i16-another-run-00000000-0000-4000-8000-000000000001' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /execution_cross_run/.test(error)));
  });

  test('rejects focused-suite report impersonation', () => {
    // an entry attributed to a focused suite has no executor record in this run
    const controls = i16NegativeControls().map((control, index) => (
      index === 0 ? { ...control, verificationSource: 'postgres-integration-suite' as const } : control
    ));
    const execution = i16ExecutionEvidence();
    assert.throws(() => assertCompleteNegativeControls(controls, execution), /negative_control_execution_source_mismatch/);
    // without ANY receipts the impersonation fails too
    assert.throws(
      () => assertCompleteNegativeControls(controls, { runId: execution.runId, receipts: [] }),
      /negative_control_execution_receipt_missing/,
    );
  });

  test('rejects a receipt whose digest or source does not match its fields', () => {
    const controls = i16NegativeControls();
    const execution = i16ExecutionEvidence();
    const tampered: I16ExecutionReceiptEvidence = { ...execution.receipts[0]!, executionDigest: 'f'.repeat(64) };
    assert.throws(
      () => assertCompleteNegativeControls(controls, { ...execution, receipts: [tampered, ...execution.receipts.slice(1)] }),
      /negative_control_execution_digest_mismatch/,
    );
    const sourceSwap: I16ExecutionReceiptEvidence = { ...execution.receipts[0]!, verificationSource: 'real-r2' };
    assert.throws(
      () => assertCompleteNegativeControls(controls, { ...execution, receipts: [sourceSwap, ...execution.receipts.slice(1)] }),
      /negative_control_execution_source_mismatch/,
    );
  });

  test('rejects duplicate or unknown receipts', () => {
    const controls = i16NegativeControls();
    const execution = i16ExecutionEvidence();
    assert.throws(
      () => assertCompleteNegativeControls(controls, { ...execution, receipts: [execution.receipts[0]!, ...execution.receipts] }),
      /negative_control_execution_receipt_duplicate/,
    );
    assert.throws(
      () => assertCompleteNegativeControls(controls, { ...execution, receipts: execution.receipts.slice(1) }),
      /negative_control_execution_receipt_missing/,
    );
  });

  test('a control missing any in-run fact keeps the gate fail-closed', () => {
    // install + hit + verdict are recorded, but cleanup never completes:
    // the executor returns no receipt, so executed:true is impossible.
    const controls = i16NegativeControls();
    const executor = new I16NegativeControlExecutor(I16_TEST_RUN_ID);
    for (const entry of controls) {
      const definition = catalog(entry.control);
      executor.begin({
        control: entry.control,
        installPoint: 'synthetic-boundary:' + entry.control,
        owningTarget: definition.intendedTarget,
        verificationSource: entry.verificationSource,
      });
      executor.recordInstall(entry.control, 'synthetic-install-proof');
      executor.recordTargetHit(entry.control);
      executor.recordStableCode(entry.control, definition.intendedCode[0]!);
    }
    assert.equal(executor.toEvidenceReceipts().length, 0);
    assert.throws(
      () => assertCompleteNegativeControls(controls, { runId: executor.runId, receipts: executor.toEvidenceReceipts() }),
      /negative_control_execution_receipt_missing/,
    );
    assert.throws(() => buildI16Evidence({
      binding: i16BindingFacts(),
      scenario: i16Scenario(),
      negativeControls: controls,
      postRunChecks: i16PostRunChecks(),
      runId: executor.runId,
      executionReceipts: executor.toEvidenceReceipts(),
    }), /negative_control_execution_receipt_missing/);
  });
});

describe('P4A-R01 evidence artifact', () => {
  test('rejects artifact order drift in the execution receipts', () => {
    const bundle = buildI16FixtureEvidence();
    const shuffled = { ...bundle, executionReceipts: [...bundle.executionReceipts].reverse() };
    assert.throws(() => assertI16EvidenceShape(shuffled), /negative_control_execution_order/);
    const result = validator.validateEvidenceBundle(shuffled);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /execution_order/.test(error)));
  });
});

describe('P4A-R01 independent validator', () => {
  test('a valid bundle with execution receipts passes', () => {
    const bundle = buildI16FixtureEvidence();
    const result = validator.validateEvidenceBundle(bundle);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.checks.includes('execution_receipts'));
  });

  test('hardcoded executed:true without receipts fails the independent validator', () => {
    const bundle = buildI16FixtureEvidence();
    const hardcoded = { ...bundle, executionReceipts: [] };
    const result = validator.validateEvidenceBundle(hardcoded);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /execution_receipt_missing/.test(error)));
    assert.ok(result.errors.some((error: string) => /digest/.test(error)), 'the canonical digest must also drift');
  });

  test('focused-suite impersonation fails the independent validator', () => {
    const bundle = buildI16FixtureEvidence();
    const controls = bundle.negativeControls.map((control, index) => (
      index === 0 ? { ...control, verificationSource: 'postgres-integration-suite' } : control
    ));
    const result = validator.validateEvidenceBundle({ ...bundle, negativeControls: controls });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /source_mismatch|forbidden_source/.test(error)));
  });

  test('a tampered execution digest fails the independent validator', () => {
    const bundle = buildI16FixtureEvidence();
    const receipts = bundle.executionReceipts.map((receipt, index) => (
      index === 0 ? { ...receipt, executionDigest: 'f'.repeat(64) } : receipt
    ));
    const result = validator.validateEvidenceBundle({ ...bundle, executionReceipts: receipts });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /execution_digest_mismatch/.test(error)));
  });
});

describe('P4A-R01 digest anti-false-negative contract', () => {
  test('durations never enter the execution digest', () => {
    let clock = 1_000;
    const slow = new I16NegativeControlExecutor(I16_TEST_RUN_ID, () => clock);
    slow.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: catalog('size_digest_mismatch').intendedTarget,
      verificationSource: 'real-r2-postgres',
    });
    slow.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    slow.recordTargetHit('size_digest_mismatch');
    slow.recordStableCode('size_digest_mismatch', 'quarantined');
    slow.recordCleanupReceipt('size_digest_mismatch', 'confirmed_absent');
    clock += 60_000;
    const slowReceipt = slow.complete('size_digest_mismatch');

    clock += 30_000;
    const fast = new I16NegativeControlExecutor(I16_TEST_RUN_ID, () => clock);
    fast.begin({
      control: 'size_digest_mismatch',
      installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify boundary',
      owningTarget: catalog('size_digest_mismatch').intendedTarget,
      verificationSource: 'real-r2-postgres',
    });
    fast.recordInstall('size_digest_mismatch', 'declared_sha256_of_different_same_size_bytes');
    fast.recordTargetHit('size_digest_mismatch');
    fast.recordStableCode('size_digest_mismatch', 'quarantined');
    fast.recordCleanupReceipt('size_digest_mismatch', 'confirmed_absent');
    const fastReceipt = fast.complete('size_digest_mismatch');

    const slowRecord = slow.recordFor('size_digest_mismatch');
    const fastRecord = fast.recordFor('size_digest_mismatch');
    assert.notEqual(slowRecord.startedAt, fastRecord.startedAt);
    assert.notEqual(slowRecord.finishedAt, fastRecord.finishedAt);
    assert.equal(slowReceipt.executionDigest, fastReceipt.executionDigest, 'duration must never enter the digest');
    assert.equal(slowReceipt.executionDigest, fastReceipt.executionDigest);
  });

  test('the execution digest binds exactly exit class, stable code, source digest and cleanup facts', () => {
    const receipt = i16ExecutionEvidence().receipts[0]!;
    const expected = sha256HexI16(canonicalizeI16({
      runId: receipt.runId,
      control: receipt.control,
      exitClass: receipt.exitClass,
      stableCode: receipt.stableCode,
      sourceDigest: receipt.sourceDigest,
      cleanupReceipt: receipt.cleanupReceipt,
      verificationSource: receipt.verificationSource,
    }));
    assert.equal(receipt.executionDigest, expected);
    // the digest input has no stderr, platform-path or duration fields
    const canonical = canonicalizeI16({
      runId: receipt.runId,
      control: receipt.control,
      exitClass: receipt.exitClass,
      stableCode: receipt.stableCode,
      sourceDigest: receipt.sourceDigest,
      cleanupReceipt: receipt.cleanupReceipt,
      verificationSource: receipt.verificationSource,
    });
    assert.ok(!canonical.includes('stderr'));
    assert.ok(!canonical.includes('startedAt') && !canonical.includes('finishedAt'));
    // a cleanup fact change changes the digest; stderr/paths/timestamps are absent
    const changed = computeI16ControlExecutionDigest({
      runId: receipt.runId,
      control: receipt.control,
      exitClass: receipt.exitClass,
      stableCode: receipt.stableCode,
      sourceDigest: receipt.sourceDigest,
      cleanupReceipt: 'not_cleaned',
      verificationSource: receipt.verificationSource,
    });
    assert.notEqual(changed, receipt.executionDigest);
  });

  test('the canonical digest never contains a path, URL or timestamp', () => {
    const bundle = buildI16FixtureEvidence();
    assert.match(bundle.canonicalDigest, /^[a-f0-9]{64}$/);
    assert.ok(!bundle.canonicalDigest.includes('http'));
    assert.ok(!bundle.canonicalDigest.includes('/'));
    assert.ok(!bundle.canonicalDigest.includes('\\'));
    // execution facts are part of the canonical projection
    const recomputed = computeI16CanonicalDigest({
      scenario: bundle.scenario,
      negativeControls: bundle.negativeControls.map(({ control, outcome }) => ({ control, outcome })),
      postRunChecks: bundle.postRunChecks,
      executionReceipts: bundle.executionReceipts,
    });
    assert.equal(recomputed, bundle.canonicalDigest);
  });
});

describe('P4A-R01 real control migration', () => {
  test('size_digest_mismatch executes through the fixed executor with its catalog facts', () => {
    const definition = catalog('size_digest_mismatch');
    const executor = i16ExecutionLedger();
    const record = executor.recordFor('size_digest_mismatch');
    assert.equal(record.owningTarget, definition.intendedTarget);
    assert.deepEqual([...record.expectedStableCodes], [...definition.intendedCode]);
    assert.equal(record.verificationSource, definition.primarySource);
    assert.equal(record.installEvidence, 'declared_sha256_of_different_same_size_bytes');
    const receipt = executor.receiptFor('size_digest_mismatch');
    assert.equal(receipt.stableCode, 'quarantined');
    assert.ok(definition.intendedCode.includes(receipt.stableCode));
    assert.equal(receipt.cleanupReceipt, 'confirmed_absent');
    // the migrated control plus the rest of the catalog pass the runner gate
    const controls = i16NegativeControls().map((control, index) => (
      index === 0 ? { ...control, outcome: 'quarantined' } : control
    ));
    const bundle = buildI16Evidence({
      binding: i16BindingFacts(),
      scenario: i16Scenario(),
      negativeControls: controls,
      postRunChecks: i16PostRunChecks(),
      runId: executor.runId,
      executionReceipts: executor.toEvidenceReceipts(),
    });
    const migrated = bundle.negativeControls.find((control) => control.control === 'size_digest_mismatch');
    assert.equal(migrated?.executed, true);
    assert.equal(migrated?.outcome, 'quarantined');
  });
});
