import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { OutboxHandlerContext } from '../outbox/router.js';
import type { PlannedAutomationFacts } from './fact-capture.js';

export interface AutomationSource {
  operation_id: string; commit_ordinal: string; source_event_id: string | null; node_id: string | null;
  occurred_at: Date | null; origin: string | null; facts_version: number | null;
  facts_json: (PlannedAutomationFacts & { action: string; actorPrincipalId: string; rootRunId: string | null; stageId: string | null; hopCount: number }) | null;
}
export type InspectAutomationSource = (tx: DatabaseTransaction, owner: { accountId: string; subjectId: string },
  collectionId: string, sources: readonly AutomationSource[]) => Promise<void>;

/** Account -> position -> admission partitions -> lease. All effects and the cursor commit together. */
export function createAutomationSourceInspector(db: Kysely<DatabaseSchema>, inspect: InspectAutomationSource) {
  return async (context: OutboxHandlerContext): Promise<boolean> => db.transaction().execute(async tx => {
    if (!context.attempt || !context.envelope.commit_ordinal || context.signal.aborted) throw new Error('Source lease required');
    const collectionId = context.envelope.payload.collectionId as string;
    const owner = await tx.selectFrom('collections as c').innerJoin('accounts as a', 'a.subject_id', 'c.owner_subject_id')
      .select(['a.id', 'a.subject_id', 'a.status', 'a.deleted_at']).where('c.id', '=', collectionId).forUpdate('a').executeTakeFirst();
    if (!owner) throw new Error('Source owner unavailable');
    await sql`INSERT INTO automation_source_positions (owner_id, collection_id, last_inspected_ordinal)
      VALUES (${owner.id}, ${collectionId}, 0) ON CONFLICT DO NOTHING`.execute(tx);
    const position = (await sql<{ last_inspected_ordinal: string }>`SELECT last_inspected_ordinal::text FROM automation_source_positions
      WHERE owner_id=${owner.id} AND collection_id=${collectionId} FOR UPDATE`.execute(tx)).rows[0]!;
    const high = BigInt(context.envelope.commit_ordinal);
    const rows = (await sql<AutomationSource>`SELECT o.operation_id, o.commit_ordinal::text, f.source_event_id, f.node_id,
      f.occurred_at, f.origin, f.facts_version, f.facts_json FROM operations o
      LEFT JOIN automation_event_facts f ON f.operation_id=o.operation_id
      WHERE o.collection_id=${collectionId} AND o.commit_ordinal > ${position.last_inspected_ordinal}::bigint
        AND o.commit_ordinal <= ${high} ORDER BY o.commit_ordinal LIMIT 200`.execute(tx)).rows;
    if (owner.status === 'active' && !owner.deleted_at)
      await inspect(tx, { accountId: owner.id, subjectId: owner.subject_id }, collectionId, rows);
    // Ordinals are positions, not a claim that every ordinal has a matching automation fact.
    const through = rows.length === 200 ? BigInt(rows.at(-1)!.commit_ordinal) : high;
    await sql`UPDATE automation_source_positions SET last_inspected_ordinal=greatest(last_inspected_ordinal, ${through})
      WHERE owner_id=${owner.id} AND collection_id=${collectionId}`.execute(tx);
    const lease = await tx.selectFrom('outbox_events').select('outbox_id')
      .where('outbox_id', '=', context.attempt.outboxId).where('domain_event_id', '=', context.envelope.event_id)
      .where('handler_name', '=', 'automation_ingest').where('state', '=', 'leased')
      .where('lease_generation', '=', BigInt(context.attempt.leaseGeneration)).where('locked_until', '>', sql<Date>`clock_timestamp()`)
      .forUpdate().executeTakeFirst();
    if (!lease || context.signal.aborted) throw new Error('Automation source lease lost');
    return through < high;
  });
}
