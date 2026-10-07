import type { ReportSourceInvalidationOutboxPort } from '../../outbox/report-source-invalidation-producer.js';
import { randomBytes } from 'node:crypto';
import type { Operation } from '@know-n/colp/types';
import {
  createCanonicalMutationApplication,
} from '../../../modules/collections/index.js';
import {
  isAllowedRecoveredParent,
  mapSyncNodeCreateOperation,
  SyncNodeCreateError,
  SyncPushHttpError,
} from '../../../modules/sync/index.js';
import { createPostgresCanonicalMutationPorts } from '../../collections/canonical-mutation-postgres-ports.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import { persistSyncOperationProjection } from './sync-pull-postgres.js';
import { persistAuthoritativeOperationEffect } from '../sync-operation-effects-postgres.js';
import { syncCanonicalMutationInput } from '../sync-canonical-mutation-input.js';
import { lookupLiveRecovered } from './sync-push-create-update-postgres.js';
import { mapCanonicalCreateError } from './sync-push-repository-postgres.js';
import type { PostgresSyncNodeCreateOptions } from './sync-push-types-postgres.js';

const RECOVERED_TITLE = 'Recovered';

export interface CreateSystemRecoveredFolderInput {
  readonly collectionId: string;
  readonly parentId: string;
  readonly actorPrincipalId: string;
    readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly now: Date;
  readonly nodeId: () => string;
  readonly faultInjector?: PostgresSyncNodeCreateOptions['faultInjector'];
}

export interface CreateSystemRecoveredFolderResult {
  readonly nodeId: string;
  readonly created: boolean;
  readonly operationId?: string;
}

/** System Recovered create: own opId/replica/sequence, no client Push receipt. */
export async function createSystemRecoveredFolder(
  tx: DatabaseTransaction,
  input: CreateSystemRecoveredFolderInput,
): Promise<CreateSystemRecoveredFolderResult> {
  const existing = await lookupLiveRecovered(tx, input.collectionId, input.parentId);
  if (existing) return { nodeId: existing.id, created: false };
  const parent = await tx.selectFrom('nodes').select(['id', 'is_root', 'kind', 'deleted_at', 'payload_json'])
    .where('collection_id', '=', input.collectionId).where('id', '=', input.parentId).executeTakeFirst();
  if (!parent || parent.deleted_at !== null) throw new SyncPushHttpError('resource_not_found');
  const folderRole = typeof parent.payload_json?.folderRole === 'string' ? parent.payload_json.folderRole : null;
  if (!isAllowedRecoveredParent({ isRoot: parent.is_root, nodeKind: parent.kind, folderRole })) {
    throw new SyncPushHttpError('invalid_document');
  }
  const nodeId = input.nodeId();
  const opId = randomBytes(16).toString('base64url');
  const replicaId = randomBytes(16).toString('base64url');
  const operation = {
    opId, replicaId, sequence: 1, type: 'create_node' as const,
    collectionId: input.collectionId, baseRevision: null, occurredAt: input.now.toISOString(),
    dependencies: [], payload: {
      parentId: input.parentId,
      node: { kind: 'folder' as const, title: RECOVERED_TITLE, folderRole: 'recovered' as const },
    },
  } satisfies Operation;
  let mapped;
  try {
    mapped = mapSyncNodeCreateOperation(operation, { managedBookmarkWrites: false });
  } catch (error) {
    if (error instanceof SyncNodeCreateError) throw new SyncPushHttpError(error.code);
    throw error;
  }
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
    reportSourceInvalidation: input.reportSourceInvalidation,
    faultInjector: {
      async afterPhase(context) {
        if (context.phase === 'resource' && context.resourceId === nodeId) {
          await input.faultInjector?.afterPhase?.('recovered_create');
        }
        if (context.phase === 'revision') await input.faultInjector?.afterPhase?.('history');
        if (context.phase === 'operation') await input.faultInjector?.afterPhase?.('operation');
      },
    },
  }));
  let mutation;
  try {
    mutation = await canonical.execute({ transaction: tx }, syncCanonicalMutationInput(
      operation, input.actorPrincipalId, {
        action: 'create',
        target: { collectionId: input.collectionId, resourceId: nodeId, resourceKind: 'node' },
        parentId: mapped.parentId,
        fields: mapped.fields,
      },
    ));
  } catch (error) {
    throw mapCanonicalCreateError(error);
  }
  await persistSyncOperationProjection(tx, operation);
  const cursor = `sync-create-${mutation.allocation.commitOrdinal}`;
  await persistAuthoritativeOperationEffect({
    transaction: tx, operation, commitOrdinal: mutation.allocation.commitOrdinal,
    terminalStatus: 'applied', cursor, targetId: nodeId,
    ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
  });
  await input.faultInjector?.afterPhase?.('recovered_effect');
  return { nodeId, created: true, operationId: opId };
}
