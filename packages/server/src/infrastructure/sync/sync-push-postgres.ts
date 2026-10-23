import { admitPushBatch } from './postgres/sync-push-batch-postgres.js';
import { assertOperationIdClaimed } from './postgres/sync-push-repository-postgres.js';
import { SnapshotTreeCapacityError, PositionRebalanceEscalationError } from '../../modules/collections/index.js';
import { createHmac } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { VerifiedSyncSession } from '@know-n/colp/sync';
import { collectionSequenceScopeKey } from '@know-n/colp/sync';
import type { SyncPushResult } from '@know-n/colp/types';
import type { DatabaseSchema } from '../database/runtime.js';
import { DatabaseOperationError } from '../database/errors.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { evaluatePushDependencies } from './postgres/sync-push-dependencies-postgres.js';
import { assertBootstrapPushMode } from './postgres/sync-push-bootstrap-mode-postgres.js';
import {
  evaluateUnsupportedSyncOperation,
  SyncPushHttpError,
  SyncSequenceBatchBindingError,
  type SyncPushHttpApplication,
  type SyncPushHttpApplicationInput,
} from '../../modules/sync/index.js';
import type { PostgresSyncSessionIssuer } from './sync-session-postgres.js';
import {
  ManagedAncestryPolicyError,
  type ManagedAncestryCapabilities,
} from './managed-ancestry-policy.js';
import {
  createPostgresSyncSequencePort,
  SyncSequencePersistenceError,
  type PostgresSyncSequencePortOptions,
} from './sync-sequence-postgres.js';
import {
  mapSequenceError,
  sessionLeaseGeneration,
  singleOperation,
  unwrapCoordinatedResult,
  wrapPushAttemptResult,
} from './postgres/sync-push-admission-postgres.js';
import {
  evaluateCanonicalNodeCreate,
  evaluateCanonicalNodeUpdate,
} from './postgres/sync-push-create-update-postgres.js';
import {
  evaluateCanonicalNodeDelete,
  evaluateCanonicalNodeMove,
} from './postgres/sync-push-move-delete-postgres.js';
import { applyCanonicalNodeRestore } from './sync-node-restore-postgres.js';
import { appliedPushResult } from './postgres/sync-push-repository-postgres.js';
import type { PostgresSyncNodeCreateOptions } from './postgres/sync-push-types-postgres.js';
import type { Operation } from '@know-n/colp/types';
import type { PushSequenceTransaction } from './postgres/sync-push-repository-postgres.js';

export type {
  PostgresSyncNodeCreateFaultPhase,
  PostgresSyncNodeUpdateFaultPhase,
  PostgresSyncNodeMoveFaultPhase,
  PostgresSyncNodeDeleteFaultPhase,
  PostgresSyncPushFaultPhase,
  PostgresSyncNodeCreateOptions,
} from './postgres/sync-push-types-postgres.js';
export type { PostgresSyncConflictFaultPhase } from './sync-conflict-postgres.js';

export function createPostgresSyncPushApplication(
  db: Kysely<DatabaseSchema>,
  sessionIssuer: PostgresSyncSessionIssuer,
  options: PostgresSyncNodeCreateOptions = {},
): SyncPushHttpApplication {
  const sequenceOptions: PostgresSyncSequencePortOptions = {
    ...(options.auditPayloadColdSource === undefined
      ? {} : { auditPayloadColdSource: options.auditPayloadColdSource }),
    faultInjector: {
      async afterPhase(phase) {
        if (phase === 'before_receipt_finalize') {
          await options.faultInjector?.afterPhase?.('before_receipt_finalize');
        } else if (phase === 'before_commit') {
          await options.faultInjector?.afterPhase?.('sequence_before_commit');
        } else if (phase === 'after_commit') {
          await options.faultInjector?.afterPhase?.('sequence_after_commit');
        }
      },
    },
  };
  const sequence = createPostgresSyncSequencePort(db, sequenceOptions);
  return Object.freeze({
    runtimeOwnership: Object.freeze({
      operationIdReservationOwner: 'sequence' as const,
      usesPushCoordinator: false as const,
      maxBatchOperations: 50,
      evaluator: 'canonical_node_create_update_move_delete' as const,
      trustedBaseOwner: 'sync_node_revision_history' as const,
      conflictBoundary: 'persisted_open' as const,
    }),
    admit: (input: SyncPushHttpApplicationInput) => {
      options.metrics?.observe('sync.push.batch_operations', input.request.operations.length);
      return admitPushBatch(db, sessionIssuer, input, admitSingle, {
        beforeCommit: () => options.faultInjector?.afterPhase?.('sequence_before_commit'),
        afterCommit: () => options.faultInjector?.afterPhase?.('sequence_after_commit'),
      });
    },
  });

  async function admitSingle(input: SyncPushHttpApplicationInput, session: VerifiedSyncSession,
    transaction?: DatabaseTransaction): Promise<SyncPushResult> {
    const database = transaction ?? db;
    const sequenceOwner = transaction
      ? createPostgresSyncSequencePort(transaction, { ...sequenceOptions, transaction }) : sequence;
    const operation = singleOperation(input);
    const persisted = await database.selectFrom('sync_sessions').select('secret_digest')
      .where('session_id', '=', session.sessionId).executeTakeFirst();
    if (!persisted) throw new SyncPushHttpError('resource_not_found');
    const serverBatchId = `${session.sessionId}.${createHmac('sha256', persisted.secret_digest)
      .update('known.sync-push.batch.v1\0', 'utf8')
      .update(input.idempotencyKey, 'utf8').digest('base64url')}`;
    // SYNC-R02: managed-bookmarks ancestry writes need the deployment
    // capability AND the transaction-local Replica write capability. The
    // Sequence coordinator re-verifies `capabilities_json.write` inside the
    // same transaction before any evaluator runs; the session scope below is
    // the same fact minted from that capability.
    const managedAncestry: ManagedAncestryCapabilities = Object.freeze({
      managedBookmarkWrites: options.managedBookmarkWrites === true,
      replicaWrite: session.authorizationScopes.includes('sync:push'),
    });
    try {
      const coordinated = await sequenceOwner.coordinateAuthorized<SyncPushResult>({
        session,
        replicaId: operation.replicaId,
        leaseGeneration: await sessionLeaseGeneration(database, session.sessionId),
        sequenceScope: collectionSequenceScopeKey(operation.collectionId!),
        sequence: operation.sequence,
        operationId: operation.opId,
        serverBatchId,
        mediaType: input.mediaType,
        endpointIdentity: input.endpointIdentity,
        // Client batchId is intentionally excluded from Sequence receipt authority.
        payload: Object.freeze({ atomic: input.request.atomic, operation }),
        // A same-binding retry may re-evaluate a durable deferred receipt. The
        // Sequence coordinator still returns the stored result unless the
        // evaluator can atomically transition it to a terminal outcome.
        reevaluateDeferred: true,
        transactionalAuthority: Object.freeze({
          credential: input.credential,
          origin: input.origin,
        }),
      }, async (_context, transaction) => {
        await assertBootstrapPushMode(transaction, session.sessionId, operation);
        const dependency = await evaluatePushDependencies(operation, serverBatchId, transaction);
        if (dependency) return dependency;
        if (operation.type === 'create_node') {
          return evaluateCanonicalNodeCreate(operation, serverBatchId, transaction, options, managedAncestry);
        }
        if (operation.type === 'update_node_content') {
          return evaluateCanonicalNodeUpdate(
            operation, serverBatchId, session.sessionId, transaction, options, managedAncestry,
          );
        }
        if (operation.type === 'move_node') {
          return evaluateCanonicalNodeMove(operation, serverBatchId, transaction, options, managedAncestry);
        }
        if (operation.type === 'delete_node' || operation.type === 'delete_subtree') {
          return evaluateCanonicalNodeDelete(operation, serverBatchId, transaction, options, managedAncestry);
        }
        if (operation.type === 'restore_node') {
          return evaluateCanonicalNodeRestore(operation, serverBatchId, transaction, options, managedAncestry);
        }
        return evaluateUnsupportedSyncOperation();
      });
      return wrapPushAttemptResult(unwrapCoordinatedResult(coordinated.result), serverBatchId);
    } catch (error) {
      if (error instanceof PositionRebalanceEscalationError) throw new SyncPushHttpError('position_context_stale');
      if (error instanceof SnapshotTreeCapacityError) throw new SyncPushHttpError('payload_too_large');
      if (error instanceof SyncPushHttpError) throw error;
      if (error instanceof ManagedAncestryPolicyError) throw new SyncPushHttpError(error.code);
      if (error instanceof SyncSequencePersistenceError) throw mapSequenceError(error);
      // A batchId that violates the Session binding contract is a recognized
      // document problem (4xx), never an unclassified internal fault (F021).
      if (error instanceof SyncSequenceBatchBindingError) {
        throw new SyncPushHttpError('invalid_document');
      }
      if (error instanceof DatabaseOperationError) throw error;
      // Keep the original failure as the cause so the route can record the
      // unrecognized error (e.g. a COLP fail-closed assertion) that the
      // stable internal_error Problem deliberately hides from the client.
      throw new SyncPushHttpError('internal_error', undefined, undefined, { cause: error });
    }
  }
}

async function evaluateCanonicalNodeRestore(
  operation: Operation,
  serverBatchId: string,
  transaction: PushSequenceTransaction,
  options: PostgresSyncNodeCreateOptions,
  managedAncestry: ManagedAncestryCapabilities,
) {
  const applied = await applyCanonicalNodeRestore(transaction.databaseTransaction, {
    operation,
    managedAncestry,
    operationIdClaimOwner: { assertClaimed: assertOperationIdClaimed },
    reportSourceInvalidation: options.reportSourceInvalidation,
    actorPrincipalId: transaction.authority.accountId,
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
    ...(options.effectPageAuthority ? { effectPageAuthority: options.effectPageAuthority } : {}),
    ...(options.effectPageTemplate ? { effectPageTemplate: options.effectPageTemplate } : {}),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return appliedPushResult(
    serverBatchId, operation, 'applied', operation.targetId!, applied.revision, applied.cursor,
  );
}
