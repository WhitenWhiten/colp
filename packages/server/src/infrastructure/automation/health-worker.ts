import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
import type { Metrics } from '../telemetry/index.js';
import type { CollectionMutationProjectionSink, CollectionMutationDelivery } from '../outbox/index.js';
import { revalidateRule } from '../../modules/automation/index.js';
import { createAutomationUnitOfWork } from './unit-of-work.js';
import { createDependencyIndex } from './dependency-index.js';
import type { CurrentBindingVerifier } from './target-worker.js';

/** Health-only consumer on the existing durable outbox. No admission, jobs, timer, models or effects. */
export function createAutomationHealthMonitor(db: Kysely<DatabaseSchema>, serverUuid: string, metrics?: Metrics, runtimeEnabled = false,
  workerOptions: { eventsEnabled?: boolean; workerEnabled?: boolean; verifyTargetBinding?: CurrentBindingVerifier } = {}) {
  const unitOfWork = createAutomationUnitOfWork(db, serverUuid, { ...workerOptions, runtimeEnabled });
  const revalidate = async (ownerId: string, ruleId: string) => {
    const owner = await db.selectFrom('accounts').select(['id', 'subject_id', 'status']).where('id', '=', ownerId).executeTakeFirst();
    if (!owner || owner.status !== 'active') return;
    const report = await unitOfWork.execute({ accountId: owner.id, subjectId: owner.subject_id }, (ports) => revalidateRule(ports, { accountId: owner.id, subjectId: owner.subject_id }, ruleId));
    metrics?.increment('automation.health.revalidated');
    for (const reason of new Set(report.incidents.map((incident) => incident.code))) metrics?.increment(`automation.health.reason.${reason}`);
    metrics?.gauge('automation.runtime.ready', runtimeEnabled ? 1 : 0);
  };
  // Health is advisory: one rule that cannot be revalidated must not stop the others, startup or the
  // core projection it rides on. Its health is recomputed on the next relevant mutation or start.
  const revalidateIsolated = async (ownerId: string, ruleId: string) => {
    try { await revalidate(ownerId, ruleId); } catch { metrics?.increment('automation.health.error'); }
  };
  const onCollectionMutation = async (delivery: CollectionMutationDelivery) => {
    const payload = delivery.payload && typeof delivery.payload === 'object' ? delivery.payload as Record<string, unknown> : {};
    const ids = [delivery.aggregateId, payload.nodeId, payload.parentId, payload.oldParentId, payload.newParentId].filter((id): id is string => typeof id === 'string');
    const affected = await createDependencyIndex(db).affected(ids);
    if (delivery.eventType.startsWith('collection.')) {
      const collectionId = typeof payload.collectionId === 'string' ? payload.collectionId : delivery.aggregateId;
      const rows = await db.selectFrom('automation_rules as r').innerJoin('automation_rule_revisions as v', 'v.id', 'r.current_revision_id')
        .innerJoin('automation_binding_sets as b', 'b.id', 'v.binding_set_id')
        .innerJoin('automation_binding_revisions as br', (join) => join.onRef('br.binding_set_id', '=', 'b.id').onRef('br.revision', '=', 'b.current_revision'))
        .select(['r.owner_id', 'r.id']).where(sql<boolean>`coalesce(v.definition_json#>>'{scope,collectionId}',
          br.values_json->(v.definition_json#>>'{scope,folderRole}')->'folder'->>'collectionId') = ${collectionId}`).execute();
      affected.push(...rows.map((row) => ({ ownerId: row.owner_id, ruleId: row.id })));
    }
    const unique = new Map(affected.map((rule) => [rule.ruleId, rule]));
    for (const rule of unique.values()) await revalidateIsolated(rule.ownerId, rule.ruleId);
  };
  return {
    async revalidateAll() {
      let after: string | null = null;
      for (;;) {
        let query = db.selectFrom('automation_rules').select(['id', 'owner_id']).orderBy('id').limit(100);
        if (after !== null) query = query.where('id', '>', after);
        const rows = await query.execute();
        for (const row of rows) await revalidateIsolated(row.owner_id, row.id);
        if (rows.length < 100) break;
        after = rows.at(-1)!.id;
      }
    },
    onCollectionMutation,
    wrap(sink: CollectionMutationProjectionSink): CollectionMutationProjectionSink {
      return { durability: sink.durability, async apply(delivery) {
        await sink.apply(delivery);
        // A failure here would make the outbox retry the core projection that already succeeded.
        try { await onCollectionMutation(delivery); } catch { metrics?.increment('automation.health.error'); }
      } };
    },
  };
}
