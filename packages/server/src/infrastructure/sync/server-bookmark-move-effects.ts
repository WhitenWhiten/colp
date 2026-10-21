import { sql } from 'kysely';
import type { Operation, Node } from '@know-n/colp/types';
import { validatePersistedAuthoritativeEffect } from '../../modules/sync/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { PlannedBookmarkMove } from '../collections/canonical-bookmark-move-plan.js';

/** Persist each transaction-local intermediate effect, rather than reading the
 * final folder after the batch and leaking later placement/revision facts. */
export async function persistServerBookmarkMoveEffects(tx: DatabaseTransaction, moves: readonly PlannedBookmarkMove[]) {
  const effects = moves.map(move => {
    const operation = move.input.operationSyncWire as unknown as Operation;
    const n = move.after, payload = n.payload_json ?? {};
    const node = { id: n.id, collectionId: n.collection_id, kind: 'bookmark', title: n.title!, url: n.url!,
      parentId: n.parent_id!, position: n.position_token!, revision: n.resource_revision,
      createdAt: n.created_at.toISOString(), updatedAt: n.updated_at.toISOString(), visibility: n.visibility,
      ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
      ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
      ...(typeof payload.canonicalUrl === 'string' ? { canonicalUrl: payload.canonicalUrl } : {}),
      ...(typeof payload.urlHash === 'string' ? { urlHash: payload.urlHash } : {}),
      extensions: payload.extensions ?? {},
    } as Node;
    const effect = validatePersistedAuthoritativeEffect({ operation, cursor: `server-move-${move.result.allocation.commitOrdinal}`,
      effect: { effectId: operation.opId, opId: operation.opId, replicaId: operation.replicaId,
        sequence: operation.sequence, collectionId: move.input.collectionId, status: 'applied',
        operationDigest: '', effectDigest: '', kind: 'node_moved', node, placement: move.placement,
        parentRevisions: [...new Set([move.sourceParentId, n.parent_id!])].map(parentId => ({
          parentId, childrenRevision: move.result.allocation.childrenRevisions[parentId]!,
        })),
      } });
    return { effect_id: effect.effectId, collection_id: effect.collectionId, operation_id: effect.opId,
      origin_replica_id: effect.replicaId, origin_sequence: BigInt(effect.sequence),
      commit_ordinal: move.result.allocation.commitOrdinal, protocol_version: '0.2' as const, terminal_status: 'applied' as const,
      operation_digest: effect.operationDigest, effect_digest: effect.effectDigest,
      effect_json: effect as unknown as Record<string, unknown> };
  });
  await sql`select set_config('known.sync_authority', 'server', true)`.execute(tx);
  await tx.insertInto('sync_operation_effects').values(effects).execute();
}
