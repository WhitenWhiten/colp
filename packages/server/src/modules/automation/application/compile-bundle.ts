import { automationDigest, normalizeRuleDefinition, ruleSemanticDigest, validateAutomation,
  type RuleDefinition, type RuleBundle, type RoleBindings, type CompiledRule } from '@know-n/colp/automation';
import { assertM1Input } from './rule-service.js';
import { AutomationError } from '../domain/errors.js';
export interface BundleRule { ruleId: string; ruleRevision: string; bindingRevision: string; definition: RuleDefinition; values: RoleBindings }
export function compileBundle(input: { revision: string; settingsRevision: number; paused: boolean; now: Date;
  rules: readonly BundleRule[]; previousRuleIds: readonly string[]; profile: string }): RuleBundle {
  if (input.profile !== 'browser-bounded-v1') throw new AutomationError('automation_unsupported_capability', 'Unsupported browser profile.');
  if (input.rules.length > 1000 || !Number.isSafeInteger(input.settingsRevision)) throw new AutomationError('payload_too_large', 'Bundle exceeds supported bounds.');
  const rules: CompiledRule[] = input.paused ? [] : input.rules.map(rule => {
    assertM1Input({ definition: rule.definition, bindingSetId: 'bundle' });
    const definition = normalizeRuleDefinition(rule.definition), match = definition.match;
    const host = match.kind === 'field' && match.field === 'bookmark.url.host' && ['eq','hostSuffix'].includes(match.op) && typeof match.value === 'string';
    return { ruleId: rule.ruleId, ruleRevision: rule.ruleRevision, bindingRevision: rule.bindingRevision,
      definition, programId: host ? 'hostRoute' : 'fieldFilter', parameters: host
        ? { host: match.value as string, includeSubdomains: match.op === 'hostSuffix', ...(definition.intake ? { folderRole: definition.intake.folderRole } : {}) } : {},
      nativeBindingHints: structuredClone(rule.values), semanticDigest: ruleSemanticDigest(definition) };
  });
  const active = new Set(rules.map(rule => rule.ruleId));
  const content = { revision: input.revision, profile: 'browser-bounded-v1' as const, rules,
    paused: input.paused, settingsRevision: input.settingsRevision, issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 7 * 24 * 60 * 60_000).toISOString(), removedRuleIds: input.previousRuleIds.filter(id => !active.has(id)) };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 1_048_576) throw new AutomationError('payload_too_large', 'Full bundle exceeds 1 MiB; no partial snapshot was issued.');
  let digest: string;
  try { digest = automationDigest(content); }
  catch { throw new AutomationError('payload_too_large', 'Full bundle exceeds structural bounds; no partial snapshot was issued.'); }
  const bundle = { ...content, digest };
  if (!validateAutomation('RuleBundle', bundle).valid) throw new AutomationError('automation_unsupported_capability', 'Compiled bundle does not satisfy the bounded profile.');
  return bundle;
}
