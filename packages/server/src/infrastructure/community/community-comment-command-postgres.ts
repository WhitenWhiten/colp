import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  communityCommentEtag,
  type CommunityCommentAuditEvent,
  type CommunityCommentCommandPorts,
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
  loadCommunityCommentAuthors,
  loadCommunityCommentRecord,
  loadCommunityCommentSettings,
} from './community-comment-shared-postgres.js';
import {
  communityTargetCurator,
  lockActiveCommunityAccount,
  resolveCommunityTargetRow,
} from './community-target-shared-postgres.js';
import { appendCommunityCommentNotificationOutbox } from './community-notification-outbox.js';

export type CommunityCommentCommandWritePhase = 'receipt' | 'authority' | 'audit' | 'complete';

export interface CommunityCommentCommandFaultInjector {
  afterPhase?(phase: CommunityCommentCommandWritePhase): void | Promise<void>;
}

export interface PostgresCommunityCommentCommandUnitOfWorkOptions {
  /** COMMUNITY_CURSOR_HMAC_KEY — derives the strong opaque Comment ETag. */
  readonly etagHmacKey: Buffer;
  readonly faultInjector?: CommunityCommentCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}

export interface PostgresCommunityCommentCommandUnitOfWork {
  execute<Result>(
    work: (ports: CommunityCommentCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

/**
 * CS-03 write ports for createCommunityComment. One transaction holds the
 * receipt claim, the FOR UPDATE target + reply-parent locks, the ledger
 * reservation, the durable comment row, and the audit event; an abort
 * cancels the backend statement exactly like the CS-01 vote command.
 */
export function createPostgresCommunityCommentCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityCommentCommandUnitOfWorkOptions,
): PostgresCommunityCommentCommandUnitOfWork {
  if (!(options.etagHmacKey instanceof Buffer) || options.etagHmacKey.length < 16) {
    throw new TypeError('community comment command requires a configured ETag HMAC key');
  }
  return Object.freeze<PostgresCommunityCommentCommandUnitOfWork>({
    execute<Result>(work: (ports: CommunityCommentCommandPorts) => Promise<Result>,
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
  options: PostgresCommunityCommentCommandUnitOfWorkOptions,
  work: (ports: CommunityCommentCommandPorts) => Promise<Result>,
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
  options: PostgresCommunityCommentCommandUnitOfWorkOptions,
): CommunityCommentCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze<CommunityCommentCommandPorts>({
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
      lockActiveAccount: (accountId) => lockActiveCommunityAccount(transaction, accountId),
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
      async lockReplyTarget(commentId) {
        return loadCommunityCommentRecord(transaction, commentId, 'forUpdate');
      },
      async insert(record) {
        // The durable id is reserved in the same transaction; the table's
        // ledger FK makes an unregistered id uninsertable.
        await transaction.insertInto('resource_id_ledger')
          .values({
            resource_id: record.id,
            resource_type: 'community_comment',
            committed_at: record.createdAt,
          })
          .execute();
        await transaction.insertInto('community_comments')
          .values({
            comment_id: record.id,
            target_kind: record.target.kind,
            target_id: record.target.id,
            target_collection_id: record.target.collectionId,
            target_series_id: record.target.seriesId,
            target_generation: record.targetGeneration,
            root_id: record.rootId,
            reply_to_id: record.replyToId,
            depth: record.depth,
            author_account_id: record.authorAccountId,
            body: record.body,
            state: record.state,
            revision: record.revision,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
          })
          .execute();
        await options.faultInjector?.afterPhase?.('authority');
      },
    },
    authors: {
      publicActors: (accountIds) => loadCommunityCommentAuthors(transaction, accountIds),
    },
    curators: {
      canCurate: (identity, subjectId) => communityTargetCurator(transaction, identity, subjectId),
    },
    settings: {
      find: (identity) => loadCommunityCommentSettings(transaction, identity, 'none'),
    },
    notifications: {
      async ownerAccountId(ownerSubjectId) {
        // CS-05: the active account behind the resolved target's owner
        // subject; null when the owner account is gone (no notification).
        const result = await sql<{ id: string }>`
          select id from accounts
          where subject_id = ${ownerSubjectId}
            and status = 'active'
            and deleted_at is null
        `.execute(transaction);
        return result.rows[0]?.id ?? null;
      },
      async append(input) {
        await appendCommunityCommentNotificationOutbox(transaction, input);
      },
    },
    ids: {
      next: () => `cc-${randomBytes(16).toString('base64url')}`,
    },
    etags: {
      for: (comment) => communityCommentEtag(comment, options.etagHmacKey),
    },
    audit: {
      async append(event: CommunityCommentAuditEvent): Promise<void> {
        await appendAuditEvent(transaction, {
          operationId: null,
          /* audit_events_authority_pair_check requires operation+collection
             to be both-set or both-null; a community comment has no operation
             row, so the header stays null and the polymorphic target lives
             in the details payload below. */
          collectionId: null,
          principalId: event.principalId,
          eventType: 'community.comment_created',
          details: {
            commentId: event.commentId,
            targetKind: event.target.kind,
            targetId: event.target.id,
            targetCollectionId: event.target.collectionId,
            targetSeriesId: event.target.seriesId,
            targetGeneration: event.generation,
            rootId: event.rootId,
            replyToId: event.replyToId,
            depth: event.depth,
          },
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
