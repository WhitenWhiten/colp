import { automationDigest } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import type { AutomationActor } from '../domain/bindings.js';
import { nextRevision, ruleInput, type AutomationPorts } from './ports.js';
import { requireRule, requireEtag, parseContract, normalizeRuleInput } from './rule-service.js';
import { blocksActivation, evaluateRuleEvent } from './rule-evaluation.js';
import { previewSnapshot } from './preview-service.js';

export async function setLifecycle(ports: AutomationPorts, actor: AutomationActor, id: string, body: unknown, ifMatch: string) {
  const input = parseContract('LifecycleInput', body), stored = await requireRule(ports, actor, id);
  requireEtag(stored.view.revision, ifMatch);
  if (stored.view.desiredState === 'archived') throw new AutomationError('automation_rule_conflict', 'Archived rules cannot be reactivated.');
  if (input.state === 'enabled') {
    const preview = input.activationPreviewId ? await ports.previews.load(actor.accountId, input.activationPreviewId) : null;
    if (!preview || preview.expiresAt.getTime() <= (await ports.now()).getTime()
      || automationDigest(normalizeRuleInput(preview.input.rule)) !== automationDigest(normalizeRuleInput(ruleInput(stored.view))))
      throw new AutomationError('automation_stale_input', 'Enable requires the exact unexpired preview of this configuration.');
    const current = await previewSnapshot(ports, actor, preview.input);
    if (preview.configDigest !== current.configDigest) throw new AutomationError('automation_stale_input', 'Bindings, settings, permissions or sampled inputs changed. Preview again.');
    if (!current.bindingAssessment.available) throw new AutomationError('automation_binding_unavailable', 'Repair the required folder binding.');
    if (current.events.some((event) => blocksActivation(evaluateRuleEvent(current.proposed, current.alternatives, event))))
      throw new AutomationError('automation_rule_conflict', 'Resolve blocked or conflicting preview decisions before enable.');
    await ports.activation(stored, { kind: 'disable' });
    await ports.activation(stored, { kind: 'enable', collectionId: current.collection.id, afterOrdinal: current.collection.commitOrdinal });
  } else {
    // Fence private activation metadata even after resource permission loss.
    await ports.activation(stored, { kind: 'disable' });
  }
  const paused = (await ports.settings.get(actor.accountId)).paused;
  stored.view = { ...stored.view, desiredState: input.state, effectiveState: input.state === 'enabled' ? (paused ? 'paused' : 'blocked') : input.state,
    revision: nextRevision(stored.view.revision), updatedAt: (await ports.now()).toISOString() };
  await ports.rules.setState(actor.accountId, stored); return stored.view;
}
export async function setPause(ports: AutomationPorts, actor: AutomationActor, body: unknown, ifMatch: string) {
  const input = parseContract('PauseInput', body), previous = await ports.settings.get(actor.accountId);
  requireEtag(previous.revision, ifMatch);
  const now = (await ports.now()).toISOString();
  const settings = { ...previous, revision: nextRevision(previous.revision), paused: input.paused, pausedAt: input.paused ? now : null,
    pausedBy: input.paused ? 'owner' as const : null };
  for (const rule of await ports.rules.list(actor.accountId, null, 500)) {
    if (rule.view.desiredState !== 'enabled') continue;
    await ports.activation(rule, { kind: 'disable' });
    // This captures only the pinned source's ordinal, never grants read/effect authority.
    if (!input.paused) await ports.activation(rule, { kind: 'resume' });
  }
  await ports.settings.save(actor.accountId, settings); return settings;
}
