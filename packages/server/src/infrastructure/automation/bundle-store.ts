import { automationConfigurationEpoch } from './configuration-epoch.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { RuleBundle, BundleAckInput, OperationReceipt } from '@know-n/colp/automation';
import { AutomationError, compileBundle, resolveBindings, assessIntakeBindings, scopeCollectionId,
  type AutomationDeviceActor, type BundleRule } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createRuleStore } from './rule-store.js';
import { createBindingReadPort, createBindingStore } from './bindings.js';

export async function issueDeviceBundle(tx: DatabaseTransaction, actor: AutomationDeviceActor, serverUuid: string, profile: string): Promise<RuleBundle> {
  const previous = (await sql<{ revision: string; snapshot_json: RuleBundle | null }>`SELECT revision::text,snapshot_json FROM automation_device_bundles
    WHERE owner_id=${actor.accountId} AND device_id=${actor.deviceId} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
  const settings = await tx.selectFrom('automation_settings').select(['paused','revision']).where('owner_id', '=', actor.accountId).executeTakeFirst();
  const reads = createBindingReadPort(tx, serverUuid), bindings = createBindingStore(tx), rules: BundleRule[] = [];
  const all = await createRuleStore(tx).list(actor.accountId, null, 501);
  if (all.length > 500) throw new AutomationError('payload_too_large', 'Rule count exceeds the complete snapshot bound.');
  if (!settings?.paused) for (const rule of all.filter(row => row.view.desiredState === 'enabled')) {
    const binding = await bindings.load(actor.accountId, rule.view.bindingSetId);
    if (!binding) throw new AutomationError('automation_binding_unavailable', 'Complete bundle requires all live bindings.');
    const collectionId = scopeCollectionId(rule.view.definition, binding.values);
    const replica = await tx.selectFrom('sync_replicas').select('replica_id').where('account_id', '=', actor.accountId)
      .where('device_id', '=', actor.deviceId).where('collection_id', '=', collectionId ?? '')
      .where('status', 'in', ['active','recovery_required']).where('lease_expires_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    const collection = collectionId ? await reads.readCollection(actor, collectionId) : null;
    if (!replica || !collection?.currentOwner)
      throw new AutomationError('automation_binding_unavailable', 'A rule lacks current Owner authority or device sync scope; no partial snapshot was issued.');
    const resolutions = await resolveBindings(reads, actor, rule.view.definition, binding.values);
    if (!assessIntakeBindings(rule.view.definition, resolutions).available)
      throw new AutomationError('automation_binding_unavailable', 'A required destination is unavailable; no partial snapshot was issued.');
    rules.push({ ruleId: rule.view.id, ruleRevision: rule.definitionRevision, bindingRevision: binding.revision,
      definition: rule.view.definition, values: binding.values });
  }
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now;
  const bundle = compileBundle({ revision: String(BigInt(previous?.revision ?? '0') + 1n), settingsRevision: Number(await automationConfigurationEpoch(tx, actor.accountId)),
    paused: settings?.paused ?? false, now, rules, previousRuleIds: previous?.snapshot_json?.rules.map(rule => rule.ruleId) ?? [], profile });
  await sql`INSERT INTO automation_device_bundles(owner_id,device_id,revision,profile,digest,issued_at,expires_at,paused,settings_revision,status,snapshot_json)
    VALUES (${actor.accountId},${actor.deviceId},${bundle.revision}::bigint,${bundle.profile},${bundle.digest},${now},${new Date(bundle.expiresAt)},
      ${bundle.paused},${bundle.settingsRevision},'issued',${JSON.stringify(bundle)}::jsonb)`.execute(tx);
  return bundle;
}
export async function acknowledgeDeviceBundle(tx: DatabaseTransaction, actor: AutomationDeviceActor, input: BundleAckInput): Promise<OperationReceipt> {
  if (input.deviceId !== actor.deviceId) throw new AutomationError('insufficient_permission', 'Bundle device does not match authenticated device.');
  const changed = await sql`UPDATE automation_device_bundles SET status=${input.status} WHERE owner_id=${actor.accountId}
    AND device_id=${actor.deviceId} AND revision::text=${input.bundleRevision} AND expires_at > clock_timestamp() RETURNING revision`.execute(tx);
  if (!changed.rows.length) throw new AutomationError('automation_stale_input', 'Bundle is unavailable or expired.');
  return { id: randomUUID(), resourceId: input.bundleRevision, status: input.status === 'applied' ? 'completed' : 'blocked', diagnostics: input.diagnostics };
}
