import { sql } from 'kysely';
import { CanonicalMutationInvariantError, type JsonObject } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendOperationsWithPayload } from '../database/operation-payload-store.js';
import { appendAuditEvents } from '../database/audit-event-payload.js';
import { assertNodeWriteResult, assertCollectionReadBack } from './canonical-mutation-postgres-ports.js';
import type { BookmarkMovePlan, PlannedBookmarkMove } from './canonical-bookmark-move-plan.js';
import { bookmarkMoveOutbox, appendBookmarkMoveOutbox } from './canonical-bookmark-move-outbox.js';

export type BookmarkBatchFactWriter = (tx: DatabaseTransaction, moves: readonly PlannedBookmarkMove[]) => Promise<void>;

/** Flush a fully planned batch inside the caller's existing transaction and gate. */
export async function writeBookmarkMoves(tx: DatabaseTransaction, plan: BookmarkMovePlan, now: Date,
  captureFacts?: BookmarkBatchFactWriter, persistEffects?: BookmarkBatchFactWriter) {
  const c = plan.collection, moves = plan.moves, outbox = bookmarkMoveOutbox(plan, !!captureFacts);
  const ids = [...moves.flatMap(m => [{ resource_id: m.input.operationId, resource_type: 'operation' },
    { resource_id: m.event.domainEventId, resource_type: 'domain-event' }]),
  ...outbox.map(row => ({ resource_id: row.outbox_id as string, resource_type: 'outbox' }))];
  await sql`INSERT INTO resource_id_ledger(resource_id,resource_type)
    SELECT resource_id,resource_type FROM jsonb_to_recordset(${JSON.stringify(ids)}::jsonb)
      AS i(resource_id text,resource_type text)`.execute(tx);
  const changed = plan.changed.map(row => ({ id: row.id, parent_id: row.parent_id, position_token: row.position_token,
    resource_revision: row.resource_revision, children_revision: row.children_revision, payload_json: row.payload_json }));
  const updated = await sql<{ id: string }>`UPDATE nodes n SET parent_id=i.parent_id, position_token=i.position_token,
    resource_revision=i.resource_revision, children_revision=i.children_revision, payload_json=i.payload_json, updated_at=${now}
    FROM jsonb_to_recordset(${JSON.stringify(changed)}::jsonb) AS i(id text, parent_id text, position_token text,
      resource_revision text, children_revision text, payload_json jsonb)
    WHERE n.collection_id=${c.id} AND n.id=i.id AND n.deleted_at IS NULL RETURNING n.id`.execute(tx);
  if (updated.rows.length !== changed.length)
    throw new CanonicalMutationInvariantError('resource_field_authority_violation', 'bookmark batch write lost a node');
  const collectionWrite = await tx.updateTable('collections').set({ content_revision: c.content_revision,
    commit_ordinal: c.commit_ordinal, updated_at: now, payload_json: c.payload_json })
    .where('id', '=', c.id).executeTakeFirst();
  if (collectionWrite.numUpdatedRows !== 1n)
    throw new CanonicalMutationInvariantError('resource_field_authority_violation', 'bookmark batch lost its collection');

  const revisions = moves.map(m => ({ id: m.after.id, resource_revision: m.after.resource_revision,
    content_revision: m.result.allocation.contentRevision!, ordinal: m.result.allocation.commitOrdinal.toString() }));
  const parents = moves.flatMap(m => Object.entries(m.result.allocation.childrenRevisions)
    .map(([id, revision]) => ({ id, revision, ordinal: m.result.allocation.commitOrdinal.toString() })));
  await sql`WITH supplied AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(revisions)}::jsonb)
        AS i(id text,resource_revision text,content_revision text,ordinal bigint)
    ), resources AS (
      INSERT INTO resource_revisions(collection_id,resource_id,revision,ordinal,created_at)
      SELECT ${c.id},id,resource_revision,ordinal,${now} FROM supplied
    ), content AS (
      INSERT INTO content_revisions(collection_id,revision,ordinal,created_at)
      SELECT ${c.id},content_revision,ordinal,${now} FROM supplied
    ) INSERT INTO children_revisions(collection_id,parent_id,revision,ordinal)
      SELECT ${c.id},id,revision,ordinal FROM jsonb_to_recordset(${JSON.stringify(parents)}::jsonb)
        AS i(id text,revision text,ordinal bigint)`.execute(tx);
  // Read actual rows after all resource/revision writes, including triggers, and
  // validate before producing any immutable history, facts or delivery evidence.
  const readBack = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', c.id)
    .where('id', 'in', plan.changed.map(row => row.id)).execute();
  const actual = new Map(readBack.map(row => [row.id, row]));
  for (const row of plan.changed) {
    const stored = actual.get(row.id);
    if (!stored) throw new CanonicalMutationInvariantError('resource_field_authority_violation', 'bookmark batch read-back lost a node');
    assertNodeWriteResult(stored, row.payload_json as JsonObject, row);
  }
  await assertCollectionReadBack(tx, c.id, c.payload_json as JsonObject, c);
  const history = moves.map(m => ({ id: m.after.id, revision: m.after.resource_revision, kind: m.after.kind,
    payload: actual.get(m.after.id)!.payload_json!, ordinal: m.result.allocation.commitOrdinal.toString(), operation_id: m.input.operationId }));
  await sql`INSERT INTO sync_node_revision_history
    (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id,recorded_at)
    SELECT ${c.id},id,revision,kind,payload,ordinal,operation_id,${now}
    FROM jsonb_to_recordset(${JSON.stringify(history)}::jsonb)
      AS i(id text,revision text,kind text,payload jsonb,ordinal bigint,operation_id text)`.execute(tx);
  await appendOperationsWithPayload(tx, moves.map(m => ({ operationId: m.input.operationId, collectionId: c.id,
    commitOrdinal: m.result.allocation.commitOrdinal, operationType: m.operation.operationType,
    payloadJson: m.operation.canonicalPayload, syncWireJson: m.input.operationSyncWire,
    actorPrincipalId: m.input.actor.principalId, createdAt: now })));
  if (persistEffects) await persistEffects(tx, moves);
  else await tx.updateTable('sync_replicas').set({ status: 'recovery_required', lifecycle_revision: sql<bigint>`lifecycle_revision+1`,
    wire_json: sql<Record<string, unknown>>`jsonb_set(wire_json,'{status}','"recovery_required"'::jsonb,true)` })
    .where('collection_id', '=', c.id).where('status', '=', 'active').execute();
  await appendAuditEvents(tx, moves.map(m => ({ operationId: m.input.operationId, collectionId: c.id,
    principalId: m.input.actor.principalId, eventType: m.operation.operationType, details: m.operation.canonicalPayload, createdAt: now })));
  await captureFacts?.(tx, moves);
  await appendBookmarkMoveOutbox(tx, outbox);
}
