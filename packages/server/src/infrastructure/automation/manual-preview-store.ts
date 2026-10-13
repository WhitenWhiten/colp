import { boundManualSnapshot } from './manual-snapshot.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest, compilePredicate, type EventFacts, type RunOnceInput, type RunOncePreview, type RuleDefinition } from '@know-n/colp/automation';
import { AutomationError, parseContract, requireRule, inspectInput, evaluateRuleEvent, ruleInput, bindingResolutionSignature, type AutomationActor, type AutomationPorts } from '../../modules/automation/index.js';
import type { RuleEventPlan } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { readCurrentSample } from './current-state.js';
export interface ManualSnapshot {
    input: RunOnceInput;
    configurationDigest: string;
    collectionId: string;
    collectionRevision: string;
    ruleRevisionId: string;
    bindingSetId: string;
    bindingRevision: string;
    policyRevision: string | null;
    definition: RuleDefinition;
    members: {
        event: EventFacts;
        revision: string;
        plan: RuleEventPlan;
    }[];
}
export async function manualConfiguration(ports: AutomationPorts, actor: AutomationActor, ruleId: string, input: RunOnceInput) {
    const rule = await requireRule(ports, actor, ruleId), inspected = await inspectInput(ports, actor, ruleInput(rule.view));
    if (!inspected.collection.currentOwner || input.folder.collectionId !== inspected.collection.id)
        throw new AutomationError('resource_not_found', 'Current Owner selection is unavailable.');
    const folder = await ports.reads.readFolder(actor, input.folder);
    if (folder.status !== 'valid')
        throw new AutomationError('automation_binding_unavailable', 'Selection folder is unavailable.');
    const digest = automationDigest({ rule: rule.view, binding: inspected.binding, bindings: bindingResolutionSignature(inspected.resolutions), worker: inspected.worker,
        folder: folder.snapshot, input });
    return { rule, inspected, digest };
}
export async function previewManualRun(tx: DatabaseTransaction, ports: AutomationPorts, actor: AutomationActor, serverUuid: string, ruleId: string, body: unknown): Promise<RunOncePreview> {
    const input = parseContract('RunOnceInput', body), { rule, inspected, digest } = await manualConfiguration(ports, actor, ruleId, input);
    if (!ports.runtimeEnabled)
        throw new AutomationError('automation_unsupported_capability', 'Execution runtime unavailable.');
    const sample = await readCurrentSample(tx, ports.reads, serverUuid, actor, rule.view.definition, inspected.binding.values, { folderId: input.folder.nodeId, includeDescendants: input.includeDescendants, limit: 1000 });
    const predicate = compilePredicate(rule.view.definition.match);
    if (!predicate.valid)
        throw new AutomationError('automation_invalid_graph', 'Predicate unavailable.');
    const members = sample.events.map(event => {
        // Explicit one-time action reuses current-state predicates/scope, not event-trigger admission.
        const manual = { ...event, type: rule.view.definition.on, intakeDisposition: input.moveFolderedBookmarks || event.bookmark.parent?.nodeId === inspected.collection.rootNodeId ? 'userDefault' as const : 'userSelected' as const };
        const plan = evaluateRuleEvent({ ruleId, definition: rule.view.definition, resolutions: inspected.resolutions, bindings: inspected.bindingAssessment, predicate }, [], manual);
        return { event: manual, revision: sample.revisions[event.nodeId]!, plan };
    });
    const snapshot: ManualSnapshot = { input, configurationDigest: digest, collectionId: inspected.collection.id, collectionRevision: inspected.collection.contentRevision,
        ruleRevisionId: rule.definitionRevisionId, bindingSetId: rule.view.bindingSetId, bindingRevision: inspected.binding.revision,
        policyRevision: inspected.worker?.policy?.revision ?? null, definition: rule.view.definition, members };
    const matches = members.filter(m => ['matched', 'placed', 'preserved'].includes(m.plan.kind)), blocked = members.filter(m => ['blocked', 'conflict', 'missingInput', 'overridden'].includes(m.plan.kind));
    const bounded = boundManualSnapshot(snapshot);
    const now = await ports.now(), id = randomUUID(), previewDigest = bounded.digest;
    const result: RunOncePreview = { id, matchedCount: matches.length, blockedCount: blocked.length, explicitChoiceCount: members.filter(m => m.plan.kind === 'preserved').length,
        maxMembers: 1000, expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(), previewDigest, sideEffects: false,
        canStart: bounded.bounded && !sample.truncated && matches.length > 0 && !blocked.length && !(await ports.settings.get(actor.accountId)).paused
            && (input.tasks === 'none' || !snapshot.definition.tasks.length || (!!ports.workerEnabled && inspected.worker?.tasks.every(t => t.available) === true)),
        sample: members.slice(0, 20).map(m => ({ nodeId: m.event.nodeId, title: m.event.bookmark.title?.slice(0, 500) ?? '',
            decision: m.plan.kind === 'preserved' ? 'explicitChoice' : m.plan.kind === 'notMatched' ? 'notMatched' : ['matched', 'placed'].includes(m.plan.kind) ? 'matched' : 'blocked' })) };
    await sql `DELETE FROM automation_manual_previews WHERE id IN (SELECT id FROM automation_manual_previews WHERE owner_id=${actor.accountId} AND expires_at<clock_timestamp() AND run_id IS NULL LIMIT 100)`.execute(tx);
    await sql `INSERT INTO automation_manual_previews(id,owner_id,rule_id,digest,snapshot_json,result_json,expires_at)
    VALUES(${id},${actor.accountId},${ruleId},${previewDigest},${JSON.stringify(bounded.snapshot)}::jsonb,${JSON.stringify(result)}::jsonb,${result.expiresAt}::timestamptz)`.execute(tx);
    return result;
}
