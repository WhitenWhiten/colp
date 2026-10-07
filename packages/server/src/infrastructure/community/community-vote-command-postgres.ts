import { sql, type Kysely } from 'kysely';
import type {
  CommunityVoteAuditEvent,
  CommunityVoteCommandPorts,
} from '../../modules/community/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionFaultInjector,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  lockActiveCommunityAccount,
  readCommunityVoteCounts,
  resolveCommunityTargetRow,
} from './community-target-shared-postgres.js';
import { appendCommunityRankRefreshOutbox } from './community-rank-refresh-outbox.js';

export type CommunityVoteCommandWritePhase = 'receipt' | 'authority' | 'audit' | 'complete';

export interface CommunityVoteCommandFaultInjector {
  afterPhase?(phase: CommunityVoteCommandWritePhase): void | Promise<void>;
}

export interface PostgresCommunityVoteCommandUnitOfWorkOptions {
  readonly faultInjector?: CommunityVoteCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}

export interface PostgresCommunityVoteCommandUnitOfWork {
  execute<Result>(
    work: (ports: CommunityVoteCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresCommunityVoteCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityVoteCommandUnitOfWorkOptions = {},
): PostgresCommunityVoteCommandUnitOfWork {
  return Object.freeze<PostgresCommunityVoteCommandUnitOfWork>({
    execute<Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(db, options, work, execution.signal);
      }
      return createUnitOfWork(db, {
        isolationLevel: 'read committed',
        ...(options.transactionFaultInjector
          ? { faultInjector: options.transactionFaultInjector }
          : {}),
      }).execute(({ transaction }) =>
        work(createPorts(transaction, options)));
    },
  });
}

async function executeAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityVoteCommandUnitOfWorkOptions,
  work: (ports: CommunityVoteCommandPorts) => Promise<Result>,
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
  options: PostgresCommunityVoteCommandUnitOfWorkOptions,
): CommunityVoteCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze<CommunityVoteCommandPorts>({
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
    votes: {
      async lockOwn(accountId, identity) {
        const result = await sql<{ value: number; target_generation: string }>`
          select value, target_generation
          from community_votes
          where account_id = ${accountId}
            and target_kind = ${identity.kind}
            and target_id = ${identity.id}
          for update
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) return null;
        return Object.freeze({
          value: row.value === 1 ? 1 as const : -1 as const,
          generation: row.target_generation,
        });
      },
      async upsert(accountId, identity, generation, value) {
        await sql`
          insert into community_votes (
            target_kind, target_id, target_collection_id, target_series_id,
            target_generation, account_id, value
          ) values (
            ${identity.kind}, ${identity.id}, ${identity.collectionId}, ${identity.seriesId},
            ${generation}, ${accountId}, ${value}
          )
          on conflict (account_id, target_kind, target_id) do update
          set value = excluded.value,
            target_generation = excluded.target_generation,
            target_collection_id = excluded.target_collection_id,
            target_series_id = excluded.target_series_id,
            updated_at = now()
        `.execute(transaction);
        // CS-02: record the first accepted ±1 vote instant for this
        // generation. Insert-or-ignore keeps the original first_vote_at on
        // value changes; a new generation gets its own row.
        await sql`
          insert into community_vote_targets (
            target_kind, target_id, target_collection_id, target_series_id,
            target_generation, first_vote_at
          ) values (
            ${identity.kind}, ${identity.id}, ${identity.collectionId}, ${identity.seriesId},
            ${generation}, now()
          )
          on conflict (target_kind, target_id, target_generation) do nothing
        `.execute(transaction);
        await options.faultInjector?.afterPhase?.('authority');
      },
      async remove(accountId, identity) {
        await sql`
          delete from community_votes
          where account_id = ${accountId}
            and target_kind = ${identity.kind}
            and target_id = ${identity.id}
        `.execute(transaction);
        await options.faultInjector?.afterPhase?.('authority');
      },
      async count(identity, generation) {
        const counts = await readCommunityVoteCounts(transaction, identity, generation, null);
        return Object.freeze({ up: counts.up, down: counts.down });
      },
    },
    refreshes: {
      /* CS-02: every accepted vote mutation durably enqueues a hot-ranking
         refresh inside the same transaction. The refresh worker rebuilds
         from retained vote authority, so a vote can never be lost to a
         crashed producer — and a replayed or no-op command, which mutates
         nothing, never forces a redundant full rebuild. */
      enqueue: () => appendCommunityRankRefreshOutbox(transaction, 'vote'),
    },
    audit: {
      async append(event: CommunityVoteAuditEvent): Promise<void> {
        await appendAuditEvent(transaction, {
          operationId: null,
          /* audit_events_authority_pair_check requires operation+collection
             to be both-set or both-null; a community vote has no operation
             row, so the header stays null and the polymorphic target lives
             in the details payload below. */
          collectionId: null,
          principalId: event.principalId,
          eventType: 'community.vote_set',
          details: {
            targetKind: event.target.kind,
            targetId: event.target.id,
            targetCollectionId: event.target.collectionId,
            targetSeriesId: event.target.seriesId,
            targetGeneration: event.generation,
            previousValue: event.previousValue,
            value: event.value,
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
