import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  materializeReplicaWireFacts,
  type ReplicaCreateInput,
  type ReplicaCreateTrustedActor,
  type ReplicaRecord,
  type ReplicaWireFacts,
  validateReplicaBindingFacts,
  validateReplicaCapabilities,
  validateProtocolSafeReplicaId,
  validateReplicaCreateInput,
} from '../../modules/sync/index.js';
import { DatabaseOperationError } from '../database/errors.js';
import { lockCollectionReplicaGate } from '../database/lock-order.js';
import type { DatabaseSchema, SyncReplicaTable } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';

export class ReplicaScopeNotFoundError extends Error {
  readonly code = 'replica_scope_not_found' as const;
  constructor() {
    super('The requested Replica scope was not found.');
    this.name = 'ReplicaScopeNotFoundError';
  }
}

export class ReplicaIdAlreadyReservedError extends Error {
  readonly code = 'replica_id_already_reserved' as const;
  constructor() {
    super('The generated Replica identity is already reserved.');
    this.name = 'ReplicaIdAlreadyReservedError';
  }
}

export class ReplicaIntegrityError extends Error {
  readonly code = 'replica_integrity_failure' as const;
  constructor() {
    super('Stored Replica relational and wire facts disagree.');
    this.name = 'ReplicaIntegrityError';
  }
}

export interface ReplicaIdGenerator {
  deviceId(): string;
  replicaId(): string;
  leaseId(): string;
}

export type ReplicaCreatePhase = 'device' | 'lifetime' | 'generation' | 'replica';
export interface ReplicaCreateFaultInjector {
  afterPhase?(phase: ReplicaCreatePhase): void | Promise<void>;
}

export interface PostgresReplicaStoreOptions {
  readonly ids?: ReplicaIdGenerator;
  readonly faultInjector?: ReplicaCreateFaultInjector;
}

export interface ReplicaLoadScope {
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
}

export interface PostgresReplicaStore {
  create(input: ReplicaCreateInput, trusted: ReplicaCreateTrustedActor): Promise<ReplicaRecord>;
  createInTransaction(
    transaction: DatabaseTransaction,
    input: ReplicaCreateInput,
    trusted: ReplicaCreateTrustedActor,
  ): Promise<ReplicaRecord>;
  load(scope: ReplicaLoadScope): Promise<ReplicaRecord | null>;
}

const defaultIds: ReplicaIdGenerator = {
  deviceId: () => `device-${randomUUID()}`,
  replicaId: () => `replica-${randomUUID()}`,
  leaseId: () => `lease-${randomUUID()}`,
};

type LoadedRow = Selectable<SyncReplicaTable> & {
  readonly device_name: string;
  readonly lease_valid: boolean;
};

function bigintText(value: bigint | string): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function expectedWire(row: LoadedRow): ReplicaWireFacts {
  return materializeReplicaWireFacts({
    replicaId: row.replica_id,
    deviceId: row.device_id,
    accountId: row.account_id,
    collectionId: row.collection_id,
    replicaName: row.replica_name,
    kind: row.kind,
    leaseId: row.lease_id,
    leaseGeneration: bigintText(row.lease_generation),
    adapter: { profile: row.adapter_profile, version: row.adapter_version },
    capabilities: validateReplicaCapabilities(row.capabilities_json),
    binding: validateReplicaBindingFacts({
      browserProfileId: row.browser_profile_id,
      mountMode: row.binding_mode,
      browserGeneration: row.browser_generation,
    }),
    checkpoint: {
      acknowledgedCursor: row.checkpoint_cursor,
      acknowledgedCommitOrdinal: row.checkpoint_commit_ordinal === null
        ? null : bigintText(row.checkpoint_commit_ordinal),
    },
    status: row.status,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ReplicaIntegrityError();
  return encoded;
}

function mapLoaded(row: LoadedRow): ReplicaRecord {
  const wire = expectedWire(row);
  if (canonicalJson(wire) !== canonicalJson(row.wire_json)) throw new ReplicaIntegrityError();
  return Object.freeze({
    ...wire,
    deviceName: row.device_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    leaseExpiresAt: row.lease_expires_at,
    retiredAt: row.retired_at,
    leaseValid: row.lease_valid,
    lifecycleRevision: bigintText(row.lifecycle_revision),
  });
}

async function loadRow(
  transaction: DatabaseTransaction,
  scope: ReplicaLoadScope,
): Promise<LoadedRow | undefined> {
  return transaction.selectFrom('sync_replicas as replica')
    .innerJoin('sync_devices as device', 'device.device_id', 'replica.device_id')
    .selectAll('replica')
    .select('device.device_name as device_name')
    .select(sql<boolean>`replica.lease_expires_at > current_timestamp`.as('lease_valid'))
    .where('replica.replica_id', '=', scope.replicaId)
    .where('replica.account_id', '=', scope.accountId)
    .where('replica.collection_id', '=', scope.collectionId)
    .executeTakeFirst() as Promise<LoadedRow | undefined>;
}

async function createReplica(
  transaction: DatabaseTransaction,
  rawInput: ReplicaCreateInput,
  trusted: ReplicaCreateTrustedActor,
  options: Required<PostgresReplicaStoreOptions>,
): Promise<ReplicaRecord> {
  const input = validateReplicaCreateInput(rawInput, trusted);
  await lockCollectionReplicaGate(transaction, input.collectionId);
  const authorizedScope = await transaction
    .selectFrom('accounts')
    .innerJoin('collections', (join) => join
      .on('collections.id', '=', input.collectionId)
      .on('collections.deleted_at', 'is', null))
    .leftJoin('collection_members', (join) => join
      .onRef('collection_members.collection_id', '=', 'collections.id')
      .onRef('collection_members.subject_id', '=', 'accounts.subject_id'))
    .select('accounts.id')
    .where('accounts.id', '=', input.accountId)
    .where('accounts.status', '=', 'active')
    .where((eb) => eb.or([
      eb('collections.owner_subject_id', '=', eb.ref('accounts.subject_id')),
      eb('collection_members.subject_id', 'is not', null),
    ])).forUpdate('collections')
    .executeTakeFirst();
  if (!authorizedScope) throw new ReplicaScopeNotFoundError();

  let deviceId = input.deviceId;
  if (deviceId === undefined) {
    deviceId = validateProtocolSafeReplicaId(options.ids.deviceId(), 'Generated device ID');
    const now = sql<Date>`current_timestamp`;
    await transaction.insertInto('resource_id_ledger').values({
      resource_id: deviceId, resource_type: 'sync_device', committed_at: now,
    }).execute();
    await transaction.insertInto('sync_devices').values({
      device_id: deviceId, account_id: input.accountId, device_name: input.deviceName,
      created_at: now,
    }).execute();
    await options.faultInjector.afterPhase?.('device');
  } else {
    const device = await transaction.selectFrom('sync_devices').select('device_id')
      .where('device_id', '=', deviceId).where('account_id', '=', input.accountId)
      .executeTakeFirst();
    if (!device) throw new ReplicaScopeNotFoundError();
  }

  const replicaId = validateProtocolSafeReplicaId(options.ids.replicaId(), 'Generated Replica ID');
  const leaseId = validateProtocolSafeReplicaId(options.ids.leaseId(), 'Generated lease ID');
  const leaseGeneration = 1n;
  const times = await sql<{ now: Date; expires_at: Date }>`
    select current_timestamp as now,
      current_timestamp + make_interval(secs => ${input.leaseDurationSeconds}) as expires_at
  `.execute(transaction);
  const now = times.rows[0]?.now;
  const leaseExpiresAt = times.rows[0]?.expires_at;
  if (!(now instanceof Date) || !(leaseExpiresAt instanceof Date)) {
    throw new ReplicaIntegrityError();
  }

  await transaction.insertInto('resource_id_ledger').values({
    resource_id: replicaId, resource_type: 'sync_replica', committed_at: now,
  }).execute();
  await transaction.insertInto('sync_replica_id_ledger').values({
    replica_id: replicaId, account_id: input.accountId, device_id: deviceId,
    collection_id: input.collectionId, initial_lease_generation: leaseGeneration,
    binding_mode: input.binding.mountMode, browser_profile_id: input.binding.browserProfileId,
    browser_generation: input.binding.browserGeneration, reserved_at: now,
  }).execute();
  await options.faultInjector.afterPhase?.('lifetime');

  await transaction.insertInto('sync_replica_generations').values({
    replica_id: replicaId, lease_generation: leaseGeneration, lease_id: leaseId,
    issued_at: now,
  }).execute();
  await options.faultInjector.afterPhase?.('generation');

  const wire = materializeReplicaWireFacts({
    replicaId, deviceId, accountId: input.accountId, collectionId: input.collectionId,
    replicaName: input.replicaName, kind: input.kind,
    leaseId, leaseGeneration: '1', adapter: input.adapter, capabilities: input.capabilities,
    binding: input.binding,
    checkpoint: { acknowledgedCursor: null, acknowledgedCommitOrdinal: null },
    status: 'active',
  });
  await transaction.insertInto('sync_replicas').values({
    replica_id: replicaId, account_id: input.accountId, device_id: deviceId,
    collection_id: input.collectionId, replica_name: input.replicaName, kind: input.kind,
    lease_generation: leaseGeneration, lease_id: leaseId,
    binding_mode: input.binding.mountMode, browser_profile_id: input.binding.browserProfileId,
    browser_generation: input.binding.browserGeneration,
    adapter_profile: input.adapter.profile, adapter_version: input.adapter.version,
    capabilities_json: input.capabilities as unknown as Record<string, unknown>, checkpoint_cursor: null,
    checkpoint_commit_ordinal: null, status: 'active', created_at: now,
    last_seen_at: now, lease_expires_at: leaseExpiresAt, retired_at: null,
    wire_json: wire as unknown as Record<string, unknown>,
  }).execute();
  await options.faultInjector.afterPhase?.('replica');
  const loaded = await loadRow(transaction, {
    accountId: input.accountId, collectionId: input.collectionId, replicaId,
  });
  if (!loaded) throw new ReplicaIntegrityError();
  return mapLoaded(loaded);
}

function isReservedIdentityConflict(error: unknown): boolean {
  const constraint = error instanceof DatabaseOperationError
    ? error.kind === 'unique_violation' ? error.constraint : undefined
    : typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === '23505'
      ? (error as { readonly constraint?: string }).constraint : undefined;
  return new Set([
      'resource_id_ledger_pkey', 'sync_devices_pkey', 'sync_replica_id_ledger_pkey',
      'sync_replica_generations_pkey', 'sync_replica_generations_lease_id_key',
      'sync_replicas_pkey',
    ]).has(constraint ?? '');
}

export function createPostgresReplicaStore(
  db: Kysely<DatabaseSchema>,
  inputOptions: PostgresReplicaStoreOptions = {},
): PostgresReplicaStore {
  const options: Required<PostgresReplicaStoreOptions> = {
    ids: inputOptions.ids ?? defaultIds,
    faultInjector: inputOptions.faultInjector ?? {},
  };
  return {
    async create(input, trusted) {
      try {
        return await createUnitOfWork(db).execute(({ transaction }) =>
          createReplica(transaction, input, trusted, options));
      } catch (error: unknown) {
        if (isReservedIdentityConflict(error)) throw new ReplicaIdAlreadyReservedError();
        throw error;
      }
    },
    async createInTransaction(transaction, input, trusted) {
      try {
        return await createReplica(transaction, input, trusted, options);
      } catch (error: unknown) {
        if (isReservedIdentityConflict(error)) throw new ReplicaIdAlreadyReservedError();
        throw error;
      }
    },
    load(scope) {
      validateProtocolSafeReplicaId(scope.replicaId, 'Replica ID');
      return createUnitOfWork(db).execute(async ({ transaction }) => {
        const row = await loadRow(transaction, scope);
        return row ? mapLoaded(row) : null;
      });
    },
  };
}
