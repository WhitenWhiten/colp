import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  isSocialIdentityText,
  type FollowAuditEvent,
  type FollowCommandPorts,
  type FollowOutboxEvent,
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
import {
  defineClosedPayloadValidator,
  EventEnvelopeRegistry,
  type EventPayloadRegistration,
} from '../outbox/envelope.js';
import { createPostgresFollowRepository } from './follow-postgres.js';

export type FollowCommandWritePhase = 'receipt' | 'authority' | 'audit' | 'outbox' | 'complete';

export interface FollowCommandFaultInjector {
  afterPhase?(phase: FollowCommandWritePhase): void | Promise<void>;
}

export interface PostgresFollowCommandUnitOfWorkOptions {
  readonly faultInjector?: FollowCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
  readonly ids?: {
    nextEventId(): string;
    nextOutboxId(): string;
  };
}

export interface PostgresFollowCommandUnitOfWork {
  execute<Result>(
    work: (ports: FollowCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export const socialFollowEventEnvelopeRegistrations: readonly EventPayloadRegistration[] =
  Object.freeze([
  Object.freeze({
    eventType: 'social.follow-created',
    eventVersion: 1,
    validatePayload: defineClosedPayloadValidator({
      actorProfileId: isSocialIdentityText,
      targetProfileId: isSocialIdentityText,
    }),
  }),
  Object.freeze({
    eventType: 'social.follow-removed',
    eventVersion: 1,
    validatePayload: defineClosedPayloadValidator({
      actorProfileId: isSocialIdentityText,
      targetProfileId: isSocialIdentityText,
    }),
  }),
]);
const followEventRegistry = new EventEnvelopeRegistry(socialFollowEventEnvelopeRegistrations);

export function createPostgresFollowCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresFollowCommandUnitOfWorkOptions = {},
): PostgresFollowCommandUnitOfWork {
  return Object.freeze<PostgresFollowCommandUnitOfWork>({
    execute<Result>(work: (ports: FollowCommandPorts) => Promise<Result>,
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
  options: PostgresFollowCommandUnitOfWorkOptions,
  work: (ports: FollowCommandPorts) => Promise<Result>,
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

function assertFollowOutboxEvent(event: FollowOutboxEvent): void {
  if (event.payload.actorProfileId !== event.actorProfileId
      || event.payload.targetProfileId !== event.targetProfileId) {
    throw new TypeError('social Follow payload must match its aggregate identity');
  }
  if (event.handlerName === 'social_feed_withdrawal') {
    if (event.eventType !== 'social.follow-removed') {
      throw new TypeError('social_feed_withdrawal requires social.follow-removed');
    }
    return;
  }
  if (event.handlerName === 'social_feed_follow_activity') {
    if (event.eventType !== 'social.follow-created') {
      throw new TypeError('social_feed_follow_activity requires social.follow-created');
    }
    return;
  }
  if (event.handlerName !== 'social_follow_activity') {
    throw new TypeError('social Follow outbox handler is unsupported');
  }
  if (event.eventType !== 'social.follow-created' && event.eventType !== 'social.follow-removed') {
    throw new TypeError('social_follow_activity requires a Follow domain event');
  }
}

function createPorts(
  transaction: DatabaseTransaction,
  options: PostgresFollowCommandUnitOfWorkOptions,
): FollowCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const repository = createPostgresFollowRepository(transaction);
  const ids = options.ids ?? {
    nextEventId: randomUUID,
    nextOutboxId: randomUUID,
  };
  return Object.freeze<FollowCommandPorts>({
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
    profiles: {
      async lockEligiblePair(binding): Promise<boolean> {
        const result = await sql<{ account_id: string }>`
          select profile.account_id
          from profiles profile
          join accounts account on account.id=profile.account_id
          where profile.account_id in (${binding.actorProfileId},${binding.targetProfileId})
            and account.status='active' and account.deleted_at is null
            and (
              profile.account_id <> ${binding.actorProfileId}
              or not ${sql.raw(accountRestrictInteractionExistsSql('profile.account_id'))}
            )
          order by profile.account_id
          for share of profile,account
        `.execute(transaction);
        const eligible = new Set(result.rows.map((row) => row.account_id));
        return binding.actorPrincipalId === binding.actorProfileId
          && eligible.has(binding.actorProfileId) && eligible.has(binding.targetProfileId);
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
    },
    audit: {
      async append(event: FollowAuditEvent): Promise<void> {
        await appendAuditEvent(transaction, {
          operationId: null,
          collectionId: null,
          principalId: event.principalId,
          eventType: event.action === 'follow'
            ? 'social.follow_created'
            : 'social.follow_removed',
          details: {
            actorProfileId: event.actorProfileId,
            targetProfileId: event.targetProfileId,
            action: event.action,
            changed: event.changed,
          },
          createdAt: event.createdAt,
        });
        await options.faultInjector?.afterPhase?.('audit');
      },
    },
    outbox: {
      async appendAll(events: readonly FollowOutboxEvent[]): Promise<void> {
        if (events.length < 1) {
          throw new TypeError('social Follow outbox appendAll requires at least one event');
        }
        const seenOutboxIds = new Set<string>();
        const seenEventIds = new Set<string>();
        const ledgerRows: Array<{
          resource_id: string;
          resource_type: 'social-domain-event' | 'social-outbox';
          committed_at: Date;
        }> = [];
        const outboxRows: Array<{
          outbox_id: string;
          domain_event_id: string;
          event_type: string;
          event_version: number;
          handler_name: string;
          handler_mode: 'delivery_each_event';
          aggregate_type: string;
          aggregate_id: string;
          aggregate_scope: string;
          aggregate_revision: string | null;
          commit_ordinal: bigint | null;
          payload_json: Record<string, unknown>;
          state: 'pending';
          attempt_count: number;
          available_at: Date;
          locked_until: null;
          lease_generation: bigint;
          completed_at: null;
          last_error: null;
          occurred_at: Date;
          dead_lettered_at: null;
        }> = [];

        for (const event of events) {
          assertFollowOutboxEvent(event);
          if (seenOutboxIds.has(event.outboxId)) {
            throw new TypeError('social Follow outbox ids must be unique within appendAll');
          }
          seenOutboxIds.add(event.outboxId);
          const envelope = followEventRegistry.validate({
            event_id: event.eventId,
            event_type: event.eventType,
            event_version: event.eventVersion,
            aggregate_identity: {
              aggregate_type: 'profile-follow',
              aggregate_id: event.actorProfileId,
              aggregate_scope: event.targetProfileId,
            },
            aggregate_revision: null,
            commit_ordinal: null,
            occurred_at: event.occurredAt.toISOString(),
            payload: event.payload,
          });
          if (!seenEventIds.has(envelope.event_id)) {
            seenEventIds.add(envelope.event_id);
            ledgerRows.push({
              resource_id: envelope.event_id,
              resource_type: 'social-domain-event',
              committed_at: event.occurredAt,
            });
          }
          ledgerRows.push({
            resource_id: event.outboxId,
            resource_type: 'social-outbox',
            committed_at: event.occurredAt,
          });
          outboxRows.push({
            outbox_id: event.outboxId,
            domain_event_id: envelope.event_id,
            event_type: envelope.event_type,
            event_version: envelope.event_version,
            handler_name: event.handlerName,
            handler_mode: event.handlerMode,
            aggregate_type: envelope.aggregate_identity.aggregate_type,
            aggregate_id: envelope.aggregate_identity.aggregate_id,
            aggregate_scope: event.targetProfileId,
            aggregate_revision: envelope.aggregate_revision,
            commit_ordinal: envelope.commit_ordinal === null
              ? null : BigInt(envelope.commit_ordinal),
            payload_json: { ...envelope.payload },
            state: 'pending',
            attempt_count: 0,
            available_at: event.occurredAt,
            locked_until: null,
            lease_generation: 0n,
            completed_at: null,
            last_error: null,
            occurred_at: new Date(envelope.occurred_at),
            dead_lettered_at: null,
          });
        }

        await transaction.insertInto('resource_id_ledger').values(ledgerRows).execute();
        await transaction.insertInto('outbox_events').values(outboxRows).execute();
        await options.faultInjector?.afterPhase?.('outbox');
      },
    },
    clock: {
      async now(): Promise<Date> {
        return (await sql<{ now: Date }>`select current_timestamp now`.execute(transaction)).rows[0]!.now;
      },
    },
    ids,
  });
}
