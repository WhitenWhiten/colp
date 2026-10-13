import { recordDevicePlacementRun } from './device-placement-run.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest, compilePredicate, type LocalReceiptInput, type ReceiptIngestResult, type RuleBundle } from '@know-n/colp/automation';
import { AutomationError, placementInputDigest, placementResultDigest, resolveBindings, type AutomationDeviceActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createBindingReadPort } from './bindings.js';
import { sourceEvent } from './source-facts.js';
import type { AutomationSource } from './source-position-store.js';

export async function verifyIntakeReceipt(tx: DatabaseTransaction, actor: AutomationDeviceActor, serverUuid: string,
  input: LocalReceiptInput, receiptId: string): Promise<ReceiptIngestResult> {
  let rootSatisfied = false;
  const result = (state: ReceiptIngestResult['state'], message: string): ReceiptIngestResult => ({ receiptId, state,
    satisfiedTaskTypes: state === 'accepted' && rootSatisfied ? ['classify.root'] : [],
    diagnostics: [{ code: state, severity: state === 'accepted' ? 'info' : 'warning', location: '/', message }] });
  if (input.deviceId !== actor.deviceId || String(input.replicaGeneration) !== actor.replicaGeneration
    || input.committedNode.serverUuid !== serverUuid || input.committedNode.collectionId !== actor.collectionId)
    return result('rejected', 'Receipt device, generation or canonical identity does not match authenticated scope.');
  const settings = await tx.selectFrom('automation_settings').select(['paused', 'revision']).where('owner_id', '=', actor.accountId).executeTakeFirst();
  if (settings?.paused) return result('review', 'Automation is paused.');
  const bundle = (await sql<{ digest: string; snapshot_json: RuleBundle | null; expires_at: Date; paused: boolean; settings_revision: string }>`SELECT digest,snapshot_json,expires_at,paused,settings_revision::text
    FROM automation_device_bundles WHERE owner_id=${actor.accountId} AND device_id=${actor.deviceId}
      AND revision=${input.bundleRevision}::bigint`.execute(tx)).rows[0];
  if (bundle?.snapshot_json) {
    const { digest, ...content } = bundle.snapshot_json;
    if (digest !== bundle.digest || automationDigest(content) !== digest) return result('rejected', 'Bundle integrity check failed.');
  }
  const pinned = bundle?.snapshot_json?.rules.find(rule => rule.ruleId === input.ruleId && rule.ruleRevision === input.ruleRevision && rule.bindingRevision === input.bindingRevision);
  if (!pinned || bundle!.paused || bundle!.expires_at <= new Date() || String(bundle!.settings_revision) !== String(settings?.revision ?? '0')) return result('review', 'Pinned authenticated bundle is unavailable, paused or expired.');
  const rule = await tx.selectFrom('automation_rule_revisions as v').innerJoin('automation_rules as r', 'r.id', 'v.rule_id')
    .select(['v.id', 'v.definition_json', 'v.binding_set_id', 'r.desired_state', 'r.current_revision_id'])
    .where('v.rule_id', '=', input.ruleId).where('v.revision', '=', input.ruleRevision).where('r.owner_id', '=', actor.accountId).executeTakeFirst();
  if (!rule || rule.desired_state !== 'enabled' || rule.current_revision_id !== rule.id) return result('review', 'Pinned rule is no longer active.');
  rootSatisfied = rule.definition_json.intake?.satisfies.includes('classify.root') === true;
  if (input.satisfiedTaskTypes.length && !rootSatisfied)
    return result('rejected', 'Rule does not declare root satisfaction.');
  const binding = await tx.selectFrom('automation_binding_revisions as v').innerJoin('automation_binding_sets as b', 'b.id', 'v.binding_set_id')
    .select(['v.values_json', 'b.current_revision']).where('v.binding_set_id', '=', rule.binding_set_id)
    .where('v.revision', '=', input.bindingRevision).where('b.owner_id', '=', actor.accountId).executeTakeFirst();
  if (!binding || String(binding.current_revision) !== input.bindingRevision) return result('review', 'Binding revision changed.');
  async function source(operationId: string) {
    return (await sql<AutomationSource & { replica_id: string | null; lease_generation: string | null; status: string | null }>`
      SELECT f.*, f.commit_ordinal::text, s.replica_id, s.lease_generation::text, s.status
      FROM automation_event_facts f LEFT JOIN sync_sequence_receipts s ON s.operation_id=f.operation_id
      WHERE f.operation_id=${operationId}`.execute(tx)).rows[0];
  }
  const created = await source(input.operationId), placed = input.placementOperationId ? await source(input.placementOperationId) : created;
  if (!created || !placed) return result('waitingForSync', 'Waiting for both canonical Sync operations.');
  for (const record of [created, placed]) if (record.node_id !== input.committedNode.nodeId || record.replica_id !== actor.replicaId
    || record.lease_generation !== actor.replicaGeneration || !['applied', 'rebased'].includes(record.status ?? '')
    || record.origin !== 'sync' || record.facts_json?.actorPrincipalId !== actor.accountId)
    return result('rejected', 'Canonical Sync identity or operation evidence does not match.');
  if (created.facts_json?.action !== 'create' || (input.placementOperationId && (placed.facts_json?.action !== 'move'
    || BigInt(placed.commit_ordinal) <= BigInt(created.commit_ordinal)))) return result('rejected', 'Expected canonical create followed by its placement move.');
  const activation = await tx.selectFrom('automation_activations').select('after_ordinal').where('rule_revision_id', '=', rule.id)
    .where('collection_id', '=', actor.collectionId).where('disabled_after_ordinal', 'is', null).executeTakeFirst();
  if (!activation || BigInt(created.commit_ordinal) <= BigInt(activation.after_ordinal)) return result('review', 'Source precedes current activation fence.');
  const reads = createBindingReadPort(tx, serverUuid), collection = await reads.readCollection(actor, actor.collectionId);
  if (!collection) return result('rejected', 'Current collection authority is unavailable.');
  const event = sourceEvent(created, serverUuid, actor.collectionId, collection.rootNodeId);
  const evaluator = compilePredicate(rule.definition_json.match);
  const resolutions = await resolveBindings(reads, actor, rule.definition_json, binding.values_json);
  const destination = resolutions[rule.definition_json.intake?.folderRole ?? ''];
  if (!event || !evaluator.valid || evaluator.evaluate(event).outcome !== 'matched' || destination?.status !== 'valid')
    return result('review', 'Rule input or current destination cannot be verified.');
  const after = placed.facts_json!.after;
  if (!after || after.parentId !== destination.snapshot.folder.nodeId || placementInputDigest(input, created.facts_json!.after!) !== input.inputDigest
    || (input.resultDigests.length > 0 && input.resultDigests[0] !== placementResultDigest(destination.snapshot.folder)))
    return result('rejected', 'Placement or input/result digest mismatch.');
  if (input.placementOperationId && (created.facts_json!.after!.parentId !== collection.rootNodeId
    || placed.facts_json!.before?.resourceRevision !== created.facts_json!.after!.resourceRevision))
    return result('review', 'Observed correction crossed a later edit or a selected folder.');
  const current = await tx.selectFrom('nodes').select(['resource_revision', 'parent_id', 'kind', 'deleted_at'])
    .where('id', '=', input.committedNode.nodeId).where('collection_id', '=', actor.collectionId).executeTakeFirst();
  if (!current || current.deleted_at || current.kind !== 'bookmark' || current.resource_revision !== after.resourceRevision
    || current.parent_id !== after.parentId) return result('review', 'A newer canonical change prevents receipt satisfaction.');
  if (input.beforeFolder && input.placementOperationId && (input.beforeFolder.serverUuid !== serverUuid
    || input.beforeFolder.collectionId !== actor.collectionId || input.beforeFolder.nodeId !== placed.facts_json!.before?.parentId))
    return result('rejected', 'Original destination is not proven by the canonical move.');
  return result('accepted', 'Canonical placement verified; only classify.root is satisfied.');
}

export async function acceptStoredIntakeReceipt(tx: DatabaseTransaction, actor: AutomationDeviceActor, serverUuid: string,
  input: LocalReceiptInput): Promise<ReceiptIngestResult> {
  const existing = (await sql<{ id: string; receipt_json: { input: LocalReceiptInput; result: ReceiptIngestResult }; owner_id: string }>`SELECT id,receipt_json,owner_id
    FROM automation_intake_receipts WHERE device_id=${actor.deviceId} AND replica_generation=${actor.replicaGeneration}::bigint
      AND local_receipt_id=${input.localReceiptId} FOR UPDATE`.execute(tx)).rows[0];
  if (existing && (existing.owner_id !== actor.accountId || automationDigest(existing.receipt_json.input) !== automationDigest(input)))
    throw new AutomationError('automation_command_conflict', 'Receipt identity already has different immutable evidence.');
  if (existing?.receipt_json.result.state === 'accepted') return existing.receipt_json.result;
  if (!existing) {
    const count = (await sql<{ count: string }>`SELECT count(*) FROM automation_intake_receipts WHERE owner_id=${actor.accountId}
      AND state='waitingForSync'`.execute(tx)).rows[0]!.count;
    if (Number(count) >= 1000) throw new AutomationError('payload_too_large', 'Too many receipts waiting for Sync.');
  }
  const id = existing?.id ?? randomUUID();
  if (!/^\d+$/.test(input.bundleRevision) || !/^\d+$/.test(input.ruleRevision) || !/^\d+$/.test(input.bindingRevision))
    throw new AutomationError('invalid_request', 'Device revision pins must be decimal sequences.');
  for (const revision of [input.bundleRevision, input.ruleRevision, input.bindingRevision])
    if (BigInt(revision) > 9223372036854775807n) throw new AutomationError('invalid_request', 'Revision exceeds the supported sequence bound.');
  const result = await verifyIntakeReceipt(tx, actor, serverUuid, input, id);
  await sql`INSERT INTO automation_intake_receipts (id,owner_id,device_id,replica_generation,local_receipt_id,operation_id,state,receipt_json)
    VALUES (${id},${actor.accountId},${actor.deviceId},${actor.replicaGeneration}::bigint,${input.localReceiptId},${input.operationId},${result.state},
      ${JSON.stringify({ input, result, actor })}::jsonb) ON CONFLICT (device_id,replica_generation,local_receipt_id)
    DO UPDATE SET state=EXCLUDED.state,receipt_json=EXCLUDED.receipt_json`.execute(tx);
  if (result.state === 'accepted') await recordDevicePlacementRun(tx, actor, input);
  return result;
}
