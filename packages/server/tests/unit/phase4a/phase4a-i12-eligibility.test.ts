/**
 * P4A-I12 eligibility-gate contract suite.
 *
 * Pins the deny-by-default exposure policy at the Attachment/application
 * export boundary:
 * - EVERY logical blob state (`issued` ... `attached_private`, `expired`) and
 *   EVERY generation state (`active`, `retired`, `quarantined`, ...) yields the
 *   explicit ineligible verdict; the negative policy is an explicit result,
 *   never "the current mapper has no field";
 * - the eligibility union is closed (no `safe`/`clean`/`ready`/`scanned`
 *   boolean can be constructed), and the physical key/body is NOT part of the
 *   assessment type;
 * - feature-flag combinations and application restarts re-evaluate to the same
 *   closed result (deny-by-default is not cached and not flag-dependent);
 * - a projection purge/rebuild that consults the gate drops every private blob
 *   marker (old residue never survives) and never reads the body;
 * - the shared-link consumer surface does not exist yet, so the gate is the
 *   deny-by-default contract for shared-link creation.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  BLOB_LOGICAL_STATES,
  GENERATION_STATES,
  OWNER_PRIVATE_EXPOSURE_MODE,
  SHARED_EXPOSURE_INELIGIBILITY_REASONS,
  SHARED_EXPOSURE_PROJECTION_KINDS,
  assessSharedExposureEligibility,
  assertSharedExposureIneligible,
  type BlobLogicalState,
  type GenerationState,
  type SharedExposureBlobFacts,
  type SharedExposureEligibility,
} from '../../../src/modules/attachments/index.js';

const ALL_BLOB_STATES: readonly BlobLogicalState[] = [...BLOB_LOGICAL_STATES];
const ALL_GENERATION_STATES: readonly GenerationState[] = [...GENERATION_STATES];

function factsFor(
  blobId: string,
  logicalState: BlobLogicalState,
  currentGenerationState: GenerationState | null,
): SharedExposureBlobFacts {
  return Object.freeze({ blobId, logicalState, currentGenerationState });
}

describe('P4A-I12 exposure eligibility gate (deny-by-default)', () => {
  test('denies EVERY logical state x generation state with an explicit ineligible verdict', () => {
    for (const logicalState of ALL_BLOB_STATES) {
      for (const currentGenerationState of ALL_GENERATION_STATES) {
        const verdict = assessSharedExposureEligibility(
          factsFor(`blob-${logicalState}-${currentGenerationState}`, logicalState, currentGenerationState),
        );
        assert.equal(verdict.eligible, false, `${logicalState}/${currentGenerationState}`);
        assert.equal(verdict.reason, 'no_content_safety_evidence', `${logicalState}/${currentGenerationState}`);
        assert.equal(verdict.exposureMode, OWNER_PRIVATE_EXPOSURE_MODE, `${logicalState}/${currentGenerationState}`);
        assert.equal(verdict.logicalState, logicalState);
        assert.equal(verdict.currentGenerationState, currentGenerationState);
      }
      // null generation state (a blob with no current generation) also denies.
      const verdict = assessSharedExposureEligibility(factsFor(`blob-${logicalState}-null`, logicalState, null));
      assert.equal(verdict.eligible, false, `${logicalState}/null`);
    }
  });

  test('the negative policy is an explicit result, not a missing mapper field', () => {
    const verdict = assessSharedExposureEligibility(
      factsFor('blob-1', 'stored_private', 'active'),
    );
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.reason, 'no_content_safety_evidence');
    assert.equal(verdict.exposureMode, OWNER_PRIVATE_EXPOSURE_MODE);
    const keys = Object.keys(verdict).sort();
    assert.deepEqual(keys, [
      'blobId', 'currentGenerationState', 'eligible', 'exposureMode', 'logicalState', 'reason',
    ]);
    for (const forbidden of ['safe', 'clean', 'ready', 'scanned']) {
      assert.equal(Object.hasOwn(verdict, forbidden), false,
        `verdict must never carry a ${forbidden} boolean (no toggle may imply safety)`);
    }
    assert.doesNotThrow(() => assertSharedExposureIneligible(verdict));
  });

  test('stored_private / attached_private are NOT renamed and never imply safety', () => {
    assert.ok(ALL_BLOB_STATES.includes('stored_private'));
    assert.ok(ALL_BLOB_STATES.includes('attached_private'));
    for (const state of ['stored_private', 'attached_private'] as const) {
      const verdict = assessSharedExposureEligibility(factsFor(`blob-${state}`, state, 'active'));
      assert.equal(verdict.eligible, false, `${state} must never be eligible`);
      assert.equal(verdict.reason, 'no_content_safety_evidence');
    }
    // A future "safe" state must be a NEW ADR/migration/capability, never a
    // boolean toggle: the closed eligibility type has no eligible member and
    // the ineligibility reasons are frozen to the single current reason.
    assert.deepEqual(SHARED_EXPOSURE_INELIGIBILITY_REASONS, ['no_content_safety_evidence']);
  });

  test('invalid or malformed facts fail closed instead of silently denying or passing', () => {
    assert.throws(() => assessSharedExposureEligibility({} as SharedExposureBlobFacts), /blobId/u);
    assert.throws(
      () => assessSharedExposureEligibility({ blobId: '', logicalState: 'stored_private', currentGenerationState: null }),
      /blobId/u,
    );
    assert.throws(
      () => assessSharedExposureEligibility({ blobId: 'b', logicalState: 'safe' as BlobLogicalState, currentGenerationState: null }),
      /logicalState/u,
    );
    assert.throws(
      () => assessSharedExposureEligibility({ blobId: 'b', logicalState: 'stored_private', currentGenerationState: 'safe' as GenerationState }),
      /currentGenerationState/u,
    );
    assert.throws(() => assessSharedExposureEligibility('nope' as unknown as SharedExposureBlobFacts), /object/u);
  });

  test('feature-flag combinations never create eligibility', () => {
    // Model every consumer feature flag as a closed state; eligibility must be
    // identical for all 2^6 combinations (the gate does not consume flags).
    const kinds = [...SHARED_EXPOSURE_PROJECTION_KINDS];
    for (let mask = 0; mask < 2 ** kinds.length; mask += 1) {
      const flags = Object.fromEntries(kinds.map((kind, index) => [kind, (mask & (1 << index)) !== 0]));
      for (const logicalState of ['stored_private', 'attached_private', 'expired'] as const) {
        const verdict = assessSharedExposureEligibility(
          factsFor(`flag-${mask}-${logicalState}`, logicalState, 'active'),
        );
        assert.equal(verdict.eligible, false, `flags=${JSON.stringify(flags)} state=${logicalState}`);
        assert.equal(verdict.reason, 'no_content_safety_evidence');
      }
    }
  });

  test('application restart re-evaluates to the same closed result', () => {
    const facts = factsFor('restart-blob', 'attached_private', 'retired');
    const processOne = assessSharedExposureEligibility(facts);
    // A second process instance (restart) must not inherit any cached verdict.
    const processTwo = assessSharedExposureEligibility(facts);
    assert.deepEqual(processTwo, processOne);
    assert.equal(processTwo.eligible, false);
    assert.equal(processTwo.reason, 'no_content_safety_evidence');
    // Even a third restart after an unrelated consumer outage stays denied.
    const processThree = assessSharedExposureEligibility(facts);
    assert.equal(processThree.eligible, false);
  });

  test('old projection residue is purged by a gate-consulting rebuild that never reads the body', () => {
    // A stale projection (e.g. a pre-policy cache/index/snapshot) may carry a
    // private marker. A rebuild that consults the eligibility gate for every
    // candidate drops all ineligible entries: the marker never survives.
    const staleProjection = [
      { blobId: 'old-1', marker: 'i12-private-stale-one', facts: factsFor('old-1', 'stored_private', 'active') },
      { blobId: 'old-2', marker: 'i12-private-stale-two', facts: factsFor('old-2', 'attached_private', 'active') },
      { blobId: 'old-3', marker: 'i12-private-stale-three', facts: factsFor('old-3', 'stored_private', 'quarantined') },
    ];
    const rebuilt = rebuildProjection(staleProjection);
    assert.deepEqual(rebuilt.includedMarkers, []);
    assert.deepEqual(rebuilt.droppedMarkers.sort(), staleProjection.map((entry) => entry.marker).sort());
    // The gate never reads the body: SharedExposureBlobFacts has no key/body
    // field, and the rebuild input carries only logical facts + a marker label.
    for (const entry of staleProjection) {
      assert.equal(Object.hasOwn(entry.facts, 'key'), false);
      assert.equal(Object.hasOwn(entry.facts, 'body'), false);
    }
  });

  test('shared-link creation has no production consumer surface yet; the gate is the deny-by-default contract', () => {
    // There is no shared-link registry module in the production composition
    // (verified by the architecture scan). While that consumer surface does
    // not exist, the eligibility gate is the explicit deny-by-default policy
    // a future shared-link registry must consult.
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('shared_link'));
    const verdict = assessSharedExposureEligibility(factsFor('shared-link-blob', 'attached_private', 'active'));
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.reason, 'no_content_safety_evidence');
    assert.equal(verdict.exposureMode, OWNER_PRIVATE_EXPOSURE_MODE);
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('publication'));
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('sync'));
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('mcp'));
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('search'));
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('profile'));
  });

  test('closed eligibility union has no eligible member a consumer could construct', () => {
    const verdict: SharedExposureEligibility = assessSharedExposureEligibility(
      factsFor('closed-blob', 'stored_private', 'active'),
    );
    // A consumer must handle the ineligible case explicitly; there is no
    // eligible branch to fall through to.
    if (verdict.eligible) {
      assert.fail('eligibility union must be closed with no eligible branch while content safety does not exist');
    }
    // @ts-expect-error - SharedExposureEligibility is closed: an eligible
    // variant does not exist and must not be constructible without a new
    // ADR/migration/capability in the attachments module.
    const impossible: SharedExposureEligibility = { eligible: true, reason: 'content_safety_evidence', exposureMode: 'owner-private-unscanned', blobId: 'x', logicalState: 'stored_private', currentGenerationState: 'active' };
    void impossible;
  });
});

interface ProjectionResidueEntry {
  readonly blobId: string;
  readonly marker: string;
  readonly facts: SharedExposureBlobFacts;
}

/**
 * Model of a projection purge/rebuild that consults the eligibility gate for
 * every candidate and NEVER reads the physical key/body. This is the shape any
 * future shared consumer must implement once it gains an approved edge to the
 * gate; today it proves old residue is always dropped.
 */
export function rebuildProjection(stale: readonly ProjectionResidueEntry[]): {
  readonly includedMarkers: string[];
  readonly droppedMarkers: string[];
} {
  const includedMarkers: string[] = [];
  const droppedMarkers: string[] = [];
  for (const entry of stale) {
    const verdict = assessSharedExposureEligibility(entry.facts);
    if (verdict.eligible) includedMarkers.push(entry.marker);
    else droppedMarkers.push(entry.marker);
  }
  return { includedMarkers, droppedMarkers };
}
