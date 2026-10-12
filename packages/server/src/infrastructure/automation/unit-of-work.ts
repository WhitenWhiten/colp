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

export function createAutomationUnitOfWork(db: Kysely<DatabaseSchema>, serverUuid: string): AutomationUnitOfWork {
  return { execute: (actor, work) => createUnitOfWork(db).execute(async ({ transaction: tx }) => {
    // Existing lock order: active Account -> receipts -> private configuration -> canonical reads.
    const account = await tx.selectFrom('accounts').select(['subject_id', 'status', 'deleted_at']).where('id', '=', actor.accountId).forUpdate().executeTakeFirst();
    if (!account || account.status !== 'active' || account.deleted_at || account.subject_id !== actor.subjectId)
      throw new AutomationError('resource_not_found', 'Active owner is unavailable.');
    const reads = createBindingReadPort(tx, serverUuid);
    return work({ receipts: createPostgresProductCommandReceiptPort(tx), rules: createRuleStore(tx), bindings: createBindingStore(tx),
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
        },
      },
      previews: {
        async load(ownerId, id) {
          const row = await tx.selectFrom('automation_preview_records').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
          return row ? { id: row.id, configDigest: row.config_digest, input: row.snapshot_json.input as unknown as PreviewInput, result: row.result_json, expiresAt: row.expires_at } : null;
        },
        async save(ownerId, preview) {
          await tx.insertInto('automation_preview_records').values({ id: preview.id, owner_id: ownerId, config_digest: preview.configDigest,
            snapshot_json: { input: preview.input }, result_json: preview.result, expires_at: preview.expiresAt }).execute();
        },
      },
      async activation(rule, collectionId, afterOrdinal, enabled) {
        if (!enabled) {
          await tx.updateTable('automation_activations').set({ disabled_after_ordinal: afterOrdinal }).where('rule_revision_id', '=', rule.definitionRevisionId)
            .where('disabled_after_ordinal', 'is', null).execute(); return;
        }
        const generations = await tx.selectFrom('automation_activations').select(sql<string>`coalesce(max(generation),0)::text`.as('generation'))
          .where('rule_revision_id', '=', rule.definitionRevisionId).executeTakeFirstOrThrow();
        const generation = (BigInt(generations.generation) + 1n).toString();
        await tx.insertInto('automation_activations').values({ rule_revision_id: rule.definitionRevisionId, collection_id: collectionId, generation,
          after_ordinal: afterOrdinal, disabled_after_ordinal: null, aggregate_epoch: generation }).execute();
      },
    });
  }) };
}
