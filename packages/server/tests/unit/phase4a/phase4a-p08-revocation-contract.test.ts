/**
 * P4A-P08 evidence revocation-scenario contract suite.
 *
 * A real-R2 p08 evidence run failed deterministically at the revocation
 * scenario with a bare `probe_retire_failed` (the 4th run, after the P07
 * retire semantics landed): the evidence script retired a `stored_private`
 * blob directly, while the production retire command requires an
 * `attached_private` Attachment (finalize first). The P07 retire suite pins
 * `stored_private` -> retire as the stable 409 `attachment_state_conflict`
 * (phase4a-p07-retire-cleanup-postgres.integration.test.ts), and the P08
 * download suite's revocation test performs finalize -> retire
 * (phase4a-p08-download-http-postgres.integration.test.ts). The evidence
 * script missed the finalize step.
 *
 * This suite pins the fix at BOTH levels (static-source-pin pattern of
 * tests/unit/phase4a/phase4a-p08-media-declaration.test.ts):
 *   (a) the revocation scenario's exported step contract
 *       `P08_REVOCATION_SCENARIO_STEPS` fixes the ORDER — the
 *       `finalize_attached_private` step MUST precede the download admission
 *       AND the retire command — plus the finalize request shape
 *       `P08_REVOCATION_FINALIZE_REQUEST` (POST /{blobId}/finalize with the
 *       mutation headers and an empty contract body, expected 200);
 *   (b) the failure-detail contract: a non-200 finalize/retire throws
 *       `probe_finalize_failed:<status>[:<problemCode>]` /
 *       `probe_retire_failed:<status>[:<problemCode>]` (the exact real-run
 *       regression tail is `probe_retire_failed:409:attachment_state_conflict`)
 *       while `stableProbeFailureCode` keeps classifying the message with the
 *       UNCHANGED stable prefix (it truncates at the first `:`), and
 *       `attachmentProblemCode` extracts the Problem code from the production
 *       error body (fail-closed `undefined` on non-JSON).
 *
 * Everything is asserted against the REAL evidence CLI module; no copy of
 * the scenario exists in the test.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  P08_REVOCATION_FINALIZE_REQUEST,
  P08_REVOCATION_SCENARIO_STEPS,
  attachmentProblemCode,
  p08FailureDetail,
  probeMutationFailureMessage,
  stableProbeFailureCode,
} from '../../../scripts/phase4a-p08-evidence.js';

test('the revocation scenario steps are pinned: finalize MUST precede the download admission and the retire command', () => {
  assert.deepEqual(
    [...P08_REVOCATION_SCENARIO_STEPS],
    [
      'upload_verify_stored_private',
      'finalize_attached_private',
      'download_admission',
      'retire',
      'revoked_delivery_zero_body',
      'revoked_admission_concealed_404',
    ],
    'the revocation step set/order is the production lifecycle contract: upload converges to '
      + 'stored_private, finalize makes it attached_private, THEN admission is minted and retire '
      + 'is legal (stored_private retire is the 409 attachment_state_conflict regression)',
  );

  const finalizeIndex = P08_REVOCATION_SCENARIO_STEPS.indexOf('finalize_attached_private');
  assert.ok(finalizeIndex > P08_REVOCATION_SCENARIO_STEPS.indexOf('upload_verify_stored_private'),
    'finalize must come after the upload converged to stored_private');
  assert.ok(finalizeIndex < P08_REVOCATION_SCENARIO_STEPS.indexOf('download_admission'),
    'finalize must come BEFORE the download admission — a stored_private blob must never be admitted '
      + 'into the revocation scenario');
  assert.ok(finalizeIndex < P08_REVOCATION_SCENARIO_STEPS.indexOf('retire'),
    'finalize must come BEFORE the retire command — the P07 retire route rejects a not-finalized '
      + 'stored_private blob with 409 attachment_state_conflict');
});

test('the finalize request shape is the production route contract (POST /{blobId}/finalize + mutation headers + empty contract body)', () => {
  // The exact request shape the P06/P07 integration suites drive through the
  // production route: POST /api/v1/attachments/{blobId}/finalize with the
  // mutation headers (session cookie + Origin + CSRF + Known-Command-Id) and
  // an empty JSON contract body; stored_private -> 200 finalized.
  assert.equal(P08_REVOCATION_FINALIZE_REQUEST.method, 'POST');
  assert.equal(P08_REVOCATION_FINALIZE_REQUEST.path, '/api/v1/attachments/{blobId}/finalize');
  assert.equal(P08_REVOCATION_FINALIZE_REQUEST.payload, '{}');
  assert.equal(P08_REVOCATION_FINALIZE_REQUEST.expectedStatus, 200);
});

test('a non-200 retire throws probe_retire_failed with the HTTP status and Problem-code tail; the stable classification is unchanged', () => {
  // The exact real-run regression: retiring a not-finalized stored_private
  // blob answers 409 attachment_state_conflict. The throw must surface the
  // status + Problem tail at the report boundary while the machine-contract
  // line stays byte-identical (stable code = prefix only).
  const regression = new Error(probeMutationFailureMessage('probe_retire_failed', 409, 'attachment_state_conflict'));
  assert.equal(
    regression.message,
    'probe_retire_failed:409:attachment_state_conflict',
    'the stored_private retire regression must carry the exact status+Problem tail',
  );
  assert.equal(
    stableProbeFailureCode(regression),
    'probe_retire_failed',
    'the stable prefix classification must stay probe_retire_failed (tail dropped at the first colon)',
  );
  assert.equal(
    p08FailureDetail(regression),
    'probe_retire_failed:409:attachment_state_conflict',
    'the CLI detail line must print the complete status+Problem tail',
  );
});

test('a non-200 finalize throws probe_finalize_failed with the same status+Problem tail and stays stable-classified', () => {
  const error = new Error(probeMutationFailureMessage('probe_finalize_failed', 409, 'attachment_state_conflict'));
  assert.equal(error.message, 'probe_finalize_failed:409:attachment_state_conflict');
  assert.equal(stableProbeFailureCode(error), 'probe_finalize_failed');
  assert.equal(p08FailureDetail(error), 'probe_finalize_failed:409:attachment_state_conflict');
  assert.equal(
    probeMutationFailureMessage('probe_finalize_failed', 422, 'invalid_document'),
    'probe_finalize_failed:422:invalid_document',
  );
});

test('a non-Problem route body still carries the HTTP status tail (fail-closed, never a bare prefix)', () => {
  // When the error body is not a JSON Problem (or carries no code), the
  // message degrades to the status-only tail — the pre-fix bare
  // `probe_retire_failed` is never emitted again.
  for (const statusCode of [409, 422, 500]) {
    const message = probeMutationFailureMessage('probe_retire_failed', statusCode);
    assert.equal(message, `probe_retire_failed:${statusCode}`, 'the status tail must always be present');
    assert.equal(stableProbeFailureCode(new Error(message)), 'probe_retire_failed');
    assert.equal(p08FailureDetail(new Error(message)), message);
  }
  assert.notEqual(probeMutationFailureMessage('probe_retire_failed', 409), 'probe_retire_failed');
});

test('attachmentProblemCode extracts the stable Problem code from the production error body and fails closed on non-JSON', () => {
  assert.equal(
    attachmentProblemCode(JSON.stringify({ error: { code: 'attachment_state_conflict', message: 'state conflict' } })),
    'attachment_state_conflict',
    'the production 409 Problem body must yield its stable code',
  );
  assert.equal(
    attachmentProblemCode(JSON.stringify({ error: { code: 'resource_not_found' } })),
    'resource_not_found',
  );
  assert.equal(attachmentProblemCode('not json'), undefined, 'non-JSON bodies must fail closed');
  assert.equal(attachmentProblemCode(''), undefined, 'empty bodies must fail closed');
  assert.equal(attachmentProblemCode(JSON.stringify({ unrelated: true })), undefined, 'code-less bodies must fail closed');
  assert.equal(attachmentProblemCode(JSON.stringify({ error: { code: 42 } })), undefined, 'non-string codes must fail closed');
});
