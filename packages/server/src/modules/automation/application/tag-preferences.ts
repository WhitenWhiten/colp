import { AutomationError } from '../domain/errors.js';
import { scopeCollectionId, type AutomationActor } from '../domain/bindings.js';
import { nextRevision, type AutomationPorts } from './ports.js';
import { parseContract, requireBinding, requireEtag, requireRule } from './rule-service.js';

export async function authorizeTagPreference(ports: AutomationPorts, actor: AutomationActor, ruleId: string) {
  const rule = await requireRule(ports, actor, ruleId);
  const binding = await requireBinding(ports, actor, rule.view.bindingSetId);
  const collectionId = scopeCollectionId(rule.view.definition, binding.values);
  const collection = collectionId ? await ports.reads.readCollection(actor, collectionId) : null;
  if (!collection?.currentOwner) throw new AutomationError('resource_not_found', 'Current Owner tag preferences are unavailable.');
  return rule;
}

export async function setTagPreference(ports: AutomationPorts, actor: AutomationActor, ruleId: string,
  key: string, rejected: boolean, body: unknown, ifMatch: string) {
  parseContract('CommandReason', body);
  const rule = await authorizeTagPreference(ports, actor, ruleId);
  requireEtag(rule.view.revision, ifMatch);
  if (!ports.tagPreferences) throw new AutomationError('automation_unsupported_capability', 'Tag preferences unavailable.');
  const tag = key.normalize('NFC');
  if (await ports.tagPreferences.set(ruleId, tag, rejected)) {
    rule.view = { ...rule.view, revision: nextRevision(rule.view.revision), updatedAt: (await ports.now()).toISOString() };
    await ports.rules.setState(actor.accountId, rule);
  }
  return { revision: rule.view.revision, receipt: {
    id: ports.id(), status: 'completed', resourceId: ruleId, diagnostics: [],
  } };
}
