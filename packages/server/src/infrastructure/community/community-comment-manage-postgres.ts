import { sql, type Kysely } from 'kysely';
import {
  communityCommentEtag,
  communityCommentSettingsEtag,
  communityCurationEtag,
  type CommunityCommentManageAuditEvent,
  type CommunityCommentManagePorts,
} from '../../modules/community/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { databaseNow } from '../database/time.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionFaultInjector,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  countCommunityVisibleDirectReplies,
  countCommunityVisibleThreadReplies,
  loadCommunityCommentAuthors,
  loadCommunityCommentCuration,
  loadCommunityCommentRecord,
  loadCommunityCommentSettings,
  updateCommunityCommentRecord,
  upsertCommunityCommentCuration,
  upsertCommunityCommentSettings,
} from './community-comment-shared-postgres.js';
import {
  communityTargetCurator,
  resolveCommunityTargetRow,
} from './community-target-shared-postgres.js';

export type CommunityCommentManageWritePhase = 'receipt' | 'authority' | 'audit' | 'complete';

export interface CommunityCommentManageFaultInjector {
  afterPhase?(phase: CommunityCommentManageWritePhase): void | Promise<void>;
}

export interface PostgresCommunityCommentManageUnitOfWorkOptions {
  /** COMMUNITY_CURSOR_HMAC_KEY — derives all three CS-04 opaque ETag domains. */
  readonly etagHmacKey: Buffer;
  readonly faultInjector?: CommunityCommentManageFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}

export interface PostgresCommunityCommentManageUnitOfWork {
  execute<Result>(
    work: (ports: CommunityCommentManagePorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

/**
 * CS-04 write ports for the four comment-management commands (author edit,
 * author delete, curator curation, comment-area settings). One transaction
 * holds the receipt claim, the FOR UPDATE comment/target locks, the CAS
 * writes on the three independent revision authorities, and the immutable
 * audit event; an abort cancels the backend statement exactly like the
 * CS-03 create command.
 */
export function createPostgresCommunityCommentManageUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityCommentManageUnitOfWorkOptions,
): PostgresCommunityCommentManageUnitOfWork {
  if (!(options.etagHmacKey instanceof Buffer) || options.etagHmacKey.length < 16) {
    throw new TypeError('community comment management requires a configured ETag HMAC key');
  }
  return Object.freeze<PostgresCommunityCommentManageUnitOfWork>({
    execute<Result>(work: (ports: CommunityCommentManagePorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(db, options, work, execution.signal);
      }
      return createUnitOfWork(db, {
        isolationLevel: 'read committed',
        ...(options.transactionFaultInjector
          ? { faultInjector: options.transactionFaultInjector }
          : {}),
      }).execute(({ transaction }) => work(createPorts(transaction, options)));
    },
  });
}

async function executeAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityCommentManageUnitOfWorkOptions,
  work: (ports: CommunityCommentManagePorts) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const disposeCancellation = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      await options.transactionFaultInjector?.beforeCallback?.(transaction);
      const result = await work(createPorts(transaction, options));
      await options.transactionFaultInjector?.afterCallbackBeforeCommit?.(transaction);
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      await disposeCancellation();
    }
  });
}

function createPorts(
  transaction: DatabaseTransaction,
  options: PostgresCommunityCommentManageUnitOfWorkOptions,
): CommunityCommentManagePorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze<CommunityCommentManagePorts>({
    receipts: {
      async claim(binding, fingerprint) {
        const claim = await receipts.claim(binding, fingerprint);
        if (claim.kind === 'claimed') await options.faultInjector?.afterPhase?.('receipt');
        return claim;
      },
      async complete(binding, fingerprint, result) {
        await receipts.complete(binding, fingerprint, result);
        await options.faultInjector?.afterPhase?.('complete');
      },
      purgeExpired: receipts.purgeExpired.bind(receipts),
      deletePrincipalReceipts: receipts.deletePrincipalReceipts.bind(receipts),
    },
    actor: {
      async lockActiveAccount(accountId) {
        const result = await sql<{ subject_id: string }>`
          select account.subject_id
          from accounts account
          where account.id = ${accountId}
            and account.status = 'active'
            and account.deleted_at is null
          for share of account
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : Object.freeze({ subjectId: row.subject_id });
      },
    },
    targets: {
      async lockResolved(identity) {
        return resolveCommunityTargetRow(transaction, {
          kind: identity.kind,
          id: identity.id,
          ...(identity.collectionId !== null ? { collectionId: identity.collectionId } : {}),
          ...(identity.seriesId !== null ? { seriesId: identity.seriesId } : {}),
        }, 'forUpdate');
      },
    },
    comments: {
      async findById(commentId) {
        return loadCommunityCommentRecord(transaction, commentId, 'none');
      },
      async lockById(commentId) {
        return loadCommunityCommentRecord(transaction, commentId, 'forUpdate');
      },
      async update(commentId, expectedRevision, write, updatedAt) {
        const record = await updateCommunityCommentRecord(
          transaction, commentId, expectedRevision, write, updatedAt,
        );
        await options.faultInjector?.afterPhase?.('authority');
        return record;
      },
      countVisibleThreadReplies: (rootIds) =>
        countCommunityVisibleThreadReplies(transaction, rootIds),
      countVisibleDirectReplies: (commentIds) =>
        countCommunityVisibleDirectReplies(transaction, commentIds),
    },
    curations: {
      async lockByCommentId(commentId) {
        return loadCommunityCommentCuration(transaction, commentId, 'forUpdate');
      },
      async upsert(record) {
        const stored = await upsertCommunityCommentCuration(transaction, record);
        await options.faultInjector?.afterPhase?.('authority');
        return stored;
      },
    },
    settings: {
      async lockByTarget(identity) {
        return loadCommunityCommentSettings(transaction, identity, 'forUpdate');
      },
      async upsert(record) {
        const stored = await upsertCommunityCommentSettings(transaction, record);
        await options.faultInjector?.afterPhase?.('authority');
        return stored;
      },
    },
    curators: {
      canCurate: (identity, subjectId) => communityTargetCurator(transaction, identity, subjectId),
    },
    authors: {
      publicActors: (accountIds) => loadCommunityCommentAuthors(transaction, accountIds),
    },
    etags: {
      for: (comment) => communityCommentEtag(comment, options.etagHmacKey),
      curation: (curation) => communityCurationEtag(curation, options.etagHmacKey),
      settings: (settings) => communityCommentSettingsEtag(settings, options.etagHmacKey),
    },
    audit: {
      async append(event: CommunityCommentManageAuditEvent): Promise<void> {
        await appendAuditEvent(transaction, {
          operationId: null,
          /* audit_events_authority_pair_check requires operation+collection
            to be both-set or both-null; a community comment has no operation
            row, so the header stays null and the polymorphic target lives
            in the details payload below. */
          collectionId: null,
          principalId: event.principalId,
          eventType: event.eventType,
          details: event.details,
          createdAt: event.createdAt,
        });
        await options.faultInjector?.afterPhase?.('audit');
      },
    },
    clock: {
      now: () => databaseNow(transaction),
    },
  });
}
