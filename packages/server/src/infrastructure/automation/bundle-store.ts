import { automationConfigurationEpoch } from './configuration-epoch.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateM1Rule, type RuleBundle, type BundleAckInput, type OperationReceipt } from '@know-n/colp/automation';
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
  const all = await createRuleStore(tx).listCurrent(actor.accountId);
  if (all.length > 500) throw new AutomationError('payload_too_large', 'Rule count exceeds the complete snapshot bound.');
  // Profile selection per collection, never a silently partial collection: a rule without intake has no
  // browser contribution; a collection this device does not sync is irrelevant to it; and a collection
  // with any intake rule the browser cannot evaluate exactly (tasks, unavailable destinations) is left
  // entirely to server intake, so device and server arbitration never see different competitor sets.
  const byCollection = new Map<string, { rules: BundleRule[]; delegated: boolean }>();
  if (!settings?.paused) for (const rule of all.filter(row => row.view.desiredState === 'enabled')) {
    if (!rule.view.definition.intake) continue;
    const binding = await bindings.load(actor.accountId, rule.view.bindingSetId);
    if (!binding) throw new AutomationError('automation_binding_unavailable', 'Complete bundle requires all live bindings.');
    const collectionId = scopeCollectionId(rule.view.definition, binding.values);
    if (!collectionId) continue;
    const replica = await tx.selectFrom('sync_replicas').select('replica_id').where('account_id', '=', actor.accountId)
      .where('device_id', '=', actor.deviceId).where('collection_id', '=', collectionId)
      .where('status', 'in', ['active','recovery_required']).where('lease_expires_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    const collection = await reads.readCollection(actor, collectionId);
    if (!replica || !collection?.currentOwner) continue;
    const entry = byCollection.get(collectionId) ?? { rules: [], delegated: false };
    byCollection.set(collectionId, entry);
    if (rule.view.definition.tasks.length || validateM1Rule(rule.view.definition).length) { entry.delegated = true; continue; }
    const resolutions = await resolveBindings(reads, actor, rule.view.definition, binding.values);
    if (!assessIntakeBindings(rule.view.definition, resolutions).available) { entry.delegated = true; continue; }
    entry.rules.push({ ruleId: rule.view.id, ruleRevision: rule.definitionRevision, bindingRevision: binding.revision,
      definition: rule.view.definition, values: binding.values });
  }
  for (const entry of byCollection.values()) if (!entry.delegated) rules.push(...entry.rules);
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
