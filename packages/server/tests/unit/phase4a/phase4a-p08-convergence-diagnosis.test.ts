/**
 * P4A-P08 evidence convergence-failure diagnosis contract suite.
 *
 * A real R2 p08 evidence run failed deterministically at the `verifyToStored`
 * final re-read with a BARE `verification_not_converged:stored_private`
 * (the production verification route returned normally, the outbox row
 * completed, so the coordinator took the `quarantined` or `already_expired`
 * branch — never a retryable error). The stable line alone cannot tell the
 * operator WHICH terminal ledger state the blob/generation converged to.
 *
 * This suite pins the diagnostic contract at the report boundary:
 *   (a) the pure helper `storedPrivateConvergenceTail` derives a STABLE,
 *       LOW-SENSITIVITY colon tail from the DB facts the evidence script
 *       re-reads (`blob_records.logical_state` + `blob_generations`
 *       generation_state / quarantined_reason / retire_reason): e.g.
 *       `stored_private:expired:quarantined:digest_mismatch`. Only the fixed
 *       classification values are used — never keys, digests, URLs or
 *       credentials — and a missing reason/row omits its segment (so the
 *       bare `stored_private` tail reproduces the legacy message exactly);
 *   (b) the throwing site composes `verification_not_converged:${tail}`:
 *       `stableProbeFailureCode` classification stays `verification_not_converged`
 *       and `p08FailureDetail` still prints the COMPLETE message on the
 *       `phase4a_p08_failure_detail:` line.
 *
 * The helper is imported from the REAL evidence CLI module (same pattern as
 * `phase4a-p08-failure-detail.test.ts`); the DB re-read itself only runs on a
 * real R2/PostgreSQL evidence run, so the pure helper is the unit-tested
 * surface and the wiring is pinned by the composed-message contract.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  p08FailureDetail,
  stableProbeFailureCode,
  storedPrivateConvergenceTail,
  type P08StoredPrivateDiagnosis,
} from '../../../scripts/phase4a-p08-evidence.js';

const STABLE_CODE = 'verification_not_converged';
const DETAIL_PREFIX = 'phase4a_p08_failure_detail:';

/** The throwing-site contract: the evidence script throws
 * `verification_not_converged:<tail>` with the helper's tail appended. */
function convergedMessage(tail: string): string {
  return `${STABLE_CODE}:${tail}`;
}

/** Asserts the full diagnosis contract for one message built from facts. */
function assertDiagnosisContract(
  diagnosis: P08StoredPrivateDiagnosis,
  expectedTail: string,
): void {
  const tail = storedPrivateConvergenceTail(diagnosis);
  assert.equal(tail, expectedTail, `tail of ${JSON.stringify(diagnosis)}`);
  const message = convergedMessage(tail);
  assert.equal(
    stableProbeFailureCode(new Error(message)),
    STABLE_CODE,
    `the stable classification of ${message} must stay verification_not_converged`,
  );
  assert.equal(
    p08FailureDetail(new Error(message)),
    message,
    `the report boundary must print the complete message of ${message}`,
  );
  assert.equal(
    `${DETAIL_PREFIX}${p08FailureDetail(new Error(message))}`,
    `phase4a_p08_failure_detail:${message}`,
    `the CLI detail line of ${message} must carry the whole diagnosis tail`,
  );
  assert.doesNotMatch(
    `${DETAIL_PREFIX}${p08FailureDetail(new Error(message))}`,
    /\b(?:null|undefined)\b/u,
    'the detail line must never carry null/undefined tokens',
  );
}

test('the quarantine diagnosis tail composes blob + generation + reason facts', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: 'expired',
      generationState: 'quarantined',
      quarantinedReason: 'digest_mismatch',
      retireReason: null,
    },
    'stored_private:expired:quarantined:digest_mismatch',
  );
});

test('the expiry diagnosis tail carries the orphaned generation and its retire reason', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: 'expired',
      generationState: 'orphaned',
      quarantinedReason: null,
      retireReason: 'expired',
    },
    'stored_private:expired:orphaned:expired',
  );
});

test('a retired generation with a replacement reason keeps its own tail', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: 'verifying',
      generationState: 'retired',
      quarantinedReason: null,
      retireReason: 'replaced',
    },
    'stored_private:verifying:retired:replaced',
  );
});

test('every production quarantine reason classifies through the same tail shape', () => {
  const quarantineReasons = [
    'digest_mismatch', 'etag_mismatch', 'size_mismatch', 'media_mismatch',
    'oversize', 'truncated', 'extra_trailing_bytes',
    'object_missing_after_attestation', 'etag_mismatch_after_attestation',
  ] as const;
  for (const reason of quarantineReasons) {
    assertDiagnosisContract(
      {
        blobLogicalState: 'expired',
        generationState: 'quarantined',
        quarantinedReason: reason,
        retireReason: null,
      },
      `stored_private:expired:quarantined:${reason}`,
    );
  }
});

test('a missing quarantine reason omits the reason segment (state stays)', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: 'expired',
      generationState: 'quarantined',
      quarantinedReason: null,
      retireReason: null,
    },
    'stored_private:expired:quarantined',
  );
});

test('a missing generation row omits every generation segment', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: 'expired',
      generationState: null,
      quarantinedReason: null,
      retireReason: null,
    },
    'stored_private:expired',
  );
});

test('empty strings are treated as missing facts and never produce segments', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: '',
      generationState: '  ',
      quarantinedReason: '',
      retireReason: '',
    },
    'stored_private',
  );
});

test('no DB facts reproduce the legacy bare message byte-identically', () => {
  assertDiagnosisContract({}, 'stored_private');
  assert.equal(
    convergedMessage(storedPrivateConvergenceTail({})),
    'verification_not_converged:stored_private',
    'the legacy message must stay byte-identical when the diagnosis finds nothing',
  );
  assert.equal(
    stableProbeFailureCode(new Error('verification_not_converged:stored_private')),
    STABLE_CODE,
  );
  assert.equal(
    p08FailureDetail(new Error('verification_not_converged:stored_private')),
    'verification_not_converged:stored_private',
  );
});

test('the composed message keeps every pre-existing verifyToStored sub-detail intact', () => {
  const variants = [
    'verification_not_converged:claim_missing',
    'verification_not_converged:wrong_event',
    'verification_not_converged:outbox_complete',
    'verification_not_converged:verified_facts',
  ] as const;
  for (const message of variants) {
    assert.equal(stableProbeFailureCode(new Error(message)), STABLE_CODE, `stable code of ${message}`);
    assert.equal(p08FailureDetail(new Error(message)), message, `detail of ${message}`);
  }
});

test('reason values are trimmed and newline/whitespace-collapsed (line-oriented detail)', () => {
  assertDiagnosisContract(
    {
      blobLogicalState: 'expired',
      generationState: 'quarantined',
      quarantinedReason: '  digest_mismatch  ',
      retireReason: null,
    },
    'stored_private:expired:quarantined:digest_mismatch',
  );
  assertDiagnosisContract(
    {
      blobLogicalState: 'expired',
      generationState: 'quarantined',
      quarantinedReason: 'digest_mismatch\nprovider body detail',
      retireReason: null,
    },
    'stored_private:expired:quarantined:digest_mismatch provider body detail',
  );
});

test('the tail is a deterministic pure function of the classification facts', () => {
  const diagnosis: P08StoredPrivateDiagnosis = {
    blobLogicalState: 'expired',
    generationState: 'quarantined',
    quarantinedReason: 'digest_mismatch',
    retireReason: null,
  };
  const first = storedPrivateConvergenceTail(diagnosis);
  const second = storedPrivateConvergenceTail({ ...diagnosis });
  assert.equal(first, second);
  assert.equal(first, 'stored_private:expired:quarantined:digest_mismatch');
});

test('the tail contains ONLY colon-joined classification segments (no key/digest/url/credential shapes)', () => {
  const tail = storedPrivateConvergenceTail({
    blobLogicalState: 'expired',
    generationState: 'quarantined',
    quarantinedReason: 'digest_mismatch',
    retireReason: null,
  });
  assert.match(tail, /^[a-z0-9_]+(?::[a-z0-9_ ]+)*$/u, 'segments must be classification identifiers');
  assert.doesNotMatch(tail, /[A-Z]{4,}/u, 'no credential-shaped tokens (AKIA/SECRET style) may appear');
  assert.doesNotMatch(tail, /^[a-f0-9]{64}$/u, 'a full digest value may never appear');
  assert.doesNotMatch(tail, /:\/\//u, 'no URL may appear');
});
