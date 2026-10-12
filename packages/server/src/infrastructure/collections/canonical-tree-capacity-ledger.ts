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

async function storeEntries(tx: DatabaseTransaction, collectionId: string, entries: Contribution[]) {
  if (!entries.length) return;
  await sql`insert into canonical_tree_capacity_entries (collection_id, node_id, node_bytes, parent_bytes)
    select ${collectionId}, e.node_id, e.node_bytes, e.parent_bytes
    from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb)
      as e(node_id text, node_bytes bigint, parent_bytes bigint)
    on conflict (collection_id, node_id) do update
      set node_bytes=excluded.node_bytes, parent_bytes=excluded.parent_bytes`.execute(tx);
}

/** Exact Snapshot byte accounting. The collection lock serializes admission;
 * triggers retain every changed row until its contribution is reconciled.
 * Existing collections are initialized once, or explicitly by the backfill CLI. */
export async function readCanonicalTreeCapacity(tx: DatabaseTransaction, collectionId: string) {
  const collection = await tx.selectFrom('collections').selectAll().where('id', '=', collectionId)
    .forUpdate().executeTakeFirstOrThrow();
  const prior = (await sql<Totals>`select * from canonical_tree_capacity
    where collection_id=${collectionId} for update`.execute(tx)).rows[0];
  if (!prior || prior.serializer_version !== SERIALIZER_VERSION) {
    const rows = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', collectionId)
      .where('deleted_at', 'is', null).execute();
    const entries = rows.map(contribution);
    await sql`delete from canonical_tree_capacity_entries where collection_id=${collectionId}`.execute(tx);
    await storeEntries(tx, collectionId, entries);
    await sql`insert into canonical_tree_capacity
      (collection_id, serializer_version, live_nodes, node_bytes, parent_count, parent_bytes)
      values (${collectionId}, ${SERIALIZER_VERSION}, ${entries.length},
        ${entries.reduce((sum, e) => sum + e.node_bytes, 0)},
        ${entries.filter(e => e.parent_bytes > 0).length},
        ${entries.reduce((sum, e) => sum + e.parent_bytes, 0)})
      on conflict (collection_id) do update set serializer_version=excluded.serializer_version,
        live_nodes=excluded.live_nodes, node_bytes=excluded.node_bytes,
        parent_count=excluded.parent_count, parent_bytes=excluded.parent_bytes`.execute(tx);
    await sql`delete from canonical_tree_capacity_dirty where collection_id=${collectionId}`.execute(tx);
  } else {
    const dirty = (await sql<{ node_id: string }>`delete from canonical_tree_capacity_dirty
      where collection_id=${collectionId} returning node_id`.execute(tx)).rows.map(row => row.node_id);
    if (dirty.length) {
      const old = (await sql<Contribution>`select node_id, node_bytes::integer, parent_bytes::integer
        from canonical_tree_capacity_entries where collection_id=${collectionId}
        and node_id in (select jsonb_array_elements_text(${JSON.stringify(dirty)}::jsonb))`.execute(tx)).rows;
      const rows = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', collectionId)
        .where('id', 'in', dirty).where('deleted_at', 'is', null).execute();
      const next = rows.map(contribution);
      await sql`delete from canonical_tree_capacity_entries where collection_id=${collectionId}
        and node_id in (select jsonb_array_elements_text(${JSON.stringify(dirty)}::jsonb))`.execute(tx);
      await storeEntries(tx, collectionId, next);
      const sum = (entries: Contribution[], field: 'node_bytes' | 'parent_bytes') =>
        entries.reduce((total, entry) => total + entry[field], 0);
      await sql`update canonical_tree_capacity set
        live_nodes=live_nodes+${next.length - old.length},
        node_bytes=node_bytes+${sum(next, 'node_bytes') - sum(old, 'node_bytes')},
        parent_count=parent_count+${next.filter(e => e.parent_bytes > 0).length - old.filter(e => e.parent_bytes > 0).length},
        parent_bytes=parent_bytes+${sum(next, 'parent_bytes') - sum(old, 'parent_bytes')}
        where collection_id=${collectionId}`.execute(tx);
    }
  }
  const total = (await sql<Totals>`select * from canonical_tree_capacity
    where collection_id=${collectionId}`.execute(tx)).rows[0]!;
  const nodes = Number(total.live_nodes); const parents = Number(total.parent_count);
  const envelope = { collection: withSnapshotBinding(mapSnapshotCollection(collection),
    'mounted-folder', collection.root_node_id), nodes: [], parentRevisions: [] };
  return { nodes, bytes: bytes(envelope) + Number(total.node_bytes) + Math.max(0, nodes - 1)
    + Number(total.parent_bytes) + Math.max(0, parents - 1) };
}
