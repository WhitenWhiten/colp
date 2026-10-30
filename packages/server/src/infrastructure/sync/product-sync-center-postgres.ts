import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { PRODUCT_REPLICA_COMMANDS_SHOWN, productReplicaActivity, REPLICA_COMMAND_TTL_MS, REPLICA_COMMANDS_OPEN_MAX,
  type ProductConflictPage, type ProductConflictResolutionView, type ProductReplicaCommandView,
  type ProductReplicaHealthView, type ProductReplicaIssuesView,
  type ProductReplicaRetirementView, type ProductSyncCenterPorts, type ProductSyncCenterUnitOfWork,
  type ProductSyncCommandOutcome } from '../../modules/sync/index.js';
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
import { stableJson } from './product-sync-stable-json.js';

const CONTRACT_VERSION = '1.10.0';
const JSON_TYPE = 'application/json; charset=utf-8';
const CACHE = 'private, no-store';
export interface ProductSyncConflictCursorPreviousKey {
  readonly secret: string;
  readonly retainUntilMs: number;
}

export interface ProductSyncCenterPostgresOptions { readonly cursorSecret: string;
  readonly cursorPreviousSecrets?: readonly ProductSyncConflictCursorPreviousKey[];
  readonly conflictPayloadKeyring: SyncConflictPayloadKeyring;
  /** Optional report cache/source-fence fan-out for conflict mutations. */
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly metrics?: Metrics }

export function createPostgresProductSyncCenterUnitOfWork(db: Kysely<DatabaseSchema>,
  options: ProductSyncCenterPostgresOptions): ProductSyncCenterUnitOfWork {
  if (options.cursorSecret.length < 32) throw new TypeError('Product Sync cursor secret must contain at least 32 characters');
  for (const key of options.cursorPreviousSecrets ?? []) {
    if (key.secret.length < 32 || !Number.isFinite(key.retainUntilMs)) {
      throw new TypeError('Product Sync cursor previous keys must contain at least 32 characters and a retention time');
    }
  }
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
      const { now, behindSince } = await readReplicaBehindSince(transaction, accountId);
      const reports = new Map((await transaction.selectFrom('sync_replica_reports')
        .select(['replica_id', 'health_state', 'health_code', 'health_since', 'health_reported_at', 'issue_total',
          'health_actions'])
        .where('account_id', '=', accountId).where('health_state', 'is not', null).execute())
        .map((row) => [row.replica_id, row]));
      const commands = await readRecentCommands(transaction, accountId, now);
      return Object.freeze({ devices: devices.map((device) => Object.freeze({ id: device.device_id, name: device.device_name })),
        replicas: replicas.map((replica) => { const revision = BigInt(replica.lifecycle_revision).toString();
          const ack = lastAck.get(replica.replica_id); const behind = behindSince.get(replica.replica_id) ?? null;
          const activity = productReplicaActivity({ status: replica.status, behindSince: behind,
            lastSeenAt: replica.last_seen_at, now });
          return Object.freeze({ id: replica.replica_id,
            deviceId: replica.device_id, name: replica.replica_name, collectionId: replica.collection_id, kind: replica.kind,
            status: replica.status, leaseExpiresAt: replica.lease_expires_at.toISOString(), lastSeenAt: replica.last_seen_at.toISOString(),
            lastAckAt: ack instanceof Date ? ack.toISOString() : null,
            acknowledgedCommitOrdinal: replica.checkpoint_commit_ordinal === null ? null : BigInt(replica.checkpoint_commit_ordinal).toString(),
            lifecycleRevision: revision, etag: `"${revision}"`,
            activity, behindSince: activity === null || behind === null ? null : behind.toISOString(),
            health: replica.status === 'retired' && !(commands.get(replica.replica_id) ?? []).some(command => command.action === 'rebuild') ? null
              : healthView(reports.get(replica.replica_id), commands.get(replica.replica_id) ?? []) }); }) });
    },
    async getReplicaIssues({ accountId, replicaId }) {
      const replica = await transaction.selectFrom('sync_replicas').select('replica_id')
        .where('replica_id', '=', replicaId).where('account_id', '=', accountId).executeTakeFirst();
      if (!replica) throw notFound();
      const report = await transaction.selectFrom('sync_replica_reports')
        .select(['health_reported_at', 'issue_total', 'issues', 'ack_warnings', 'ack_warnings_at'])
        .where('replica_id', '=', replicaId).executeTakeFirst();
      return Object.freeze({ replicaId, reportedAt: report?.health_reported_at?.toISOString() ?? null,
        total: report?.issue_total ?? 0,
        items: Object.freeze([...(report?.issues ?? [])] as ProductReplicaIssuesView['items']),
        ackWarnings: Object.freeze([...(report?.ack_warnings ?? [])] as ProductReplicaIssuesView['ackWarnings']),
        ackWarningsAt: report?.ack_warnings_at?.toISOString() ?? null });
    },
    async getConflicts({ accountId, limit, cursor }) {
      const after = cursor === undefined ? undefined : decodeCursor(cursor, accountId, options.cursorSecret, options.cursorPreviousSecrets);
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
    sendReplicaCommand: (input) => command(transaction, { principalId: input.accountId,
      commandScope: `sync-replica-command:${input.replicaId}`, commandId: input.commandId }, input.fingerprint, async () => {
      const replica = await transaction.selectFrom('sync_replicas').select(['status', 'lifecycle_revision'])
        // Serializes commands for one replica without blocking the Sync rows that reference it.
        .where('replica_id', '=', input.replicaId).where('account_id', '=', input.accountId).forNoKeyUpdate().executeTakeFirst();
      if (!replica) throw notFound();
      if (input.expectedLifecycleRevision !== undefined && replica.lifecycle_revision.toString() !== input.expectedLifecycleRevision)
        throw Object.assign(new Error('Replica lifecycle revision changed'), { code: 'precondition_failed' });
      const report = await transaction.selectFrom('sync_replica_reports').select(['health_state', 'health_actions', 'issues'])
        .where('replica_id', '=', input.replicaId).executeTakeFirst();
      const resumingReset = replica.status === 'retired' && input.action === 'rebuild' && input.issueId === undefined
        && await transaction.selectFrom('sync_replica_commands').select('command_id')
          .where('replica_id', '=', input.replicaId).where('action', '=', 'rebuild').where('issue_id', 'is', null).executeTakeFirst();
      // The browser decides what it can do; the Sync center only asks for what it offered.
      const issues = (report?.issues ?? []) as ProductReplicaIssuesView['items'];
      const offered = (replica.status !== 'retired' || resumingReset) && report?.health_state != null && (input.issueId === undefined
        ? report.health_actions.includes(input.action)
        : issues.some((issue) => issue.issueId === input.issueId && issue.actions.includes(input.action)));
      if (!offered) throw Object.assign(new Error('Replica action not offered'), { code: 'replica_action_unavailable' });
      const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction)).rows[0]!.now;
      const open = await transaction.selectFrom('sync_replica_commands').selectAll()
        .where('replica_id', '=', input.replicaId).where('state', 'in', ['pending', 'delivered'])
        .where('expires_at', '>', now).orderBy('created_at').execute();
      const same = open.find((row) => row.action === input.action && row.issue_id === (input.issueId ?? null));
      if (same) return commandView(same, now);
      if (open.length >= REPLICA_COMMANDS_OPEN_MAX) {
        throw Object.assign(new Error('Too many open replica commands'), { code: 'replica_commands_full' });
      }
      const created = await transaction.insertInto('sync_replica_commands').values({
        command_id: `cmd_${randomUUID()}`, replica_id: input.replicaId, account_id: input.accountId,
        action: input.action, issue_id: input.issueId ?? null, state: 'pending', created_at: now,
        expires_at: new Date(now.getTime() + REPLICA_COMMAND_TTL_MS),
      }).returningAll().executeTakeFirstOrThrow();
      return commandView(created, now);
    }),
    ...productSyncTrashPorts(transaction, {
      cursorSecret: options.cursorSecret,
      reportSourceInvalidation: options.reportSourceInvalidation,
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    }),
  };
}

function healthView(row: { readonly health_state: ProductReplicaHealthView['state'] | null; readonly health_code: string | null;
  readonly health_since: Date | null; readonly health_reported_at: Date | null; readonly issue_total: number | null;
  readonly health_actions: string[] } | undefined, commands: readonly ProductReplicaCommandView[]) {
  if (!row?.health_state || !row.health_since || !row.health_reported_at) return null;
  return Object.freeze({ state: row.health_state, code: row.health_code, since: row.health_since.toISOString(),
    reportedAt: row.health_reported_at.toISOString(), issueCount: row.issue_total ?? 0,
    actions: Object.freeze([...row.health_actions] as ProductReplicaHealthView['actions']),
    commands: Object.freeze([...commands]) }) satisfies ProductReplicaHealthView;
}

type CommandRow = { readonly command_id: string; readonly replica_id: string; readonly action: ProductReplicaCommandView['action'];
  readonly issue_id: string | null; readonly state: ProductReplicaCommandView['state']; readonly result_code: string | null;
  readonly created_at: Date; readonly completed_at: Date | null; readonly expires_at: Date };

/** An open command past its expiry reads as expired before the next report records it. */
function commandView(row: CommandRow, now: Date): ProductReplicaCommandView {
  const lapsed = (row.state === 'pending' || row.state === 'delivered') && row.expires_at <= now;
  return Object.freeze({ commandId: row.command_id, replicaId: row.replica_id, action: row.action, issueId: row.issue_id,
    state: lapsed ? 'expired' : row.state, resultCode: row.result_code, createdAt: row.created_at.toISOString(),
    completedAt: lapsed ? row.expires_at.toISOString() : row.completed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString() });
}

async function readRecentCommands(transaction: DatabaseTransaction, accountId: string, now: Date) {
  const rows = await transaction.selectFrom('sync_replica_commands').selectAll()
    .where('account_id', '=', accountId).where(eb => eb.or([
      eb('created_at', '>', new Date(now.getTime() - REPLICA_COMMAND_TTL_MS)),
      // A failed/interrupted reset may have retired the replica already. Keep
      // its recovery entry reachable even after a long offline period.
      eb.and([eb('action', '=', 'rebuild'), eb('state', '!=', 'done')]),
    ]))
    .orderBy('created_at', 'desc').orderBy('command_id', 'desc').execute();
  const byReplica = new Map<string, ProductReplicaCommandView[]>();
  for (const row of rows) {
    const list = byReplica.get(row.replica_id) ?? [];
    if (list.length < PRODUCT_REPLICA_COMMANDS_SHOWN) list.push(commandView(row, now));
    byReplica.set(row.replica_id, list);
  }
  return byReplica;
}

/**
 * For each live replica, when the oldest Sync stream row past its checkpoint
 * was committed. The three sources mirror the stream cut in
 * `readSyncPullStreamCut` (sync-operation-payload-reader.ts): wire operations
 * that are not conflicted, conflicts, and resolved conflict dismissals. Commits
 * that never enter the stream (sidecar writes) cannot make a replica behind.
 */
async function readReplicaBehindSince(transaction: DatabaseTransaction, accountId: string) {
  const result = await sql<{ replica_id: string; behind_since: Date | null; now: Date }>`
    SELECT replica.replica_id, clock_timestamp() AS now, (
      SELECT MIN(missed.created_at) FROM (
        (SELECT operation.created_at FROM operations AS operation
          WHERE operation.collection_id = replica.collection_id
            AND operation.commit_ordinal > COALESCE(replica.checkpoint_commit_ordinal, 0)
            AND operation.sync_wire_present AND operation.operation_type <> 'sync.conflict.dismissed'
            AND NOT EXISTS (SELECT 1 FROM sync_conflicts AS operation_conflict
              WHERE operation_conflict.collection_id = operation.collection_id
                AND operation_conflict.operation_id = operation.operation_id)
          ORDER BY operation.commit_ordinal LIMIT 1)
        UNION ALL
        (SELECT conflict.created_at FROM sync_conflicts AS conflict
          WHERE conflict.collection_id = replica.collection_id
            AND conflict.commit_ordinal > COALESCE(replica.checkpoint_commit_ordinal, 0)
          ORDER BY conflict.commit_ordinal LIMIT 1)
        UNION ALL
        (SELECT resolution.created_at FROM operations AS resolution
          JOIN sync_conflicts AS conflict ON conflict.collection_id = resolution.collection_id
            AND conflict.resolved_by_operation_id = resolution.operation_id
          WHERE resolution.collection_id = replica.collection_id
            AND resolution.operation_type = 'sync.conflict.dismissed' AND conflict.status = 'resolved'
            AND resolution.commit_ordinal > COALESCE(replica.checkpoint_commit_ordinal, 0)
          ORDER BY resolution.commit_ordinal LIMIT 1)
      ) AS missed
    ) AS behind_since
    FROM sync_replicas AS replica
    WHERE replica.account_id = ${accountId} AND replica.status <> 'retired'`.execute(transaction);
  const now = result.rows[0]?.now ?? new Date();
  return { now, behindSince: new Map(result.rows.flatMap((row) =>
    row.behind_since instanceof Date ? [[row.replica_id, row.behind_since] as const] : [])) };
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

const CONFLICT_CURSOR_TTL_MS = 15 * 60_000;
const CONFLICT_CURSOR_PURPOSE = 'product-sync-conflicts';

export function encodeProductSyncConflictCursor(value: { createdAt: string; id: string; limit: number }, accountId: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(stableJson({ v: 1, p: CONFLICT_CURSOR_PURPOSE, exp: now + CONFLICT_CURSOR_TTL_MS, ...value }, 'reject'), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(`${CONFLICT_CURSOR_PURPOSE}\0`).update(accountId).update('\0').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeProductSyncConflictCursor(cursor: string, accountId: string, currentSecret: string,
  previous: readonly ProductSyncConflictCursorPreviousKey[] = [], now = Date.now()): { createdAt: string; id: string; limit: number } {
  try {
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra) throw new Error();
    const keys = [
      { secret: currentSecret, usable: true },
      ...previous.map((key) => ({ secret: key.secret, usable: now < key.retainUntilMs })),
    ];
    let matched = false;
    for (const key of keys) {
      if (conflictCursorSignatureMatches(payload, signature, accountId, key.secret) && key.usable) matched = true;
    }
    if (!matched) throw new Error();
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.p !== CONFLICT_CURSOR_PURPOSE || typeof parsed.exp !== 'number'
      || !Number.isSafeInteger(parsed.exp) || parsed.exp < now
      || typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string'
      || !Number.isSafeInteger(parsed.limit) || (parsed.limit as number) < 1 || (parsed.limit as number) > 100) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id, limit: parsed.limit as number };
  } catch { throw Object.assign(new Error('Invalid Product Sync cursor'), { code: 'invalid_cursor' }); }
}

function conflictCursorSignatureMatches(payload: string, signature: string, accountId: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(`${CONFLICT_CURSOR_PURPOSE}\0`).update(accountId).update('\0').update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function encodeCursor(value: { createdAt: string; id: string; limit: number }, accountId: string, secret: string): string {
  return encodeProductSyncConflictCursor(value, accountId, secret);
}
function decodeCursor(cursor: string, accountId: string, secret: string,
  previous?: readonly ProductSyncConflictCursorPreviousKey[]): { createdAt: string; id: string; limit: number } {
  return decodeProductSyncConflictCursor(cursor, accountId, secret, previous);
}
function notFound() { return Object.assign(new Error('Replica not found'), { code: 'resource_not_found' }); }
function preconditionFailed() { return Object.assign(new Error('Replica lifecycle revision changed'), { code: 'precondition_failed' }); }
