/**
 * P4A-P11 control-catalog contract (plan §9 P11: "I16 24 负控目录回归（或引用
 * 等价 in-run controls——必须 in-run 执行，不得读历史 evidence）"; §4.1; §12):
 *  - the P11 artifact binds the FIXED 24-control I16 catalog — no IDs may
 *    drift, no extra IDs may appear, and every catalog entry on a sealed
 *    artifact is `executed:true` with a `pass` verdict;
 *  - each control's in-run execution carries the FIVE-tuple
 *    (corruption installed / target hit / stable code / executed / cleanup)
 *    through the I16 executor state machine: a receipt can only be produced
 *    after install evidence, a target hit, a catalog-expected stable code
 *    and a cleanup receipt — `executed:true` can never be self-declared;
 *  - forbidden verification sources (mock/fixture/skip/stub/in-memory
 *    fallback) can never enter an executed control;
 *  - the P11 regression phase requires 24/24 executed + the sealed
 *    sub-run receipts digest in the artifact.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  I16_NEGATIVE_CONTROL_CATALOG,
  I16_NEGATIVE_CONTROL_IDS,
  I16NegativeControlExecutor,
  I16_FORBIDDEN_SOURCES,
  I16_VERIFICATION_SOURCES,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import { assertP11EvidenceShape } from '../../../scripts/phase4a-owner-private-evidence.js';
import { p11FixtureBundle, p11SealedBundle } from '../../support/phase4a-p11-evidence-fixture.js';

test('the P11 artifact binds exactly the fixed 24-control I16 catalog', () => {
  const fixture = p11FixtureBundle();
  const catalog = fixture.binding.negativeControlCatalog;
  assert.equal(catalog.length, 24);
  const ids = catalog.map((entry) => entry.control);
  assert.deepEqual(ids, [...I16_NEGATIVE_CONTROL_IDS], 'catalog IDs must match the I16 fixed order');
  assert.equal(new Set(ids).size, 24, 'catalog IDs must be unique');
  // Every entry on a sealed artifact is executed with a pass verdict.
  for (const entry of catalog) {
    assert.equal(entry.verdict, 'pass');
    assert.equal(entry.executed, true);
  }
  // The schema rejects an unexecuted catalog entry.
  const unexecuted = p11SealedBundle({
    binding: {
      ...p11FixtureBundle().binding,
      negativeControlCatalog: p11FixtureBundle().binding.negativeControlCatalog.map((entry, index) =>
        (index === 0 ? { ...entry, executed: false } : entry)),
    },
  });
  assert.throws(() => assertP11EvidenceShape(unexecuted), /evidence_schema:negative_control_not_executed/u);
  // The schema rejects a catalog with fewer than 24 entries.
  const truncated = p11SealedBundle({
    binding: {
      ...p11FixtureBundle().binding,
      negativeControlCatalog: p11FixtureBundle().binding.negativeControlCatalog.slice(0, 23),
    },
  });
  assert.throws(() => assertP11EvidenceShape(truncated), /evidence_schema:negative_control_catalog_count/u);
});

test('every catalog entry fixes exactly ONE broken item with its owning target and stable codes', () => {
  for (const definition of I16_NEGATIVE_CONTROL_CATALOG) {
    assert.ok(definition.breaks.length > 0, `${definition.control} must fix its broken item`);
    assert.ok(definition.intendedCode.length > 0, `${definition.control} must fix its stable codes`);
    assert.ok(definition.intendedTarget.length > 0, `${definition.control} must fix its owning target`);
    assert.ok(I16_VERIFICATION_SOURCES.includes(definition.primarySource),
      `${definition.control} primary source must be a real verification source`);
    assert.ok(!(I16_FORBIDDEN_SOURCES as readonly string[]).includes(definition.primarySource),
      `${definition.control} primary source must not be a forbidden source`);
  }
});

test('the five-tuple state machine gates executed:true (corruption installed / target hit / stable code / cleanup)', () => {
  const definition = I16_NEGATIVE_CONTROL_CATALOG[0]!;
  const runId = randomUUID();
  const executor = new I16NegativeControlExecutor(runId);
  const options = {
    control: definition.control,
    installPoint: 'temporary boundary',
    owningTarget: definition.intendedTarget,
    verificationSource: 'real-r2-postgres' as const,
  };

  // A receipt requires the FULL five-tuple in order.
  executor.begin(options);
  assert.throws(() => executor.complete(definition.control), /negative_control_install_missing/u);
  executor.recordInstall(definition.control, 'corruption-installed');
  assert.throws(() => executor.complete(definition.control), /negative_control_target_not_hit/u);
  assert.throws(() => executor.recordStableCode(definition.control, definition.intendedCode[0]!),
    /negative_control_target_not_hit/u);
  executor.recordTargetHit(definition.control);
  executor.recordStableCode(definition.control, definition.intendedCode[0]!);
  assert.throws(() => executor.complete(definition.control), /negative_control_cleanup_missing/u);
  executor.recordCleanupReceipt(definition.control, 'confirmed_absent');
  const receipt = executor.complete(definition.control);
  assert.equal(receipt.control, definition.control);
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.exitClass, 'clean');
  assert.equal(receipt.stableCode, definition.intendedCode[0]);
  assert.match(receipt.executionDigest, /^[a-f0-9]{64}$/u);
  // The catalog completeness gate requires EVERY control's receipt.
  assert.throws(() => executor.assertCatalogComplete(), /negative_control_missing/u);

  // Wrong owning target / wrong stable code / forbidden source are rejected.
  const wrongTarget = new I16NegativeControlExecutor(runId);
  assert.throws(() => wrongTarget.begin({ ...options, owningTarget: 'some-other-target' }),
    /negative_control_target_mismatch/u);
  const wrongCode = new I16NegativeControlExecutor(runId);
  wrongCode.begin(options);
  wrongCode.recordInstall(definition.control, 'corruption-installed');
  wrongCode.recordTargetHit(definition.control);
  assert.throws(() => wrongCode.recordStableCode(definition.control, 'wrong-code'),
    /negative_control_wrong_stable_code/u);
  const forbidden = new I16NegativeControlExecutor(runId);
  assert.throws(() => forbidden.begin({ ...options, verificationSource: 'mock' as never }),
    /negative_control_forbidden_source/u);
});

test('a subprocess failure or cross-run receipt can never seal a control', () => {
  const definition = I16_NEGATIVE_CONTROL_CATALOG[1]!;
  const executor = new I16NegativeControlExecutor('run-one');
  executor.begin({
    control: definition.control,
    installPoint: 'temporary boundary',
    owningTarget: definition.intendedTarget,
    verificationSource: 'real-r2' as const,
  });
  executor.recordInstall(definition.control, 'corruption-installed');
  executor.recordTargetHit(definition.control);
  executor.recordStableCode(definition.control, definition.intendedCode[0]!);
  executor.recordCleanupReceipt(definition.control, 'absent');
  executor.recordAbnormalExit(definition.control);
  assert.throws(() => executor.complete(definition.control), /negative_control_subprocess_failed/u);

  // A receipt from another run cannot satisfy this run's catalog.
  const otherRun = new I16NegativeControlExecutor('run-two');
  const otherDefinition = I16_NEGATIVE_CONTROL_CATALOG[2]!;
  otherRun.begin({
    control: otherDefinition.control,
    installPoint: 'temporary boundary',
    owningTarget: otherDefinition.intendedTarget,
    verificationSource: 'real-r2' as const,
  });
  otherRun.recordInstall(otherDefinition.control, 'corruption-installed');
  otherRun.recordTargetHit(otherDefinition.control);
  otherRun.recordStableCode(otherDefinition.control, otherDefinition.intendedCode[0]!);
  otherRun.recordCleanupReceipt(otherDefinition.control, 'absent');
  otherRun.complete(otherDefinition.control);
  const thisRun = new I16NegativeControlExecutor('run-one');
  // The I16 executor's pinned contract (R01): a control that was never
  // started in this run fails as `negative_control_not_started`; one that
  // was started but never completed fails as `negative_control_not_executed`.
  // Either way a receipt from another run can never satisfy this run.
  assert.throws(() => thisRun.assertExecutedInRun(otherDefinition.control),
    /negative_control_not_(started|executed)/u);
});
