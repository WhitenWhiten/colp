import { randomUUID } from 'node:crypto';
import { allocatePosition, createCanonicalMutationApplication, assertLibraryDestination } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import { createPostgresNodeWritePort } from '../collections/repositories.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SourceArchiveError, type ManagedReconcilePorts } from '../../modules/source-archives/index.js';
import { lockManagedLibrary, managedSavePorts } from './managed-copies.js';
export function managedReconcilePorts(tx: DatabaseTransaction, subjectId: string, accountId: string): ManagedReconcilePorts {
  const nodes = createPostgresNodeWritePort(tx), read = managedSavePorts(tx, subjectId, accountId).read;
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, { invalidateSyncReplicasOnNodeMutation: true, replicaLocksAlreadyHeld: () => true }));
  return { read, async mutate(c, undoDelete = false) {
    const library = await lockManagedLibrary(tx, subjectId, c.collectionId);
    const node = await nodes.getNode(c.collectionId, c.expected.nodeId), parent = await nodes.getNode(c.collectionId, c.parentId);
    if (!node || !parent || parent.deletedAt || parent.kind !== 'folder' || node.isRoot) throw new SourceArchiveError('source_reconcile_conflict');
    await assertLibraryDestination({ nodes }, library, parent);
    if (node.kind === 'folder') {
      const seen = new Set<string>(); let ancestor: string | null = parent.id;
      while (ancestor) { if (ancestor === node.id || seen.has(ancestor) || seen.size >= 256) throw new SourceArchiveError('source_reconcile_conflict'); seen.add(ancestor); ancestor = (await nodes.getNode(c.collectionId, ancestor))?.parentId ?? null; }
    }
    let position: string | undefined;
    if (node.deletedAt) {
      const deletion = await tx.selectFrom('sync_node_tombstones').select(['delete_revision', 'payload_purged_at']).where('collection_id', '=', c.collectionId).where('target_id', '=', node.id).executeTakeFirst();
      if (!deletion || deletion.payload_purged_at !== null || deletion.delete_revision !== c.expected.revision) throw new SourceArchiveError('source_reconcile_restore_unavailable');
      const siblings = await tx.selectFrom('nodes').select('position_token').where('collection_id', '=', c.collectionId).where('parent_id', '=', parent.id).where('deleted_at', 'is', null).execute();
      const tokens = siblings.flatMap(n => n.position_token ? [n.position_token] : []).sort(); position = allocatePosition(tokens.at(-1) ?? null, null, tokens);
    }
    await canonical.execute({ transaction: tx }, { operationId: randomUUID(), collectionId: c.collectionId, actor: { principalId: accountId, principalType: 'account' },
      intakeDisposition: 'userSelected', automationContext: { origin: 'import' }, mutation: {
        action: undoDelete ? 'delete' : node.deletedAt ? 'restore' : c.parentId !== node.parentId ? 'move' : 'update',
        target: { collectionId: c.collectionId, resourceId: node.id, resourceKind: 'node' }, parentId: c.parentId, expectedResourceRevision: node.resourceRevision,
        fields: { kindFields: { kind: node.kind, title: c.title, url: node.url, description: node.description, tags: node.tags, visibility: node.visibility }, extensions: {} },
        ...(position ? { trustedFacts: { restorePositionToken: position } } : {}),
      } });
    return (await read(c.collectionId, node.id))!;
  } };
}
