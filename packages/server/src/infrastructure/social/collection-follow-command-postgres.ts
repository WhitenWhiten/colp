import { createPostgresBookmarkSubscriptionExitPort } from '../bookmark-subscriptions/unit-of-work.js';
import { sql, type Kysely } from 'kysely';
import {
  type CollectionFollowAuditEvent,
  type CollectionFollowCommandPorts,
} from '../../modules/social/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionFaultInjector,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { accountRestrictInteractionExistsSql } from '../governance/collection-control-sql.js';
import { createPostgresCollectionFollowRepository } from './collection-follow-postgres.js';

export type CollectionFollowCommandWritePhase = 'receipt' | 'authority' | 'audit' | 'complete';

export interface CollectionFollowCommandFaultInjector {
  afterPhase?(phase: CollectionFollowCommandWritePhase): void | Promise<void>;
}

export interface PostgresCollectionFollowCommandUnitOfWorkOptions {
  readonly faultInjector?: CollectionFollowCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}

export interface PostgresCollectionFollowCommandUnitOfWork {
  execute<Result>(
    work: (ports: CollectionFollowCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresCollectionFollowCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCollectionFollowCommandUnitOfWorkOptions = {},
): PostgresCollectionFollowCommandUnitOfWork {
  return Object.freeze<PostgresCollectionFollowCommandUnitOfWork>({
    execute<Result>(work: (ports: CollectionFollowCommandPorts) => Promise<Result>,
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
  options: PostgresCollectionFollowCommandUnitOfWorkOptions,
  work: (ports: CollectionFollowCommandPorts) => Promise<Result>,
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
  options: PostgresCollectionFollowCommandUnitOfWorkOptions,
): CollectionFollowCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const repository = createPostgresCollectionFollowRepository(transaction);
  return Object.freeze<CollectionFollowCommandPorts>({
    subscriptionExit: createPostgresBookmarkSubscriptionExitPort(transaction),
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
      async lockActiveProfile(binding): Promise<boolean> {
        const result = await sql<{ account_id: string }>`
          select profile.account_id
          from profiles profile
          join accounts account on account.id=profile.account_id
          where profile.account_id=${binding.actorProfileId}
            and account.status='active' and account.deleted_at is null
            and not ${sql.raw(accountRestrictInteractionExistsSql('profile.account_id'))}
          for share of profile,account
        `.execute(transaction);
        return binding.actorPrincipalId === binding.actorProfileId
          && result.rows.length === 1;
      },
    },
    collection: {
      async lockFollowable(collectionId) {
        const result = await sql<{ owner_subject_id: string }>`
          select collection.owner_subject_id
          from collections collection
          where collection.id=${collectionId}
            and collection.deleted_at is null
            and collection.visibility in ('public','unlisted')
          for share of collection
        `.execute(transaction);
        const row = result.rows[0];
        if (!row) return { kind: 'not_found' };
        return { kind: 'followable', ownerSubjectId: row.owner_subject_id };
      },
    },
    follows: {
      async save(binding) {
        const result = await repository.save(binding);
        await options.faultInjector?.afterPhase?.('authority');
        return result;
      },
      async remove(binding) {
        const result = await repository.remove(binding);
        await options.faultInjector?.afterPhase?.('authority');
        return result;
      },
      async countFollowers(collectionId) {
        return repository.countFollowers(collectionId);
      },
    },
    audit: {
      async append(event: CollectionFollowAuditEvent): Promise<void> {
        await appendAuditEvent(transaction, {
          operationId: null,
          collectionId: null,
          principalId: event.principalId,
          eventType: event.action === 'follow'
            ? 'social.collection_follow_created'
            : 'social.collection_follow_removed',
          details: {
            actorProfileId: event.actorProfileId,
            collectionId: event.collectionId,
            action: event.action,
            changed: event.changed,
          },
          createdAt: event.createdAt,
        });
        await options.faultInjector?.afterPhase?.('audit');
      },
    },
    clock: {
      async now(): Promise<Date> {
        return (await sql<{ now: Date }>`select current_timestamp now`.execute(transaction)).rows[0]!.now;
      },
    },
  });
}
