/**
 * P4A-I12 fixture: a FUTURE shared consumer that bypasses the exposure
 * eligibility gate.
 *
 * This file is deliberately NOT part of the production composition (`src`).
 * It models what must be prevented: a shared consumer importing the
 * attachments facade for a non-approved symbol (`authorizeOwnerDownload` is
 * the owner-private read surface, not an eligibility dependency) together
 * with the gate. The architecture scan must report this as a violation even
 * though the gate symbol is present, because the consumer still reaches a
 * forbidden attachment surface.
 */
import {
  assessSharedExposureEligibility,
  authorizeOwnerDownload,
} from '../../../src/modules/attachments/index.js';

export function bypassingFutureConsumer(blobFacts: Parameters<typeof assessSharedExposureEligibility>[0]): boolean {
  const verdict = assessSharedExposureEligibility(blobFacts);
  // This branch is unreachable while the gate is deny-by-default; the import
  // of authorizeOwnerDownload is the violation being modeled.
  void authorizeOwnerDownload;
  return verdict.eligible;
}
