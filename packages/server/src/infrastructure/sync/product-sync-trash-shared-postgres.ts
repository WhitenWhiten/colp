import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { randomBytes } from 'node:crypto';
import type { Operation } from '@know-n/colp/types';
import {
  decodeTrashDeletionId,
  PRODUCT_SYNC_TRASH_CONTRACT_VERSION,
  SyncPushHttpError,
  type ProductSyncCommandOutcome,
  type ProductSyncTrashRestoreView,
  type ProductSyncTrashRestoreItemResult,
  type ProductSyncTrashRestoreBatchSummary,
} from '../../modules/sync/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { Metrics } from '../telemetry/index.js';
import { applyCanonicalNodeRestore } from './sync-node-restore-postgres.js';

export interface ProductSyncTrashPostgresOptions {
  readonly cursorSecret: string;
  readonly metrics?: Metrics;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

export const TRASH_JSON_TYPE = 'application/json; charset=utf-8';
export const TRASH_CACHE = 'private, no-store';
export const TRASH_OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;

export type LocatedDeletion =
  | { readonly kind: 'missing' }
  | { readonly kind: 'purged'; readonly collectionId: string }
  | {
    readonly kind: 'live'; readonly collectionId: string;
    readonly tombstone: { readonly delete_revision: string };
  };

export type TrashRestoreAttempt =
  | { readonly kind: 'applied'; readonly view: ProductSyncTrashRestoreView }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'purged' }
  | { readonly kind: 'precondition_failed' }
  | { readonly kind: 'invalid_request' };

export async function restoreTrashItemInTransaction(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string; readonly subjectId: string; readonly deletionId: string;
    readonly expectedRevision: string; readonly collectionId?: string;
  },
  reportSourceInvalidation?: ReportSourceInvalidationOutboxPort,
): Promise<ProductSyncTrashRestoreView> {
  const decoded = decodeTrashDeletionId(input.deletionId);
  if (!decoded) throw notFound();
  const located = await locateDeletion(transaction, decoded.operationId, decoded.targetId);
  if (located.kind === 'missing') throw notFound();
  if (input.collectionId !== undefined && located.collectionId !== input.collectionId) throw notFound();
  const collection = await ownedCollection(transaction, located.collectionId, input.subjectId);
  if (!collection) throw notFound();
  if (located.kind === 'purged') throw purged();
  if (located.tombstone.delete_revision !== input.expectedRevision) throw preconditionFailed();
  const opId = randomBytes(16).toString('base64url');
  const replicaId = randomBytes(16).toString('base64url');
  const reservation = await transaction.insertInto('resource_id_ledger')
    .values({ resource_id: opId, resource_type: 'operation' })
    .onConflict((conflict) => conflict.column('resource_id').doNothing())
    .returning('resource_id').executeTakeFirst();
  if (!reservation) throw Object.assign(new Error('Restore operation identity unavailable'), { code: 'internal_error' });
  const occurredAt = new Date().toISOString();
  const operation = {
    opId, replicaId, sequence: 1, type: 'restore_node' as const,
    collectionId: located.collectionId, targetId: decoded.targetId,
    baseRevision: located.tombstone.delete_revision, occurredAt, dependencies: [], payload: {},
  } satisfies Operation;
  try {
    const applied = await applyCanonicalNodeRestore(transaction, {
      operation, actorPrincipalId: input.accountId, reportSourceInvalidation,
      operationIdClaimOwner: { async assertClaimed(tx, operationId) {
        const claim = await tx.selectFrom('resource_id_ledger').select('resource_type').where('resource_id', '=', operationId).executeTakeFirst();
        if (claim?.resource_type !== 'operation') throw new Error('Product restore operation reservation is missing');
      } },
    });
    return {
      deletionId: input.deletionId, nodeId: decoded.targetId, parentId: applied.parentId,
      revision: applied.revision, etag: `"${applied.revision}"`, restoredAt: occurredAt,
    };
  } catch (error) {
    throw mapRestoreError(error);
  }
}

export async function attemptRestoreTrashItem(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string; readonly subjectId: string; readonly deletionId: string;
    readonly expectedRevision: string; readonly collectionId?: string;
  },
  metrics?: Metrics,
  reportSourceInvalidation?: ReportSourceInvalidationOutboxPort,
): Promise<TrashRestoreAttempt> {
  try {
    const view = await restoreTrashItemInTransaction(transaction, input, reportSourceInvalidation);
    metrics?.increment('sync_trash_restore_total.applied');
    return { kind: 'applied', view };
  } catch (error) {
    incrementRestoreOutcome(metrics, error);
    const code = codeOf(error);
    if (code === 'resource_purged') return { kind: 'purged' };
    if (code === 'precondition_failed') return { kind: 'precondition_failed' };
    if (code === 'invalid_request') return { kind: 'invalid_request' };
    if (code === 'resource_not_found') return { kind: 'not_found' };
    throw error;
  }
}

export async function locateDeletion(
  transaction: DatabaseTransaction, operationId: string, targetId: string,
): Promise<LocatedDeletion> {
  const tombstone = await transaction.selectFrom('sync_node_tombstones')
    .select(['collection_id', 'payload_purged_at', 'delete_revision'])
    .where('operation_id', '=', operationId).where('target_id', '=', targetId)
    .executeTakeFirst();
  if (tombstone) {
    if (tombstone.payload_purged_at !== null) {
      return { kind: 'purged', collectionId: tombstone.collection_id };
    }
    return { kind: 'live', collectionId: tombstone.collection_id,
      tombstone: { delete_revision: tombstone.delete_revision } };
  }
  const watermark = await transaction.selectFrom('sync_purged_node_id_watermarks')
    .select('collection_id').where('target_id', '=', targetId).executeTakeFirst();
  if (watermark) return { kind: 'purged', collectionId: watermark.collection_id };
  const node = await transaction.selectFrom('nodes').select('collection_id')
    .where('id', '=', targetId).executeTakeFirst();
  if (!node) return { kind: 'missing' };
  return { kind: 'missing' };
}

export async function ownedCollection(
  transaction: DatabaseTransaction, collectionId: string, subjectId: string,
) {
  if (!TRASH_OPAQUE.test(collectionId)) return null;
  const row = await transaction.selectFrom('collections')
    .select(['id', 'owner_subject_id', 'deleted_at'])
    .where('id', '=', collectionId).executeTakeFirst();
  if (!row || row.deleted_at !== null || row.owner_subject_id !== subjectId) return null;
  return row;
}

export async function productTrashCommand<T>(
  transaction: DatabaseTransaction,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string, mutate: () => Promise<T>,
): Promise<ProductSyncCommandOutcome<T>> {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const claim = await receipts.claim(binding, fingerprint);
  if (claim.kind === 'replay') {
    return { kind: 'replay', status: claim.result.status, body: claim.result.body,
      stableHeaders: claim.result.stableHeaders, mediaType: claim.result.mediaType };
  }
  if (claim.kind !== 'claimed') return claim;
  const result = await mutate();
  const body = Buffer.from(stableJson(result), 'utf8');
  const etag = typeof (result as { etag?: unknown }).etag === 'string'
    ? (result as { etag: string }).etag : undefined;
  await receipts.complete(binding, fingerprint, {
    status: 200, body, stableHeaders: { 'cache-control': TRASH_CACHE, 'content-type': TRASH_JSON_TYPE,
      ...(etag ? { etag } : {}) }, mediaType: TRASH_JSON_TYPE,
    contractVersion: PRODUCT_SYNC_TRASH_CONTRACT_VERSION,
  });
  return { kind: 'committed', result };
}

export function appliedRestoreResult(
  deletionId: string, view: ProductSyncTrashRestoreView,
): ProductSyncTrashRestoreItemResult {
  return Object.freeze({
    deletionId, outcome: 'applied' as const, nodeId: view.nodeId, parentId: view.parentId,
    revision: view.revision, restoredAt: view.restoredAt,
  });
}

export function restoreOutcomeResult(
  deletionId: string,
  kind: Exclude<TrashRestoreAttempt['kind'], 'applied' | 'invalid_request'>,
): ProductSyncTrashRestoreItemResult {
  return Object.freeze({ deletionId, outcome: kind });
}

export function summarizeRestoreResults(
  results: readonly ProductSyncTrashRestoreItemResult[],
): ProductSyncTrashRestoreBatchSummary {
  let applied = 0; let preconditionFailed = 0; let purged = 0; let notFound = 0;
  for (const result of results) {
    if (result.outcome === 'applied') applied += 1;
    else if (result.outcome === 'precondition_failed') preconditionFailed += 1;
    else if (result.outcome === 'purged') purged += 1;
    else notFound += 1;
  }
  return Object.freeze({ applied, preconditionFailed, purged, notFound });
}

export function incrementRestoreOutcome(metrics: Metrics | undefined, error: unknown): void {
  const code = codeOf(error);
  if (code === 'resource_purged') metrics?.increment('sync_trash_restore_total.purged');
  else if (code === 'precondition_failed') metrics?.increment('sync_trash_restore_total.precondition_failed');
  else if (code === 'resource_not_found') metrics?.increment('sync_trash_restore_total.not_found');
  else if (code === 'invalid_request') metrics?.increment('sync_trash_restore_total.invalid_request');
}

export function mapRestoreError(error: unknown): unknown {
  if (error instanceof SyncPushHttpError) {
    if (error.code === 'resource_purged') return purged();
    if (error.code === 'revision_conflict') return preconditionFailed();
    if (error.code === 'resource_not_found') return notFound();
    if (error.code === 'invalid_document' || error.code === 'unsupported_operation') {
      return Object.assign(new Error('The restore request is invalid.'), { code: 'invalid_request' });
    }
  }
  return error;
}

export function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

export function notFound() { return Object.assign(new Error('Trash item not found'), { code: 'resource_not_found' }); }
export function purged() { return Object.assign(new Error('The deleted Node was purged'), { code: 'resource_purged' }); }
export function preconditionFailed() {
  return Object.assign(new Error('Trash revision changed'), { code: 'precondition_failed' });
}
export function invalidRequest(message = 'The restore request is invalid.') {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
