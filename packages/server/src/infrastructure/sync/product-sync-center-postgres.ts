import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ProductConflictPage, ProductConflictResolutionView, ProductReplicaRetirementView,
  ProductSyncCenterPorts, ProductSyncCenterUnitOfWork, ProductSyncCommandOutcome } from '../../modules/sync/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { lockCollectionReplicaGate } from '../database/lock-order.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { readProductConflictSafeSummary, resolveProductConflictInTransaction } from './sync-conflict-resolution-postgres.js';
import { isSyncConflictPayloadKeyring, selectSyncConflictPayloadKey,
  type SyncConflictPayloadKeyring } from './sync-conflict-postgres.js';
import type { SyncConflictKeyringReadiness } from '../../modules/sync/index.js';
import { retireReplicaInTransaction } from './replica-lifecycle-postgres.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import type { Metrics } from '../telemetry/index.js';
import { productSyncTrashPorts } from './product-sync-trash-postgres.js';

const CONTRACT_VERSION = '1.10.0';
const JSON_TYPE = 'application/json; charset=utf-8';
const CACHE = 'private, no-store';
export interface ProductSyncCenterPostgresOptions { readonly cursorSecret: string;
  readonly conflictPayloadKeyring: SyncConflictPayloadKeyring;
  /** Optional report cache/source-fence fan-out for conflict mutations. */
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly metrics?: Metrics }

export function createPostgresProductSyncCenterUnitOfWork(db: Kysely<DatabaseSchema>,
  options: ProductSyncCenterPostgresOptions): ProductSyncCenterUnitOfWork {
  if (options.cursorSecret.length < 32) throw new TypeError('Product Sync cursor secret must contain at least 32 characters');
  if (!isSyncConflictPayloadKeyring(options.conflictPayloadKeyring)) {
    throw new TypeError('Product Sync Conflict keyring configuration is invalid');
  }
  return { execute: (work) => createUnitOfWork(db).execute(({ transaction }) => work(ports(transaction, options))) };
}

/**
 * FIX-M-011 (SYNC-R06): startup/readiness gate for the versioned Conflict
 * keyring. Queries every open Conflict's persisted key version and fails
 * closed when a referenced version has no key in the configured keyring, so a
 * key cannot be removed while historical open Conflicts still need it. Only
 * version numbers are exposed — never key material.
 */
export function createPostgresSyncConflictKeyringReadiness(
  db: Kysely<DatabaseSchema>,
  keyring: SyncConflictPayloadKeyring,
): () => Promise<SyncConflictKeyringReadiness> {
  if (!isSyncConflictPayloadKeyring(keyring)) {
    throw new TypeError('Product Sync Conflict keyring configuration is invalid');
  }
  return async () => {
    let rows: Array<{ private_payload_key_version: number }>;
    try {
      rows = await db.selectFrom('sync_conflicts').select('private_payload_key_version')
        .where('status', '=', 'open').distinct().execute();
    } catch {
      return Object.freeze({ capability: 'sync-conflicts' as const, status: 'not-ready' as const,
        referencedVersions: Object.freeze([]), reason: 'dependency_unavailable' as const });
    }
    const referencedVersions = Object.freeze(rows.map((row) => row.private_payload_key_version)
      .sort((left, right) => left - right));
    if (referencedVersions.some((version) => selectSyncConflictPayloadKey(keyring, version) === undefined)) {
      return Object.freeze({ capability: 'sync-conflicts' as const, status: 'not-ready' as const,
        referencedVersions, reason: 'missing_retained_key' as const });
    }
    return Object.freeze({ capability: 'sync-conflicts' as const, status: 'ready' as const,
      referencedVersions });
  };
}

function ports(transaction: DatabaseTransaction, options: ProductSyncCenterPostgresOptions): ProductSyncCenterPorts {
  return {
    async getStatus({ accountId }) {
      const devices = await transaction.selectFrom('sync_devices').select(['device_id', 'device_name'])
        .where('account_id', '=', accountId).orderBy('device_id').execute();
      const replicas = await transaction.selectFrom('sync_replicas as replica')
        .select(['replica.replica_id','replica.device_id','replica.replica_name','replica.collection_id','replica.kind',
          'replica.status','replica.lease_expires_at','replica.last_seen_at','replica.checkpoint_commit_ordinal',
          'replica.lifecycle_revision'])
        .where('replica.account_id', '=', accountId).orderBy('replica.device_id').orderBy('replica.replica_id').execute();
      const ackRows = await transaction.selectFrom('sync_ack_receipts as ack')
        .innerJoin('sync_replicas as replica', 'replica.replica_id', 'ack.replica_id')
        .select(['ack.replica_id'])
        .select(({ fn }) => fn.max('ack.completed_at').as('last_ack_at'))
        .where('replica.account_id', '=', accountId)
        .groupBy('ack.replica_id').execute();
      const lastAck = new Map(ackRows.map((row) => [row.replica_id, row.last_ack_at]));
      return Object.freeze({ devices: devices.map((device) => Object.freeze({ id: device.device_id, name: device.device_name })),
        replicas: replicas.map((replica) => { const revision = BigInt(replica.lifecycle_revision).toString();
          const ack = lastAck.get(replica.replica_id); return Object.freeze({ id: replica.replica_id,
            deviceId: replica.device_id, name: replica.replica_name, collectionId: replica.collection_id, kind: replica.kind,
            status: replica.status, leaseExpiresAt: replica.lease_expires_at.toISOString(), lastSeenAt: replica.last_seen_at.toISOString(),
            lastAckAt: ack instanceof Date ? ack.toISOString() : null,
            acknowledgedCommitOrdinal: replica.checkpoint_commit_ordinal === null ? null : BigInt(replica.checkpoint_commit_ordinal).toString(),
            lifecycleRevision: revision, etag: `"${revision}"` }); }) });
    },
    async getConflicts({ accountId, limit, cursor }) {
      const after = cursor === undefined ? undefined : decodeCursor(cursor, accountId, options.cursorSecret);
      const pageLimit = after?.limit ?? limit;
      let query = transaction.selectFrom('sync_conflicts as conflict')
        .innerJoin('sync_replicas as replica', 'replica.replica_id', 'conflict.replica_id')
        .innerJoin('nodes as node', 'node.id', 'conflict.target_id')
        .selectAll('conflict')
        .select(['replica.lease_generation','node.kind as node_kind'])
        .where('replica.account_id', '=', accountId).where('conflict.status', '=', 'open');
      if (after) query = query.where((eb) => eb.or([
        eb('conflict.created_at', '<', new Date(after.createdAt)),
        eb.and([eb('conflict.created_at', '=', new Date(after.createdAt)), eb('conflict.conflict_id', '<', after.id)]),
      ]));
      const rows = await query.orderBy('conflict.created_at', 'desc').orderBy('conflict.conflict_id', 'desc').limit(pageLimit + 1).execute();
      const pageRows = rows.slice(0, pageLimit); const tail = rows.length > pageLimit ? pageRows.at(-1) : undefined;
      return Object.freeze({ items: pageRows.map((conflict) => { const field = conflict.conflicting_fields.length === 1
        ? conflict.conflicting_fields[0] ?? null : null;
        const summary = readProductConflictSafeSummary(conflict, options.conflictPayloadKeyring,
          conflict.node_kind, conflict.lease_generation, field);
        return Object.freeze({ id: conflict.conflict_id,
          collectionId: conflict.collection_id, targetId: conflict.target_id, type: conflict.conflict_type, field,
          status: 'open' as const, allowedResolutions: [...conflict.allowed_resolutions], revision: conflict.revision,
          etag: `"${conflict.revision}"`, createdAt: conflict.created_at.toISOString(), summary: Object.freeze(summary) }); }), page: Object.freeze({ nextCursor: tail ? encodeCursor({ createdAt: tail.created_at.toISOString(),
          id: tail.conflict_id, limit: pageLimit }, accountId, options.cursorSecret) : null }) }) satisfies ProductConflictPage;
    },
    resolveConflict: (input) => command(transaction, { principalId: input.accountId,
      commandScope: `sync-conflict-resolution:${input.conflictId}`, commandId: input.commandId }, input.fingerprint, async () => {
      const result = await resolveProductConflictInTransaction(transaction, input, {
        conflictPayloadKeyring: options.conflictPayloadKeyring,
        ...(options.reportSourceInvalidation === undefined ? {} : {
          reportSourceInvalidation: options.reportSourceInvalidation,
        }),
      });
      const resolved = await transaction.selectFrom('sync_conflicts').select('resolved_at')
        .where('conflict_id', '=', input.conflictId).executeTakeFirstOrThrow();
      if (!(resolved.resolved_at instanceof Date)) throw new Error('Resolved Conflict has no completion time');
      return { conflictId: result.conflict.id, status: 'resolved', revision: result.conflict.revision,
        etag: `"${result.conflict.revision}"`, resolvedAt: resolved.resolved_at.toISOString() } satisfies ProductConflictResolutionView;
    }),
    retireReplica: (input) => command(transaction, { principalId: input.accountId,
      commandScope: `sync-replica-retire:${input.replicaId}`, commandId: input.commandId }, input.fingerprint, async () => {
      const located = await transaction.selectFrom('sync_replicas').select('collection_id')
        .where('replica_id', '=', input.replicaId).where('account_id', '=', input.accountId)
        .executeTakeFirst();
      if (!located) throw notFound();
      await lockCollectionReplicaGate(transaction, located.collection_id);
      const replica = await transaction.selectFrom('sync_replicas').selectAll().where('replica_id', '=', input.replicaId)
        .where('account_id', '=', input.accountId).forUpdate().executeTakeFirst();
      if (!replica) throw notFound();
      if (BigInt(replica.lifecycle_revision).toString() !== input.expectedLifecycleRevision) throw preconditionFailed();
      const result = await retireReplicaInTransaction(transaction, { accountId: input.accountId, collectionId: replica.collection_id,
        replicaId: replica.replica_id, expectedLeaseGeneration: BigInt(replica.lease_generation).toString(),
        expectedLifecycleRevision: input.expectedLifecycleRevision }, { auditPrincipalId: input.accountId });
      if (result.state !== 'committed') throw preconditionFailed();
      const retired = await transaction.selectFrom('sync_replicas').select(['retired_at', 'lifecycle_revision'])
        .where('replica_id', '=', replica.replica_id).executeTakeFirstOrThrow();
      if (!(retired.retired_at instanceof Date)) throw new Error('Retired Replica has no completion time');
      const retiredAt = retired.retired_at;
      await transaction.updateTable('sync_sessions').set({ status: 'terminated', termination_reason: 'administrative', terminated_at: retiredAt })
        .where('replica_id', '=', replica.replica_id).where('status', '=', 'active').execute();
      const revision = BigInt(retired.lifecycle_revision).toString();
      return { replicaId: input.replicaId, status: 'retired', lifecycleRevision: revision,
        etag: `"${revision}"`, retiredAt: retiredAt.toISOString() } satisfies ProductReplicaRetirementView;
    }),
    ...productSyncTrashPorts(transaction, {
      cursorSecret: options.cursorSecret,
      reportSourceInvalidation: options.reportSourceInvalidation,
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    }),
  };
}

async function command<T>(transaction: DatabaseTransaction,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string }, fingerprint: string,
  mutate: () => Promise<T>): Promise<ProductSyncCommandOutcome<T>> {
  const receipts = createPostgresProductCommandReceiptPort(transaction); const claim = await receipts.claim(binding, fingerprint);
  if (claim.kind === 'replay') return { kind: 'replay', status: claim.result.status, body: claim.result.body,
    stableHeaders: claim.result.stableHeaders, mediaType: claim.result.mediaType };
  if (claim.kind !== 'claimed') return claim;
  const result = await mutate(); const body = Buffer.from(stableJson(result), 'utf8');
  const etag = typeof (result as { etag?: unknown }).etag === 'string' ? (result as { etag: string }).etag : undefined;
  await receipts.complete(binding, fingerprint, { status: 200, body, stableHeaders: { 'cache-control': CACHE,
    'content-type': JSON_TYPE, ...(etag ? { etag } : {}) }, mediaType: JSON_TYPE, contractVersion: CONTRACT_VERSION });
  return { kind: 'committed', result };
}

function encodeCursor(value: { createdAt: string; id: string; limit: number }, accountId: string, secret: string): string {
  const payload = Buffer.from(stableJson({ v: 1, p: 'product-sync-conflicts', exp: Date.now() + 15 * 60_000, ...value }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update('product-sync-conflicts\0').update(accountId).update('\0').update(payload).digest('base64url'); return `${payload}.${signature}`;
}
function decodeCursor(cursor: string, accountId: string, secret: string): { createdAt: string; id: string; limit: number } {
  try { const [payload, signature, extra] = cursor.split('.'); if (!payload || !signature || extra) throw new Error();
    const expected = createHmac('sha256', secret).update('product-sync-conflicts\0').update(accountId).update('\0').update(payload).digest(); const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.p !== 'product-sync-conflicts' || typeof parsed.exp !== 'number'
      || !Number.isSafeInteger(parsed.exp) || parsed.exp < Date.now()
      || typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string'
      || !Number.isSafeInteger(parsed.limit) || (parsed.limit as number) < 1 || (parsed.limit as number) > 100) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id, limit: parsed.limit as number };
  } catch { throw Object.assign(new Error('Invalid Product Sync cursor'), { code: 'invalid_cursor' }); }
}
function notFound() { return Object.assign(new Error('Replica not found'), { code: 'resource_not_found' }); }
function preconditionFailed() { return Object.assign(new Error('Replica lifecycle revision changed'), { code: 'precondition_failed' }); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
