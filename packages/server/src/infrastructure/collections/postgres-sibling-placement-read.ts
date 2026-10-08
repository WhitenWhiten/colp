import { sql, type Kysely } from 'kysely';
import {
  NodeConflictError,
  resolvePlacement,
  type BoundedPositionSibling,
  type ResolvedPlacement,
} from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export interface LiveSiblingRow {
  readonly id: string;
  readonly positionToken: string;
}

export interface BoundedPlacementReadRequest {
  readonly collectionId: string;
  readonly parentId: string;
  readonly excludeNodeId?: string;
  readonly afterId?: string;
  readonly beforeId?: string;
  readonly forUpdate?: boolean;
}

export interface BoundedPlacementReadResult {
  readonly siblings: readonly LiveSiblingRow[];
  readonly placement: ResolvedPlacement;
  readonly insertIndex: number;
}

export interface RebalanceWindowReadRequest {
  readonly collectionId: string;
  readonly parentId: string;
  readonly excludeNodeId?: string;
  readonly placement: ResolvedPlacement;
  readonly afterId?: string;
  readonly beforeId?: string;
  readonly windowSize: number;
  readonly forUpdate?: boolean;
}

export interface RebalanceWindowReadResult {
  readonly windowSiblings: readonly BoundedPositionSibling[];
  readonly insertIndex: number;
  readonly outsideLowerBoundToken: string | null;
  readonly outsideUpperBoundToken: string | null;
}

export interface LiveSiblingNeighborhoodRequest {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly expectedParentId?: string;
}

export interface LiveSiblingNeighborhood {
  readonly parentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly position: string;
}

export class LiveSiblingNeighborhoodError extends Error {
  readonly code: 'not_found' | 'missing_position' | 'inconsistent_parent';

  constructor(code: LiveSiblingNeighborhoodError['code'], message: string) {
    super(message);
    this.name = 'LiveSiblingNeighborhoodError';
    this.code = code;
  }
}

export interface PreresolvedSiblingPlacement {
  readonly siblings: readonly LiveSiblingRow[];
}

interface RawSiblingRow {
  readonly id: string;
  readonly position_token: string;
}

function stale(message: string): never {
  throw new NodeConflictError('position_context_stale', message);
}

function mapRow(row: RawSiblingRow | undefined): LiveSiblingRow | undefined {
  if (!row || row.position_token === null) return undefined;
  return { id: row.id, positionToken: row.position_token };
}

async function readLiveSiblingById(
  tx: DatabaseTransaction,
  request: BoundedPlacementReadRequest,
  nodeId: string,
): Promise<LiveSiblingRow | undefined> {
  if (nodeId === request.excludeNodeId) return undefined;
  let query = tx.selectFrom('nodes')
    .select(['id', 'position_token'])
    .where('collection_id', '=', request.collectionId)
    .where('parent_id', '=', request.parentId)
    .where('id', '=', nodeId)
    .where('deleted_at', 'is', null)
    .where('is_root', '=', false);
  if (request.forUpdate) query = query.forUpdate();
  return mapRow(await query.executeTakeFirst() as RawSiblingRow | undefined);
}

async function readPredecessor(
  tx: DatabaseTransaction,
  request: BoundedPlacementReadRequest,
  anchorToken: string,
  anchorId: string,
): Promise<LiveSiblingRow | undefined> {
  const lock = request.forUpdate ? sql`for update` : sql``;
  const exclude = request.excludeNodeId === undefined
    ? sql`true`
    : sql`id <> ${request.excludeNodeId}`;
  const result = await sql<RawSiblingRow>`
    select id, position_token
    from nodes
    where collection_id = ${request.collectionId}
      and parent_id = ${request.parentId}
      and deleted_at is null
      and is_root = false
      and ${exclude}
      and (position_token collate "C", id) < (${anchorToken}::text collate "C", ${anchorId})
    order by position_token collate "C" desc, id desc
    limit 1
    ${lock}
  `.execute(tx);
  return mapRow(result.rows[0]);
}

async function readSuccessor(
  tx: DatabaseTransaction,
  request: BoundedPlacementReadRequest,
  anchorToken: string,
  anchorId: string,
): Promise<LiveSiblingRow | undefined> {
  const lock = request.forUpdate ? sql`for update` : sql``;
  const exclude = request.excludeNodeId === undefined
    ? sql`true`
    : sql`id <> ${request.excludeNodeId}`;
  const result = await sql<RawSiblingRow>`
    select id, position_token
    from nodes
    where collection_id = ${request.collectionId}
      and parent_id = ${request.parentId}
      and deleted_at is null
      and is_root = false
      and ${exclude}
      and (position_token collate "C", id) > (${anchorToken}::text collate "C", ${anchorId})
    order by position_token collate "C" asc, id asc
    limit 1
    ${lock}
  `.execute(tx);
  return mapRow(result.rows[0]);
}

async function readTailSibling(
  tx: DatabaseTransaction,
  request: BoundedPlacementReadRequest,
): Promise<LiveSiblingRow | undefined> {
  const lock = request.forUpdate ? sql`for update` : sql``;
  const exclude = request.excludeNodeId === undefined
    ? sql`true`
    : sql`id <> ${request.excludeNodeId}`;
  const result = await sql<RawSiblingRow>`
    select id, position_token
    from nodes
    where collection_id = ${request.collectionId}
      and parent_id = ${request.parentId}
      and deleted_at is null
      and is_root = false
      and ${exclude}
    order by position_token collate "C" desc, id desc
    limit 1
    ${lock}
  `.execute(tx);
  return mapRow(result.rows[0]);
}

async function readNeighborsBefore(
  tx: DatabaseTransaction,
  request: RebalanceWindowReadRequest,
  anchorToken: string,
  anchorId: string,
  limit: number,
): Promise<readonly LiveSiblingRow[]> {
  if (limit <= 0) return [];
  const lock = request.forUpdate ? sql`for update` : sql``;
  const exclude = request.excludeNodeId === undefined
    ? sql`true`
    : sql`id <> ${request.excludeNodeId}`;
  const result = await sql<RawSiblingRow>`
    select id, position_token
    from nodes
    where collection_id = ${request.collectionId}
      and parent_id = ${request.parentId}
      and deleted_at is null
      and is_root = false
      and ${exclude}
      and (position_token collate "C", id) < (${anchorToken}::text collate "C", ${anchorId})
    order by position_token collate "C" desc, id desc
    limit ${limit}
    ${lock}
  `.execute(tx);
  return result.rows
    .map((row) => mapRow(row))
    .filter((row): row is LiveSiblingRow => row !== undefined)
    .reverse();
}

async function readNeighborsAfter(
  tx: DatabaseTransaction,
  request: RebalanceWindowReadRequest,
  anchorToken: string,
  anchorId: string,
  limit: number,
): Promise<readonly LiveSiblingRow[]> {
  if (limit <= 0) return [];
  const lock = request.forUpdate ? sql`for update` : sql``;
  const exclude = request.excludeNodeId === undefined
    ? sql`true`
    : sql`id <> ${request.excludeNodeId}`;
  const result = await sql<RawSiblingRow>`
    select id, position_token
    from nodes
    where collection_id = ${request.collectionId}
      and parent_id = ${request.parentId}
      and deleted_at is null
      and is_root = false
      and ${exclude}
      and (position_token collate "C", id) > (${anchorToken}::text collate "C", ${anchorId})
    order by position_token collate "C" asc, id asc
    limit ${limit}
    ${lock}
  `.execute(tx);
  return result.rows
    .map((row) => mapRow(row))
    .filter((row): row is LiveSiblingRow => row !== undefined);
}

function dedupeOrdered(rows: readonly LiveSiblingRow[]): LiveSiblingRow[] {
  const seen = new Set<string>();
  const ordered: LiveSiblingRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    ordered.push(row);
  }
  return ordered;
}

function toPlacementSiblings(rows: readonly LiveSiblingRow[]) {
  return rows.map((row) => ({ id: row.id, positionToken: row.positionToken }));
}

interface NeighborhoodRow {
  parent_id: string | null;
  position: string | null;
  after_id: string | null;
  before_id: string | null;
}

export function liveSiblingNeighborhoodQuery(collectionId: string, nodeId: string) {
  return sql<NeighborhoodRow>`
    select target.parent_id as parent_id,
           target.position_token as position,
           predecessor.id as after_id,
           successor.id as before_id
      from nodes as target
      left join lateral (
        select sibling.id
          from nodes as sibling
         where sibling.collection_id = target.collection_id
           and sibling.parent_id = target.parent_id
           and sibling.deleted_at is null
           and sibling.is_root = false
           and sibling.id <> target.id
           and sibling.position_token is not null
           and (sibling.position_token collate "C", sibling.id)
             < (target.position_token collate "C", target.id)
         order by sibling.position_token collate "C" desc, sibling.id desc
         limit 1
      ) predecessor on true
      left join lateral (
        select sibling.id
          from nodes as sibling
         where sibling.collection_id = target.collection_id
           and sibling.parent_id = target.parent_id
           and sibling.deleted_at is null
           and sibling.is_root = false
           and sibling.id <> target.id
           and sibling.position_token is not null
           and (sibling.position_token collate "C", sibling.id)
             > (target.position_token collate "C", target.id)
         order by sibling.position_token collate "C" asc, sibling.id asc
         limit 1
      ) successor on true
     where target.collection_id = ${collectionId}
       and target.id = ${nodeId}
       and target.deleted_at is null
  `;
}

export function compileLiveSiblingNeighborhoodQuery(
  db: Kysely<DatabaseSchema>,
  collectionId: string,
  nodeId: string,
) {
  return liveSiblingNeighborhoodQuery(collectionId, nodeId).compile(db);
}

export async function readLiveSiblingNeighborhood(
  tx: DatabaseTransaction,
  request: LiveSiblingNeighborhoodRequest,
): Promise<LiveSiblingNeighborhood> {
  const result = await liveSiblingNeighborhoodQuery(request.collectionId, request.nodeId).execute(tx);
  const row = result.rows[0];
  if (!row) {
    throw new LiveSiblingNeighborhoodError('not_found', 'live sibling target was not found');
  }
  if (row.parent_id === null || row.position === null) {
    throw new LiveSiblingNeighborhoodError('missing_position', 'live sibling target is missing parent or position');
  }
  if (request.expectedParentId !== undefined && row.parent_id !== request.expectedParentId) {
    throw new LiveSiblingNeighborhoodError(
      'inconsistent_parent',
      'live sibling target parent does not match the expected parent',
    );
  }
  return {
    parentId: row.parent_id,
    afterId: row.after_id,
    beforeId: row.before_id,
    position: row.position,
  };
}

export async function readBoundedPlacementContext(
  tx: DatabaseTransaction,
  request: BoundedPlacementReadRequest,
): Promise<BoundedPlacementReadResult> {
  const { afterId, beforeId } = request;
  if (afterId !== undefined && beforeId !== undefined) {
    if (afterId === beforeId) stale('afterId and beforeId must be adjacent target siblings');
    const after = await readLiveSiblingById(tx, request, afterId);
    const before = await readLiveSiblingById(tx, request, beforeId);
    if (!after) stale('afterId is not a live target sibling');
    if (!before) stale('beforeId is not a live target sibling');
    const successor = await readSuccessor(tx, request, after.positionToken, after.id);
    if (successor?.id !== before.id) {
      stale('afterId and beforeId must be adjacent target siblings');
    }
    const siblings = [after, before];
    const placement = resolvePlacement(toPlacementSiblings(siblings), afterId, beforeId);
    return { siblings, placement, insertIndex: placement.insertIndex };
  }

  if (afterId !== undefined) {
    const after = await readLiveSiblingById(tx, request, afterId);
    if (!after) stale('afterId is not a live target sibling');
    const successor = await readSuccessor(tx, request, after.positionToken, after.id);
    const siblings = successor ? [after, successor] : [after];
    const placement = resolvePlacement(toPlacementSiblings(siblings), afterId, undefined);
    return { siblings, placement, insertIndex: placement.insertIndex };
  }

  if (beforeId !== undefined) {
    const before = await readLiveSiblingById(tx, request, beforeId);
    if (!before) stale('beforeId is not a live target sibling');
    const predecessor = await readPredecessor(tx, request, before.positionToken, before.id);
    const siblings = predecessor ? [predecessor, before] : [before];
    const placement = resolvePlacement(toPlacementSiblings(siblings), undefined, beforeId);
    return { siblings, placement, insertIndex: placement.insertIndex };
  }

  const tail = await readTailSibling(tx, request);
  const siblings = tail ? [tail] : [];
  const placement = resolvePlacement(toPlacementSiblings(siblings), undefined, undefined);
  return { siblings, placement, insertIndex: placement.insertIndex };
}

export async function readRebalanceWindowSiblings(
  tx: DatabaseTransaction,
  request: RebalanceWindowReadRequest,
): Promise<RebalanceWindowReadResult> {
  const rewriteCount = Math.max(1, request.windowSize);

  if (request.afterId !== undefined && request.beforeId !== undefined) {
    const after = await readLiveSiblingById(tx, {
      collectionId: request.collectionId,
      parentId: request.parentId,
      excludeNodeId: request.excludeNodeId,
      forUpdate: request.forUpdate,
    }, request.afterId);
    const before = await readLiveSiblingById(tx, {
      collectionId: request.collectionId,
      parentId: request.parentId,
      excludeNodeId: request.excludeNodeId,
      forUpdate: request.forUpdate,
    }, request.beforeId);
    if (!after || !before) {
      return {
        windowSiblings: [],
        insertIndex: 0,
        outsideLowerBoundToken: null,
        outsideUpperBoundToken: null,
      };
    }
    const additionalSlots = Math.max(0, rewriteCount - 2);
    const leftSlots = Math.floor(additionalSlots / 2);
    const rightSlots = additionalSlots - leftSlots;
    const left = await readNeighborsBefore(tx, request, after.positionToken, after.id, leftSlots);
    const right = await readNeighborsAfter(tx, request, before.positionToken, before.id, rightSlots);
    const windowRows = rewriteCount === 1
      ? [before]
      : dedupeOrdered([...left, after, before, ...right]);
    const first = windowRows[0]!;
    const last = windowRows[windowRows.length - 1]!;
    const outsideLower = rewriteCount === 1
      ? after
      : await readPredecessor(tx, {
        collectionId: request.collectionId,
        parentId: request.parentId,
        excludeNodeId: request.excludeNodeId,
        forUpdate: request.forUpdate,
      }, first.positionToken, first.id);
    const outsideUpper = await readSuccessor(tx, {
      collectionId: request.collectionId,
      parentId: request.parentId,
      excludeNodeId: request.excludeNodeId,
      forUpdate: request.forUpdate,
    }, last.positionToken, last.id);
    return {
      windowSiblings: windowRows.map((row) => ({ id: row.id, positionToken: row.positionToken })),
      insertIndex: windowRows.findIndex((row) => row.id === before.id),
      outsideLowerBoundToken: outsideLower?.positionToken ?? null,
      outsideUpperBoundToken: outsideUpper?.positionToken ?? null,
    };
  }

  const leftSlots = Math.floor(rewriteCount / 2);
  const rightSlots = rewriteCount - leftSlots - 1;
  let center: LiveSiblingRow | undefined;
  if (request.afterId !== undefined) {
    center = await readLiveSiblingById(tx, {
      collectionId: request.collectionId,
      parentId: request.parentId,
      excludeNodeId: request.excludeNodeId,
      forUpdate: request.forUpdate,
    }, request.afterId);
  } else if (request.beforeId !== undefined) {
    center = await readLiveSiblingById(tx, {
      collectionId: request.collectionId,
      parentId: request.parentId,
      excludeNodeId: request.excludeNodeId,
      forUpdate: request.forUpdate,
    }, request.beforeId);
  } else {
    center = await readTailSibling(tx, {
      collectionId: request.collectionId,
      parentId: request.parentId,
      excludeNodeId: request.excludeNodeId,
      forUpdate: request.forUpdate,
    });
  }

  if (!center) {
    return {
      windowSiblings: [],
      insertIndex: 0,
      outsideLowerBoundToken: null,
      outsideUpperBoundToken: null,
    };
  }

  const left = await readNeighborsBefore(tx, request, center.positionToken, center.id, leftSlots);
  const right = await readNeighborsAfter(tx, request, center.positionToken, center.id, rightSlots);
  const windowRows = dedupeOrdered([...left, center, ...right]);
  const first = windowRows[0]!;
  const last = windowRows[windowRows.length - 1]!;
  const outsideLower = await readPredecessor(tx, {
    collectionId: request.collectionId,
    parentId: request.parentId,
    excludeNodeId: request.excludeNodeId,
    forUpdate: request.forUpdate,
  }, first.positionToken, first.id);
  const outsideUpper = await readSuccessor(tx, {
    collectionId: request.collectionId,
    parentId: request.parentId,
    excludeNodeId: request.excludeNodeId,
    forUpdate: request.forUpdate,
  }, last.positionToken, last.id);

  const centerIndex = windowRows.findIndex((row) => row.id === center!.id);
  const insertIndex = request.afterId !== undefined
    ? centerIndex + 1
    : request.beforeId !== undefined
      ? centerIndex
      : windowRows.length;

  return {
    windowSiblings: windowRows.map((row) => ({ id: row.id, positionToken: row.positionToken })),
    insertIndex,
    outsideLowerBoundToken: outsideLower?.positionToken ?? null,
    outsideUpperBoundToken: outsideUpper?.positionToken ?? null,
  };
}

export function isUnboundedLiveSiblingScan(query: string): boolean {
  const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized.includes(' from nodes')) return false;
  if (!normalized.includes('parent_id')) return false;
  if (!normalized.includes('position_token')) return false;
  if (normalized.includes(' limit ')) return false;
  if (normalized.includes('position_token collate "c", id)')) return false;
  return normalized.includes('order by') && normalized.includes('position_token');
}
