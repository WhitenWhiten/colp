import { sql } from 'kysely';
import { compilePredicate, type EventFacts, type RuleBundle } from '@know-n/colp/automation';
import { resolveBindings, assessIntakeBindings, evaluateRuleEvent, scopeCollectionId,
  type PreparedRule, type AutomationDeviceActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createBindingReadPort } from './bindings.js';
/** Reuse the same scope, binding and priority arbitration as preview/server intake. */
export async function verifyReceiptPlacementDecision(tx: DatabaseTransaction, actor: AutomationDeviceActor,
  serverUuid: string, bundle: RuleBundle, ruleId: string, event: EventFacts): Promise<boolean> {
  const reads = createBindingReadPort(tx, serverUuid), prepared: PreparedRule[] = [];
  const active = (await sql<{ rule_id: string; revision: string; binding_revision: string }>`SELECT r.id AS rule_id,
    v.revision::text,b.current_revision::text AS binding_revision FROM automation_rules r
    JOIN automation_rule_revisions v ON v.id=r.current_revision_id
    JOIN automation_binding_sets b ON b.id=v.binding_set_id
    JOIN automation_activations a ON a.rule_revision_id=v.id AND a.collection_id=${actor.collectionId}
    WHERE r.owner_id=${actor.accountId} AND r.desired_state='enabled' AND a.disabled_after_ordinal IS NULL
      AND a.after_ordinal < ${event.commitOrdinal}::bigint`.execute(tx)).rows;
  for (const rule of bundle.rules) {
    if (!active.some(pin => pin.rule_id === rule.ruleId && pin.revision === rule.ruleRevision && pin.binding_revision === rule.bindingRevision)
      || scopeCollectionId(rule.definition, rule.nativeBindingHints) !== actor.collectionId) continue;
    const predicate = compilePredicate(rule.definition.match);
    if (!predicate.valid) continue;
    const resolutions = await resolveBindings(reads, actor, rule.definition, rule.nativeBindingHints);
    prepared.push({ ruleId: rule.ruleId, definition: rule.definition, predicate, resolutions,
      bindings: assessIntakeBindings(rule.definition, resolutions) });
  }
  const selected = prepared.find(rule => rule.ruleId === ruleId);
  if (!selected) return false;
  // This describes an already committed, verified placement, never permission for another move.
  return evaluateRuleEvent(selected, prepared.filter(rule => rule.ruleId !== ruleId), { ...event, intakeDisposition: 'rulePlacement' }).kind === 'placed';
}
