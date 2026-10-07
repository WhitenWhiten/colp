/**
 * P4A-I12 fixture: the ONLY approved future-consumer dependency shape.
 *
 * A future shared consumer may depend on exactly the exposure-eligibility
 * gate exported from the attachments facade. The architecture scan must report
 * this as an approved dependency (no violation) so the rule is not so wide it
 * blocks a legitimate policy dependency (anti-false-negative).
 */
import { assessSharedExposureEligibility, type SharedExposureBlobFacts } from '../../../src/modules/attachments/index.js';

export function approvedEligibilityConsumer(facts: SharedExposureBlobFacts): boolean {
  const verdict = assessSharedExposureEligibility(facts);
  if (verdict.eligible) return true;
  return false;
}
