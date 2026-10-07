import type {
  SyncSessionRequest, SyncSessionRequestV02, SyncSessionResult, SyncSessionResultV02,
} from '@know-n/colp/types';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  REPLICA_LEASE_BOUNDS,
  canonicalSyncSessionFingerprint,
  SyncSessionIssueError,
  SyncSessionHttpError,
  type SyncSessionHttpApplicationInput,
  type SyncSessionHttpApplication,
  type SyncSessionIssueInput,
  type SyncSessionIssueEnvelope,
} from '../../modules/sync/index.js';
import type { PostgresSyncSessionIssuer } from './sync-session-postgres.js';
import { createPostgresReplicaStore, ReplicaIdAlreadyReservedError } from './replica-postgres.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import {
  bindSessionTransportBudget,
  defaultServerTransportBudget,
  negotiateSyncTransportBudget,
  readDeclaredTransportBudget,
  type SyncTransportBudget,
} from './sync-transport-budget.js';

export interface PostgresSyncSessionHttpOptions {
  readonly registerUnknownGenerationOneReplica?: boolean;
  readonly registrationLeaseSeconds?: number;
  readonly serverBudget?: SyncTransportBudget;
}

export function createPostgresSyncSessionHttpApplication(
  db: Kysely<DatabaseSchema>,
  issuer: PostgresSyncSessionIssuer,
  options: PostgresSyncSessionHttpOptions = {},
): SyncSessionHttpApplication {
  return Object.freeze({
    async issue(input: SyncSessionHttpApplicationInput) {
      try {
        const pending = await createUnitOfWork(db).execute(({ transaction }) =>
          issueInUnitOfWork(transaction, issuer, options, input));
        const issued = issuer.completeIssue(pending.issued);
        return Object.freeze({
          state: issued.state,
          response: toColpResponse(issued.envelope, pending.request),
          transportBudget: pending.transportBudget,
        });
      } catch (error: unknown) {
        throw mapIssueError(error);
      }
    },
  });
}

async function issueInUnitOfWork(
  db: DatabaseTransaction,
  issuer: PostgresSyncSessionIssuer,
  options: PostgresSyncSessionHttpOptions,
  input: SyncSessionHttpApplicationInput,
) {
      const request = collectionRequest(input.request);
      let clientBudget;
      try {
        clientBudget = readDeclaredTransportBudget(request.replica.extensions);
      } catch {
        throw new SyncSessionHttpError('invalid_document');
      }
      const negotiated = negotiateSyncTransportBudget(
        clientBudget, options.serverBudget ?? defaultServerTransportBudget(),
      );
      if (!input.credential.scopes.includes('known.sync')) {
        throw new SyncSessionHttpError('insufficient_scope');
      }

      // Coarse account/Collection authorization deliberately precedes Replica detail.
      // P3-07 repeats every mutable check under transaction locks.
      const identity = await db.selectFrom('account_identities as identity')
        .innerJoin('accounts as account', 'account.id', 'identity.account_id')
        .select(['account.id as account_id', 'account.subject_id', 'account.status'])
        .where('identity.issuer', '=', input.credential.issuer)
        .where('identity.subject', '=', input.credential.subject)
        .executeTakeFirst();
      if (!identity || identity.status !== 'active') throw new SyncSessionHttpError('authentication_required');
      const collection = await db.selectFrom('collections').select([
        'id', 'owner_subject_id', 'content_revision', 'deleted_at',
      ]).where('id', '=', request.collection.collectionId).executeTakeFirst();
      if (!collection || collection.deleted_at !== null) throw new SyncSessionHttpError('resource_not_found');
      const membership = collection.owner_subject_id === identity.subject_id
        ? 'owner'
        : (await db.selectFrom('collection_members').select('role')
          .where('collection_id', '=', collection.id)
          .where('subject_id', '=', identity.subject_id).executeTakeFirst())?.role;
      if (!membership) throw new SyncSessionHttpError('resource_not_found');
      // Account and credential rows precede the collection replica gate that
      // createReplica and session issue take next. Push uses the same order.
      await db.selectFrom('accounts').select('id').where('id', '=', identity.account_id)
        .forUpdate().executeTakeFirst();
      await db.selectFrom('sync_extension_credentials').select('credential_id')
        .where('issuer', '=', input.credential.issuer)
        .where('credential_id', '=', input.credential.credentialId)
        .forUpdate().executeTakeFirst();

      const requestedScopes = [
        ...(request.replica.capabilities.read ? ['sync:bootstrap', 'sync:pull'] as const : []),
        ...(request.replica.capabilities.write ? ['sync:push'] as const : []),
      ];
      if (requestedScopes.length < 1) throw new SyncSessionHttpError('insufficient_scope');

      if (options.registerUnknownGenerationOneReplica === true) {
        const registrationLock = JSON.stringify([
          identity.account_id, collection.id, request.replica.replicaId,
        ]);
        await sql`select pg_advisory_xact_lock(hashtextextended(${registrationLock}, 0))`.execute(db);
      }
      let replica = await db.selectFrom('sync_replicas').selectAll()
        .where('replica_id', '=', request.replica.replicaId)
        .where('account_id', '=', identity.account_id)
        .where('collection_id', '=', collection.id)
        .executeTakeFirst();
      if (!replica && options.registerUnknownGenerationOneReplica === true
          && request.replica.binding?.generation === '1') {
        await registerFirstInstallationReplica(db, {
          accountId: identity.account_id, collectionId: collection.id, request,
          leaseDurationSeconds: options.registrationLeaseSeconds ?? 3_600,
        });
        replica = await db.selectFrom('sync_replicas').selectAll()
          .where('replica_id', '=', request.replica.replicaId)
          .where('account_id', '=', identity.account_id)
          .where('collection_id', '=', collection.id)
          .executeTakeFirst();
      }
      if (!replica) throw new SyncSessionHttpError('resource_not_found');
      const binding = request.replica.binding;
      if (!binding
          || replica.kind !== request.replica.kind
          || replica.adapter_profile !== request.replica.adapter.profile
          || replica.adapter_version !== request.replica.adapter.version
          || replica.binding_mode !== binding.mountMode
          || replica.browser_profile_id !== binding.browserProfileId
          || replica.browser_generation !== binding.generation) {
        throw new SyncSessionHttpError('stale_replica');
      }
      const baseIssueInput: SyncSessionIssueInput = {
          credential: input.credential,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          collectionId: collection.id,
          replicaId: replica.replica_id,
          expectedLeaseGeneration: BigInt(replica.lease_generation).toString(),
          expectedLifecycleRevision: BigInt(replica.lifecycle_revision).toString(),
          binding: {
            browserProfileId: binding.browserProfileId,
            mountMode: binding.mountMode,
            browserGeneration: binding.generation,
          },
          requestedScopes,
          origin: input.origin,
          protocolVersion: request.protocolVersion,
        };
      const issueInput = await recoverReplayFence(db, identity.account_id, baseIssueInput);
      const issued = await issuer.issueInTransaction(db, issueInput);
      const transportBudget = issued.state === 'issued' || issued.state === 'replayed'
        ? await bindSessionTransportBudget(db, issued.session.sessionId, issued.state, negotiated)
        : negotiated;
      return { request, issued, transportBudget };
}

async function registerFirstInstallationReplica(
  db: DatabaseTransaction,
  input: {
    readonly accountId: string;
    readonly collectionId: string;
    readonly request: Extract<SyncSessionRequest | SyncSessionRequestV02, { scope: 'collection' }>;
    readonly leaseDurationSeconds: number;
  },
): Promise<void> {
  const binding = input.request.replica.binding;
  if (!binding || !Number.isSafeInteger(input.leaseDurationSeconds)
      || input.leaseDurationSeconds < REPLICA_LEASE_BOUNDS.minSeconds
      || input.leaseDurationSeconds > REPLICA_LEASE_BOUNDS.maxSeconds) {
    throw new SyncSessionHttpError('invalid_document');
  }
  const store = createPostgresReplicaStore(db, { ids: {
    deviceId: () => `device-${randomUUID()}`,
    replicaId: () => input.request.replica.replicaId,
    leaseId: () => `lease-${randomUUID()}`,
  } });
  try {
    await store.createInTransaction(db, {
      accountId: input.accountId,
      collectionId: input.collectionId,
      deviceName: input.request.replica.name,
      replicaName: input.request.replica.name,
      kind: input.request.replica.kind,
      adapter: input.request.replica.adapter,
      capabilities: input.request.replica.capabilities,
      binding: {
        browserProfileId: binding.browserProfileId,
        mountMode: binding.mountMode,
        browserGeneration: binding.generation,
      },
      leaseDurationSeconds: input.leaseDurationSeconds,
    }, { actorAccountId: input.accountId });
  } catch (error: unknown) {
    if (error instanceof ReplicaIdAlreadyReservedError) throw new SyncSessionHttpError('resource_not_found');
    throw error;
  }
}

async function recoverReplayFence(
  db: Kysely<DatabaseSchema>,
  accountId: string,
  current: SyncSessionIssueInput,
): Promise<SyncSessionIssueInput> {
  const receipt = await db.selectFrom('sync_session_idempotency_receipts as receipt')
    .innerJoin('sync_session_bindings as binding', 'binding.session_id', 'receipt.session_id')
    .select([
      'receipt.request_fingerprint', 'binding.lease_generation', 'binding.lifecycle_revision',
    ])
    .where('receipt.principal_id', '=', accountId)
    .where('receipt.session_scope', '=', 'collection')
    .where('receipt.idempotency_key', '=', current.idempotencyKey)
    .executeTakeFirst();
  if (!receipt) return current;
  const issuedGeneration = BigInt(receipt.lease_generation);
  const issuedRevision = BigInt(receipt.lifecycle_revision);
  if (issuedRevision < 1n) return current;
  const originalRevision = (issuedRevision - 1n).toString();
  const generationCandidates = [issuedGeneration, issuedGeneration - 1n]
    .filter((value, index, values) => value > 0n && values.indexOf(value) === index);
  for (const generation of generationCandidates) {
    const candidate = Object.freeze({
      ...current,
      expectedLeaseGeneration: generation.toString(),
      expectedLifecycleRevision: originalRevision,
    });
    if (canonicalSyncSessionFingerprint(candidate) === receipt.request_fingerprint) return candidate;
  }
  return current;
}

function collectionRequest(request: SyncSessionRequest | SyncSessionRequestV02):
Extract<SyncSessionRequest | SyncSessionRequestV02, { scope: 'collection' }> {
  if (request.scope !== 'collection') throw new SyncSessionHttpError('invalid_document');
  return request;
}

function toColpResponse(
  envelope: SyncSessionIssueEnvelope,
  request: Extract<SyncSessionRequest | SyncSessionRequestV02, { scope: 'collection' }>,
): SyncSessionResult | SyncSessionResultV02 {
  const clientTime = Date.parse(request.clientTime);
  const serverTime = Date.parse(envelope.serverTime);
  const skew = Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, serverTime - clientTime));
  return Object.freeze({
    sessionId: envelope.sessionId,
    expiresAt: envelope.expiresAt,
    serverTime: envelope.serverTime,
    clockSkewMilliseconds: skew,
    acceptedProtocolVersion: envelope.acceptedProtocolVersion,
    scope: 'collection' as const,
    maxBatchOperations: envelope.maxBatchOperations,
    tombstoneRetentionSeconds: envelope.tombstoneRetentionSeconds,
    replicaLease: Object.freeze({ ...envelope.replicaLease }),
    collection: Object.freeze({
      collectionId: request.collection.collectionId,
      snapshotRequired: envelope.snapshotRequired,
      serverCursor: envelope.collectionCursor,
      serverRevision: envelope.collectionRevision,
    }),
    conversionPolicy: Object.freeze({ ...envelope.conversionPolicy }),
  });
}

function mapIssueError(error: unknown): SyncSessionHttpError {
  if (error instanceof SyncSessionHttpError) return error;
  if (!(error instanceof SyncSessionIssueError)) return new SyncSessionHttpError('internal_error');
  switch (error.code) {
    case 'credential_invalid': return new SyncSessionHttpError('authentication_required');
    case 'not_found': return new SyncSessionHttpError('resource_not_found');
    case 'stale_replica': return new SyncSessionHttpError('stale_replica');
    case 'replica_retired': return new SyncSessionHttpError('replica_retired');
    case 'replica_expired':
    case 'replica_recovery_required': return new SyncSessionHttpError('stale_replica');
    case 'idempotency_key_reuse': return new SyncSessionHttpError('idempotency_key_reused');
    case 'session_expired':
    case 'session_revoked': return new SyncSessionHttpError('authentication_required');
    case 'integrity_failure': return new SyncSessionHttpError('internal_error');
  }
}
