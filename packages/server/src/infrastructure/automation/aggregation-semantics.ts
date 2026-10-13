import { ruleSemanticDigest, type RuleDefinition } from '@know-n/colp/automation';

/** Admission budgets are independent of member selection and grouping semantics. */
export function aggregationSemanticDigest(definition: RuleDefinition): string {
  return ruleSemanticDigest({ ...definition, policy: { ...definition.policy, maxRunsPerDay: 1 } });
}
