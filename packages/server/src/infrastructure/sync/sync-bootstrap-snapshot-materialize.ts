import type { PoolClient } from 'pg';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateSnapshotSemantics } from '@know-n/colp/semantic';
import type { Collection } from '@know-n/colp/types';
import { SyncBootstrapSnapshotError } from '../../modules/sync/index.js';
import { mapSnapshotNode, snapshotParentRevisions, type SnapshotNodeRow } from '../collections/snapshot-document.js';
import { insertSnapshotNodeRows } from './sync-bootstrap-snapshot-persist.js';

const BATCH_SIZE = 500;
const validators = createValidatorRegistry();

/** The caller owns the repeatable-read transaction and rolls it back on failure. */
export async function materializeSnapshotNodes(client: PoolClient, input: {
  readonly snapshotId: string; readonly collection: Collection; readonly expectedNodes: number;
  readonly protocolVersion: '0.1' | '0.2'; readonly syncCursor: string; readonly generatedAt: string;
  readonly maxBytes?: number;
}): Promise<void> {
  // The cursor keeps projected payloads in PostgreSQL until their bounded batch
  // is requested. C collation preserves parent-first-v1 sibling ordering.
  await client.query(`declare snapshot_materialization no scroll cursor for
    with recursive tree as (
      select n.*, array[coalesce(n.position_token,''),n.id]::text[] as traversal_path,
        array[n.id]::text[] as ancestor_ids
      from nodes n where n.collection_id=$1 and n.id=$2 and n.deleted_at is null
        and n.is_root and n.parent_id is null and n.kind='folder'
      union all
      select child.*, tree.traversal_path || array[child.position_token,child.id],
        tree.ancestor_ids || child.id
      from tree join nodes child on child.parent_id=tree.id and child.collection_id=$1
      where tree.kind='folder' and not child.is_root and child.deleted_at is null
        and not child.id=any(tree.ancestor_ids)
    ) select id,collection_id,parent_id,kind,is_root,title,url,position_token,visibility,
      resource_revision,children_revision,created_at,updated_at,payload_json
      from tree order by traversal_path collate "C"`, [input.collection.id, input.collection.rootNodeId]);
  let count = 0; let parentCount = 0;
  let bytes = Buffer.byteLength(JSON.stringify({ collection: input.collection, nodes: [], parentRevisions: [] }));
  while (true) {
    const batch = await client.query<SnapshotNodeRow>(`fetch forward ${BATCH_SIZE} from snapshot_materialization`);
    if (batch.rows.length === 0) break;
    const nodes = batch.rows.map(mapSnapshotNode);
    const parents = snapshotParentRevisions(batch.rows);
    const base = { snapshotId: input.snapshotId, mode: 'sync' as const, complete: true,
      collection: input.collection, nodes, annotations: [], attachments: [], relations: [], tombstones: [],
      revision: input.collection.revision, syncCursor: input.syncCursor, generatedAt: input.generatedAt,
      page: { nextCursor: count + nodes.length < input.expectedNodes ? 'materialization-next' : null,
        hasMore: count + nodes.length < input.expectedNodes, sequence: Math.floor(count / BATCH_SIZE) + 1 }, warnings: [] };
    const document = input.protocolVersion === '0.2'
      ? { ...base, protocolVersion: '0.2', parentRevisions: parents }
      : { ...base, protocolVersion: '0.1' };
    const structural = validators.validate(input.protocolVersion === '0.2' ? 'syncSnapshotV02' : 'snapshot', document);
    if (!structural.valid) throw new Error(`Authoritative Snapshot batch failed schema: ${JSON.stringify(structural.errors)}`);
    const semantic = validateSnapshotSemantics({ ...base, protocolVersion: '0.1' },
      { referenceResolution: { mode: 'deferred' } });
    if (!semantic.valid) throw new Error(`Authoritative Snapshot batch failed semantics: ${JSON.stringify(semantic.issues)}`);
    for (const node of nodes) bytes += Buffer.byteLength(JSON.stringify(node)) + (count++ > 0 ? 1 : 0);
    for (const parent of parents) bytes += Buffer.byteLength(JSON.stringify(parent)) + (parentCount++ > 0 ? 1 : 0);
    if (input.maxBytes !== undefined && bytes > input.maxBytes) throw new SyncBootstrapSnapshotError('payload_too_large');
    await insertSnapshotNodeRows(client, input.snapshotId, nodes, count - nodes.length, parents);
  }
  await client.query('close snapshot_materialization');
  // The rooted traversal excludes cycles, orphans, children of bookmarks and
  // additional roots. Equality with the RR count proves the whole live graph
  // was visited exactly once before any Snapshot becomes visible.
  if (count !== input.expectedNodes || count === 0) throw new Error('Authoritative Snapshot is not a rooted tree');
}
