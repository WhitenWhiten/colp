import { SnapshotTreeCapacityError } from '../../modules/collections/index.js';
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Conflict, ConflictResolutionResult, NodeCreate, Operation } from '@know-n/colp/types';
import { deepEqualSyncMergeValue } from '@know-n/colp/sync';
import { createValidatorRegistry, preserveExtensions } from '@know-n/colp/schema';
import {
  canonicalSyncConflictResolutionDigest,
  evaluateSyncNodeUpdate,
  mapSyncNodeCreateOperation,
  SyncConflictResolutionError,
  SyncNodeCreateError,
  SyncNodeUpdateError,
  validateSyncConflictResolutionCommand,
  type SyncConflictResolutionApplication,
  type SyncConflictResolutionInput,
  type ValidatedSyncConflictResolutionCommand,
} from '../../modules/sync/index.js';
import {
  CanonicalMutationInvariantError,
  CollectionsError,
  assertValidHttpUrlNoUserInfo,
  assertValidNodeDescription,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  createCanonicalMutationApplication,
  type CanonicalMutationResult,
} from '../../modules/collections/index.js';
import type { DatabaseSchema, SyncConflictTable } from '../database/runtime.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { appendOperationWithPayload } from '../database/operation-payload-store.js';
import { DatabaseOperationError } from '../database/errors.js';
import { lockCollectionReplicaGate, lockSyncReplicaBeforeCollection } from '../database/lock-order.js';
import {
  assertPlainCustomObject as assertPlainCustomObjectValue,
  isRecord,
  stableJson as stableJsonValue,
} from './sync-conflict-json.js';
import {
  decryptPrivatePayload as decryptPrivatePayloadValue,
  type PrivateConflictPayload,
} from './sync-conflict-private-payload.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import type { PostgresSyncSessionIssuer } from './sync-session-postgres.js';
import {
  assertManagedAncestryWritable,
  loadLockedManagedAncestryChain,
  ManagedAncestryPolicyError,
} from './managed-ancestry-policy.js';
import type { SyncConflictPayloadKeyring } from './sync-conflict-postgres.js';
import { encryptPrivatePayload, isSyncConflictPayloadKeyring, selectSyncConflictPayloadKey } from './sync-conflict-postgres.js';
import { persistSyncOperationProjection } from './postgres/sync-pull-postgres.js';
import { claimResolutionAuthor, hasResolutionClaim } from './sync-resolution-author-postgres.js';
import {
  persistAuthoritativeOperationEffect,
  type SyncOperationEffectFaultPhase,
} from './sync-operation-effects-postgres.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { appendConflictReportSourceInvalidation } from './report-source-invalidation.js';
export type PostgresSyncConflictResolutionFaultPhase =
  | 'mutation' | SyncOperationEffectFaultPhase | 'conflict_update' | 'before_receipt_finalize';

/** Explicit capability marker for the trusted product-command path that has
 * already performed its own receipt admission and therefore skips the HTTP
 * session authority check. It is never accepted by the external resolver. */
const INTERNAL_SYNC_RESOLUTION_CAPABILITY = 'internal:sync-resolution';

export interface PostgresSyncConflictResolutionOptions {
  readonly conflictPayloadKeyring: SyncConflictPayloadKeyring;
  readonly operationId?: () => string;
  readonly nodeId?: () => string;
  /** Deployment capability: SYNC_MANAGED_BOOKMARK_WRITES=true. */
  readonly managedBookmarkWrites?: boolean;
  /** Optional report cache/source-fence fan-out for conflict mutations. */
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly faultInjector?: {
    afterPhase?(phase: PostgresSyncConflictResolutionFaultPhase): void | Promise<void>;
  };
}

const validators = createValidatorRegistry();
const RESOLUTION_REVISION_PREFIX = 'conflict-resolved-';
function deny(code: SyncConflictResolutionError['code'], currentRevision?: string): never {
  throw new SyncConflictResolutionError(code, currentRevision);
}

export function createPostgresSyncConflictResolutionApplication(
  db: Kysely<DatabaseSchema>,
  sessionIssuer: PostgresSyncSessionIssuer,
  options: PostgresSyncConflictResolutionOptions,
): SyncConflictResolutionApplication {
  assertOptions(options);
  return Object.freeze({
    async resolve(input: SyncConflictResolutionInput): Promise<ConflictResolutionResult> {
      if (typeof input.origin !== 'string' || input.origin.length < 1 || input.origin.length > 2_048) {
        deny('resource_not_found');
      }
      const command = validateSyncConflictResolutionCommand(input);
      let verified;
      try {
        verified = await sessionIssuer.verify({
          credential: input.credential,
          sessionId: input.sessionId,
          collectionId: input.collectionId,
          replicaId: input.replicaId,
        });
      } catch {
        deny('resource_not_found');
      }
      if (!verified.authorizationScopes.includes('sync:push')) deny('insufficient_scope');
      try {
        return await createUnitOfWork(db).execute(({ transaction }) => resolveInTransaction(
          transaction, input, command, options,
        ));
      } catch (error) {
        if (error instanceof SnapshotTreeCapacityError) throw new SyncConflictResolutionError('payload_too_large');
        if (error instanceof SyncConflictResolutionError) throw error;
        if (error instanceof DatabaseOperationError) throw error;
        if (error instanceof ManagedAncestryPolicyError) {
          throw new SyncConflictResolutionError(error.code);
        }
        if (error instanceof SyncNodeUpdateError || error instanceof SyncNodeCreateError) {
          throw new SyncConflictResolutionError(error.code);
        }
        if (error instanceof CanonicalMutationInvariantError || error instanceof CollectionsError) {
          throw new SyncConflictResolutionError('invalid_document');
        }
        throw new SyncConflictResolutionError('internal_error');
      }
    },
  });
}

async function resolveInTransaction(
  transaction: DatabaseTransaction,
  input: SyncConflictResolutionInput,
  command: ValidatedSyncConflictResolutionCommand,
  options: PostgresSyncConflictResolutionOptions,
  authorizedAccountId?: string,
): Promise<ConflictResolutionResult> {
  const authority: Readonly<{ accountId: string; replicaWrite?: boolean }> = authorizedAccountId === undefined
    ? await assertTransactionalAuthority(transaction, input)
    : { accountId: authorizedAccountId };
  const conflict = await transaction.selectFrom('sync_conflicts').selectAll()
    .where('conflict_id', '=', command.conflictId)
    .where('collection_id', '=', input.collectionId).forUpdate().executeTakeFirst();
  if (!conflict) deny('resource_not_found');

  const requestDigest = canonicalSyncConflictResolutionDigest(command);
  const receipt = await transaction.selectFrom('sync_conflict_resolution_receipts').selectAll()
    .where('principal_id', '=', authority.accountId)
    .where('conflict_id', '=', conflict.conflict_id)
    .where('conflict_revision', '=', command.conflictRevision)
    .where('idempotency_key', '=', command.idempotencyKey).forUpdate().executeTakeFirst();
  if (receipt) {
    if (receipt.request_digest !== requestDigest || receipt.resolution !== command.resolution) {
      deny('idempotency_key_reused');
    }
    if (!receipt.completed_at || !receipt.result_json) deny('idempotency_in_progress');
    const replay = receipt.result_json as unknown as ConflictResolutionResult;
    const replayDigest = createHash('sha256').update(stableJson(replay), 'utf8').digest('hex');
    if (!validators.validate('conflictResolutionResult', replay).valid
        || receipt.result_digest !== replayDigest
        || receipt.operation_id !== replay.operation.opId
        || conflict.resolved_by_operation_id !== receipt.operation_id
        || conflict.resolution_result_json === null
        || stableJson(conflict.resolution_result_json) !== stableJson(replay)) deny('internal_error');
    return replay;
  }
  if (conflict.status !== 'open' || conflict.revision !== command.conflictRevision) {
    deny('precondition_failed', conflict.revision);
  }
  if (!conflict.allowed_resolutions.includes(command.resolution)) deny('unsupported_operation');

  await transaction.insertInto('sync_conflict_resolution_receipts').values({
    principal_id: authority.accountId,
    conflict_id: conflict.conflict_id,
    conflict_revision: command.conflictRevision,
    idempotency_key: command.idempotencyKey,
    request_digest: requestDigest,
    resolution: command.resolution,
    result_json: null,
    result_digest: null,
    operation_id: null,
    completed_at: null,
  }).execute();

  const operationId = validGeneratedId(options.operationId?.() ?? generatedId('resolution-op-'));
  const occurredAt = await databaseNow(transaction);
  // Authorization uses the caller's identity; the operation gets a separate
  // server author whose Sequence cannot collide with an offline browser queue.
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: operationId, resource_type: 'operation',
  }).execute();
  const author = await claimResolutionAuthor(transaction, { operationId,
    collectionId: input.collectionId, conflictId: conflict.conflict_id, requestDigest });
  const claimedSequence = author.sequence;

  const current = await transaction.selectFrom('nodes').selectAll()
    .where('collection_id', '=', conflict.collection_id)
    .where('id', '=', conflict.target_id).forUpdate().executeTakeFirst();
  if (!current || !current.payload_json) deny('resource_not_found');
  if (current.deleted_at !== null) {
    // FIX-M-015: only a historical delete_update may resolve a deleted target;
    // all other conflict menus remain concealed/unsupported as originally advertised.
    if (conflict.conflict_type !== 'delete_update') deny('resource_not_found');
    if (command.resolution !== 'server') deny('unsupported_operation');
    return dismissDeleteUpdateConflict(transaction, { ...input, replicaId: author.replicaId }, command, options, authority,
      conflict, current, operationId, claimedSequence, requestDigest, occurredAt);
  }
  const conflictBinding = await transaction.selectFrom('sync_session_bindings').select('lease_generation')
    .where('session_id', '=', conflict.session_id).executeTakeFirst();
  if (!conflictBinding) deny('internal_error');
  const privatePayload = decryptPrivatePayload(
    conflict, options.conflictPayloadKeyring, current.kind, conflictBinding.lease_generation,
  );

  // A Conflict revision does not advance when another node update commits.
  // Reject an obsolete overwriting decision, while allowing unrelated fields
  // to change and an incoming value that has already converged on the server.
  if (current.resource_revision !== conflict.current_revision
      && (command.resolution === 'incoming' || command.resolution === 'custom')) {
    const stale = conflict.conflicting_fields.map(pointer => pointer.slice(1)).some(field =>
      !deepEqualSyncMergeValue(current.payload_json![field], privatePayload.current[field])
      && !(command.resolution === 'incoming'
        && deepEqualSyncMergeValue(current.payload_json![field], privatePayload.incoming[field])));
    if (stale) deny('precondition_failed', conflict.revision);
  }

  let mutation: CanonicalMutationResult;
  let wireOperation: Operation;
  let effectTargetId: string | undefined;
  if (command.resolution === 'both') {
    if (current.kind !== 'bookmark' || privatePayload.nodeKind !== 'bookmark'
        || conflict.conflict_type !== 'concurrent_field_update'
        || conflict.conflicting_fields.some((field) => field !== '/title' && field !== '/url')) {
      deny('unsupported_operation');
    }
    // SYNC-R02: lock the inherited parent-to-root chain and enforce the
    // managed-bookmarks policy before any ledger claim or mutation.
    const parentChain = await loadLockedManagedAncestryChain(
      transaction, input.collectionId, current.parent_id!,
    );
    if (parentChain.some((fact) => fact.kind !== 'folder')) deny('resource_not_found');
    assertManagedAncestryWritable(parentChain, {
      managedBookmarkWrites: options.managedBookmarkWrites === true,
      replicaWrite: authority.replicaWrite ?? await conflictReplicaWriteCapability(
        transaction, conflict.replica_id,
      ),
    });
    const nodeId = validGeneratedId(options.nodeId?.() ?? generatedId('node-'));
    const node = duplicateNodeDocument(current.payload_json, privatePayload, conflict.conflicting_fields);
    // T-10 / ADR-0027: `both` duplicates a live bookmark, so it must pass the
    // same aggregate Snapshot admission as every other node-creating path.
    effectTargetId = nodeId;
    await transaction.insertInto('resource_id_ledger').values({
      resource_id: nodeId, resource_type: 'node',
    }).execute();
    wireOperation = {
      opId: operationId, replicaId: author.replicaId, sequence: claimedSequence,
      collectionId: input.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: occurredAt.toISOString(), dependencies: [conflict.operation_id],
      payload: { parentId: current.parent_id!, afterId: current.id, node },
      source: { adapterProfile: 'known-conflict-resolution', extensions: {
        'https://known.example/extensions/sync-conflict-resolution': { createdNodeId: nodeId },
      } },
    } satisfies Operation;
    const mapped = mapSyncNodeCreateOperation(wireOperation, { managedBookmarkWrites: false });
    const canonical = canonicalApplication(transaction, nodeId, options.reportSourceInvalidation);
    mutation = await canonical.execute({ transaction }, {
      operationId, collectionId: input.collectionId,
      actor: { principalId: authority.accountId, principalType: 'account' },
      operationSyncWire: wireOperation as unknown as import('../../modules/collections/index.js').JsonObject,
      mutation: {
        action: 'create', target: { collectionId: input.collectionId, resourceId: nodeId, resourceKind: 'node' },
        parentId: mapped.parentId, relativePosition: mapped.relativePosition, fields: mapped.fields,
      },
    });
  } else {
    const desired = selectedResolutionFields(command, current.payload_json, privatePayload,
      conflict.conflicting_fields);
    wireOperation = {
      opId: operationId, replicaId: author.replicaId, sequence: claimedSequence,
      collectionId: input.collectionId, type: 'update_node_content', targetId: current.id,
      baseRevision: current.resource_revision, occurredAt: occurredAt.toISOString(),
      dependencies: [conflict.operation_id], payload: { base: desired.base, value: desired.value },
      source: { adapterProfile: 'known-conflict-resolution' },
    } satisfies Operation;
    const trusted = {
      collectionId: current.collection_id, resourceId: current.id, revision: current.resource_revision,
      kind: current.kind, deleted: false, payload: current.payload_json,
    } as const;
    const evaluated = evaluateSyncNodeUpdate(wireOperation, trusted, trusted);
    if (evaluated.status !== 'merged') deny('invalid_document');
    const canonical = canonicalApplication(transaction, undefined, options.reportSourceInvalidation);
    mutation = await canonical.execute({ transaction }, {
      operationId, collectionId: input.collectionId,
      actor: { principalId: authority.accountId, principalType: 'account' },
      operationSyncWire: wireOperation as unknown as import('../../modules/collections/index.js').JsonObject,
      mutation: {
        action: 'update', target: { collectionId: input.collectionId,
          resourceId: current.id, resourceKind: 'node' },
        parentId: current.parent_id, expectedResourceRevision: current.resource_revision,
        fields: evaluated.fields,
      },
    });
  }
  await persistSyncOperationProjection(transaction, wireOperation);
  await options.faultInjector?.afterPhase?.('mutation');

  const revision = `${RESOLUTION_REVISION_PREFIX}${mutation.allocation.commitOrdinal}`;
  const cursor = `sync-conflict-resolution-${mutation.allocation.commitOrdinal}`;
  await persistAuthoritativeOperationEffect({
    transaction, operation: wireOperation, commitOrdinal: mutation.allocation.commitOrdinal,
    terminalStatus: 'applied', cursor,
    ...(effectTargetId ? { targetId: effectTargetId } : {}),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  const resolvedConflict = resolvedConflictWire(conflict, revision);
  const result: ConflictResolutionResult = { conflict: resolvedConflict, operation: wireOperation, cursor };
  if (!validators.validate('conflictResolutionResult', result).valid) deny('internal_error');
  await finalizeConflictResolution(transaction, options, conflict, command, authority,
    operationId, result, requestDigest, occurredAt);
  return Object.freeze(result);
}

/**
 * FIX-M-015 (SYNC-R10): `server` dismiss accepts the server's delete. The
 * tombstone and the deleted Node row stay untouched and no canonical mutation
 * runs — restoring the node would require a dedicated canonical restore
 * mutation with the full permission/ancestry/revision/ID-ledger checks. The
 * resolution still allocates a fresh commit ordinal and records its own
 * operation and audit event. Pull publishes the resolved Conflict at this
 * commit instead of an effectless delete Operation: the original deletion
 * already carries the authoritative tombstone. This then closes the
 * Conflict atomically and finalizes the exact-replay receipt.
 */
async function dismissDeleteUpdateConflict(
  transaction: DatabaseTransaction,
  input: SyncConflictResolutionInput,
  command: ValidatedSyncConflictResolutionCommand,
  options: PostgresSyncConflictResolutionOptions,
  authority: Readonly<{ accountId: string; replicaWrite?: boolean }>,
  conflict: Selectable<SyncConflictTable>,
  current: Selectable<DatabaseSchema['nodes']>,
  operationId: string,
  claimedSequence: number,
  requestDigest: string,
  occurredAt: Date,
): Promise<ConflictResolutionResult> {
  const collection = await transaction.updateTable('collections').set({
    commit_ordinal: sql`commit_ordinal + 1`,
    payload_json: sql`jsonb_set(payload_json, '{commitOrdinal}', to_jsonb((commit_ordinal + 1)::text), true)`,
  }).where('id', '=', conflict.collection_id)
    .returning(['commit_ordinal', 'content_revision', 'policy_revision']).executeTakeFirst();
  if (!collection) deny('internal_error');
  const commitOrdinal = BigInt(collection.commit_ordinal);
  await appendConflictReportSourceInvalidation(options.reportSourceInvalidation, transaction, {
    operationId,
    collectionId: conflict.collection_id,
    commitOrdinal,
    contentRevision: collection.content_revision,
    policyRevision: collection.policy_revision,
  });

  const wireOperation = {
    opId: operationId, replicaId: input.replicaId, sequence: claimedSequence,
    collectionId: conflict.collection_id, type: 'delete_node', targetId: current.id,
    baseRevision: current.resource_revision, occurredAt: occurredAt.toISOString(),
    dependencies: [conflict.operation_id],
    payload: { reason: 'conflict-dismissed' },
    source: { adapterProfile: 'known-conflict-resolution' },
  } satisfies Operation;
  const details = Object.freeze({
    action: 'dismiss', collectionId: conflict.collection_id,
    commitOrdinal: commitOrdinal.toString(), conflictId: conflict.conflict_id,
    conflictType: conflict.conflict_type, resolution: 'server',
    resourceType: 'node', targetId: current.id,
  });
  await appendOperationWithPayload(transaction, {
    operationId, collectionId: conflict.collection_id, commitOrdinal,
    operationType: 'sync.conflict.dismissed', payloadJson: details,
    actorPrincipalId: authority.accountId,
  });
  await appendAuditEvent(transaction, {
    operationId, collectionId: conflict.collection_id, principalId: authority.accountId,
    eventType: 'sync.conflict.dismissed', details, createdAt: occurredAt,
  });
  await options.faultInjector?.afterPhase?.('mutation');

  const revision = `${RESOLUTION_REVISION_PREFIX}${commitOrdinal}`;
  const cursor = `sync-conflict-resolution-${commitOrdinal}`;
  const resolvedConflict = resolvedConflictWire(conflict, revision);
  const result: ConflictResolutionResult = { conflict: resolvedConflict, operation: wireOperation, cursor };
  if (!validators.validate('conflictResolutionResult', result).valid) deny('internal_error');
  await finalizeConflictResolution(transaction, options, conflict, command, authority,
    operationId, result, requestDigest, occurredAt);
  return Object.freeze(result);
}

function resolvedConflictWire(conflict: Selectable<SyncConflictTable>, revision: string): Conflict {
  return {
    id: conflict.conflict_id, collectionId: conflict.collection_id, targetId: conflict.target_id,
    type: conflict.conflict_type,
    ...(conflict.conflicting_fields.length === 1 ? { field: conflict.conflicting_fields[0] } : {}),
    incomingOpId: conflict.operation_id, createdAt: conflict.created_at.toISOString(),
    status: 'resolved', allowedResolutions: [...conflict.allowed_resolutions] as Conflict['allowedResolutions'],
    revision,
  };
}

async function finalizeConflictResolution(
  transaction: DatabaseTransaction,
  options: PostgresSyncConflictResolutionOptions,
  conflict: Selectable<SyncConflictTable>,
  command: ValidatedSyncConflictResolutionCommand,
  authority: Readonly<{ accountId: string }>,
  operationId: string,
  result: ConflictResolutionResult,
  requestDigest: string,
  occurredAt: Date,
): Promise<void> {
  const persistedResult = result as unknown as Record<string, unknown>;
  const updated = await transaction.updateTable('sync_conflicts').set({
    status: 'resolved', revision: result.conflict.revision,
    resolved_by_operation_id: operationId,
    resolved_by_principal_id: authority.accountId,
    resolution: command.resolution,
    resolution_result_json: persistedResult,
    resolved_at: occurredAt,
  }).where('conflict_id', '=', conflict.conflict_id)
    .where('status', '=', 'open')
    .where('revision', '=', command.conflictRevision).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) deny('precondition_failed', conflict.revision);
  await options.faultInjector?.afterPhase?.('conflict_update');
  await options.faultInjector?.afterPhase?.('before_receipt_finalize');
  const resultDigest = createHash('sha256').update(stableJson(result), 'utf8').digest('hex');
  const completed = await transaction.updateTable('sync_conflict_resolution_receipts').set({
    result_json: persistedResult, result_digest: resultDigest, operation_id: operationId,
    completed_at: occurredAt,
  }).where('principal_id', '=', authority.accountId)
    .where('conflict_id', '=', conflict.conflict_id)
    .where('conflict_revision', '=', command.conflictRevision)
    .where('idempotency_key', '=', command.idempotencyKey)
    .where('request_digest', '=', requestDigest)
    .where('completed_at', 'is', null).executeTakeFirst();
  if (completed.numUpdatedRows !== 1n) deny('internal_error');
}

/** Product admission adapter for the same authoritative P3-18 transaction core. */
export async function resolveProductConflictInTransaction(
  transaction: DatabaseTransaction,
  input: { readonly accountId: string; readonly subjectId: string; readonly conflictId: string;
    readonly expectedRevision: string; readonly commandId: string;
    readonly resolution: 'server'|'incoming'|'custom'|'both'; readonly value?: unknown },
  options: PostgresSyncConflictResolutionOptions,
): Promise<ConflictResolutionResult> {
  const conflict = await transaction.selectFrom('sync_conflicts as conflict')
    .innerJoin('collections as collection', 'collection.id', 'conflict.collection_id')
    .select(['conflict.collection_id', 'conflict.replica_id', 'conflict.session_id'])
    .where('conflict.conflict_id', '=', input.conflictId)
    .where('collection.owner_subject_id', '=', input.subjectId)
    .where('collection.deleted_at', 'is', null).executeTakeFirst();
  if (!conflict) deny('resource_not_found');
  // T-10 lock order (ADR-0027): this product entry point deliberately skips
  // `assertTransactionalAuthority` (the product command receipt owns admission),
  // so it must still take the Replica and Collection rows itself. Doing it here
  // keeps `sync_replicas` → `collections` → `nodes` order, which the conflict
  // core below would otherwise invert by locking `nodes` first.
  await lockSyncReplicaBeforeCollection(transaction, conflict.replica_id);
  await transaction.selectFrom('collections').select('id')
    .where('id', '=', conflict.collection_id).forUpdate().executeTakeFirst();
  const request = { resolution: input.resolution,
    baseConflictRevision: input.expectedRevision,
    ...(input.resolution === 'custom' ? { value: input.value } : {}),
  } as SyncConflictResolutionInput['request'];
  const command = validateSyncConflictResolutionCommand({ conflictId: input.conflictId,
    idempotencyKey: input.commandId, ifMatch: [`"${input.expectedRevision}"`], request });
  const productInput = { credential: {} as SyncConflictResolutionInput['credential'],
    sessionId: conflict.session_id, replicaId: conflict.replica_id, collectionId: conflict.collection_id,
    origin: INTERNAL_SYNC_RESOLUTION_CAPABILITY,
    conflictId: input.conflictId, idempotencyKey: input.commandId, ifMatch: [`"${input.expectedRevision}"`], request };
  return resolveInTransaction(transaction, productInput, command, options, input.accountId);
}

function canonicalApplication(
  transaction: DatabaseTransaction,
  claimedNodeId?: string,
  reportSourceInvalidation?: ReportSourceInvalidationOutboxPort,
) {
  return createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction, {
    operationIdClaimOwner: {
      async assertClaimed(tx, operationId) {
        if (!await hasResolutionClaim(tx, operationId)) deny('internal_error');
      },
    },
    ...(claimedNodeId ? { resourceIdClaimOwner: { async assertClaimed(tx, resourceId, resourceType) {
      const row = await tx.selectFrom('resource_id_ledger').select('resource_type')
        .where('resource_id', '=', resourceId).executeTakeFirst();
      if (resourceId !== claimedNodeId || row?.resource_type !== resourceType) deny('internal_error');
    } } } : {}),
    ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
  }));
}

async function assertTransactionalAuthority(transaction: DatabaseTransaction, input: SyncConflictResolutionInput) {
  const now = await databaseNow(transaction);
  const session = await transaction.selectFrom('sync_sessions').selectAll()
    .where('session_id', '=', input.sessionId).where('collection_id', '=', input.collectionId)
    .where('replica_id', '=', input.replicaId).forUpdate().executeTakeFirst();
  if (!session) deny('resource_not_found');
  const account = await transaction.selectFrom('accounts').selectAll()
    .where('id', '=', session.account_id).forUpdate().executeTakeFirst();
  const credential = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', input.credential.issuer)
    .where('credential_id', '=', input.credential.credentialId).forUpdate().executeTakeFirst();
  await lockCollectionReplicaGate(transaction, input.collectionId);
  const replica = await transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', input.replicaId).forUpdate().executeTakeFirst();
  const collection = await transaction.selectFrom('collections')
    .select(['owner_subject_id', 'policy_revision', 'deleted_at'])
    .where('id', '=', input.collectionId).forUpdate().executeTakeFirst();
  let role: 'owner' | 'editor' | 'viewer' | undefined;
  if (account && collection?.owner_subject_id === account.subject_id) role = 'owner';
  if (account && !role) role = (await transaction.selectFrom('collection_members').select('role')
    .where('collection_id', '=', input.collectionId).where('subject_id', '=', account.subject_id)
    .executeTakeFirst())?.role;
  const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', input.sessionId).executeTakeFirst();
  const pushScope = await transaction.selectFrom('sync_session_scopes').select('scope')
    .where('session_id', '=', input.sessionId).where('scope', '=', 'sync:push').executeTakeFirst();
  const active = !!account && account.status === 'active' && !!credential && credential.revoked_at === null
    && credential.credential_digest === input.credential.credentialDigest
    && credential.subject === input.credential.subject && credential.account_id === account.id
    && credential.client_id === input.credential.clientId
    // The account security epoch is the durable Sync revoke fact (password reset,
    // email change, provider link, MFA disable, revoke-all). The entry
    // sessionIssuer.verify commits in its own transaction before this one opens,
    // so the epoch must be re-checked from the locked rows here as well -- exactly
    // as push (sync-sequence-postgres), retire, ack, pull-authority, session
    // verify and recovery do.
    && BigInt(session.account_security_epoch) === BigInt(account.security_epoch)
    && BigInt(credential.security_epoch) === BigInt(account.security_epoch)
    && credential.credential_expires_at > now && input.credential.credentialExpiresAt > now
    && input.credential.evidenceExpiresAt > now
    && session.status === 'active' && session.expires_at > now
    && session.account_id === account.id && session.credential_issuer === input.credential.issuer
    && session.credential_id === input.credential.credentialId
    // Extension requests must match the exact Origin recorded on the Sync
    // session.  The product Sync Center is a separate, account-authorized
    // capability and deliberately enters through the internal adapter below;
    // it has no extension Origin to present, so it uses the non-forgeable
    // in-process marker instead of weakening the external route check.
    && (input.origin === INTERNAL_SYNC_RESOLUTION_CAPABILITY || session.origin === input.origin)
    && !!collection && collection.deleted_at === null && collection.policy_revision === session.policy_revision
    && (role === 'owner' || role === 'editor') && !!pushScope
    && !!replica && replica.account_id === account.id && replica.collection_id === input.collectionId
    && replica.status === 'active' && replica.lease_expires_at > now
    && replica.capabilities_json.write === true
    && BigInt(replica.lease_generation) === BigInt(session.lease_generation)
    && BigInt(replica.lifecycle_revision) === BigInt(session.lifecycle_revision)
    && !!binding && binding.account_id === account.id && binding.collection_id === input.collectionId
    && binding.replica_id === input.replicaId && binding.policy_revision === collection.policy_revision
    && BigInt(binding.lease_generation) === BigInt(replica.lease_generation)
    && BigInt(binding.lifecycle_revision) === BigInt(replica.lifecycle_revision);
  if (!active) deny('resource_not_found');
  return { accountId: account.id, replicaWrite: replica.capabilities_json.write === true };
}

async function conflictReplicaWriteCapability(
  transaction: DatabaseTransaction,
  replicaId: string,
): Promise<boolean> {
  const replica = await transaction.selectFrom('sync_replicas').select('capabilities_json')
    .where('replica_id', '=', replicaId).forUpdate().executeTakeFirst();
  if (!replica) deny('internal_error');
  return replica.capabilities_json.write === true;
}

function selectedResolutionFields(
  command: ValidatedSyncConflictResolutionCommand,
  current: Readonly<Record<string, unknown>>,
  privatePayload: PrivateConflictPayload,
  pointers: readonly string[],
): Readonly<{ base: Record<string, unknown>; value: Record<string, unknown> }> {
  const fields = pointers.map((pointer) => pointer.slice(1))
    .filter((field) => !['baseRevision', 'deletedAt'].includes(field));
  if (fields.length < 1) deny('unsupported_operation');
  const base: Record<string, unknown> = {};
  const value: Record<string, unknown> = {};
  for (const field of fields) base[field] = current[field];
  if (command.resolution === 'server') {
    for (const field of fields) value[field] = current[field];
  } else if (command.resolution === 'incoming') {
    for (const field of fields) value[field] = privatePayload.incoming[field];
  } else {
    if (fields.length === 1) value[fields[0]!] = command.value;
    else {
      const custom = assertPlainCustomObject(command.value, 'custom conflict value');
      if (fields.some((field) => !Object.hasOwn(custom, field))
          || Object.keys(custom).some((field) => !fields.includes(field))) deny('invalid_document');
      for (const field of fields) value[field] = custom[field];
    }
  }
  return { base, value };
}

function duplicateNodeDocument(
  current: Readonly<Record<string, unknown>>,
  privatePayload: PrivateConflictPayload,
  pointers: readonly string[],
): NodeCreate {
  const title = assertValidNodeTitle(
    pointers.includes('/title') ? privatePayload.incoming.title as string : current.title as string,
  );
  const url = assertValidHttpUrlNoUserInfo(
    pointers.includes('/url') ? privatePayload.incoming.url as string : current.url as string,
  );
  const description = assertValidNodeDescription(current.description as string | null | undefined ?? null);
  const tags = assertValidNodeTags(current.tags as readonly string[] | undefined ?? []);
  const visibility = assertValidNodeVisibility(current.visibility as string | undefined ?? 'inherit');
  const rawExtensions = current.extensions ?? {};
  if (!isRecord(rawExtensions)) deny('internal_error');
  const preserved = preserveExtensions(
    rawExtensions as Parameters<typeof preserveExtensions>[0],
    { surface: 'sync-server', path: '/payload/node' },
  );
  if (preserved.removals.length !== 0) deny('internal_error');
  return {
    kind: 'bookmark', title, url, tags: [...tags], visibility,
    extensions: preserved.extensions,
    ...(description === null ? {} : { description }),
  };
}

function decryptPrivatePayload(
  conflict: Selectable<SyncConflictTable>,
  keyring: SyncConflictPayloadKeyring,
  nodeKind: 'folder' | 'bookmark' | 'separator',
  leaseGeneration: bigint,
): PrivateConflictPayload {
  return decryptPrivatePayloadValue(conflict, keyring, nodeKind, leaseGeneration, invalidDocument);
}

export function readProductConflictSafeSummary(
  conflict: Selectable<SyncConflictTable>,
  keyring: SyncConflictPayloadKeyring,
  nodeKind: 'folder' | 'bookmark' | 'separator',
  leaseGeneration: bigint,
  field: string | null,
): { readonly current: string | null; readonly incoming: string | null } {
  if (field !== '/title' && field !== '/description' && field !== '/visibility') {
    return { current: null, incoming: null };
  }
  const payload = decryptPrivatePayload(conflict, keyring, nodeKind, leaseGeneration);
  const key = field.slice(1);
  const summarize = (source: Readonly<Record<string, unknown>>): string | null => {
    const value = source[key];
    return typeof value === 'string' ? value.slice(0, 256) : null;
  };
  return { current: summarize(payload.current), incoming: summarize(payload.incoming) };
}

async function databaseNow(transaction: DatabaseTransaction): Promise<Date> {
  const result = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) deny('internal_error');
  return now;
}

function assertOptions(options: PostgresSyncConflictResolutionOptions): void {
  if (!isSyncConflictPayloadKeyring(options.conflictPayloadKeyring)) deny('internal_error');
}

export interface ReencryptOpenSyncConflictsResult {
  readonly reencrypted: number;
}

/**
 * FIX-M-011 (SYNC-R06): transactional drain tool. Re-encrypts every open
 * Conflict still encrypted with `sourceKeyVersion` to the active key so the
 * retired version can be removed from the retained keyring. The whole batch
 * fails closed when any Conflict cannot be decrypted or re-encrypted; the
 * operator retries after remediation. Key material never leaves the process.
 */
export async function reencryptOpenSyncConflicts(
  transaction: DatabaseTransaction,
  keyring: SyncConflictPayloadKeyring,
  sourceKeyVersion: number,
): Promise<Readonly<ReencryptOpenSyncConflictsResult>> {
  if (!isSyncConflictPayloadKeyring(keyring) || !Number.isSafeInteger(sourceKeyVersion)
      || sourceKeyVersion < 1 || sourceKeyVersion > 2_147_483_647) deny('internal_error');
  if (sourceKeyVersion === keyring.active.keyVersion) return Object.freeze({ reencrypted: 0 });
  if (selectSyncConflictPayloadKey(keyring, sourceKeyVersion) === undefined) deny('internal_error');
  const conflicts = await transaction.selectFrom('sync_conflicts as conflict')
    .selectAll('conflict')
    .innerJoin('nodes as node', 'node.id', 'conflict.target_id')
    .select('node.kind as node_kind')
    .innerJoin('sync_session_bindings as binding', 'binding.session_id', 'conflict.session_id')
    .select('binding.lease_generation')
    .where('conflict.status', '=', 'open')
    .where('conflict.private_payload_key_version', '=', sourceKeyVersion)
    .forUpdate().execute();
  for (const conflict of conflicts) {
    const nodeKind = conflict.node_kind;
    if (nodeKind !== 'folder' && nodeKind !== 'bookmark' && nodeKind !== 'separator') deny('internal_error');
    const privatePayload = decryptPrivatePayload(conflict, keyring, nodeKind, conflict.lease_generation);
    const encrypted = encryptPrivatePayload(stableJson(privatePayload), keyring.active, {
      collectionId: conflict.collection_id,
      replicaId: conflict.replica_id,
      leaseGeneration: conflict.lease_generation.toString(),
      sessionId: conflict.session_id,
      operationId: conflict.operation_id,
      targetId: conflict.target_id,
      conflictId: conflict.conflict_id,
      commitOrdinal: conflict.commit_ordinal.toString(),
      conflictType: conflict.conflict_type,
      conflictingFields: stableJson(conflict.conflicting_fields),
      nodeKind,
      baseRevision: conflict.base_revision,
      currentRevision: conflict.current_revision,
      keyVersion: String(keyring.active.keyVersion),
    });
    const updated = await transaction.updateTable('sync_conflicts').set({
      private_payload_ciphertext: encrypted.ciphertext,
      private_payload_iv: encrypted.iv,
      private_payload_auth_tag: encrypted.authTag,
      private_payload_key_version: keyring.active.keyVersion,
      private_payload_digest: encrypted.digest,
    }).where('conflict_id', '=', conflict.conflict_id)
      .where('status', '=', 'open')
      .where('private_payload_key_version', '=', sourceKeyVersion).executeTakeFirst();
    if (!updated || updated.numUpdatedRows !== 1n) deny('internal_error');
  }
  return Object.freeze({ reencrypted: conflicts.length });
}

function validGeneratedId(value: string): string {
  if (!validators.validate('opaqueId', value).valid) deny('internal_error');
  return value;
}

function generatedId(prefix: string): string {
  return `${prefix}${randomBytes(18).toString('base64url')}`;
}

function stableJson(value: unknown): string {
  return stableJsonValue(value, invalidDocument);
}

function assertPlainCustomObject(value: unknown, _label: string): Record<string, unknown> {
  return assertPlainCustomObjectValue(value, invalidDocument);
}

function invalidDocument(): never {
  return deny('invalid_document');
}
