import type { AutomationExport, RuleDefinition, Rule } from '@know-n/colp/automation';
import { AUTOMATION_CONTRACT_VERSION } from '@know-n/colp/automation';
export function buildAutomationExport(rows: readonly { definition: RuleDefinition; desiredState: Rule['desiredState']; bindingsByPath: Record<string, string> }[], now: Date): AutomationExport {
  if (rows.length > 500) throw new RangeError('Automation export exceeds 500 rules.');
  return { contractVersion: AUTOMATION_CONTRACT_VERSION, exportedAt: now.toISOString(), rules: rows.map((row) => {
    const { collectionId: _collection, ...scope } = row.definition.scope;
    const { targetIds: _targets, ...route } = row.definition.route;
    return { rule: { ...row.definition, scope: { ...scope, collectionSlot: 'collection' }, route: { ...route, targetSlots: [] } },
      desiredState: row.desiredState, bindingsByPath: row.bindingsByPath };
  }) };
}
