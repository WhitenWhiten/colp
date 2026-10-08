import { createHash, randomUUID } from 'node:crypto';
import {
  coordinateSessionBoundSequence,
  type SequenceCoordinatorResult,
  type SequenceCoordinatorTransaction,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type VerifiedSyncSession,
} from '@know-n/colp/sync';
import { sql, type Kysely } from 'kysely';
import {
  createCanonicalMutationApplication,
  type CanonicalMutationInput,
  type CanonicalMutationResult,
} from '../../src/modules/collections/index.js';
import type { DatabaseSchema, DatabaseTransaction } from '../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationPorts } from '../../src/infrastructure/collections/index.js';

export const PHASE3_SEQUENCE_MAX_BATCH_OPERATIONS = 1 as const;

export type Phase3SequenceEntryFaultPoint =
  | 'receipt_claim'
  | 'canonical_mutation'
  | 'operation'
  | 'audit'
  | 'outbox'
  | 'receipt_finalize'
  | 'commit_outcome';

export interface Phase3SequenceEntryFaultInjector {
  after(point: Phase3SequenceEntryFaultPoint): void | Promise<void>;
}

export interface Phase3SequenceEntryHarnessOptions {
  readonly faultInjector?: Phase3SequenceEntryFaultInjector;
}

export interface Phase3SequenceEntryRequest {
  readonly session: VerifiedSyncSession;
  readonly leaseGeneration: number;
  readonly batchId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly mediaType: string;
  readonly endpointIdentity: string;
  readonly payload: CanonicalMutationInput;
  /** Transport-only observability input. Deliberately excluded from the digest. */
  readonly requestId?: string;
  /** Transport-only HTTP metadata. Deliberately excluded from the digest. */
  readonly date?: string;
}

export interface Phase3SequenceOperationResult {
  readonly status: 'applied';
  readonly operationId: string;
  readonly collectionId: string;
  readonly resourceId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly commitOrdinal: string;
}

export interface Phase3SequenceEntryResult {
  readonly session: VerifiedSyncSession;
  readonly result: SequenceCoordinatorResult<Phase3SequenceOperationResult>;
  readonly operationResult?: Phase3SequenceOperationResult;
}

export interface Phase3SequenceEntryEvidence {
  readonly nodeTitle: string;
  readonly nodeRevision: string;
  readonly collectionContentRevision: string;
  readonly commitOrdinal: string;
  readonly resourceLedgerEntries: number;
  readonly resourceRevisions: number;
  readonly contentRevisions: number;
  readonly childrenRevisions: number;
  readonly policyRevisions: number;
  readonly operations: number;
  readonly sequenceReceipts: number;
  readonly operationClaims: number;
  readonly conflicts: number;
  readonly tombstones: number;
  readonly auditEvents: number;
  readonly outboxEvents: number;
}

export interface Phase3StoredSequenceReceiptEvidence extends StoredSequenceReceipt {
  readonly sessionId: string;
  readonly leaseGeneration: number;
  readonly batchId: string;
  readonly mediaType: string;
  readonly endpointIdentity: string;
}

interface StoredSequenceReceipt {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly digest: string;
  readonly status: 'applied';
  readonly result: Phase3SequenceOperationResult;
}

interface Phase3SequenceTransaction
  extends SequenceCoordinatorTransaction<Phase3SequenceOperationResult> {
  readonly databaseTransaction: DatabaseTransaction;
}

export class Phase3SequenceEntryFaultError extends Error {
  public readonly point: Phase3SequenceEntryFaultPoint;

  public constructor(point: Phase3SequenceEntryFaultPoint) {
    super(`P3-02 injected fault after ${point}`);
    this.name = 'Phase3SequenceEntryFaultError';
    this.point = point;
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must be non-empty`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('canonical digest payload must be JSON data');
    return encoded;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical digest payload must contain finite numbers');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('canonical digest payload must be JSON data');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('canonical digest payload must be JSON data');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * Canonical P3-02 replay digest. Request IDs and Date are transport metadata and
 * intentionally absent; every durable admission identity is explicitly bound.
 */
export function createPhase3SequenceRequestDigest(request: Phase3SequenceEntryRequest): string {
  const envelope = {
    sessionId: request.session.sessionId,
    leaseGeneration: request.leaseGeneration,
    batchId: request.batchId,
    replicaId: request.replicaId,
    sequenceScope: request.sequenceScope,
    sequence: request.sequence,
    operationId: request.operationId,
    mediaType: request.mediaType,
    endpointIdentity: request.endpointIdentity,
    payload: request.payload,
  };
  return createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex');
}

function assertEntryRequest(request: Phase3SequenceEntryRequest): void {
  requireNonEmpty(request.batchId, 'batchId');
  requireNonEmpty(request.replicaId, 'replicaId');
  requireNonEmpty(request.sequenceScope, 'sequenceScope');
  requireNonEmpty(request.operationId, 'operationId');
  requireNonEmpty(request.mediaType, 'mediaType');
  requireNonEmpty(request.endpointIdentity, 'endpointIdentity');
  if (!Number.isSafeInteger(request.leaseGeneration) || request.leaseGeneration < 1) {
    throw new RangeError('leaseGeneration must be a positive safe integer');
  }
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) {
    throw new RangeError('sequence must be a positive safe integer');
  }
  if (request.payload.operationId !== request.operationId) {
    throw new TypeError('payload operationId must match the Sequence operationId');
  }
  if (request.payload.collectionId !== request.session.collectionId) {
    throw new TypeError('canonical mutation Collection must match the verified Session');
  }
  if (request.payload.actor.principalId !== request.session.principal.id) {
    throw new TypeError('canonical mutation actor must match the verified Session principal');
  }
  const batchPrefixes = [`${request.session.sessionId}.`];
  if (request.batchId !== request.session.sessionId
    && !batchPrefixes.some((prefix) => request.batchId.startsWith(prefix)
      && request.batchId.length > prefix.length)) {
    throw new TypeError('batchId must be bound to the verified Session');
  }
}

async function inject(
  injector: Phase3SequenceEntryFaultInjector | undefined,
  point: Phase3SequenceEntryFaultPoint,
): Promise<void> {
  await injector?.after(point);
}

function operationResult(canonical: CanonicalMutationResult): Phase3SequenceOperationResult {
  const resourceRevision = canonical.allocation.resourceRevision;
  const contentRevision = canonical.allocation.contentRevision;
  if (!resourceRevision || !contentRevision) {
    throw new TypeError('P3-02 Node update must allocate resource and content revisions');
  }
  return Object.freeze({
    status: 'applied',
    operationId: canonical.operationId,
    collectionId: canonical.collectionId,
    resourceId: canonical.resourceId,
    resourceRevision,
    contentRevision,
    commitOrdinal: canonical.allocation.commitOrdinal.toString(),
  });
}

function parseReceipt(row: Record<string, unknown>): StoredSequenceReceipt {
  if (row.status !== 'applied') {
    throw new TypeError(`P3-02 entry harness found unsupported receipt status: ${String(row.status)}`);
  }
  return {
    operationId: String(row.operation_id),
    replicaId: String(row.replica_id),
    sequenceScope: String(row.sequence_scope),
    sequence: Number(row.sequence_number),
    digest: String(row.digest),
    status: 'applied',
    result: row.result_json as unknown as Phase3SequenceOperationResult,
  };
}

function createTransactionAdapter(
  tx: DatabaseTransaction,
  request: Phase3SequenceEntryRequest,
  faultInjector: Phase3SequenceEntryFaultInjector | undefined,
): Phase3SequenceTransaction {
  const operationClaims = {
    async load(operationId: string): Promise<SyncOperationClaim | undefined> {
      const result = await sql<Record<string, unknown>>`
        select operation_id, digest, replica_id, sequence_scope, sequence_number
        from p3_sync_operation_claims where operation_id=${operationId}
      `.execute(tx);
      const row = result.rows[0];
      return row === undefined ? undefined : {
        operationId: String(row.operation_id), digest: String(row.digest), replicaId: String(row.replica_id),
        sequenceScope: String(row.sequence_scope), sequence: Number(row.sequence_number),
      };
    },
    async save(claim: SyncOperationClaim): Promise<void> {
      await sql`
        insert into p3_sync_operation_claims
          (operation_id, digest, replica_id, sequence_scope, sequence_number)
        values (${claim.operationId}, ${claim.digest}, ${claim.replicaId},
          ${claim.sequenceScope}, ${claim.sequence})
      `.execute(tx);
      await inject(faultInjector, 'receipt_claim');
    },
  };
  return {
    databaseTransaction: tx,
    idReservations: {
      async reserveAll(reservations) {
        for (const reservation of reservations) {
          const inserted = await sql<{ resource_id: string }>`
            insert into resource_id_ledger (resource_id, resource_type)
            values (${reservation.id}, ${reservation.resourceType})
            on conflict (resource_id) do nothing returning resource_id
          `.execute(tx);
          if (inserted.rows.length === 0) {
            const existing = await sql<{ resource_type: string }>`
              select resource_type from resource_id_ledger where resource_id=${reservation.id}
            `.execute(tx);
            return {
              state: 'conflict' as const,
              conflict: {
                requested: reservation,
                existing: { id: reservation.id, resourceType: existing.rows[0]!.resource_type as typeof reservation.resourceType },
              },
            };
          }
        }
        return { state: 'reserved' as const };
      },
    },
    operationClaims,
    reuseAudits: {
      async append(audit: SyncOperationReuseAudit): Promise<string> {
        const key = randomUUID();
        await sql`
          insert into p3_sequence_reuse_audits (audit_id, code, attempted_json, stored_json)
          values (${key}, ${audit.code}, ${JSON.stringify(audit.attempted)}::jsonb,
            ${JSON.stringify(audit.stored)}::jsonb)
        `.execute(tx);
        return key;
      },
      async load(key: string): Promise<SyncOperationReuseAudit | undefined> {
        const result = await sql<Record<string, unknown>>`
          select code, attempted_json, stored_json from p3_sequence_reuse_audits where audit_id=${key}
        `.execute(tx);
        const row = result.rows[0];
        return row === undefined ? undefined : {
          code: row.code as SyncOperationReuseAudit['code'],
          attempted: row.attempted_json as unknown as SyncOperationClaim,
          stored: row.stored_json as unknown as SyncOperationClaim,
        };
      },
    },
    receipts: {
      async load(lane: SequenceLaneKey, sequence: number): Promise<StoredSequenceReceipt | undefined> {
        const result = await sql<Record<string, unknown>>`
          select operation_id, replica_id, sequence_scope, sequence_number, digest,
            status, result_json
          from p3_sequence_receipts
          where replica_id=${lane.replicaId} and sequence_scope=${lane.sequenceScope}
            and sequence_number=${sequence}
        `.execute(tx);
        return result.rows[0] === undefined ? undefined : parseReceipt(result.rows[0]);
      },
      async save(receipt, condition): Promise<void> {
        if (condition.kind !== 'absent') {
          throw new TypeError('P3-02 entry harness does not evaluate deferred receipts');
        }
        await sql`
          insert into p3_sequence_receipts (
            replica_id, sequence_scope, sequence_number, operation_id, digest, status,
            result_json, session_id, lease_generation, batch_id, media_type, endpoint_identity
          ) values (
            ${receipt.replicaId}, ${receipt.sequenceScope}, ${receipt.sequence},
            ${receipt.operationId}, ${receipt.digest}, ${receipt.status},
            ${JSON.stringify(receipt.result)}::jsonb, ${request.session.sessionId},
            ${request.leaseGeneration}, ${request.batchId}, ${request.mediaType},
            ${request.endpointIdentity}
          )
        `.execute(tx);
        await inject(faultInjector, 'receipt_finalize');
      },
    },
    async loadLaneState(lane: SequenceLaneKey): Promise<SequenceLaneState | undefined> {
      const result = await sql<{ next_sequence: number }>`
        select next_sequence from p3_sequence_lanes
        where replica_id=${lane.replicaId} and sequence_scope=${lane.sequenceScope}
      `.execute(tx);
      return result.rows[0] === undefined ? undefined : { nextSequence: Number(result.rows[0].next_sequence) };
    },
    async saveLaneState(lane: SequenceLaneKey, state: SequenceLaneState): Promise<void> {
      await sql`
        update p3_sequence_lanes set next_sequence=${state.nextSequence}
        where replica_id=${lane.replicaId} and sequence_scope=${lane.sequenceScope}
      `.execute(tx);
    },
  };
}

export interface Phase3SequenceEntryHarness {
  readonly operationIdReservationOwner: 'sequence';
  readonly maxBatchOperations: 1;
  readonly usesPushCoordinator: false;
  ensurePrivateSchema(): Promise<void>;
  admit(request: Phase3SequenceEntryRequest): Promise<Phase3SequenceEntryResult>;
  admitBatch(requests: readonly Phase3SequenceEntryRequest[]): Promise<Phase3SequenceEntryResult>;
  inspect(collectionId: string): Promise<Phase3SequenceEntryEvidence>;
  inspectReceipt(
    replicaId: string,
    sequenceScope: string,
    sequence: number,
  ): Promise<Phase3StoredSequenceReceiptEvidence | undefined>;
  inspectReuseCodes(): Promise<readonly ('sequence_reuse' | 'op_id_reused')[]>;
}

/**
 * P3-02 entry Spike only. The private tables intentionally have no migration;
 * P3-10 will evolve this exact lane/claim/receipt shape into production DDL.
 */
export function createPhase3SequenceEntryHarness(
  db: Kysely<DatabaseSchema>,
  options: Phase3SequenceEntryHarnessOptions = {},
): Phase3SequenceEntryHarness {
  async function ensurePrivateSchema(): Promise<void> {
    await sql`
      create table if not exists p3_sequence_lanes (
        replica_id text not null,
        sequence_scope text not null,
        next_sequence bigint not null default 1 check (next_sequence > 0),
        primary key (replica_id, sequence_scope)
      )
    `.execute(db);
    await sql`
      create table if not exists p3_sync_operation_claims (
        operation_id text primary key references resource_id_ledger(resource_id) on delete restrict,
        digest text not null check (length(digest) = 64),
        replica_id text not null,
        sequence_scope text not null,
        sequence_number bigint not null check (sequence_number > 0),
        unique (replica_id, sequence_scope, sequence_number),
        unique (operation_id, replica_id, sequence_scope, sequence_number, digest)
      )
    `.execute(db);
    await sql`
      create table if not exists p3_sequence_receipts (
        replica_id text not null,
        sequence_scope text not null,
        sequence_number bigint not null check (sequence_number > 0),
        operation_id text not null unique references p3_sync_operation_claims(operation_id) on delete restrict,
        digest text not null check (length(digest) = 64),
        status text not null check (status in ('applied','rebased','noop','conflicted','rejected','deferred')),
        result_json jsonb not null,
        session_id text not null,
        lease_generation bigint not null check (lease_generation > 0),
        batch_id text not null,
        media_type text not null,
        endpoint_identity text not null,
        created_at timestamptz not null default now(),
        primary key (replica_id, sequence_scope, sequence_number),
        foreign key (replica_id, sequence_scope, sequence_number)
          references p3_sync_operation_claims(replica_id, sequence_scope, sequence_number)
          on delete restrict,
        foreign key (operation_id, replica_id, sequence_scope, sequence_number, digest)
          references p3_sync_operation_claims(operation_id, replica_id, sequence_scope, sequence_number, digest)
          on delete restrict
      )
    `.execute(db);
    await sql`
      create or replace function p3_sequence_terminal_receipt_immutable()
      returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' or old.status <> 'deferred' then
          raise exception 'terminal Sequence receipt is immutable' using errcode = '23514';
        end if;
        if new.operation_id <> old.operation_id
          or new.replica_id <> old.replica_id
          or new.sequence_scope <> old.sequence_scope
          or new.sequence_number <> old.sequence_number
          or new.digest <> old.digest
          or new.session_id <> old.session_id
          or new.lease_generation <> old.lease_generation
          or new.batch_id <> old.batch_id
          or new.media_type <> old.media_type
          or new.endpoint_identity <> old.endpoint_identity then
          raise exception 'Sequence receipt binding is immutable' using errcode = '23514';
        end if;
        return new;
      end $$
    `.execute(db);
    await sql`drop trigger if exists p3_sequence_receipt_immutable on p3_sequence_receipts`.execute(db);
    await sql`
      create trigger p3_sequence_receipt_immutable before update or delete on p3_sequence_receipts
      for each row execute function p3_sequence_terminal_receipt_immutable()
    `.execute(db);
    await sql`
      create table if not exists p3_sequence_reuse_audits (
        audit_id text primary key,
        audit_ordinal bigserial unique,
        code text not null check (code in ('sequence_reuse','op_id_reused')),
        attempted_json jsonb not null,
        stored_json jsonb not null,
        created_at timestamptz not null default now()
      )
    `.execute(db);
  }

  async function admitBatch(requests: readonly Phase3SequenceEntryRequest[]): Promise<Phase3SequenceEntryResult> {
    if (requests.length !== PHASE3_SEQUENCE_MAX_BATCH_OPERATIONS) {
      throw new RangeError('P3-02 Sequence entry requires maxBatchOperations=1');
    }
    const request = requests[0]!;
    assertEntryRequest(request);
    const digest = createPhase3SequenceRequestDigest(request);
    let operationResultValue: Phase3SequenceOperationResult | undefined;
    const unitOfWork = {
      operationIdReservationOwner: 'sequence' as const,
      async execute<Value>(lane: SequenceLaneKey, work: (transaction: Phase3SequenceTransaction) => Promise<Value>): Promise<Value> {
        const value = await db.transaction().execute(async (tx) => {
          await sql`
            insert into p3_sequence_lanes (replica_id, sequence_scope, next_sequence)
            values (${lane.replicaId}, ${lane.sequenceScope}, 1)
            on conflict (replica_id, sequence_scope) do nothing
          `.execute(tx);
          await sql`
            select next_sequence from p3_sequence_lanes
            where replica_id=${lane.replicaId} and sequence_scope=${lane.sequenceScope}
            for update
          `.execute(tx);
          return work(createTransactionAdapter(tx, request, options.faultInjector));
        });
        await inject(options.faultInjector, 'commit_outcome');
        return value;
      },
    };
    const coordinated = await coordinateSessionBoundSequence<
      Phase3SequenceOperationResult,
      Phase3SequenceTransaction
    >(
      {
        kind: 'verified',
        session: request.session,
        // @know-n/colp 0.1.1 requires a Replica ownership proof. This harness
        // exercises the Sequence owner; each fixture Replica belongs to its
        // fixture Session, so the proof only binds the Replica to that lane.
        sequenceOwnershipVerifier: (_session, key) => key.replicaId === request.replicaId,
      },
      unitOfWork,
      {
        operationId: request.operationId,
        replicaId: request.replicaId,
        sequenceScope: request.sequenceScope,
        sequence: request.sequence,
        digest,
      },
      async (_context, transaction) => {
        const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(
          transaction.databaseTransaction,
          {
            operationIdClaimOwner: {
              async assertClaimed(tx, operationId) {
                const claim = await sql<{ operation_id: string }>`
                  select claim.operation_id
                  from p3_sync_operation_claims claim
                  join resource_id_ledger ledger on ledger.resource_id=claim.operation_id
                  where claim.operation_id=${operationId}
                    and claim.digest=${digest}
                    and claim.replica_id=${request.replicaId}
                    and claim.sequence_scope=${request.sequenceScope}
                    and claim.sequence_number=${request.sequence}
                    and ledger.resource_type='operation'
                `.execute(tx);
                if (claim.rows.length !== 1) {
                  throw new TypeError('Canonical Mutation requires the exact durable Sequence Operation claim');
                }
              },
            },
            faultInjector: {
              async afterPhase(context) {
                if (context.phase === 'operation' || context.phase === 'audit' || context.phase === 'outbox') {
                  await inject(options.faultInjector, context.phase);
                }
              },
            },
          },
        ));
        const result = await canonical.execute(
          { transaction: transaction.databaseTransaction },
          request.payload,
        );
        await inject(options.faultInjector, 'canonical_mutation');
        operationResultValue = operationResult(result);
        return { status: 'applied' as const, result: operationResultValue };
      },
    );
    const receipt = coordinated.result.kind === 'executed' || coordinated.result.kind === 'replayed'
      ? coordinated.result.receipt
      : undefined;
    const resolvedOperationResult = receipt?.result ?? operationResultValue;
    if (resolvedOperationResult === undefined) {
      // Reuse denials carry no receipt; expose the previously committed result only
      // when one is addressable by this request's opId.
      const stored = await sql<{ result_json: Phase3SequenceOperationResult }>`
        select result_json from p3_sequence_receipts where operation_id=${request.operationId}
      `.execute(db);
      operationResultValue = stored.rows[0]?.result_json;
    }
    return Object.freeze({
      session: coordinated.session,
      result: coordinated.result,
      ...(resolvedOperationResult ?? operationResultValue
        ? { operationResult: resolvedOperationResult ?? operationResultValue }
        : {}),
    });
  }

  return {
    operationIdReservationOwner: 'sequence',
    maxBatchOperations: PHASE3_SEQUENCE_MAX_BATCH_OPERATIONS,
    usesPushCoordinator: false,
    ensurePrivateSchema,
    admit: (request) => admitBatch([request]),
    admitBatch,
    async inspect(collectionId): Promise<Phase3SequenceEntryEvidence> {
      const state = await sql<Record<string, unknown>>`
        select n.title node_title, n.resource_revision node_revision,
          c.content_revision, c.commit_ordinal::text commit_ordinal,
          (select count(*)::int from resource_id_ledger ledger
            where ledger.resource_id=c.id
              or ledger.resource_id in (select child.id from nodes child where child.collection_id=c.id)
              or ledger.resource_id in (select operation_id from operations o where o.collection_id=c.id)
          ) resource_ledger_entries,
          (select count(*)::int from resource_revisions r where r.collection_id=c.id) resource_revisions,
          (select count(*)::int from content_revisions r where r.collection_id=c.id) content_revisions,
          (select count(*)::int from children_revisions r where r.collection_id=c.id) children_revisions,
          (select count(*)::int from policy_revisions r where r.collection_id=c.id) policy_revisions,
          (select count(*)::int from operations o where o.collection_id=c.id) operations,
          (select count(*)::int from p3_sequence_receipts) sequence_receipts,
          (select count(*)::int from p3_sync_operation_claims) operation_claims,
          0::int conflicts,
          (select count(*)::int from nodes deleted
            where deleted.collection_id=c.id and deleted.deleted_at is not null) tombstones,
          (select count(*)::int from audit_events a where a.collection_id=c.id) audit_events,
          (select count(*)::int from outbox_events) outbox_events
        from collections c join nodes n on n.collection_id=c.id and n.is_root=false and n.deleted_at is null
        where c.id=${collectionId}
        order by n.id limit 1
      `.execute(db);
      const row = state.rows[0];
      if (!row) throw new TypeError('P3-02 fixture Collection/Node is missing');
      return {
        nodeTitle: String(row.node_title), nodeRevision: String(row.node_revision),
        collectionContentRevision: String(row.content_revision), commitOrdinal: String(row.commit_ordinal),
        resourceLedgerEntries: Number(row.resource_ledger_entries),
        resourceRevisions: Number(row.resource_revisions),
        contentRevisions: Number(row.content_revisions),
        childrenRevisions: Number(row.children_revisions),
        policyRevisions: Number(row.policy_revisions),
        operations: Number(row.operations),
        sequenceReceipts: Number(row.sequence_receipts),
        operationClaims: Number(row.operation_claims),
        conflicts: Number(row.conflicts), tombstones: Number(row.tombstones),
        auditEvents: Number(row.audit_events),
        outboxEvents: Number(row.outbox_events),
      };
    },
    async inspectReceipt(replicaId, sequenceScope, sequence) {
      const result = await sql<Record<string, unknown>>`
        select operation_id, replica_id, sequence_scope, sequence_number, digest,
          status, result_json, session_id, lease_generation, batch_id, media_type,
          endpoint_identity
        from p3_sequence_receipts
        where replica_id=${replicaId} and sequence_scope=${sequenceScope}
          and sequence_number=${sequence}
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        ...parseReceipt(row),
        sessionId: String(row.session_id),
        leaseGeneration: Number(row.lease_generation),
        batchId: String(row.batch_id),
        mediaType: String(row.media_type),
        endpointIdentity: String(row.endpoint_identity),
      };
    },
    async inspectReuseCodes() {
      const result = await sql<{ code: 'sequence_reuse' | 'op_id_reused' }>`
        select code from p3_sequence_reuse_audits order by audit_ordinal
      `.execute(db);
      return result.rows.map((row) => row.code);
    },
  };
}
