import { sql, type RawBuilder } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/**
 * SYNC-R02: one locked Node row fact evaluated by the managed-bookmarks
 * ancestry policy. Callers must pass rows that were read (and, where the row
 * is not already locked by the caller, FOR UPDATE locked) inside the same
 * transaction as the write they are guarding.
 */
export interface ManagedAncestryNodeFact {
  readonly id: string;
  readonly parentId: string | null;
  readonly isRoot: boolean;
  readonly deleted: boolean;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly folderRole: 'managed-bookmarks' | null;
}

/** Capabilities that must BOTH hold before any managed-bookmarks ancestry write is permitted. */
export interface ManagedAncestryCapabilities {
  /** Deployment capability: SYNC_MANAGED_BOOKMARK_WRITES=true. */
  readonly managedBookmarkWrites: boolean;
  /** Replica write capability verified inside the same transaction. */
  readonly replicaWrite: boolean;
}

export class ManagedAncestryPolicyError extends Error {
  constructor(public readonly code: 'node_read_only' | 'resource_not_found') {
    super(`Sync managed ancestry policy denied: ${code}`);
    this.name = 'ManagedAncestryPolicyError';
  }
}

/** Converts one locked Node row into the ancestry policy fact shape. */
export function managedAncestryNodeFact(row: {
  readonly id: string;
  readonly parent_id: string | null;
  readonly is_root: boolean;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly deleted_at: Date | null;
  readonly payload_json: Record<string, unknown> | null;
}): ManagedAncestryNodeFact {
  return Object.freeze({
    id: row.id,
    parentId: row.parent_id,
    isRoot: row.is_root,
    deleted: row.deleted_at !== null,
    kind: row.kind,
    folderRole: row.payload_json?.folderRole === 'managed-bookmarks' ? 'managed-bookmarks' : null,
  });
}

/**
 * Fails closed whenever any locked chain fact is managed-bookmarks and the
 * deployment capability and the transaction-local Replica write capability are
 * not BOTH present. The whole chain (target itself plus every ancestor) is
 * inspected, so managed folders, their direct children and their deep
 * descendants are all rejected uniformly.
 */
export function assertManagedAncestryWritable(
  facts: readonly ManagedAncestryNodeFact[],
  capabilities: ManagedAncestryCapabilities,
): void {
  if (capabilities.managedBookmarkWrites && capabilities.replicaWrite) return;
  if (facts.some((fact) => fact.folderRole === 'managed-bookmarks')) {
    throw new ManagedAncestryPolicyError('node_read_only');
  }
}

/** One SELECT snapshot for read-side decisions. Resolution reloads the same
 * facts under row locks before applying this shared chain and write policy. */
export function managedAncestrySnapshotSql(input: {
  readonly collectionId: RawBuilder<string>;
  readonly startId: RawBuilder<string>;
  readonly retainedTombstones: RawBuilder<boolean>;
}): RawBuilder<readonly ManagedAncestryNodeFact[]> {
  return sql<readonly ManagedAncestryNodeFact[]>`(
    with recursive ancestry(id, parent_id, is_root, kind, deleted_at, payload_json, depth, path) as (
      select id, parent_id, is_root, kind, deleted_at, payload_json, 0, array[id]
      from nodes where collection_id = ${input.collectionId} and id = ${input.startId}
        and (${input.retainedTombstones} or deleted_at is null)
      union all
      select parent.id, parent.parent_id, parent.is_root, parent.kind, parent.deleted_at,
        parent.payload_json, child.depth + 1, child.path || parent.id
      from ancestry child
      join nodes parent on parent.collection_id = ${input.collectionId} and parent.id = child.parent_id
      where child.depth < 255 and (${input.retainedTombstones} or parent.deleted_at is null)
        and not parent.id = any(child.path)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'parentId', parent_id, 'isRoot', is_root, 'kind', kind,
      'deleted', deleted_at is not null,
      'folderRole', case when payload_json->>'folderRole' = 'managed-bookmarks' then 'managed-bookmarks' else null end
    ) order by depth), '[]'::jsonb) from ancestry
  )`;
}

export function managedAncestryWriteBlockedReason(
  facts: readonly ManagedAncestryNodeFact[],
  startId: string,
  capabilities: ManagedAncestryCapabilities,
  options: { readonly retainedTombstones?: boolean } = {},
): ManagedAncestryPolicyError['code'] | null {
  try {
    assertManagedAncestryWritable(validateManagedAncestryChain(facts, startId, options), capabilities);
    return null;
  } catch (error) {
    if (error instanceof ManagedAncestryPolicyError) return error.code;
    throw error;
  }
}

function validateManagedAncestryChain(
  facts: readonly ManagedAncestryNodeFact[], startId: string,
  options: { readonly retainedTombstones?: boolean },
): readonly ManagedAncestryNodeFact[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact] as const));
  const chain: ManagedAncestryNodeFact[] = [];
  const seen = new Set<string>();
  let currentId: string | null = startId;
  while (currentId !== null) {
    if (seen.has(currentId) || seen.size >= 256) throw new ManagedAncestryPolicyError('resource_not_found');
    seen.add(currentId);
    const current = byId.get(currentId);
    if (!current || (current.deleted && (!options.retainedTombstones || current.isRoot))
        || (current.id !== startId && current.kind !== 'folder')) {
      throw new ManagedAncestryPolicyError('resource_not_found');
    }
    chain.push(current);
    if (current.isRoot) break;
    currentId = current.parentId;
  }
  if (chain.at(-1)?.isRoot !== true) throw new ManagedAncestryPolicyError('resource_not_found');
  return Object.freeze(chain);
}

/**
 * Loads and locks the closed ancestry chain from startId up to the collection
 * root and returns it ordered from startId (first) to root (last). All returned
 * rows are locked FOR UPDATE in stable ID order. Abnormal chains — missing
 * start row, deleted chain member, cycle, depth overflow, dangling parent or a
 * chain that does not terminate at the live collection root — fail closed with
 * `resource_not_found`. Conflict admission/recovery may inspect retained
 * tombstones, but must still prove the complete chain and a live root; the
 * managed policy sees the deleted ancestors too. Live writes use the default.
 */
export async function loadLockedManagedAncestryChain(
  tx: DatabaseTransaction,
  collectionId: string,
  startId: string,
  options: { readonly retainedTombstones?: boolean } = {},
): Promise<readonly ManagedAncestryNodeFact[]> {
  const retainedTombstones = options.retainedTombstones === true;
  const discovered = await sql<{ id: string; parent_id: string | null }>`
    with recursive ancestry(id, parent_id, depth, path) as (
      select id, parent_id, 0, array[id]
      from nodes where collection_id = ${collectionId} and id = ${startId}
        and (${retainedTombstones} or deleted_at is null)
      union all
      select parent.id, parent.parent_id, child.depth + 1, child.path || parent.id
      from ancestry child
      join nodes parent on parent.collection_id = ${collectionId} and parent.id = child.parent_id
      where child.depth < 255 and (${retainedTombstones} or parent.deleted_at is null)
        and not parent.id = any(child.path)
    )
    select id, parent_id from ancestry order by depth
  `.execute(tx);
  const ids = discovered.rows.map((row) => row.id);
  if (ids.length < 1 || ids[0] !== startId) throw new ManagedAncestryPolicyError('resource_not_found');
  const locked = await tx.selectFrom('nodes').select([
    'id', 'parent_id', 'kind', 'is_root', 'deleted_at', 'payload_json',
  ]).where('collection_id', '=', collectionId).where('id', 'in', ids)
    .orderBy('id').forUpdate().execute();
  if (locked.length !== ids.length) throw new ManagedAncestryPolicyError('resource_not_found');
  return validateManagedAncestryChain(locked.map(managedAncestryNodeFact), startId, options);
}
