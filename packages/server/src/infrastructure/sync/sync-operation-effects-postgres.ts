import { sql, type Selectable, type Transaction } from 'kysely';
import {
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  validateAuthoritativePullEventPages,
} from '@know-n/colp/sync';
import type {
  AuthoritativeEffectPage,
  AuthoritativePullEffect,
  Node,
  Operation,
  SyncTombstone,
} from '@know-n/colp/types';
import type { DatabaseSchema } from '../database/runtime.js';
import { readLiveSiblingNeighborhood, LiveSiblingNeighborhoodError } from '../collections/postgres-sibling-placement-read.js';
import {
  buildAuthoritativeEffectPages,
  SyncOperationEffectIntegrityError,
  validatePersistedAuthoritativeEffect,
} from '../../modules/sync/index.js';

export type SyncOperationEffectFaultPhase =
  | 'effect_built' | 'effect_persisted' | 'effect_pages_persisted';

export interface PersistAuthoritativeOperationEffectInput {
  readonly transaction: Transaction<DatabaseSchema>;
  readonly operation: Operation;
  readonly commitOrdinal: bigint;
  readonly terminalStatus: 'applied' | 'rebased';
  readonly cursor: string;
  readonly targetId?: string;
  readonly sourceParentId?: string;
  readonly memberIds?: readonly string[];
  readonly consumedTombstone?: SyncTombstone;
  readonly effectPageAuthority?: string;
  readonly effectPageTemplate?: string;
  readonly faultInjector?: { afterPhase?(phase: SyncOperationEffectFaultPhase): void | Promise<void> };
}

export async function persistAuthoritativeOperationEffect(
  input: PersistAuthoritativeOperationEffectInput,
): Promise<AuthoritativePullEffect> {
  const { transaction, operation, commitOrdinal, terminalStatus, cursor } = input;
  if (terminalStatus !== 'applied' && terminalStatus !== 'rebased') {
    throw new SyncOperationEffectIntegrityError();
  }
  await sql`select set_config('known.sync_authority', 'server', true)`.execute(transaction);
  const operationResult = await sql<{ collection_id: string; operation_id: string;
    commit_ordinal: bigint; sync_wire_json: Record<string, unknown> | null }>`
    SELECT operation.collection_id, operation.operation_id, operation.commit_ordinal,
      payload.sync_wire_json FROM operations operation
    LEFT JOIN operation_payloads payload ON payload.operation_id=operation.operation_id
    WHERE operation.collection_id=${operation.collectionId!}
      AND operation.operation_id=${operation.opId} FOR UPDATE OF operation`.execute(transaction);
  const operationRow = operationResult.rows[0];
  if (!operationRow || operationRow.sync_wire_json === null
      || BigInt(operationRow.commit_ordinal) !== commitOrdinal
      || canonical(operationRow.sync_wire_json) !== canonical(operation)) {
    throw new SyncOperationEffectIntegrityError();
  }
  const cutover = await transaction.selectFrom('sync_collection_effect_cutovers')
    .select('effect_cutover_ordinal').where('collection_id', '=', operation.collectionId!)
    .forUpdate().executeTakeFirst();
  if (!cutover || commitOrdinal < BigInt(cutover.effect_cutover_ordinal)) {
    throw new SyncOperationEffectIntegrityError();
  }

  const { draft, pages } = await buildEffect(input);
  const effect = validatePersistedAuthoritativeEffect({ operation, effect: draft, cursor,
    ...(input.effectPageAuthority ? { effectPageAuthority: input.effectPageAuthority } : {}),
    ...(input.effectPageTemplate ? { effectPageTemplate: input.effectPageTemplate } : {}) });
  await input.faultInjector?.afterPhase?.('effect_built');
  await transaction.insertInto('sync_operation_effects').values({
    effect_id: effect.effectId, collection_id: effect.collectionId,
    operation_id: effect.opId, origin_replica_id: effect.replicaId,
    origin_sequence: BigInt(effect.sequence), commit_ordinal: commitOrdinal,
    protocol_version: '0.2', terminal_status: terminalStatus,
    operation_digest: effect.operationDigest, effect_json: effect as unknown as Record<string, unknown>,
    effect_digest: effect.effectDigest,
  }).execute();
  await input.faultInjector?.afterPhase?.('effect_persisted');
  if (pages.length > 0) {
    if (effect.kind !== 'subtree_deleted' || !('effectRef' in effect) || !effect.effectRef) {
      throw new SyncOperationEffectIntegrityError();
    }
    validateAuthoritativePullEventPages(pages, { ...effect.effectRef, effectId: effect.effectId,
      rootId: effect.rootTombstone.targetId });
    await transaction.insertInto('sync_operation_effect_pages').values(pages.map((page) => ({
      effect_id: page.effectId, page_number: page.pageNumber, page_count: page.pageCount,
      member_count: page.memberCount, page_json: page as unknown as Record<string, unknown>,
      page_digest: page.pageDigest, previous_page_digest: page.previousPageDigest,
    }))).execute();
  }
  await input.faultInjector?.afterPhase?.('effect_pages_persisted');
  return effect;
}

async function buildEffect(input: PersistAuthoritativeOperationEffectInput): Promise<{
  readonly draft: AuthoritativePullEffect; readonly pages: readonly AuthoritativeEffectPage[];
}> {
  const binding = {
    effectId: input.operation.opId, opId: input.operation.opId,
    replicaId: input.operation.replicaId, sequence: input.operation.sequence,
    collectionId: input.operation.collectionId!, status: input.terminalStatus,
    operationDigest: canonicalOperationDigest(input.operation), effectDigest: '',
  } as const;
  if (input.operation.type === 'delete_node' || input.operation.type === 'delete_subtree') {
    return buildDeleteEffect(input, binding);
  }
  if (input.operation.type === 'restore_node') {
    const node = await readFinalNode(input.transaction, input.operation.collectionId!,
      input.operation.targetId!);
    if (!input.consumedTombstone) throw new SyncOperationEffectIntegrityError();
    const placement = await readPlacement(input.transaction, node.collectionId, node.id, node.parentId!);
    return { draft: { ...binding, kind: 'node_restored', node, placement,
      parentRevision: await readParentRevision(input.transaction, node.collectionId, node.parentId!),
      consumedTombstone: input.consumedTombstone }, pages: [] };
  }
  const node = await readFinalNode(input.transaction, input.operation.collectionId!,
    input.operation.type === 'create_node' ? input.targetId! : input.operation.targetId!);
  if (input.operation.type === 'update_node_content') {
    return { draft: { ...binding, kind: 'node_content_updated', node }, pages: [] };
  }
  const placement = await readPlacement(input.transaction, node.collectionId, node.id, node.parentId!);
  if (input.operation.type === 'create_node') {
    return { draft: { ...binding, kind: 'node_created', node, placement,
      parentRevision: await readParentRevision(input.transaction, node.collectionId, node.parentId!),
      nodeChildrenRevision: await readNodeChildrenRevision(
        input.transaction, node.collectionId, node.id, node.kind,
      ) }, pages: [] };
  }
  if (input.operation.type !== 'move_node' || !input.sourceParentId) {
    throw new SyncOperationEffectIntegrityError();
  }
  const parentIds = input.sourceParentId === node.parentId
    ? [node.parentId!] : [input.sourceParentId, node.parentId!];
  const parentRevisions = await Promise.all(parentIds.map((parentId) =>
    readParentRevision(input.transaction, node.collectionId, parentId)));
  return { draft: { ...binding, kind: 'node_moved', node, placement, parentRevisions }, pages: [] };
}

async function buildDeleteEffect(
  input: PersistAuthoritativeOperationEffectInput,
  binding: Omit<AuthoritativePullEffect, 'kind'> & Record<string, unknown>,
): Promise<{ readonly draft: AuthoritativePullEffect; readonly pages: readonly AuthoritativeEffectPage[] }> {
  const rows = await input.transaction.selectFrom('sync_node_tombstones').selectAll()
    .where('collection_id', '=', input.operation.collectionId!)
    .where('operation_id', '=', input.operation.opId).orderBy('target_id').execute();
  const root = rows.find((row) => row.target_id === input.operation.targetId);
  if (!root || rows.length < 1 || BigInt(root.delete_commit_ordinal) !== input.commitOrdinal) {
    throw new SyncOperationEffectIntegrityError();
  }
  const tombstone = mapTombstone(root);
  const parentId = typeof root.payload_json.parentId === 'string'
    ? root.payload_json.parentId : input.sourceParentId;
  if (!parentId) throw new SyncOperationEffectIntegrityError();
  const parentRevision = await readParentRevision(input.transaction, root.collection_id, parentId);
  if (input.operation.type === 'delete_node') {
    return { draft: { ...binding, kind: 'node_deleted', deletion: tombstone,
      tombstone, parentRevision } as AuthoritativePullEffect, pages: [] };
  }
  const members = input.memberIds ? [...input.memberIds].sort() : rows.map((row) => row.target_id).sort();
  if (members.length !== root.affected_count || new Set(members).size !== members.length) {
    throw new SyncOperationEffectIntegrityError();
  }
  const memberDigest = canonicalAuthoritativeMemberDigest(members);
  if (members.length <= 512 && Buffer.byteLength(JSON.stringify(members), 'utf8') <= 131_072) {
    return { draft: { ...binding, kind: 'subtree_deleted', rootTombstone: tombstone,
      memberCount: members.length, memberDigest, parentRevision, members } as AuthoritativePullEffect, pages: [] };
  }
  if (!input.effectPageTemplate || !input.effectPageAuthority) throw new SyncOperationEffectIntegrityError();
  const pages = buildAuthoritativeEffectPages(input.operation.opId, members);
  const firstPageDigest = pages[0]?.pageDigest;
  if (!firstPageDigest) throw new SyncOperationEffectIntegrityError();
  return { draft: { ...binding, kind: 'subtree_deleted', rootTombstone: tombstone,
    memberCount: members.length, memberDigest, parentRevision,
    effectRef: { pageCount: pages.length, memberCount: members.length,
      memberDigest, firstPageDigest } } as AuthoritativePullEffect, pages };
}

async function readFinalNode(
  transaction: Transaction<DatabaseSchema>, collectionId: string, nodeId: string,
): Promise<Node> {
  const row = await transaction.selectFrom('nodes').selectAll()
    .where('collection_id', '=', collectionId).where('id', '=', nodeId).executeTakeFirst();
  if (!row || row.deleted_at !== null || row.parent_id === null || row.position_token === null) {
    throw new SyncOperationEffectIntegrityError();
  }
  const payload = row.payload_json ?? {};
  const common = { id: row.id, collectionId: row.collection_id, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), revision: row.resource_revision,
    ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
    ...(isRecord(payload.extensions) ? { extensions: structuredClone(payload.extensions) } : {}),
    visibility: row.visibility,
    parentId: row.parent_id, position: row.position_token };
  if (row.kind === 'folder') return { ...common, kind: 'folder', title: row.title!,
    ...(typeof payload.folderRole === 'string' ? { folderRole: payload.folderRole as never } : {}) };
  if (row.kind === 'separator') return { ...common, kind: 'separator' };
  return { ...common, kind: 'bookmark', title: row.title!, url: row.url!,
    ...(typeof payload.canonicalUrl === 'string' ? { canonicalUrl: payload.canonicalUrl as never } : {}),
    ...(typeof payload.urlHash === 'string' ? { urlHash: payload.urlHash } : {}) };
}

async function readPlacement(
  transaction: Transaction<DatabaseSchema>, collectionId: string, nodeId: string, parentId: string,
) {
  try {
    return await readLiveSiblingNeighborhood(transaction, {
      collectionId, nodeId, expectedParentId: parentId,
    });
  } catch (error: unknown) {
    if (error instanceof LiveSiblingNeighborhoodError) throw new SyncOperationEffectIntegrityError();
    throw error;
  }
}

async function readParentRevision(
  transaction: Transaction<DatabaseSchema>, collectionId: string, parentId: string,
) {
  const row = await transaction.selectFrom('nodes').select('children_revision')
    .where('collection_id', '=', collectionId).where('id', '=', parentId)
    .where('deleted_at', 'is', null).executeTakeFirst();
  if (!row?.children_revision) throw new SyncOperationEffectIntegrityError();
  return { parentId, childrenRevision: row.children_revision };
}

async function readNodeChildrenRevision(
  transaction: Transaction<DatabaseSchema>, collectionId: string, nodeId: string, kind: Node['kind'],
): Promise<string | null> {
  const row = await transaction.selectFrom('nodes').select('children_revision')
    .where('collection_id', '=', collectionId).where('id', '=', nodeId)
    .where('deleted_at', 'is', null).executeTakeFirst();
  if (!row || (kind === 'folder' && !row.children_revision)) throw new SyncOperationEffectIntegrityError();
  return kind === 'folder' ? row.children_revision : null;
}

function mapTombstone(row: Selectable<DatabaseSchema['sync_node_tombstones']>): SyncTombstone {
  return { resourceType: 'node', targetId: row.target_id, collectionId: row.collection_id,
    scope: row.scope, deletedAt: row.deleted_at.toISOString(), deleteRevision: row.delete_revision,
    operationId: row.operation_id, deleteCursor: row.delete_cursor, affectedCount: row.affected_count,
    purgeAfter: row.purge_after.toISOString() };
}

export function validateStoredPageDigest(page: AuthoritativeEffectPage): void {
  if (page.pageDigest !== canonicalAuthoritativeEffectPageDigest(page)) {
    throw new SyncOperationEffectIntegrityError();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SyncOperationEffectIntegrityError();
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
