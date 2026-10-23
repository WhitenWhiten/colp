import { BROWSER_FOLDER_ROLES } from '../../generated/browser-folder-roles.js';
import { randomBytes } from 'node:crypto';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SyncPushHttpError } from '../../modules/sync/index.js';
import { assertManagedAncestryWritable, loadLockedManagedAncestryChain, managedAncestryNodeFact,
  type ManagedAncestryCapabilities } from './managed-ancestry-policy.js';
import { createSystemRecoveredFolder } from './postgres/sync-recovered-create-postgres.js';
import type { PostgresSyncNodeCreateOptions } from './postgres/sync-push-types-postgres.js';

const MOUNT_ROLES = new Set<string>([...BROWSER_FOLDER_ROLES, 'custom']);

/** The caller holds the collection lock. Follow retained parent identity to
 * the owning live mount; a deleted/purged mount falls back to the root. */
export async function resolveRecoveredParent(tx: DatabaseTransaction, input: {
  readonly collectionId: string; readonly originalParentId: string | null; readonly rootNodeId: string;
  readonly actorPrincipalId: string; readonly managedCapabilities: ManagedAncestryCapabilities;
  readonly now: Date; readonly options: PostgresSyncNodeCreateOptions;
}): Promise<string> {
  let cursor = input.originalParentId;
  let parentId = input.rootNodeId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor) || seen.size >= 256) throw new SyncPushHttpError('invalid_document');
    seen.add(cursor);
    const row = await tx.selectFrom('nodes').select(['id', 'parent_id', 'kind', 'is_root', 'deleted_at', 'payload_json'])
      .where('collection_id', '=', input.collectionId).where('id', '=', cursor).forUpdate().executeTakeFirst();
    if (!row) break;
    if (row.kind !== 'folder') throw new SyncPushHttpError('invalid_document');
    assertManagedAncestryWritable([managedAncestryNodeFact(row)], input.managedCapabilities);
    if (row.is_root) break;
    const role = row.payload_json?.folderRole;
    if (typeof role === 'string' && MOUNT_ROLES.has(role) && row.deleted_at === null) { parentId = row.id; break; }
    cursor = row.parent_id;
  }
  assertManagedAncestryWritable(await loadLockedManagedAncestryChain(tx, input.collectionId, parentId), input.managedCapabilities);
  const recovered = await createSystemRecoveredFolder(tx, { collectionId: input.collectionId, parentId,
    actorPrincipalId: input.actorPrincipalId, now: input.now,
    nodeId: input.options.nodeId ?? (() => randomBytes(16).toString('base64url')),
    reportSourceInvalidation: input.options.reportSourceInvalidation,
    ...(input.options.faultInjector ? { faultInjector: input.options.faultInjector } : {}),
  });
  return recovered.nodeId;
}
