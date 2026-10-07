import { createHash } from 'node:crypto';
import {
  SYNC_PULL_STREAM_KIND_ORDER,
  SyncPullReadError,
  type SyncPullCursorContext,
  type SyncPullCursorKeyring,
  type SyncPullCursorLineageFacts,
  type SyncPullCursorLineageKeyring,
  type SyncPullReadErrorCode,
  type SyncPullStreamKind,
  type SyncPullTuple,
} from '../../../modules/sync/index.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';

export interface CursorEvidenceVisibleRow {
  readonly commitOrdinal: string;
  readonly streamKind: SyncPullStreamKind;
  readonly stableId: string;
}

export interface CursorEvidenceAuthorityFacts {
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly leaseGeneration: string;
  readonly policyRevision: string;
  readonly collectionRevision: string;
  readonly protocolVersion: '0.1' | '0.2';
}

export interface PreparedIssuedCursorEvidenceItem {
  readonly cursor: string;
  readonly digest: string;
  readonly tuple: SyncPullTuple;
  readonly cursorExpiresAt: number;
  readonly evidenceFacts: CursorEvidenceInsertFacts;
}

export interface PreparedIssuedCursorEvidenceBatch {
  readonly items: readonly PreparedIssuedCursorEvidenceItem[];
  readonly pageUpperTuple: SyncPullTuple;
}

interface CursorEvidenceInsertFacts {
  readonly cursor: string;
  readonly cursor_digest: string;
  readonly session_id: string;
  readonly account_id: string;
  readonly collection_id: string;
  readonly replica_id: string;
  readonly lease_generation: bigint;
  readonly policy_revision: string;
  readonly protocol_version: '0.1' | '0.2';
  readonly tuple_commit_ordinal: bigint;
  readonly tuple_stream_kind: number;
  readonly tuple_stable_id: string;
  readonly cursor_expires_at: Date;
  readonly upper_commit_ordinal: bigint;
  readonly upper_stream_kind: number;
  readonly upper_stable_id: string;
  readonly collection_revision: string;
  readonly page_limit: number;
  readonly purge_commit_ordinal: bigint;
  readonly purge_stream_kind: number;
  readonly purge_stable_id: string;
}

export type SyncPullEvidencePersistencePhase =
  | 'evidence_insert'
  | 'evidence_readback'
  | 'proof_insert'
  | 'proof_readback';

export interface SyncPullEvidenceFaultInjector {
  afterPhase?(phase: SyncPullEvidencePersistencePhase, transaction: DatabaseTransaction): void | Promise<void>;
}

/** FIX-L-035: minimal digest-only lineage row persisted beside the cursor evidence. */
export interface PreparedIssuedCursorLineageItem {
  readonly cursorDigest: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly leaseGeneration: bigint;
  readonly policyRevision: string;
  readonly protocolVersion: '0.1' | '0.2';
  readonly pageLimit: number;
  readonly tupleCommitOrdinal: bigint;
  readonly tupleStreamKind: number;
  readonly tupleStableId: string;
  readonly cursorExpiresAt: Date;
  readonly lineageExpiresAt: Date;
  readonly issuedAt: Date;
  readonly keyVersion: string;
  readonly receipt: string;
}

export function buildIssuedCursorEntries(input: {
  readonly visible: readonly CursorEvidenceVisibleRow[];
  readonly eventCursors: readonly string[];
  readonly nextCursor: string;
  readonly pageUpperTuple: SyncPullTuple;
}): readonly { readonly cursor: string; readonly tuple: SyncPullTuple }[] {
  if (input.visible.length !== input.eventCursors.length) fail('integrity_failure');
  // The equal-length guard above means every index has a matching event cursor.
  const issued = input.visible.map((row, index) => ({
    cursor: input.eventCursors[index]!,
    tuple: Object.freeze({
      commitOrdinal: row.commitOrdinal,
      streamKind: row.streamKind,
      stableId: row.stableId,
    }),
  }));
  if (issued.length === 0 || issued.at(-1)?.cursor !== input.nextCursor) {
    issued.push({ cursor: input.nextCursor, tuple: input.pageUpperTuple });
  }
  return Object.freeze(issued);
}

export function prepareIssuedCursorEvidenceItems(input: {
  readonly visible: readonly CursorEvidenceVisibleRow[];
  readonly eventCursors: readonly string[];
  readonly nextCursor: string;
  readonly pageUpperTuple: SyncPullTuple;
  readonly keyring: SyncPullCursorKeyring;
  readonly context: SyncPullCursorContext;
  readonly authority: CursorEvidenceAuthorityFacts;
}): PreparedIssuedCursorEvidenceBatch {
  const entries = buildIssuedCursorEntries(input);
  const seenDigests = new Set<string>();
  const items: PreparedIssuedCursorEvidenceItem[] = [];
  for (const entry of entries) {
    const verified = input.keyring.verify(entry.cursor, input.context);
    if (!verified.valid) fail(verified.code);
    const digest = createHash('sha256').update(entry.cursor, 'utf8').digest('hex');
    if (seenDigests.has(digest)) fail('integrity_failure');
    seenDigests.add(digest);
    items.push(Object.freeze({
      cursor: entry.cursor,
      digest,
      tuple: entry.tuple,
      cursorExpiresAt: verified.expiresAt,
      evidenceFacts: Object.freeze(buildCursorEvidenceInsertFacts({
        cursor: entry.cursor,
        digest,
        tuple: entry.tuple,
        cursorExpiresAt: verified.expiresAt,
        pageUpperTuple: input.pageUpperTuple,
        context: input.context,
        authority: input.authority,
      })),
    }));
  }
  return Object.freeze({ items: Object.freeze(items), pageUpperTuple: input.pageUpperTuple });
}

/** Persist only the page next-cursor (last issued item). Intermediates stay HMAC-stateless. */
export function selectPersistedIssuedCursorItems(
  prepared: PreparedIssuedCursorEvidenceBatch,
): readonly PreparedIssuedCursorEvidenceItem[] {
  const last = prepared.items.at(-1);
  if (last === undefined) return Object.freeze([]);
  return Object.freeze([last]);
}

function buildCursorEvidenceInsertFacts(input: {
  readonly cursor: string;
  readonly digest: string;
  readonly tuple: SyncPullTuple;
  readonly cursorExpiresAt: number;
  readonly pageUpperTuple: SyncPullTuple;
  readonly context: SyncPullCursorContext;
  readonly authority: CursorEvidenceAuthorityFacts;
}): CursorEvidenceInsertFacts {
  return {
    cursor: input.cursor,
    cursor_digest: input.digest,
    session_id: input.context.sessionId,
    account_id: input.authority.accountId,
    collection_id: input.authority.collectionId,
    replica_id: input.authority.replicaId,
    lease_generation: BigInt(input.authority.leaseGeneration),
    policy_revision: input.authority.policyRevision,
    protocol_version: input.authority.protocolVersion,
    tuple_commit_ordinal: BigInt(input.tuple.commitOrdinal),
    tuple_stream_kind: SYNC_PULL_STREAM_KIND_ORDER[input.tuple.streamKind],
    tuple_stable_id: input.tuple.stableId,
    cursor_expires_at: new Date(input.cursorExpiresAt),
    upper_commit_ordinal: BigInt(input.pageUpperTuple.commitOrdinal),
    upper_stream_kind: SYNC_PULL_STREAM_KIND_ORDER[input.pageUpperTuple.streamKind],
    upper_stable_id: input.pageUpperTuple.stableId,
    collection_revision: input.authority.collectionRevision,
    page_limit: input.context.limit,
    purge_commit_ordinal: BigInt(input.context.purgeBoundary.commitOrdinal),
    purge_stream_kind: SYNC_PULL_STREAM_KIND_ORDER[input.context.purgeBoundary.streamKind],
    purge_stable_id: input.context.purgeBoundary.stableId,
  };
}

export function prepareIssuedCursorLineageItems(input: {
  readonly items: readonly PreparedIssuedCursorEvidenceItem[];
  readonly keyring: SyncPullCursorLineageKeyring;
  readonly lineageRetentionMs: number;
  readonly issuedAt: Date;
}): readonly PreparedIssuedCursorLineageItem[] {
  if (!Number.isSafeInteger(input.lineageRetentionMs) || input.lineageRetentionMs < 1
      || !(input.issuedAt instanceof Date) || !Number.isSafeInteger(input.issuedAt.getTime())) {
    fail('integrity_failure');
  }
  return Object.freeze(input.items.map((item) => {
    const facts = lineageFactsFromEvidence(item.evidenceFacts);
    const receipt = input.keyring.sign(facts);
    const cursorExpiresAtMs = item.evidenceFacts.cursor_expires_at.getTime();
    if (!Number.isSafeInteger(cursorExpiresAtMs)) fail('integrity_failure');
    return Object.freeze({
      cursorDigest: item.evidenceFacts.cursor_digest,
      sessionId: item.evidenceFacts.session_id,
      accountId: item.evidenceFacts.account_id,
      collectionId: item.evidenceFacts.collection_id,
      replicaId: item.evidenceFacts.replica_id,
      leaseGeneration: item.evidenceFacts.lease_generation,
      policyRevision: item.evidenceFacts.policy_revision,
      protocolVersion: item.evidenceFacts.protocol_version,
      pageLimit: item.evidenceFacts.page_limit,
      tupleCommitOrdinal: item.evidenceFacts.tuple_commit_ordinal,
      tupleStreamKind: item.evidenceFacts.tuple_stream_kind,
      tupleStableId: item.evidenceFacts.tuple_stable_id,
      cursorExpiresAt: item.evidenceFacts.cursor_expires_at,
      lineageExpiresAt: new Date(Math.max(
        input.issuedAt.getTime() + input.lineageRetentionMs, cursorExpiresAtMs + 1,
      )),
      issuedAt: input.issuedAt,
      keyVersion: input.keyring.activeKeyId,
      receipt,
    });
  }));
}

function lineageFactsFromEvidence(facts: CursorEvidenceInsertFacts): SyncPullCursorLineageFacts {
  return Object.freeze({
    cursorDigest: facts.cursor_digest,
    sessionId: facts.session_id,
    accountId: facts.account_id,
    collectionId: facts.collection_id,
    replicaId: facts.replica_id,
    leaseGeneration: BigInt(facts.lease_generation).toString(),
    policyRevision: facts.policy_revision,
    protocolVersion: facts.protocol_version,
    pageLimit: facts.page_limit,
    tuple: Object.freeze({
      commitOrdinal: BigInt(facts.tuple_commit_ordinal).toString(),
      streamKind: facts.tuple_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation
        ? 'operation' as const : 'conflict' as const,
      stableId: facts.tuple_stable_id,
    }),
    cursorExpiresAt: facts.cursor_expires_at.getTime(),
  });
}

function fail(code: SyncPullReadErrorCode): never {
  throw new SyncPullReadError(code);
}
