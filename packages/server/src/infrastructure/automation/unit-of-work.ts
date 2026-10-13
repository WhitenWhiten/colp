import { createOwnerDeliveryStore } from './delivery-store.js';
import { createOwnerJobStore } from './owner-job-store.js';
import { readAutomationUsage } from './usage-read-store.js';
import { createTargetStore } from './target-store.js';
import { createExecutionPolicyStore } from './execution-policy-store.js';
import { touchAutomationConfiguration } from './configuration-epoch.js';
import { appendAutomationResume } from '../outbox/automation-ingest.js';
import { createPlacementUndoPort } from './placement-undo-store.js';
import { createRunStore } from './run-store.js';
import { createHealthStore } from './health-store.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PauseState, PreviewInput } from '@know-n/colp/automation';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { databaseNow } from '../database/time.js';
import { createBindingReadPort, createBindingStore } from './bindings.js';
import { createDependencyIndex } from './dependency-index.js';
import { createRuleStore } from './rule-store.js';
import { readCurrentSample } from './current-state.js';
import { exportAutomations } from './export.js';
import { AutomationError } from '../../modules/automation/index.js';
import type { AutomationUnitOfWork } from '../../modules/automation/index.js';

export function createAutomationUnitOfWork(db: Kysely<DatabaseSchema>, serverUuid: string, options: { runtimeEnabled?: boolean; workerEnabled?: boolean; verifyTargetBinding?: import('./target-worker.js').CurrentBindingVerifier } = {}): AutomationUnitOfWork {
  return { execute: (actor, work) => createUnitOfWork(db).execute(async ({ transaction: tx }) => {
    // Existing lock order: active Account -> receipts -> private configuration -> canonical reads.
    const account = await tx.selectFrom('accounts').select(['subject_id', 'status', 'deleted_at']).where('id', '=', actor.accountId).forUpdate().executeTakeFirst();
    if (!account || account.status !== 'active' || account.deleted_at || account.subject_id !== actor.subjectId)
      throw new AutomationError('resource_not_found', 'Active owner is unavailable.');
    const reads = createBindingReadPort(tx, serverUuid);
    return work({ deliveries: createOwnerDeliveryStore(tx,actor),usage: { rule: id => readAutomationUsage(tx,actor,id) },...(options.workerEnabled ? { ownerJobs: createOwnerJobStore(tx,actor,serverUuid) } : {}),workerEnabled: options.workerEnabled === true, targets: createTargetStore(tx,actor.accountId,options.verifyTargetBinding), policies: createExecutionPolicyStore(tx, actor.accountId), runtimeEnabled: options.runtimeEnabled === true, placementUndo: createPlacementUndoPort(tx, actor), runs: createRunStore(tx, actor, serverUuid), health: createHealthStore(tx), receipts: createPostgresProductCommandReceiptPort(tx), rules: createRuleStore(tx, options.runtimeEnabled), bindings: createBindingStore(tx),
      reads, dependencies: createDependencyIndex(tx), id: randomUUID, now: () => databaseNow(tx),
      sample: (owner, rule, values) => readCurrentSample(tx, reads, serverUuid, owner, rule, values), export: (ownerId) => exportAutomations(tx, ownerId),
      settings: {
        async get(ownerId): Promise<PauseState> {
          const held = await sql<{ count: string }>`select count(*)::text as count from automation_jobs j join automation_runs r on r.id=j.run_id
            where r.owner_id=${ownerId} and j.state in ('pending','ready','leased','committing','awaitingApproval')`.execute(tx);
          const heldJobs = Number(held.rows[0]?.count ?? 0);
          const row = await tx.selectFrom('automation_settings').selectAll().where('owner_id', '=', ownerId).executeTakeFirst();
          return row ? { paused: row.paused, pausedAt: row.paused_at?.toISOString() ?? null, pausedBy: row.paused_by, revision: String(row.revision), heldJobs }
            : { paused: false, pausedAt: null, pausedBy: null, revision: '0', heldJobs };
        },
        async save(ownerId, state) {
          await tx.insertInto('automation_settings').values({ owner_id: ownerId, paused: state.paused, paused_at: state.pausedAt ? new Date(state.pausedAt) : null,
            paused_by: state.pausedBy, revision: state.revision }).onConflict((oc) => oc.column('owner_id').doUpdateSet({ paused: state.paused,
              paused_at: state.pausedAt ? new Date(state.pausedAt) : null, paused_by: state.pausedBy, revision: state.revision })).execute();
          await touchAutomationConfiguration(tx, ownerId);
        },
      },
      previews: {
        async load(ownerId, id) {
          const row = await tx.selectFrom('automation_preview_records').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
          return row ? { id: row.id, configDigest: row.config_digest, input: row.snapshot_json.input as unknown as PreviewInput, result: row.result_json, expiresAt: row.expires_at } : null;
        },
        async save(ownerId, preview) {
          await sql`delete from automation_preview_records where id in (
            select id from automation_preview_records where owner_id=${ownerId} and expires_at <= current_timestamp
              order by expires_at limit 100
          )`.execute(tx);
          await tx.insertInto('automation_preview_records').values({ id: preview.id, owner_id: ownerId, config_digest: preview.configDigest,
            snapshot_json: { input: preview.input }, result_json: preview.result, expires_at: preview.expiresAt }).execute();
        },
      },
      async wakePendingRuns() {
        const rows = (await sql<{ collection_id: string }>`SELECT DISTINCT explanation_json->>'collectionId' AS collection_id
          FROM automation_runs WHERE owner_id=${actor.accountId} AND state='waiting' AND NOT held
          ORDER BY collection_id`.execute(tx)).rows;
        for (const row of rows) await appendAutomationResume(tx, row.collection_id);
      },
      async pendingRuns(revisionId, policy) {
        const resumed = await sql<{ collection_id: string }>`UPDATE automation_runs SET held=${policy === 'hold'},
          state=CASE WHEN ${policy}='cancel' THEN 'cancelled' ELSE state END,
          revision=revision+1, updated_at=clock_timestamp()
          WHERE owner_id=${actor.accountId} AND rule_revision_id IN (
            SELECT id FROM automation_rule_revisions WHERE rule_id=(
              SELECT rule_id FROM automation_rule_revisions WHERE id=${revisionId} AND owner_id=${actor.accountId}
            )
          ) AND state IN ('waiting','running') RETURNING explanation_json->>'collectionId' AS collection_id`.execute(tx);
        if (policy === 'continuePinned') for (const collectionId of [...new Set(resumed.rows.map(row => row.collection_id))].sort())
          await appendAutomationResume(tx, collectionId);
      },
      async activation(rule, transition) {
        if (transition.kind === 'disable') {
          const active = await tx.selectFrom('automation_activations').selectAll().where('rule_revision_id', '=', rule.definitionRevisionId)
            .where('disabled_after_ordinal', 'is', null).orderBy('collection_id').execute();
          for (const pin of active) {
            const canonical = await tx.selectFrom('collections').select('commit_ordinal').where('id', '=', pin.collection_id).forShare().executeTakeFirst();
            await tx.updateTable('automation_activations').set({ disabled_after_ordinal: String(canonical?.commit_ordinal ?? pin.after_ordinal) })
              .where('rule_revision_id', '=', rule.definitionRevisionId).where('collection_id', '=', pin.collection_id).where('generation', '=', pin.generation).execute();
          }
          return;
        }
        let collectionId: string, afterOrdinal: string;
        if (transition.kind === 'resume') {
          const previous = await tx.selectFrom('automation_activations').select('collection_id').where('rule_revision_id', '=', rule.definitionRevisionId)
            .orderBy('generation', 'desc').executeTakeFirst();
          if (!previous) return;
          const canonical = await tx.selectFrom('collections').select(['commit_ordinal', 'deleted_at']).where('id', '=', previous.collection_id).forShare().executeTakeFirst();
          if (!canonical || canonical.deleted_at) return;
          collectionId = previous.collection_id; afterOrdinal = String(canonical.commit_ordinal);
        } else { collectionId = transition.collectionId; afterOrdinal = transition.afterOrdinal; }
        const generations = await tx.selectFrom('automation_activations').select(sql<string>`coalesce(max(generation),0)::text`.as('generation'))
          .where('rule_revision_id', '=', rule.definitionRevisionId).executeTakeFirstOrThrow();
        const generation = (BigInt(generations.generation) + 1n).toString();
        await tx.insertInto('automation_activations').values({ rule_revision_id: rule.definitionRevisionId, collection_id: collectionId, generation,
          after_ordinal: afterOrdinal, disabled_after_ordinal: null, aggregate_epoch: generation }).execute();
      },
    });
  }) };
}
