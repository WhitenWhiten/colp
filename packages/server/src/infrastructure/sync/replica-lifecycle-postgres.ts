import {
  asReplicaAuthenticatedCommand,
  assertReplicaCallerAuthenticated,
  coordinateReplicaDueExpiry,
  coordinateReplicaLifecycle,
  type AuthoritativeSnapshotBinding,
  type DurableReplicaCheckpoint,
  type ReplicaLifecycleCommand,
  type ReplicaLifecycleCoordinatorResult,
  type ReplicaLifecycleTransaction,
  type ReplicaRetentionWindow,
  type ReplicaSnapshotAck,
} from '@know-n/colp/sync';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  classifyReplicaRenewalOutcome,
  materializeReplicaWireFacts,
  validateProtocolSafeReplicaId,
  validateReplicaCapabilities,
  validateReplicaLeaseDuration,
  validateReplicaLifecycleScope,
  type ReplicaLifecycleScope,
  type ReplicaRenewalOutcome,
} from '../../modules/sync/index.js';
import { databaseNow } from '../database/time.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { lockCollectionReplicaGate } from '../database/lock-order.js';
import type { DatabaseSchema, SyncReplicaTable } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';

export type ReplicaLifecycleFaultPhase = 'generation' | 'replica' | 'audit' | 'coordinator';

export interface ReplicaLifecycleFaultInjector {
  afterPhase?(phase: ReplicaLifecycleFaultPhase): void | Promise<void>;
}

export interface ReplicaRetentionWindowPort {
  load(transaction: DatabaseTransaction, collectionId: string): Promise<ReplicaRetentionWindow & {
    readonly earliestPullTuple?: ReplicaRetentionTuple;
    readonly purgedThroughTuple?: ReplicaRetentionTuple;
  }>;
}

export interface ReplicaRetentionTuple {
  readonly commitOrdinal: string;
  readonly streamKind: 0 | 1;
  readonly stableId: string;
}

export interface PostgresReplicaLifecycleOptions {
  readonly leaseId?: () => string;
  readonly retentionWindow?: ReplicaRetentionWindowPort;
  readonly faultInjector?: ReplicaLifecycleFaultInjector;
  readonly auditPrincipalId?: string;
}

export interface ReplicaLifecycleLeaseCommand {
  readonly scope: ReplicaLifecycleScope;
  readonly outcome: ReplicaRenewalOutcome;
  readonly leaseDurationSeconds: number;
}

export interface ReplicaLifecycleRetireCommand {
  readonly scope: ReplicaLifecycleScope;
  readonly outcome: ReplicaRenewalOutcome;
}

export interface ReplicaLifecycleMaintenanceCommand {
  readonly scope: ReplicaLifecycleScope;
}

export interface ExpireReplicaBatchInput {
  readonly limit: number;
}

export interface ExpireReplicaBatchResult {
  readonly expiredReplicaIds: readonly string[];
}

export interface PostgresReplicaLifecycleService {
  renew(command: ReplicaLifecycleLeaseCommand): Promise<ReplicaLifecycleCoordinatorResult>;
  resume(command: ReplicaLifecycleLeaseCommand): Promise<ReplicaLifecycleCoordinatorResult>;
  retire(command: ReplicaLifecycleRetireCommand): Promise<ReplicaLifecycleCoordinatorResult>;
  requireRecovery(command: ReplicaLifecycleMaintenanceCommand): Promise<ReplicaLifecycleCoordinatorResult>;
  expireDue(input: ExpireReplicaBatchInput): Promise<ExpireReplicaBatchResult>;
}

class StaleReplicaLifecycleFenceError extends Error {
  constructor() {
    super('Replica lifecycle generation or revision fence is stale.');
    this.name = 'StaleReplicaLifecycleFenceError';
  }
}

class ReplicaLifecyclePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaLifecyclePersistenceError';
  }
}

type LockedReplicaRow = Selectable<SyncReplicaTable>;

function formatInstant(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReplicaLifecyclePersistenceError('PostgreSQL returned an invalid lifecycle timestamp.');
  }
  return value.toISOString();
}

function checkpointFromRow(row: LockedReplicaRow): DurableReplicaCheckpoint {
  return Object.freeze({
    replicaId: row.replica_id,
    collectionId: row.collection_id,
    leaseId: row.lease_id,
    generation: BigInt(row.lease_generation).toString(),
    lastSeenAt: formatInstant(row.last_seen_at),
    leaseExpiresAt: formatInstant(row.lease_expires_at),
    acknowledgedCursor: row.checkpoint_cursor,
    acknowledgedCommitOrdinal: row.checkpoint_commit_ordinal === null
      ? null : BigInt(row.checkpoint_commit_ordinal).toString(),
    lifecycle: row.status,
  });
}

function lifecycleWire(row: LockedReplicaRow, checkpoint: DurableReplicaCheckpoint) {
  return materializeReplicaWireFacts({
    replicaId: row.replica_id,
    deviceId: row.device_id,
    accountId: row.account_id,
    collectionId: row.collection_id,
    replicaName: row.replica_name,
    kind: row.kind,
    leaseId: checkpoint.leaseId,
    leaseGeneration: checkpoint.generation,
    adapter: { profile: row.adapter_profile, version: row.adapter_version },
    capabilities: validateReplicaCapabilities(row.capabilities_json),
    binding: {
      browserProfileId: row.browser_profile_id,
      mountMode: row.binding_mode,
      browserGeneration: row.browser_generation,
    },
    checkpoint: {
      acknowledgedCursor: checkpoint.acknowledgedCursor,
      acknowledgedCommitOrdinal: checkpoint.acknowledgedCommitOrdinal,
    },
    status: checkpoint.lifecycle,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ReplicaLifecyclePersistenceError('Replica wire facts are invalid.');
  return encoded;
}

function denied(code: 'unauthorized' | 'request_failed' | 'stale_replica'):
Readonly<ReplicaLifecycleCoordinatorResult> {
  return Object.freeze({ state: 'denied' as const, code });
}

function hostAuthenticationProof() {
  return assertReplicaCallerAuthenticated({ authenticated: true, source: 'host-verified' });
}

function assertTransition(
  current: LockedReplicaRow,
  checkpoint: DurableReplicaCheckpoint,
): { generationChanged: boolean; nextGeneration: bigint } {
  if (current.retired_at !== null || current.status === 'retired') {
    throw new ReplicaLifecyclePersistenceError('A retired Replica cannot be changed.');
  }
  const nextGeneration = BigInt(checkpoint.generation);
  const currentGeneration = BigInt(current.lease_generation);
  const generationChanged = nextGeneration !== currentGeneration;
  if (generationChanged) {
    if (current.status !== 'expired' || checkpoint.lifecycle !== 'active'
        || nextGeneration !== currentGeneration + 1n || checkpoint.leaseId === current.lease_id) {
      throw new ReplicaLifecyclePersistenceError('Replica lease generation must advance exactly once on resume.');
    }
  } else if (checkpoint.leaseId !== current.lease_id) {
    throw new ReplicaLifecyclePersistenceError('Replica lease ID changed without a fresh generation.');
  }
  const allowed = new Set([
    `${current.status}:${current.status}`,
    'active:expired', 'active:recovery_required', 'active:retired',
    'expired:active', 'expired:recovery_required', 'expired:retired',
    'recovery_required:retired',
  ]);
  if (!allowed.has(`${current.status}:${checkpoint.lifecycle}`)) {
    throw new ReplicaLifecyclePersistenceError('Replica lifecycle transition is forbidden.');
  }
  if (new Date(checkpoint.leaseExpiresAt).getTime() <= new Date(checkpoint.lastSeenAt).getTime()) {
    throw new ReplicaLifecyclePersistenceError('Replica lease deadline must follow last-seen time.');
  }
  return { generationChanged, nextGeneration };
}

class PostgresLifecycleTransaction implements ReplicaLifecycleTransaction {
  private current: LockedReplicaRow | undefined;
  private loaded = false;
  private authoritativeTime: Date | undefined;
  changed = false;

  constructor(
    private readonly transaction: DatabaseTransaction,
    private readonly scope: ReplicaLifecycleScope,
    private readonly options: Required<Pick<PostgresReplicaLifecycleOptions, 'faultInjector'>>
      & Pick<PostgresReplicaLifecycleOptions, 'retentionWindow' | 'auditPrincipalId'>,
    initial?: LockedReplicaRow,
  ) {
    if (initial) {
      this.current = initial;
      this.loaded = true;
      this.assertInitialFence(initial);
    }
  }

  private assertInitialFence(row: LockedReplicaRow): void {
    if (BigInt(row.lease_generation).toString() !== this.scope.expectedLeaseGeneration
        || BigInt(row.lifecycle_revision).toString() !== this.scope.expectedLifecycleRevision) {
      throw new StaleReplicaLifecycleFenceError();
    }
  }

  async loadReplica(replicaId: string): Promise<DurableReplicaCheckpoint | undefined> {
    if (replicaId !== this.scope.replicaId) {
      throw new ReplicaLifecyclePersistenceError('Coordinator requested a different Replica identity.');
    }
    if (!this.loaded) {
      this.current = await this.transaction.selectFrom('sync_replicas').selectAll()
        .where('replica_id', '=', replicaId)
        .where('account_id', '=', this.scope.accountId)
        .where('collection_id', '=', this.scope.collectionId)
        .forUpdate().executeTakeFirst();
      this.loaded = true;
      if (this.current) this.assertInitialFence(this.current);
    }
    return this.current ? checkpointFromRow(this.current) : undefined;
  }

  async saveReplica(checkpoint: DurableReplicaCheckpoint): Promise<void> {
    const current = this.current;
    if (!this.loaded || !current || checkpoint.replicaId !== current.replica_id
        || checkpoint.collectionId !== current.collection_id) {
      throw new ReplicaLifecyclePersistenceError('Replica save has no matching locked authority row.');
    }
    if (canonicalJson(lifecycleWire(current, checkpointFromRow(current)))
        !== canonicalJson(current.wire_json)) {
      throw new ReplicaLifecyclePersistenceError('Stored Replica relational and wire facts disagree.');
    }
    const { generationChanged, nextGeneration } = assertTransition(current, checkpoint);
    const now = this.authoritativeTime ?? await databaseNow(this.transaction);
    this.authoritativeTime = now;
    if (generationChanged) {
      await this.transaction.insertInto('sync_replica_generations').values({
        replica_id: current.replica_id,
        lease_generation: nextGeneration,
        lease_id: checkpoint.leaseId,
        issued_at: now,
      }).execute();
      await this.options.faultInjector.afterPhase?.('generation');
    }

    const currentGeneration = BigInt(current.lease_generation);
    const currentRevision = BigInt(current.lifecycle_revision);
    const nextRevision = currentRevision + 1n;
    const retiredAt = checkpoint.lifecycle === 'retired' ? now : null;
    const wire = lifecycleWire(current, checkpoint);
    const updated = await this.transaction.updateTable('sync_replicas').set({
      lease_generation: nextGeneration,
      lease_id: checkpoint.leaseId,
      checkpoint_cursor: checkpoint.acknowledgedCursor,
      checkpoint_commit_ordinal: checkpoint.acknowledgedCommitOrdinal === null
        ? null : BigInt(checkpoint.acknowledgedCommitOrdinal),
      status: checkpoint.lifecycle,
      last_seen_at: new Date(checkpoint.lastSeenAt),
      lease_expires_at: new Date(checkpoint.leaseExpiresAt),
      retired_at: retiredAt,
      lifecycle_revision: nextRevision,
      wire_json: wire as unknown as Record<string, unknown>,
    }).where('replica_id', '=', current.replica_id)
      .where('account_id', '=', current.account_id)
      .where('collection_id', '=', current.collection_id)
      .where('lease_generation', '=', currentGeneration)
      .where('lifecycle_revision', '=', currentRevision)
      .where('status', '=', current.status)
      .where('retired_at', 'is', null)
      .returningAll().executeTakeFirst();
    if (!updated) throw new StaleReplicaLifecycleFenceError();
    await this.options.faultInjector.afterPhase?.('replica');

    const eventType = current.status === checkpoint.lifecycle
      ? 'sync.replica.lease_renewed'
      : `sync.replica.lifecycle.${current.status}_to_${checkpoint.lifecycle}`;
    await appendAuditEvent(this.transaction, {
      operationId: null,
      collectionId: null,
      principalId: this.options.auditPrincipalId ?? null,
      eventType,
      details: {
        replicaId: current.replica_id,
        collectionId: current.collection_id,
        from: current.status,
        to: checkpoint.lifecycle,
        previousLeaseGeneration: currentGeneration.toString(),
        leaseGeneration: nextGeneration.toString(),
        lifecycleRevision: nextRevision.toString(),
      },
      createdAt: now,
    });
    await this.options.faultInjector.afterPhase?.('audit');
    this.current = updated;
    this.changed = true;
  }

  async readAuthoritativeTime(): Promise<string> {
    this.authoritativeTime ??= await databaseNow(this.transaction);
    return formatInstant(this.authoritativeTime);
  }

  async loadRetentionWindow(collectionId: string): Promise<ReplicaRetentionWindow> {
    if (!this.options.retentionWindow) {
      throw new ReplicaLifecyclePersistenceError('Replica resume requires an authoritative retention-window port.');
    }
    const window = await this.options.retentionWindow.load(this.transaction, collectionId);
    // Replica row is already locked and the collection gate is already held.
    // A checkpoint behind the collection head must not become active: raising
    // the retention floor makes the coordinator persist recovery_required.
    const head = await this.transaction.selectFrom('collections').select('commit_ordinal')
      .where('id', '=', collectionId).forUpdate().executeTakeFirst();
    const acknowledged = this.current?.checkpoint_commit_ordinal;
    if (!head || acknowledged === null || acknowledged === undefined) return window;
    if (BigInt(acknowledged) >= BigInt(head.commit_ordinal)) return window;
    return {
      ...window,
      earliestPull: {
        ...window.earliestPull,
        commitOrdinal: BigInt(head.commit_ordinal).toString(),
      },
    };
  }

  loadAuthoritativeSnapshot(_snapshotId: string): Promise<AuthoritativeSnapshotBinding | undefined> {
    throw new ReplicaLifecyclePersistenceError('Snapshot recovery is not implemented in P3-06.');
  }

  saveSnapshotAck(_ack: ReplicaSnapshotAck): Promise<void> {
    throw new ReplicaLifecyclePersistenceError('Snapshot recovery is not implemented in P3-06.');
  }

  loadSnapshotAck(_replicaId: string): Promise<ReplicaSnapshotAck | undefined> {
    throw new ReplicaLifecyclePersistenceError('Snapshot recovery is not implemented in P3-06.');
  }
}

function inlineUnitOfWork(adapter: PostgresLifecycleTransaction) {
  return {
    async execute<Value>(replicaId: string, work: (port: PostgresLifecycleTransaction) => Promise<Value>) {
      if (replicaId.length < 1) throw new ReplicaLifecyclePersistenceError('Replica ID is empty.');
      return work(adapter);
    },
  };
}

function validateBatchLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new TypeError('Replica expiration batch limit must be an integer from 1 through 1000.');
  }
  return value as number;
}

/**
 * The single transaction-bound authority for explicit Replica retirement.
 * HTTP, Product and recovery callers must compose this function instead of updating sync_replicas.
 */
export async function retireReplicaInTransaction(
  transaction: DatabaseTransaction,
  rawScope: ReplicaLifecycleScope,
  inputOptions: Pick<PostgresReplicaLifecycleOptions, 'faultInjector' | 'auditPrincipalId'> = {},
): Promise<ReplicaLifecycleCoordinatorResult> {
  const scope = validateReplicaLifecycleScope(rawScope);
  const options = { faultInjector: inputOptions.faultInjector ?? {},
    auditPrincipalId: inputOptions.auditPrincipalId };
  try {
    await lockCollectionReplicaGate(transaction, scope.collectionId);
    const adapter = new PostgresLifecycleTransaction(transaction, scope, options);
    const result = await coordinateReplicaLifecycle(
      inlineUnitOfWork(adapter),
      { replicaId: scope.replicaId, collectionId: scope.collectionId },
      asReplicaAuthenticatedCommand(
        { type: 'retire' as const, succeeded: true as const },
        hostAuthenticationProof(),
      ),
    );
    await options.faultInjector.afterPhase?.('coordinator');
    return result;
  } catch (error: unknown) {
    if (error instanceof StaleReplicaLifecycleFenceError) return denied('stale_replica');
    throw error;
  }
}

export function createPostgresReplicaLifecycleService(
  db: Kysely<DatabaseSchema>,
  inputOptions: PostgresReplicaLifecycleOptions = {},
): PostgresReplicaLifecycleService {
  const leaseId = inputOptions.leaseId ?? (() => `lease-${randomUUID()}`);
  const options = {
    retentionWindow: inputOptions.retentionWindow,
    faultInjector: inputOptions.faultInjector ?? {},
    auditPrincipalId: inputOptions.auditPrincipalId,
  };

  async function execute(
    rawScope: ReplicaLifecycleScope,
    build: (now: Date) => ReplicaLifecycleCommand,
  ): Promise<ReplicaLifecycleCoordinatorResult> {
    const scope = validateReplicaLifecycleScope(rawScope);
    try {
      return await createUnitOfWork(db).execute(async ({ transaction }) => {
        await lockCollectionReplicaGate(transaction, scope.collectionId);
        const now = await databaseNow(transaction);
        const adapter = new PostgresLifecycleTransaction(transaction, scope, options);
        const result = await coordinateReplicaLifecycle(
          inlineUnitOfWork(adapter),
          { replicaId: scope.replicaId, collectionId: scope.collectionId },
          build(now),
        );
        await options.faultInjector.afterPhase?.('coordinator');
        return result;
      });
    } catch (error: unknown) {
      if (error instanceof StaleReplicaLifecycleFenceError) return denied('stale_replica');
      throw error;
    }
  }

  function preflight(outcome: ReplicaRenewalOutcome): ReplicaLifecycleCoordinatorResult | null {
    const rejection = classifyReplicaRenewalOutcome(outcome);
    return rejection ? denied(rejection.code) : null;
  }

  return {
    async renew(command) {
      const scope = validateReplicaLifecycleScope(command.scope);
      const duration = validateReplicaLeaseDuration(command.leaseDurationSeconds);
      const rejection = preflight(command.outcome);
      if (rejection) return rejection;
      return execute(scope, (now) => asReplicaAuthenticatedCommand({
        type: 'renew' as const,
        succeeded: true as const,
        leaseExpiresAt: new Date(now.getTime() + duration * 1_000).toISOString(),
      }, hostAuthenticationProof()));
    },
    async resume(command) {
      const scope = validateReplicaLifecycleScope(command.scope);
      const duration = validateReplicaLeaseDuration(command.leaseDurationSeconds);
      const rejection = preflight(command.outcome);
      if (rejection) return rejection;
      const freshLeaseId = validateProtocolSafeReplicaId(leaseId(), 'Generated lifecycle lease ID');
      const nextGeneration = (BigInt(scope.expectedLeaseGeneration) + 1n).toString();
      return execute(scope, (now) => asReplicaAuthenticatedCommand({
        type: 'resume' as const,
        succeeded: true as const,
        leaseId: freshLeaseId,
        generation: nextGeneration,
        leaseExpiresAt: new Date(now.getTime() + duration * 1_000).toISOString(),
      }, hostAuthenticationProof()));
    },
    async retire(command) {
      const scope = validateReplicaLifecycleScope(command.scope);
      const rejection = preflight(command.outcome);
      if (rejection) return rejection;
      return createUnitOfWork(db).execute(({ transaction }) =>
        retireReplicaInTransaction(transaction, scope, {
          faultInjector: options.faultInjector,
          auditPrincipalId: options.auditPrincipalId,
        }));
    },
    requireRecovery(command) {
      const scope = validateReplicaLifecycleScope(command.scope);
      return execute(scope, () => asReplicaAuthenticatedCommand({
        type: 'require_recovery' as const,
        succeeded: true as const,
      }, hostAuthenticationProof()));
    },
    async expireDue(input) {
      const limit = validateBatchLimit(input.limit);
      return createUnitOfWork(db).execute(async ({ transaction }) => {
        const candidates = await transaction.selectFrom('sync_replicas').selectAll()
          .where('status', '=', 'active')
          .where('lease_expires_at', '<=', sql<Date>`current_timestamp`)
          .orderBy('lease_expires_at', 'asc').orderBy('replica_id', 'asc')
          .limit(limit).forUpdate().skipLocked().execute();
        const expiredReplicaIds: string[] = [];
        for (const candidate of candidates) {
          const scope = validateReplicaLifecycleScope({
            accountId: candidate.account_id,
            collectionId: candidate.collection_id,
            replicaId: candidate.replica_id,
            expectedLeaseGeneration: candidate.lease_generation.toString(),
            expectedLifecycleRevision: candidate.lifecycle_revision.toString(),
          });
          const adapter = new PostgresLifecycleTransaction(transaction, scope, options, candidate);
          const result = await coordinateReplicaDueExpiry(
            inlineUnitOfWork(adapter),
            { replicaId: scope.replicaId, collectionId: scope.collectionId },
          );
          if (result.state !== 'committed' || result.checkpoint.lifecycle !== 'expired') {
            throw new ReplicaLifecyclePersistenceError('Due Replica expiration was not committed.');
          }
          await options.faultInjector.afterPhase?.('coordinator');
          if (adapter.changed) expiredReplicaIds.push(candidate.replica_id);
        }
        return Object.freeze({ expiredReplicaIds: Object.freeze(expiredReplicaIds) });
      });
    },
  };
}
