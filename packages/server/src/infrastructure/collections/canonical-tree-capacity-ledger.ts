import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { mapSnapshotCollection, mapSnapshotNode, snapshotParentRevisions, withSnapshotBinding,
  type SnapshotNodeRow } from './snapshot-document.js';

const SERIALIZER_VERSION = 1;
interface Contribution { node_id: string; node_bytes: number; parent_bytes: number }
interface Totals {
  serializer_version: number; live_nodes: string; node_bytes: string;
  parent_count: string; parent_bytes: string;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function contribution(row: SnapshotNodeRow): Contribution {
  const parent = snapshotParentRevisions([row])[0];
  return { node_id: row.id, node_bytes: bytes(mapSnapshotNode(row)), parent_bytes: parent ? bytes(parent) : 0 };
}

/** Delete only absent entries so the two modifying CTEs never touch the same row. */
function entryChanges(collectionId: string, entries: Contribution[], dirtyIds?: string[]) {
  return sql`next as (
    select * from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb)
      as e(node_id text, node_bytes bigint, parent_bytes bigint)
  ), removed as (
    delete from canonical_tree_capacity_entries where collection_id=${collectionId}
      ${dirtyIds === undefined ? sql`` : sql`and node_id in (
        select jsonb_array_elements_text(${JSON.stringify(dirtyIds)}::jsonb))`}
      and node_id not in (select node_id from next)
  ), stored as (
    insert into canonical_tree_capacity_entries (collection_id, node_id, node_bytes, parent_bytes)
      select ${collectionId}, node_id, node_bytes, parent_bytes from next
    on conflict (collection_id, node_id) do update
      set node_bytes=excluded.node_bytes, parent_bytes=excluded.parent_bytes
  )`;
}

/** Exact Snapshot byte accounting. The collection lock serializes admission;
 * triggers retain every changed row until its contribution is reconciled.
 * Existing collections are initialized once, or explicitly by the backfill CLI. */
export async function readCanonicalTreeCapacity(tx: DatabaseTransaction, collectionId: string) {
  const collection = await tx.selectFrom('collections').selectAll().where('id', '=', collectionId)
    .forUpdate().executeTakeFirstOrThrow();
  // Keep this read after lock acquisition: a combined query could retain the
  // snapshot taken before a concurrent admission released the collection lock.
  const prior = (await sql<Totals>`select * from canonical_tree_capacity
    where collection_id=${collectionId} for update`.execute(tx)).rows[0];
  let total: Totals;
  if (!prior || prior.serializer_version !== SERIALIZER_VERSION) {
    const rows = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', collectionId)
      .where('deleted_at', 'is', null).execute();
    const entries = rows.map(contribution);
    total = (await sql<Totals>`with ${entryChanges(collectionId, entries)}, cleared as (
      delete from canonical_tree_capacity_dirty where collection_id=${collectionId}
    ) insert into canonical_tree_capacity
      (collection_id, serializer_version, live_nodes, node_bytes, parent_count, parent_bytes)
      values (${collectionId}, ${SERIALIZER_VERSION}, ${entries.length},
        ${entries.reduce((sum, e) => sum + e.node_bytes, 0)},
        ${entries.filter(e => e.parent_bytes > 0).length},
        ${entries.reduce((sum, e) => sum + e.parent_bytes, 0)})
      on conflict (collection_id) do update set serializer_version=excluded.serializer_version,
        live_nodes=excluded.live_nodes, node_bytes=excluded.node_bytes,
        parent_count=excluded.parent_count, parent_bytes=excluded.parent_bytes
      returning *`.execute(tx)).rows[0]!;
  } else {
    const dirty = (await sql<{
      node_id: string; node_bytes: number | null; parent_bytes: number | null; node: SnapshotNodeRow | null;
    }>`with dirty as (
      delete from canonical_tree_capacity_dirty where collection_id=${collectionId} returning node_id
    ) select dirty.node_id, e.node_bytes::integer, e.parent_bytes::integer, to_jsonb(n) as node
      from dirty left join canonical_tree_capacity_entries e
        on e.collection_id=${collectionId} and e.node_id=dirty.node_id
      left join nodes n on n.collection_id=${collectionId} and n.id=dirty.node_id and n.deleted_at is null
    `.execute(tx)).rows;
    total = prior;
    if (dirty.length) {
      const old: Contribution[] = dirty.flatMap(row => row.node_bytes === null ? [] : [{
        node_id: row.node_id, node_bytes: row.node_bytes, parent_bytes: row.parent_bytes!,
      }]);
      const next = dirty.flatMap(row => row.node === null ? [] : [contribution({ ...row.node,
        created_at: new Date(row.node.created_at), updated_at: new Date(row.node.updated_at) })]);
      const sum = (entries: Contribution[], field: 'node_bytes' | 'parent_bytes') =>
        entries.reduce((total, entry) => total + entry[field], 0);
      total = (await sql<Totals>`with ${entryChanges(collectionId, next, dirty.map(row => row.node_id))}
      update canonical_tree_capacity set
        live_nodes=live_nodes+${next.length - old.length},
        node_bytes=node_bytes+${sum(next, 'node_bytes') - sum(old, 'node_bytes')},
        parent_count=parent_count+${next.filter(e => e.parent_bytes > 0).length - old.filter(e => e.parent_bytes > 0).length},
        parent_bytes=parent_bytes+${sum(next, 'parent_bytes') - sum(old, 'parent_bytes')}
        where collection_id=${collectionId} returning *`.execute(tx)).rows[0]!;
    }
  }
  const nodes = Number(total.live_nodes); const parents = Number(total.parent_count);
  const envelope = { collection: withSnapshotBinding(mapSnapshotCollection(collection),
    'mounted-folder', collection.root_node_id), nodes: [], parentRevisions: [] };
  return { nodes, bytes: bytes(envelope) + Number(total.node_bytes) + Math.max(0, nodes - 1)
    + Number(total.parent_bytes) + Math.max(0, parents - 1) };
}
