import { sql, type Kysely } from 'kysely';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateAuthoritativePullEvent } from '@know-n/colp/sync';
import type { Conflict, Operation, SyncPullEvent, SyncPullEventV02 } from '@know-n/colp/types';
import { withAbort } from '../../async/abort-and-settle.js';
import {
  buildSyncRouteAuthorityContext,
  SYNC_PULL_STREAM_KIND_ORDER,
  SyncPullReadError,
  syncPullCursorContext,
  validateVerifiedExtensionCredential,
  type SyncPullCursorContext,
  type SyncPullCursorKeyring,
  type SyncPullCursorLineageKeyring,
  type SyncPullReadErrorCode,
  type SyncPullReadInput,
  type SyncPullReadPort,
  type SyncPullStreamKind,
  type SyncPullTuple,
  validatePersistedAuthoritativeEffect,
} from '../../../modules/sync/index.js';
import type { DatabaseSchema } from '../../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../../database/unit-of-work.js';
import { resolvePullResponseBudget } from '../sync-transport-budget.js';
import { readSyncPullStreamCut, type SyncPullStreamRow as StreamRow } from './sync-operation-payload-reader.js';
import {
  type PullAuthority,
  type SyncPullAuthorityFaultInjector,
  lockAndRevalidatePullAuthority,
  readPullAuthoritySnapshot,
} from './sync-pull-authority-postgres.js';
import {
  compareTuple,
  cursorIsBehindEffectCutover,
  cursorIsBehindPurgeBoundary,
  loadPurgeBoundary,
  loadSyncHistoryFloor,
  resolveCursorAnchor,
  reuseOrIssueInitialCursor,
  syncPullTupleIsBehindHistoryFloor,
} from './sync-pull-cursor-codec-postgres.js';
import {
  prepareIssuedCursorEvidenceItems,
  prepareIssuedCursorLineageItems,
  selectPersistedIssuedCursorItems,
  type SyncPullEvidenceFaultInjector,
} from './sync-pull-cursor-evidence.js';
import { persistIssuedPageEvidence } from './sync-pull-page-evidence-postgres.js';
import {
  markRecoveryForExpiredCursor,
  resolveCursorHandoff,
  transitionReplicaToRecovery,
} from './sync-pull-recovery-postgres.js';

export { persistSyncOperationProjection } from './sync-operation-payload-reader.js';
export {
  assertTransactionalPullAuthority,
  lockAndRevalidatePullAuthority,
  readPullAuthoritySnapshot,
  type PullAuthorityFingerprint,
  type PullAuthoritySnapshot,
  type SyncPullAuthorityFaultInjector,
  type SyncPullAuthorityPhase,
} from './sync-pull-authority-postgres.js';
export {
  syncPullTupleIsBehindHistoryFloor,
} from './sync-pull-cursor-codec-postgres.js';
export {
  buildIssuedCursorEntries,
  prepareIssuedCursorEvidenceItems,
  prepareIssuedCursorLineageItems,
  selectPersistedIssuedCursorItems,
  type CursorEvidenceAuthorityFacts,
  type CursorEvidenceVisibleRow,
  type PreparedIssuedCursorEvidenceBatch,
  type PreparedIssuedCursorEvidenceItem,
  type PreparedIssuedCursorLineageItem,
  type SyncPullEvidenceFaultInjector,
  type SyncPullEvidencePersistencePhase,
} from './sync-pull-cursor-evidence.js';
export { lineageProvesExpiredCursor } from './sync-pull-recovery-postgres.js';

const validators = createValidatorRegistry();

export function createPostgresSyncPullReadPort(
  db: Kysely<DatabaseSchema>,
  cursorKeyring: SyncPullCursorKeyring,
  options: { readonly effectPageAuthority?: string; readonly effectPageTemplate?: string;
    readonly responseBudgetBytes?: number; readonly recoveryProofRetentionMs?: number;
    readonly lineageKeyring?: SyncPullCursorLineageKeyring; readonly lineageRetentionMs?: number;
    readonly cursorNow?: () => number; readonly evidenceFaultInjector?: SyncPullEvidenceFaultInjector;
    readonly authorityFaultInjector?: SyncPullAuthorityFaultInjector } = {},
): SyncPullReadPort {
  if (!cursorKeyring || cursorKeyring.destroyed) throw new SyncPullReadError('integrity_failure');
  const recoveryProofRetentionMs = options.recoveryProofRetentionMs ?? 2_592_000_000;
  if (!Number.isSafeInteger(recoveryProofRetentionMs) || recoveryProofRetentionMs < 1_000
      || recoveryProofRetentionMs > 31_536_000_000) fail('integrity_failure');
  const lineageKeyring = options.lineageKeyring;
  const lineageRetentionMs = options.lineageRetentionMs;
  if (lineageKeyring !== undefined) {
    if (lineageKeyring.destroyed || typeof lineageRetentionMs !== 'number'
        || !Number.isSafeInteger(lineageRetentionMs)
        || lineageRetentionMs < 1_000 || lineageRetentionMs > 126_144_000_000) {
      fail('integrity_failure');
    }
  } else if (lineageRetentionMs !== undefined
      && (!Number.isSafeInteger(lineageRetentionMs) || lineageRetentionMs < 1_000
        || lineageRetentionMs > 126_144_000_000)) {
    fail('integrity_failure');
  }
  return Object.freeze({
    async read(rawInput: SyncPullReadInput) {
      const input = validateInput(rawInput);
      const outcome = await createUnitOfWork(db).execute(async ({ transaction }) => {
        input.signal?.throwIfAborted();
        if (input.timeoutMs !== undefined) {
          await sql`select set_config('statement_timeout', ${String(input.timeoutMs)}, true)`.execute(transaction);
        }
        const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transaction);
        const backendPidRow = backend.rows[0];
        // pg_backend_pid always returns exactly one row for a live backend session; a missing
        // or non-positive pid is an integrity fault that fails closed before any write.
        if (!backendPidRow || !Number.isSafeInteger(backendPidRow.pid) || backendPidRow.pid < 1) fail('integrity_failure');
        const backendPid = backendPidRow.pid;
        return withAbort((async () => {
          const snapshot = await readPullAuthoritySnapshot(transaction, input);
          await options.authorityFaultInjector?.afterPhase?.('after_snapshot', transaction);
          const authority = snapshot.authority;
          const finalizeAuthority = async (): Promise<PullAuthority> => {
            await options.authorityFaultInjector?.afterPhase?.('before_finalization', transaction);
            return lockAndRevalidatePullAuthority(transaction, input, snapshot.fingerprint);
          };
          const cursorNow = options.cursorNow?.() ?? authority.now.getTime();
          if (!Number.isSafeInteger(cursorNow)) fail('integrity_failure');
          const purgeBoundary = await loadPurgeBoundary(transaction, authority.collectionId);
          const routeAuthority = buildSyncRouteAuthorityContext({ accountId: authority.accountId,
            collectionId: authority.collectionId, replicaId: authority.replicaId,
            sessionId: input.sessionId, leaseGeneration: authority.leaseGeneration,
            lifecycleRevision: authority.lifecycleRevision, policyRevision: authority.policyRevision,
            protocolVersion: authority.protocolVersion });
          const context: SyncPullCursorContext = syncPullCursorContext(routeAuthority, purgeBoundary, input.limit);
          let after: SyncPullTuple = purgeBoundary;
          let cursorExpiresAt: number | undefined;
          let cursorHandoff = false;
          if (input.cursor !== null) {
            if (await cursorIsBehindPurgeBoundary(
              transaction, authority, input.cursor, context,
            )) {
              const finalized = await finalizeAuthority();
              await transitionReplicaToRecovery(transaction, finalized, purgeBoundary, 'purge_boundary');
              return Object.freeze({ recoveryRequired: true as const });
            }
            if (input.cursor === authority.checkpointCursor && input.cursor.startsWith('boot_')
                && authority.checkpointTuple !== null) {
              after = authority.checkpointTuple;
            } else {
              const verified = cursorKeyring.verify(input.cursor, context);
              if (verified.valid) {
                after = await resolveCursorAnchor(transaction, authority.collectionId, verified.anchor, purgeBoundary);
                cursorExpiresAt = verified.expiresAt;
                if (compareTuple(after, purgeBoundary) < 0) {
                  const finalized = await finalizeAuthority();
                  await transitionReplicaToRecovery(transaction, finalized, purgeBoundary, 'purge_boundary');
                  return Object.freeze({ recoveryRequired: true as const });
                }
              } else if (verified.code === 'sync_cursor_expired') {
                const finalized = await finalizeAuthority();
                await markRecoveryForExpiredCursor(transaction, finalized, context, input.cursor, cursorNow);
                return Object.freeze({ recoveryRequired: true as const });
              } else if (verified.code === 'invalid_cursor_scope') {
                const handoff = await resolveCursorHandoff(
                  transaction, authority, context, input.cursor, cursorNow, finalizeAuthority,
                  lineageKeyring,
                );
                if ('recoveryRequired' in handoff) return handoff;
                after = handoff.tuple;
                cursorExpiresAt = handoff.expiresAt;
                cursorHandoff = true;
              } else throw new SyncPullReadError(verified.code);
            }
          }
          const historyFloor = await loadSyncHistoryFloor(transaction, authority.collectionId);
          if (syncPullTupleIsBehindHistoryFloor(after, historyFloor)) {
            const finalized = await finalizeAuthority();
            await transitionReplicaToRecovery(transaction, finalized, historyFloor, 'history_floor');
            return Object.freeze({ recoveryRequired: true as const });
          }
          if (authority.protocolVersion === '0.2') {
            if (await cursorIsBehindEffectCutover(
              transaction, authority, after,
            )) {
              const finalized = await finalizeAuthority();
              await transitionReplicaToRecovery(transaction, finalized, purgeBoundary, 'effect_cutover');
              return Object.freeze({ recoveryRequired: true as const });
            }
          }
          const cut = await readSyncPullStreamCut(transaction, authority.collectionId, after, input.limit);
          if (cut === null) {
            await finalizeAuthority();
            fail('integrity_failure');
          }
          const rows = cut.rows;
          const candidates = rows.slice(0, input.limit);
          const candidateEvents = candidates.map((row) => mapEvent(
            row, cursorKeyring, context, cursorExpiresAt,
            options.effectPageAuthority, options.effectPageTemplate,
          ));
          const sessionBinding = await transaction.selectFrom('sync_sessions').select('binding_json')
            .where('session_id', '=', input.sessionId).executeTakeFirst();
          const pullBudget = resolvePullResponseBudget(sessionBinding?.binding_json, options.responseBudgetBytes);
          let visibleCount: number;
          try {
            visibleCount = byteAwareEventCount(candidateEvents, pullBudget);
          } catch (error) {
            if (!(error instanceof SyncPullReadError) || error.code !== 'payload_too_large') throw error;
            // F013: the stream head alone exceeds the negotiated page budget, so
            // no byte-shaped page can ever advance this cursor — answering 413
            // would loop forever. Escalate the Replica to Snapshot recovery
            // (410 stale_replica) instead: the Snapshot's materialized state
            // carries the oversized content and its bootstrap cursor lands
            // above the inexpressible event. Nothing is emitted or consumed.
            const head = candidates[0];
            // byteAwareEventCount only throws payload_too_large when the first
            // candidate itself overflows, so the head row is always present.
            if (!head) throw error;
            const finalized = await finalizeAuthority();
            await transitionReplicaToRecovery(transaction, finalized, tupleFrom(head),
              'payload_too_large');
            return Object.freeze({ recoveryRequired: true as const });
          }
          const visible = candidates.slice(0, visibleCount);
          const events = candidateEvents.slice(0, visibleCount);
          // The visible.length > 0 branch guards the last-element read, so the element is present.
          const nextTuple = visible.length > 0 ? tupleFrom(visible[visible.length - 1]!) : after;
          // The same visible.length > 0 branch guarantees the last event cursor exists.
          const nextCursor = visible.length > 0
            ? events[events.length - 1]!.cursor
            : input.cursor === null || cursorHandoff
              ? await reuseOrIssueInitialCursor(transaction, authority, context, nextTuple, cursorKeyring, cursorNow)
              : input.cursor;
          // The cursor stays on the delivered cut. It does not jump to a later head.
          if (visible.length > 0 && (compareTuple(nextTuple, after) <= 0
              || input.cursor !== null && nextCursor === input.cursor)) fail('integrity_failure');
          const finalized = await finalizeAuthority();
          // collectionRevision is the cut revision from the event statement, not the
          // head this lock may now see. hasMore is only whether that cut still has
          // events past this page. Copying the head into either field would tell the
          // client it had fully caught commits that were not delivered.
          const pageAuthority: PullAuthority = Object.freeze({
            ...finalized,
            collectionRevision: cut.contentRevision,
          });
          // An empty continuation page is cursor identity and creates no duplicate evidence, but
          // it still passes final authority validation before a successful response is returned.
          if (visible.length > 0 || input.cursor === null || cursorHandoff) {
            await persistIssuedCursorEvidence(transaction, pageAuthority, context, visible, events, nextCursor,
              nextTuple, cursorKeyring, recoveryProofRetentionMs, lineageKeyring, lineageRetentionMs,
              options.evidenceFaultInjector);
          }
          return Object.freeze({
            events: Object.freeze(events), nextCursor, nextTuple,
            hasMore: rows.length > visibleCount, collectionRevision: pageAuthority.collectionRevision,
            protocolVersion: pageAuthority.protocolVersion, ...(cursorHandoff ? { cursorReissued: true } : {}),
          });
        })(), input.signal, () => cancelPostgresBackend(db, backendPid));
      });
      if ('recoveryRequired' in outcome) fail('recovery_required');
      return outcome;
    },
  });
}

export function byteAwareEventCount(
  events: readonly (SyncPullEvent | SyncPullEventV02)[],
  budget = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(budget) || budget < 1) fail('integrity_failure');
  let bytes = 1_024;
  let count = 0;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (count > 0 && bytes + eventBytes > budget) break;
    if (bytes + eventBytes > budget) fail('payload_too_large');
    bytes += eventBytes;
    count += 1;
  }
  return count;
}

async function persistIssuedCursorEvidence(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  context: SyncPullCursorContext,
  visible: readonly StreamRow[],
  events: readonly (SyncPullEvent | SyncPullEventV02)[],
  nextCursor: string,
  pageUpperTuple: SyncPullTuple,
  keyring: SyncPullCursorKeyring,
  recoveryProofRetentionMs: number,
  lineageKeyring: SyncPullCursorLineageKeyring | undefined,
  lineageRetentionMs: number | undefined,
  evidenceFaultInjector?: SyncPullEvidenceFaultInjector,
): Promise<void> {
  const prepared = prepareIssuedCursorEvidenceItems({
    visible: visible.map((row) => ({
      commitOrdinal: BigInt(row.commit_ordinal).toString(),
      streamKind: row.stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation
        ? 'operation' as const : row.stream_kind === SYNC_PULL_STREAM_KIND_ORDER.conflict
          ? 'conflict' as const : fail('integrity_failure'),
      stableId: row.stable_id,
    })),
    eventCursors: events.map((event) => event.cursor),
    nextCursor,
    pageUpperTuple,
    keyring,
    context,
    authority,
  });
  const persistItems = selectPersistedIssuedCursorItems(prepared);
  if (persistItems.length === 0) return;
  const issuedAt = authority.now;
  const lineageItems = lineageKeyring !== undefined && lineageRetentionMs !== undefined
    ? prepareIssuedCursorLineageItems({
      items: persistItems, keyring: lineageKeyring, lineageRetentionMs, issuedAt,
    })
    : undefined;
  await persistIssuedPageEvidence(transaction, {
    replicaId: authority.replicaId,
    lifecycleRevision: authority.lifecycleRevision,
    context,
    prepared,
    persistItems,
    visibleCount: visible.length,
    issuedAt,
    recoveryProofRetentionMs,
    lineageItems,
    evidenceFaultInjector,
  });
}

function mapEvent(
  row: StreamRow,
  keyring: SyncPullCursorKeyring,
  context: SyncPullCursorContext,
  expiresAt: number | undefined,
  effectPageAuthority: string | undefined,
  effectPageTemplate: string | undefined,
): SyncPullEvent | SyncPullEventV02 {
  const tuple = tupleFrom(row);
  const cursor = keyring.sign({ ...context, tuple }, expiresAt);
  if (tuple.streamKind === 'operation') {
    if (!validators.validate('operation', row.payload).valid) throw new SyncPullReadError('integrity_failure');
    const operation = row.payload as Operation;
    if (context.protocolVersion === '0.1') {
      return Object.freeze({ cursor, kind: 'operation', operation });
    }
    if (!row.effect || row.effect_operation_id !== operation.opId
        || row.effect_collection_id !== operation.collectionId
        || row.effect_replica_id !== operation.replicaId
        || BigInt(row.effect_sequence ?? 0) !== BigInt(operation.sequence)
        || BigInt(row.effect_commit_ordinal ?? 0) !== BigInt(row.commit_ordinal)
        || row.effect_protocol_version !== '0.2'
        || (row.effect_terminal_status !== 'applied' && row.effect_terminal_status !== 'rebased')) {
      throw new SyncPullReadError('integrity_failure');
    }
    try {
      const effect = validatePersistedAuthoritativeEffect({ operation,
        effect: row.effect as Record<string, unknown>, cursor,
        ...(effectPageAuthority ? { effectPageAuthority } : {}),
        ...(effectPageTemplate ? { effectPageTemplate } : {}) });
      if (row.operation_digest !== effect.operationDigest || row.effect_digest !== effect.effectDigest) {
        throw new Error('stored digest mismatch');
      }
      return validateAuthoritativePullEvent(
        { cursor, kind: 'operation', operation, effect } as never,
        '0.2',
        {
          ...(effectPageAuthority ? { effectPageAuthority } : {}),
          ...(effectPageTemplate ? { effectPageTemplate } : {}),
        },
      ) as SyncPullEventV02;
    } catch {
      throw new SyncPullReadError('integrity_failure');
    }
  }
  if (!validators.validate('conflict', row.payload).valid) throw new SyncPullReadError('integrity_failure');
  return Object.freeze({ cursor, kind: 'conflict', conflict: row.payload as Conflict });
}

function tupleFrom(row: StreamRow): SyncPullTuple {
  const streamKind: SyncPullStreamKind = row.stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation
    ? 'operation' : row.stream_kind === SYNC_PULL_STREAM_KIND_ORDER.conflict
      ? 'conflict' : fail('integrity_failure');
  return Object.freeze({
    commitOrdinal: BigInt(row.commit_ordinal).toString(), streamKind, stableId: row.stable_id,
  });
}

function validateInput(input: SyncPullReadInput): SyncPullReadInput {
  if (!input || typeof input !== 'object') fail('not_found');
  validateVerifiedExtensionCredential(input.credential);
  for (const value of [input.sessionId]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512) fail('not_found');
  }
  if (input.origin !== undefined
      && (typeof input.origin !== 'string' || input.origin.length < 1 || input.origin.length > 2_048)) {
    fail('not_found');
  }
  for (const value of [input.collectionId, input.replicaId]) {
    if (value !== undefined && (typeof value !== 'string' || value.length < 1 || value.length > 512)) fail('not_found');
  }
  if (input.cursor !== null && (typeof input.cursor !== 'string' || input.cursor.length > 8_192)) {
    fail('invalid_cursor_scope');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) fail('not_found');
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail('integrity_failure');
  if (input.timeoutMs !== undefined
      && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000)) {
    fail('integrity_failure');
  }
  return input;
}

async function cancelPostgresBackend(db: Kysely<DatabaseSchema>, backendPid: number): Promise<void> {
  await sql`select pg_cancel_backend(${backendPid})`.execute(db);
}

function fail(code: SyncPullReadErrorCode): never {
  throw new SyncPullReadError(code);
}
