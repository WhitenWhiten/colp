import { createHash } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import {
  SYNC_PULL_STREAM_KIND_ORDER,
  SyncPullReadError,
  type SyncPullCursorContext,
  type SyncPullReadErrorCode,
  type SyncPullTuple,
} from '../../../modules/sync/index.js';
import type {
  SyncPullCursorEvidenceTable,
  SyncPullCursorRecoveryProofTable,
} from '../../database/runtime.js';
import type { SyncPullPageEvidenceTable } from '../../database/sync-pull-page-evidence-tables.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import type {
  PreparedIssuedCursorEvidenceBatch,
  PreparedIssuedCursorEvidenceItem,
  PreparedIssuedCursorLineageItem,
  SyncPullEvidenceFaultInjector,
} from './sync-pull-cursor-evidence.js';

export interface PersistIssuedPageEvidenceInput {
  readonly replicaId: string;
  readonly lifecycleRevision: string;
  readonly context: SyncPullCursorContext;
  readonly prepared: PreparedIssuedCursorEvidenceBatch;
  readonly persistItems: readonly PreparedIssuedCursorEvidenceItem[];
  readonly visibleCount: number;
  readonly issuedAt: Date;
  readonly recoveryProofRetentionMs: number;
  readonly lineageItems: readonly PreparedIssuedCursorLineageItem[] | undefined;
  readonly evidenceFaultInjector?: SyncPullEvidenceFaultInjector;
}

interface RecoveryProofInsertFacts {
  readonly cursor_digest: string;
  readonly authority_session_id: string;
  readonly authority_lifecycle_revision: bigint;
  readonly account_id: string;
  readonly collection_id: string;
  readonly replica_id: string;
  readonly lease_generation: bigint;
  readonly policy_revision: string;
  readonly protocol_version: '0.1' | '0.2';
  readonly page_limit: number;
  readonly tuple_commit_ordinal: bigint;
  readonly tuple_stream_kind: number;
  readonly tuple_stable_id: string;
  readonly upper_commit_ordinal: bigint;
  readonly upper_stream_kind: number;
  readonly upper_stable_id: string;
  readonly purge_commit_ordinal: bigint;
  readonly purge_stream_kind: number;
  readonly purge_stable_id: string;
  readonly cursor_expires_at: Date;
  readonly proof_expires_at: Date;
  readonly issued_at: Date;
  readonly consumed_at: null;
}

interface PageEvidenceInsertFacts {
  readonly page_digest: string;
  readonly next_cursor_digest: string;
  readonly session_id: string;
  readonly account_id: string;
  readonly collection_id: string;
  readonly replica_id: string;
  readonly lease_generation: bigint;
  readonly lifecycle_revision: bigint;
  readonly policy_revision: string;
  readonly protocol_version: '0.1' | '0.2';
  readonly page_limit: number;
  readonly event_count: number;
  readonly lower_commit_ordinal: bigint;
  readonly lower_stream_kind: number;
  readonly lower_stable_id: string;
  readonly upper_commit_ordinal: bigint;
  readonly upper_stream_kind: number;
  readonly upper_stable_id: string;
  readonly purge_commit_ordinal: bigint;
  readonly purge_stream_kind: number;
  readonly purge_stable_id: string;
  readonly page_expires_at: Date;
}

export function buildSyncPullPageEvidenceDigest(input: {
  readonly replicaId: string;
  readonly sessionId: string;
  readonly leaseGeneration: string;
  readonly nextCursorDigest: string;
  readonly lower: SyncPullTuple;
  readonly upper: SyncPullTuple;
  readonly policyRevision: string;
  readonly protocolVersion: string;
  readonly pageLimit: number;
  readonly eventCount: number;
}): string {
  return createHash('sha256').update([
    input.replicaId, input.sessionId, input.leaseGeneration, input.nextCursorDigest,
    input.lower.commitOrdinal, input.lower.streamKind, input.lower.stableId,
    input.upper.commitOrdinal, input.upper.streamKind, input.upper.stableId,
    input.policyRevision, input.protocolVersion, String(input.pageLimit), String(input.eventCount),
  ].join('\0'), 'utf8').digest('hex');
}

export async function lookupSyncPullPageEvidenceByNextCursorDigest(
  transaction: DatabaseTransaction,
  replicaId: string,
  collectionId: string,
  digest: string,
): Promise<Selectable<SyncPullPageEvidenceTable> | undefined> {
  return transaction.selectFrom('sync_pull_page_evidence').selectAll()
    .where('replica_id', '=', replicaId).where('collection_id', '=', collectionId)
    .where('next_cursor_digest', '=', digest).executeTakeFirst();
}

export async function persistIssuedPageEvidence(
  transaction: DatabaseTransaction,
  input: PersistIssuedPageEvidenceInput,
): Promise<void> {
  if (input.persistItems.length !== 1) fail('integrity_failure');
  const persistItem = input.persistItems[0];
  if (persistItem === undefined) fail('integrity_failure');
  const pageFacts = buildPageEvidenceInsertFacts(input, persistItem);
  await insertSyncPullPageEvidence(transaction, pageFacts, input.issuedAt);
  const evidenceFacts = input.persistItems.map((item) => item.evidenceFacts);
  await batchInsertCursorEvidence(transaction, evidenceFacts, input.issuedAt);
  await input.evidenceFaultInjector?.afterPhase?.('evidence_insert', transaction);
  const persistedEvidence = await batchLoadCursorEvidenceByDigest(
    transaction, input.replicaId, input.persistItems.map((item) => item.digest),
  );
  await input.evidenceFaultInjector?.afterPhase?.('evidence_readback', transaction);
  const proofFacts: RecoveryProofInsertFacts[] = [];
  for (const item of input.persistItems) {
    const persisted = persistedEvidence.get(item.digest);
    assertPersistedEvidenceMatches(item.evidenceFacts, persisted);
    proofFacts.push(buildRecoveryProofInsertFacts({
      evidence: item.evidenceFacts,
      persistedIssuedAt: persisted.issued_at,
      authorityLifecycleRevision: input.lifecycleRevision,
      context: input.context,
      recoveryProofRetentionMs: input.recoveryProofRetentionMs,
    }));
  }
  await batchInsertRecoveryProofs(transaction, proofFacts);
  await input.evidenceFaultInjector?.afterPhase?.('proof_insert', transaction);
  const persistedProofs = await batchLoadRecoveryProofsByDigest(
    transaction, input.replicaId, input.persistItems.map((item) => item.digest),
  );
  await input.evidenceFaultInjector?.afterPhase?.('proof_readback', transaction);
  for (const expected of proofFacts) {
    assertPersistedProofMatches(expected, persistedProofs.get(expected.cursor_digest));
  }
  if (input.lineageItems !== undefined) {
    await batchInsertCursorLineage(transaction, input.lineageItems);
  }
  const persistedPage = await lookupSyncPullPageEvidenceByNextCursorDigest(
    transaction, input.replicaId, persistItem.evidenceFacts.collection_id, persistItem.digest,
  );
  assertPersistedPageMatches(pageFacts, persistedPage);
}

function buildPageEvidenceInsertFacts(
  input: PersistIssuedPageEvidenceInput,
  persistItem: PreparedIssuedCursorEvidenceItem,
): PageEvidenceInsertFacts {
  const lowerItem = input.visibleCount === 0 ? persistItem : input.prepared.items[0];
  if (lowerItem === undefined) fail('integrity_failure');
  const lower = lowerItem.tuple;
  const upper = input.prepared.pageUpperTuple;
  const facts = persistItem.evidenceFacts;
  if (!Number.isSafeInteger(input.visibleCount) || input.visibleCount < 0 || input.visibleCount > 1000) {
    fail('integrity_failure');
  }
  return {
    page_digest: buildSyncPullPageEvidenceDigest({
      replicaId: facts.replica_id,
      sessionId: facts.session_id,
      leaseGeneration: BigInt(facts.lease_generation).toString(),
      nextCursorDigest: persistItem.digest,
      lower,
      upper,
      policyRevision: facts.policy_revision,
      protocolVersion: facts.protocol_version,
      pageLimit: facts.page_limit,
      eventCount: input.visibleCount,
    }),
    next_cursor_digest: persistItem.digest,
    session_id: facts.session_id,
    account_id: facts.account_id,
    collection_id: facts.collection_id,
    replica_id: facts.replica_id,
    lease_generation: facts.lease_generation,
    lifecycle_revision: BigInt(input.lifecycleRevision),
    policy_revision: facts.policy_revision,
    protocol_version: facts.protocol_version,
    page_limit: facts.page_limit,
    event_count: input.visibleCount,
    lower_commit_ordinal: BigInt(lower.commitOrdinal),
    lower_stream_kind: SYNC_PULL_STREAM_KIND_ORDER[lower.streamKind],
    lower_stable_id: lower.stableId,
    upper_commit_ordinal: BigInt(upper.commitOrdinal),
    upper_stream_kind: SYNC_PULL_STREAM_KIND_ORDER[upper.streamKind],
    upper_stable_id: upper.stableId,
    purge_commit_ordinal: facts.purge_commit_ordinal,
    purge_stream_kind: facts.purge_stream_kind,
    purge_stable_id: facts.purge_stable_id,
    page_expires_at: facts.cursor_expires_at,
  };
}

async function insertSyncPullPageEvidence(
  transaction: DatabaseTransaction,
  facts: PageEvidenceInsertFacts,
  issuedAt: Date,
): Promise<void> {
  if (facts.page_expires_at.getTime() <= issuedAt.getTime()) fail('integrity_failure');
  await sql`
    INSERT INTO sync_pull_page_evidence (
      page_digest, next_cursor_digest, session_id, account_id, collection_id, replica_id,
      lease_generation, lifecycle_revision, policy_revision, protocol_version, page_limit, event_count,
      lower_commit_ordinal, lower_stream_kind, lower_stable_id,
      upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      purge_commit_ordinal, purge_stream_kind, purge_stable_id,
      page_expires_at, issued_at
    ) VALUES (
      ${facts.page_digest}, ${facts.next_cursor_digest}, ${facts.session_id}, ${facts.account_id},
      ${facts.collection_id}, ${facts.replica_id}, ${facts.lease_generation}, ${facts.lifecycle_revision},
      ${facts.policy_revision}, ${facts.protocol_version}, ${facts.page_limit}, ${facts.event_count},
      ${facts.lower_commit_ordinal}, ${facts.lower_stream_kind}, ${facts.lower_stable_id},
      ${facts.upper_commit_ordinal}, ${facts.upper_stream_kind}, ${facts.upper_stable_id},
      ${facts.purge_commit_ordinal}, ${facts.purge_stream_kind}, ${facts.purge_stable_id},
      ${facts.page_expires_at}, ${issuedAt}
    )
    ON CONFLICT (replica_id, next_cursor_digest) DO NOTHING
  `.execute(transaction);
}

function assertPersistedPageMatches(
  expected: PageEvidenceInsertFacts,
  persisted: Selectable<SyncPullPageEvidenceTable> | undefined,
): void {
  // Stream identity plus collection revision. Concurrent Ack/session freshen may
  // persist the same page with a newer replica lifecycle; ON CONFLICT reuse
  // must not 500 on that fingerprint drift.
  if (!persisted || persisted.page_digest !== expected.page_digest
      || persisted.next_cursor_digest !== expected.next_cursor_digest
      || persisted.session_id !== expected.session_id
      || persisted.account_id !== expected.account_id
      || persisted.collection_id !== expected.collection_id
      || persisted.replica_id !== expected.replica_id
      || BigInt(persisted.lease_generation) !== expected.lease_generation
      || persisted.policy_revision !== expected.policy_revision
      || persisted.protocol_version !== expected.protocol_version
      || persisted.page_limit !== expected.page_limit
      || persisted.event_count !== expected.event_count
      || BigInt(persisted.lower_commit_ordinal) !== expected.lower_commit_ordinal
      || persisted.lower_stream_kind !== expected.lower_stream_kind
      || persisted.lower_stable_id !== expected.lower_stable_id
      || BigInt(persisted.upper_commit_ordinal) !== expected.upper_commit_ordinal
      || persisted.upper_stream_kind !== expected.upper_stream_kind
      || persisted.upper_stable_id !== expected.upper_stable_id
      || BigInt(persisted.purge_commit_ordinal) !== expected.purge_commit_ordinal
      || persisted.purge_stream_kind !== expected.purge_stream_kind
      || persisted.purge_stable_id !== expected.purge_stable_id
      || persisted.page_expires_at.getTime() !== expected.page_expires_at.getTime()) {
    fail('integrity_failure');
  }
}

function buildRecoveryProofInsertFacts(input: {
  readonly evidence: PreparedIssuedCursorEvidenceItem['evidenceFacts'];
  readonly persistedIssuedAt: Date;
  readonly authorityLifecycleRevision: string;
  readonly context: SyncPullCursorContext;
  readonly recoveryProofRetentionMs: number;
}): RecoveryProofInsertFacts {
  return {
    cursor_digest: input.evidence.cursor_digest,
    authority_session_id: input.context.sessionId,
    authority_lifecycle_revision: BigInt(input.authorityLifecycleRevision),
    account_id: input.evidence.account_id,
    collection_id: input.evidence.collection_id,
    replica_id: input.evidence.replica_id,
    lease_generation: input.evidence.lease_generation,
    policy_revision: input.evidence.policy_revision,
    protocol_version: input.evidence.protocol_version,
    page_limit: input.evidence.page_limit,
    tuple_commit_ordinal: input.evidence.tuple_commit_ordinal,
    tuple_stream_kind: input.evidence.tuple_stream_kind,
    tuple_stable_id: input.evidence.tuple_stable_id,
    upper_commit_ordinal: input.evidence.upper_commit_ordinal,
    upper_stream_kind: input.evidence.upper_stream_kind,
    upper_stable_id: input.evidence.upper_stable_id,
    purge_commit_ordinal: input.evidence.purge_commit_ordinal,
    purge_stream_kind: input.evidence.purge_stream_kind,
    purge_stable_id: input.evidence.purge_stable_id,
    cursor_expires_at: input.evidence.cursor_expires_at,
    proof_expires_at: new Date(Math.max(
      input.persistedIssuedAt.getTime() + input.recoveryProofRetentionMs,
      input.evidence.cursor_expires_at.getTime() + 1,
    )),
    issued_at: input.persistedIssuedAt,
    consumed_at: null,
  };
}

function assertPersistedEvidenceMatches(
  expected: PreparedIssuedCursorEvidenceItem['evidenceFacts'],
  persisted: Selectable<SyncPullCursorEvidenceTable> | undefined,
): asserts persisted is Selectable<SyncPullCursorEvidenceTable> {
  // Concurrent Push may persist the same page with a newer Collection
  // content revision. Cursor digest does not include that fingerprint, so
  // ON CONFLICT reuse must not 500 on the drift.
  if (!persisted || persisted.cursor !== expected.cursor || persisted.session_id !== expected.session_id
      || persisted.cursor_digest !== expected.cursor_digest
      || persisted.account_id !== expected.account_id
      || persisted.collection_id !== expected.collection_id
      || persisted.replica_id !== expected.replica_id
      || BigInt(persisted.lease_generation) !== expected.lease_generation
      || persisted.policy_revision !== expected.policy_revision
      || persisted.protocol_version !== expected.protocol_version
      || persisted.cursor_expires_at.getTime() !== expected.cursor_expires_at.getTime()
      || BigInt(persisted.tuple_commit_ordinal) !== expected.tuple_commit_ordinal
      || persisted.tuple_stream_kind !== expected.tuple_stream_kind
      || persisted.tuple_stable_id !== expected.tuple_stable_id
      || BigInt(persisted.upper_commit_ordinal) !== expected.upper_commit_ordinal
      || persisted.upper_stream_kind !== expected.upper_stream_kind
      || persisted.upper_stable_id !== expected.upper_stable_id
      || persisted.page_limit !== expected.page_limit
      || BigInt(persisted.purge_commit_ordinal) !== expected.purge_commit_ordinal
      || persisted.purge_stream_kind !== expected.purge_stream_kind
      || persisted.purge_stable_id !== expected.purge_stable_id) fail('integrity_failure');
}

function assertPersistedProofMatches(
  expected: RecoveryProofInsertFacts,
  proof: Selectable<SyncPullCursorRecoveryProofTable> | undefined,
): void {
  if (!proof || proof.authority_session_id !== expected.authority_session_id
      || proof.account_id !== expected.account_id || proof.collection_id !== expected.collection_id
      || proof.replica_id !== expected.replica_id
      || BigInt(proof.lease_generation) !== expected.lease_generation
      || proof.policy_revision !== expected.policy_revision
      || proof.protocol_version !== expected.protocol_version || proof.page_limit !== expected.page_limit
      || BigInt(proof.tuple_commit_ordinal) !== expected.tuple_commit_ordinal
      || proof.tuple_stream_kind !== expected.tuple_stream_kind
      || proof.tuple_stable_id !== expected.tuple_stable_id
      || BigInt(proof.upper_commit_ordinal) !== expected.upper_commit_ordinal
      || proof.upper_stream_kind !== expected.upper_stream_kind
      || proof.upper_stable_id !== expected.upper_stable_id
      || BigInt(proof.purge_commit_ordinal) !== expected.purge_commit_ordinal
      || proof.purge_stream_kind !== expected.purge_stream_kind
      || proof.purge_stable_id !== expected.purge_stable_id
      || proof.cursor_expires_at.getTime() !== expected.cursor_expires_at.getTime()
      || proof.proof_expires_at.getTime() !== expected.proof_expires_at.getTime()) fail('integrity_failure');
}

async function batchInsertCursorEvidence(
  transaction: DatabaseTransaction,
  facts: readonly PreparedIssuedCursorEvidenceItem['evidenceFacts'][],
  issuedAt: Date,
): Promise<void> {
  if (facts.length === 0) return;
  for (const row of facts) {
    if (row.cursor_expires_at.getTime() <= issuedAt.getTime()) fail('integrity_failure');
  }
  await sql`
    INSERT INTO sync_pull_cursor_evidence (
      cursor, cursor_digest, session_id, account_id, collection_id, replica_id,
      lease_generation, policy_revision, protocol_version,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      cursor_expires_at, issued_at, upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      collection_revision, page_limit, purge_commit_ordinal, purge_stream_kind, purge_stable_id
    )
    SELECT cursor, cursor_digest, session_id, account_id, collection_id, replica_id,
      lease_generation, policy_revision, protocol_version,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      cursor_expires_at, issued_at, upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      collection_revision, page_limit, purge_commit_ordinal, purge_stream_kind, purge_stable_id
    FROM unnest(
      ${facts.map((row) => row.cursor)}::text[],
      ${facts.map((row) => row.cursor_digest)}::text[],
      ${facts.map((row) => row.session_id)}::text[],
      ${facts.map((row) => row.account_id)}::text[],
      ${facts.map((row) => row.collection_id)}::text[],
      ${facts.map((row) => row.replica_id)}::text[],
      ${facts.map((row) => row.lease_generation)}::bigint[],
      ${facts.map((row) => row.policy_revision)}::text[],
      ${facts.map((row) => row.protocol_version)}::text[],
      ${facts.map((row) => row.tuple_commit_ordinal)}::bigint[],
      ${facts.map((row) => row.tuple_stream_kind)}::smallint[],
      ${facts.map((row) => row.tuple_stable_id)}::text[],
      ${facts.map((row) => row.cursor_expires_at)}::timestamptz[],
      ${facts.map(() => issuedAt)}::timestamptz[],
      ${facts.map((row) => row.upper_commit_ordinal)}::bigint[],
      ${facts.map((row) => row.upper_stream_kind)}::smallint[],
      ${facts.map((row) => row.upper_stable_id)}::text[],
      ${facts.map((row) => row.collection_revision)}::text[],
      ${facts.map((row) => row.page_limit)}::integer[],
      ${facts.map((row) => row.purge_commit_ordinal)}::bigint[],
      ${facts.map((row) => row.purge_stream_kind)}::smallint[],
      ${facts.map((row) => row.purge_stable_id)}::text[]
    ) AS batch(
      cursor, cursor_digest, session_id, account_id, collection_id, replica_id,
      lease_generation, policy_revision, protocol_version,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      cursor_expires_at, issued_at, upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      collection_revision, page_limit, purge_commit_ordinal, purge_stream_kind, purge_stable_id
    )
    ON CONFLICT (replica_id, cursor_digest) DO NOTHING
  `.execute(transaction);
}

async function batchLoadCursorEvidenceByDigest(
  transaction: DatabaseTransaction,
  replicaId: string,
  digests: readonly string[],
): Promise<Map<string, Selectable<SyncPullCursorEvidenceTable>>> {
  if (digests.length === 0) return new Map();
  const rows = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
    .where('replica_id', '=', replicaId)
    .where('cursor_digest', 'in', [...digests])
    .execute();
  const byDigest = new Map<string, Selectable<SyncPullCursorEvidenceTable>>();
  for (const row of rows) byDigest.set(row.cursor_digest, row);
  return byDigest;
}

async function batchInsertRecoveryProofs(
  transaction: DatabaseTransaction,
  facts: readonly RecoveryProofInsertFacts[],
): Promise<void> {
  if (facts.length === 0) return;
  await sql`
    INSERT INTO sync_pull_cursor_recovery_proofs (
      cursor_digest, authority_session_id, authority_lifecycle_revision, account_id, collection_id,
      replica_id, lease_generation, policy_revision, protocol_version, page_limit,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      purge_commit_ordinal, purge_stream_kind, purge_stable_id,
      cursor_expires_at, proof_expires_at, issued_at
    )
    SELECT cursor_digest, authority_session_id, authority_lifecycle_revision, account_id, collection_id,
      replica_id, lease_generation, policy_revision, protocol_version, page_limit,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      purge_commit_ordinal, purge_stream_kind, purge_stable_id,
      cursor_expires_at, proof_expires_at, issued_at
    FROM unnest(
      ${facts.map((row) => row.cursor_digest)}::text[],
      ${facts.map((row) => row.authority_session_id)}::text[],
      ${facts.map((row) => row.authority_lifecycle_revision)}::bigint[],
      ${facts.map((row) => row.account_id)}::text[],
      ${facts.map((row) => row.collection_id)}::text[],
      ${facts.map((row) => row.replica_id)}::text[],
      ${facts.map((row) => row.lease_generation)}::bigint[],
      ${facts.map((row) => row.policy_revision)}::text[],
      ${facts.map((row) => row.protocol_version)}::text[],
      ${facts.map((row) => row.page_limit)}::integer[],
      ${facts.map((row) => row.tuple_commit_ordinal)}::bigint[],
      ${facts.map((row) => row.tuple_stream_kind)}::smallint[],
      ${facts.map((row) => row.tuple_stable_id)}::text[],
      ${facts.map((row) => row.upper_commit_ordinal)}::bigint[],
      ${facts.map((row) => row.upper_stream_kind)}::smallint[],
      ${facts.map((row) => row.upper_stable_id)}::text[],
      ${facts.map((row) => row.purge_commit_ordinal)}::bigint[],
      ${facts.map((row) => row.purge_stream_kind)}::smallint[],
      ${facts.map((row) => row.purge_stable_id)}::text[],
      ${facts.map((row) => row.cursor_expires_at)}::timestamptz[],
      ${facts.map((row) => row.proof_expires_at)}::timestamptz[],
      ${facts.map((row) => row.issued_at)}::timestamptz[]
    ) AS batch(
      cursor_digest, authority_session_id, authority_lifecycle_revision, account_id, collection_id,
      replica_id, lease_generation, policy_revision, protocol_version, page_limit,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      upper_commit_ordinal, upper_stream_kind, upper_stable_id,
      purge_commit_ordinal, purge_stream_kind, purge_stable_id,
      cursor_expires_at, proof_expires_at, issued_at
    )
    ON CONFLICT (replica_id, cursor_digest) DO NOTHING
  `.execute(transaction);
}

async function batchLoadRecoveryProofsByDigest(
  transaction: DatabaseTransaction,
  replicaId: string,
  digests: readonly string[],
): Promise<Map<string, Selectable<SyncPullCursorRecoveryProofTable>>> {
  if (digests.length === 0) return new Map();
  const rows = await transaction.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
    .where('replica_id', '=', replicaId)
    .where('cursor_digest', 'in', [...digests])
    .execute();
  const byDigest = new Map<string, Selectable<SyncPullCursorRecoveryProofTable>>();
  for (const row of rows) byDigest.set(row.cursor_digest, row);
  return byDigest;
}

async function batchInsertCursorLineage(
  transaction: DatabaseTransaction,
  items: readonly PreparedIssuedCursorLineageItem[],
): Promise<void> {
  if (items.length === 0) return;
  await sql`
    INSERT INTO sync_pull_cursor_lineage (
      cursor_digest, session_id, account_id, collection_id, replica_id, lease_generation,
      policy_revision, protocol_version, page_limit,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      cursor_expires_at, lineage_expires_at, issued_at, key_version, receipt
    )
    SELECT cursor_digest, session_id, account_id, collection_id, replica_id, lease_generation,
      policy_revision, protocol_version, page_limit,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      cursor_expires_at, lineage_expires_at, issued_at, key_version, receipt
    FROM unnest(
      ${items.map((row) => row.cursorDigest)}::text[],
      ${items.map((row) => row.sessionId)}::text[],
      ${items.map((row) => row.accountId)}::text[],
      ${items.map((row) => row.collectionId)}::text[],
      ${items.map((row) => row.replicaId)}::text[],
      ${items.map((row) => row.leaseGeneration)}::bigint[],
      ${items.map((row) => row.policyRevision)}::text[],
      ${items.map((row) => row.protocolVersion)}::text[],
      ${items.map((row) => row.pageLimit)}::integer[],
      ${items.map((row) => row.tupleCommitOrdinal)}::bigint[],
      ${items.map((row) => row.tupleStreamKind)}::smallint[],
      ${items.map((row) => row.tupleStableId)}::text[],
      ${items.map((row) => row.cursorExpiresAt)}::timestamptz[],
      ${items.map((row) => row.lineageExpiresAt)}::timestamptz[],
      ${items.map((row) => row.issuedAt)}::timestamptz[],
      ${items.map((row) => row.keyVersion)}::text[],
      ${items.map((row) => row.receipt)}::text[]
    ) AS batch(
      cursor_digest, session_id, account_id, collection_id, replica_id, lease_generation,
      policy_revision, protocol_version, page_limit,
      tuple_commit_ordinal, tuple_stream_kind, tuple_stable_id,
      cursor_expires_at, lineage_expires_at, issued_at, key_version, receipt
    )
    ON CONFLICT (replica_id, cursor_digest) DO NOTHING
  `.execute(transaction);
}

function fail(code: SyncPullReadErrorCode): never {
  throw new SyncPullReadError(code);
}
