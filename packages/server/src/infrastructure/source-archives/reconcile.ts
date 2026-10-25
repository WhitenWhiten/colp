import { randomUUID, createHash } from 'node:crypto';
import type { Operation, SyncTombstone } from '@know-n/colp/types';
import { allocatePosition, createCanonicalMutationApplication, assertLibraryDestination, CollectionsError, NODE_DELETION_PURGE_RETENTION_MS, type JsonObject } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import { createPostgresNodeWritePort } from '../collections/repositories.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SourceArchiveError, type ManagedReconcilePorts } from '../../modules/source-archives/index.js';
import { lockManagedLibrary, managedSavePorts } from './managed-copies.js';
import { persistAuthoritativeOperationEffect, createPostgresSyncNodeTombstonePort } from '../sync/index.js';
export function managedReconcilePorts(tx: DatabaseTransaction, subjectId: string, accountId: string): ManagedReconcilePorts {
  const nodes = createPostgresNodeWritePort(tx), read = managedSavePorts(tx, subjectId, accountId).read;
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, { replicaLocksAlreadyHeld: () => true }));
  const conflict = (e: unknown): never => { if (e instanceof CollectionsError) throw new SourceArchiveError('source_reconcile_conflict'); throw e; };
  return { read, async mutate(c, undoDelete = false) {
    const library = await lockManagedLibrary(tx, subjectId, c.collectionId);
    const node = await nodes.getNode(c.collectionId, c.expected.nodeId), parent = await nodes.getNode(c.collectionId, c.parentId);
    if (!node || !parent || parent.deletedAt || parent.kind !== 'folder' || node.isRoot || node.folderRole !== null) throw new SourceArchiveError('source_reconcile_conflict');
    await assertLibraryDestination({ nodes }, library, parent).catch(conflict);
    if (node.kind === 'folder') {
      const seen = new Set<string>(); let ancestor: string | null = parent.id;
      while (ancestor) { if (ancestor === node.id || seen.has(ancestor) || seen.size >= 256) throw new SourceArchiveError('source_reconcile_conflict'); seen.add(ancestor); ancestor = (await nodes.getNode(c.collectionId, ancestor))?.parentId ?? null; }
    }
    let position: string | undefined, consumedTombstone: SyncTombstone | undefined;
    if (node.deletedAt) {
      const deletion = await tx.selectFrom('sync_node_tombstones').selectAll().where('collection_id', '=', c.collectionId).where('target_id', '=', node.id).executeTakeFirst();
      if (!deletion || deletion.payload_purged_at !== null || deletion.delete_revision !== c.expected.revision) throw new SourceArchiveError('source_reconcile_restore_unavailable');
      consumedTombstone = { resourceType: 'node', targetId: deletion.target_id, collectionId: deletion.collection_id, scope: deletion.scope,
        deletedAt: deletion.deleted_at.toISOString(), deleteRevision: deletion.delete_revision, operationId: deletion.operation_id,
        deleteCursor: deletion.delete_cursor, affectedCount: deletion.affected_count, purgeAfter: deletion.purge_after.toISOString() };
      const siblings = await tx.selectFrom('nodes').select('position_token').where('collection_id', '=', c.collectionId).where('parent_id', '=', parent.id).where('deleted_at', 'is', null).execute();
      const tokens = siblings.flatMap(n => n.position_token ? [n.position_token] : []).sort(); position = allocatePosition(tokens.at(-1) ?? null, null, tokens);
    }
    const action = undoDelete ? 'delete' : node.deletedAt ? 'restore' : c.parentId !== node.parentId ? 'move' : 'update';
    const operationId = randomUUID(), common = { opId: operationId, collectionId: c.collectionId, targetId: node.id, baseRevision: node.resourceRevision,
      replicaId: `server-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`, sequence: 1, occurredAt: new Date().toISOString(), dependencies: [] };
    const source = node.parentId && await nodes.getNode(c.collectionId, node.parentId);
    if (action === 'move' && (!source || !source.childrenRevision || !parent.childrenRevision)) throw new SourceArchiveError('source_reconcile_conflict');
    const operation: Operation = action === 'move' ? { ...common, type: 'move_node', payload: { newParentId: parent.id,
      baseSourceParentRevision: source && source.childrenRevision || '', baseTargetParentRevision: parent.childrenRevision! } }
      : action === 'update' ? { ...common, type: 'update_node_content', payload: { base: { title: node.title }, value: { title: c.title } } }
      : action === 'restore' ? { ...common, type: 'restore_node', payload: { newParentId: parent.id } } : { ...common, type: 'delete_node', payload: {} };
    const result = await canonical.execute({ transaction: tx }, { operationId, collectionId: c.collectionId, actor: { principalId: accountId, principalType: 'account' },
      operationSyncWire: operation as unknown as JsonObject,
      intakeDisposition: 'userSelected', automationContext: { origin: 'import' }, mutation: {
        action,
        target: { collectionId: c.collectionId, resourceId: node.id, resourceKind: 'node' }, parentId: c.parentId, expectedResourceRevision: node.resourceRevision,
        fields: { kindFields: { kind: node.kind, title: c.title, url: node.url, description: node.description, tags: node.tags, visibility: node.visibility }, extensions: {} },
        ...(position ? { trustedFacts: { restorePositionToken: position } } : {}),
        ...(undoDelete ? { deleteIntent: { scope: 'single' as const } } : {}),
      } }).catch(conflict);
    if (undoDelete) {
      const deleted = await tx.selectFrom('nodes').select(['deleted_at', 'payload_json']).where('collection_id', '=', c.collectionId).where('id', '=', node.id).executeTakeFirstOrThrow();
      if (!deleted.deleted_at) throw new SourceArchiveError('source_reconcile_conflict');
      await createPostgresSyncNodeTombstonePort(tx).append({ collectionId: c.collectionId, rootTargetId: node.id, operationId, scope: 'single',
        deleteCommitOrdinal: result.allocation.commitOrdinal, deleteCursor: `source-reconcile-${result.allocation.commitOrdinal}`, deletedAt: deleted.deleted_at,
        purgeAfter: new Date(deleted.deleted_at.getTime() + NODE_DELETION_PURGE_RETENTION_MS),
        members: [{ targetId: node.id, kind: node.kind, deleteRevision: result.allocation.resourceRevision!, extensions: (deleted.payload_json?.extensions ?? {}) as JsonObject }] });
    }
    await persistAuthoritativeOperationEffect({ transaction: tx, operation, commitOrdinal: result.allocation.commitOrdinal, terminalStatus: 'applied',
      cursor: `source-reconcile-${result.allocation.commitOrdinal}`, ...(node.parentId ? { sourceParentId: node.parentId } : {}),
      ...(consumedTombstone ? { consumedTombstone } : {}) });
    return (await read(c.collectionId, node.id))!;
  } };
}
