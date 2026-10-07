/**
 * P4A-I16 contract suite: negative-control catalog definitions.
 *
 * The catalog is the full fixed list of real negative controls. Every entry
 * must:
 *  - be unique and exactly once;
 *  - break exactly ONE item at a temporary source/config/credential/target
 *    boundary (`breaks`);
 *  - name the stable code(s) the broken item must hit (`intendedCode`);
 *  - name the stable production code/port it must exercise (`intendedTarget`);
 *  - carry a primary verification source from the fixed allowlist.
 * `assertCompleteNegativeControls` enforces completeness, uniqueness,
 * pass-only verdicts, and rejects any mock/skip/fixture source so a weakened
 * catalog can never be recorded as accepted evidence.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  I16_FORBIDDEN_SOURCES,
  I16_NEGATIVE_CONTROL_CATALOG,
  I16_NEGATIVE_CONTROL_IDS,
  I16_VERIFICATION_SOURCES,
  assertCompleteNegativeControls,
  type I16NegativeControlId,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import { i16ExecutionEvidence, i16NegativeControls } from '../../support/phase4a-i16-test-helpers.js';

describe('P4A-I16 negative-control catalog', () => {
  test('the catalog contains every required control exactly once', () => {
    const ids = I16_NEGATIVE_CONTROL_CATALOG.map((entry) => entry.control);
    assert.equal(new Set(ids).size, ids.length, 'control ids must be unique');
    assert.deepEqual(new Set(ids), new Set(I16_NEGATIVE_CONTROL_IDS));
    for (const required of [
      'size_digest_mismatch', 'polyglot_content', 'oversize_object',
      'duplicate_grant', 'expired_grant', 'tampered_grant', 'concurrent_writer',
      'ro_rw_permissions', 'provider_throttle_timeout', 'verification_lease_steal',
      'db_commit_unknown', 'provider_commit_unknown', 'replacement_cleanup_finalize_races',
      'late_upload', 'candidate_corruption', 'delete_unknown',
      'api_worker_origin_restart', 'credential_revocation', 'secret_marker',
      'wrong_migration', 'missing_migration', 'missing_i01_capability',
      'projection_negatives', 'residual_prefix',
    ] as const) {
      assert.ok(ids.includes(required), `catalog must include ${required}`);
    }
  });

  test('every catalog entry is well-formed and one-break', () => {
    const boundaries = /(source|config|credential|target)/i;
    for (const entry of I16_NEGATIVE_CONTROL_CATALOG) {
      assert.ok(entry.breaks.trim().length > 10, `${entry.control}.breaks must describe the broken item`);
      assert.ok(boundaries.test(entry.breaks), `${entry.control}.breaks must name a temporary boundary`);
      assert.ok(entry.intendedCode.length > 0, `${entry.control}.intendedCode must not be empty`);
      assert.ok(entry.intendedTarget.trim().length > 0, `${entry.control}.intendedTarget must name stable code`);
      assert.ok(I16_VERIFICATION_SOURCES.includes(entry.primarySource),
        `${entry.control}.primarySource must be an allowed source`);
      assert.ok(!I16_FORBIDDEN_SOURCES.includes(entry.primarySource as never),
        `${entry.control}.primarySource must not be forbidden`);
    }
  });

  test('each control has a distinct intended stable-code mapping', () => {
    const byControl = new Map<I16NegativeControlId, string>();
    for (const entry of I16_NEGATIVE_CONTROL_CATALOG) {
      byControl.set(entry.control, entry.intendedTarget);
    }
    assert.equal(byControl.size, I16_NEGATIVE_CONTROL_CATALOG.length);
    for (const [control, target] of byControl) {
      assert.ok(target.length > 0, `${control} must map to stable code`);
    }
  });

  test('assertCompleteNegativeControls accepts the full pass catalog', () => {
    assert.doesNotThrow(() => assertCompleteNegativeControls(i16NegativeControls(), i16ExecutionEvidence()));
  });

  test('assertCompleteNegativeControls rejects missing/duplicate/failed/forbidden-source records', () => {
    const all = i16NegativeControls();
    assert.throws(() => assertCompleteNegativeControls(all.slice(1), i16ExecutionEvidence()), /negative_control_missing/);
    assert.throws(() => assertCompleteNegativeControls([all[0]!, ...all], i16ExecutionEvidence()), /negative_control_duplicate/);
    assert.throws(
      () => assertCompleteNegativeControls(all.map((c, i) => (i === 0 ? { ...c, verdict: 'fail' as const } : c)), i16ExecutionEvidence()),
      /negative_control_failed/,
    );
    assert.throws(
      () => assertCompleteNegativeControls(all.map((c, i) => (
        i === 0 ? { ...c, verificationSource: 'skip' as never } : c
      )), i16ExecutionEvidence()),
      /negative_control_forbidden_source/,
    );
    assert.throws(
      () => assertCompleteNegativeControls(all.map((c, i) => (
        i === 0 ? { ...c, executed: false } : c
      )), i16ExecutionEvidence()),
      /negative_control_not_executed/,
    );
  });

  test('every catalog entry is recorded in a fixture evidence bundle', () => {
    const controls = i16NegativeControls();
    const ids = new Set(controls.map((control) => control.control));
    assert.equal(ids.size, I16_NEGATIVE_CONTROL_CATALOG.length);
    for (const control of controls) {
      assert.ok(I16_VERIFICATION_SOURCES.includes(control.verificationSource));
      assert.equal(control.verdict, 'pass');
      assert.equal(control.executed, true);
    }
  });
});
