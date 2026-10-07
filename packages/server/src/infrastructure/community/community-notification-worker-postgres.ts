import { fenceOutboxLease } from '../outbox/lease-fence.js';
import { createHash } from 'node:crypto';
import { CompiledQuery, sql, type Kysely } from 'kysely';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE,
  COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME,
} from './community-notification-outbox.js';
import {
  COMMUNITY_NOTIFICATION_KIND,
  COMMUNITY_NOTIFICATION_SUBJECT_TYPE,
  communityCommentEffectiveState,
  type CommunityNotificationWorkerRepository,
  type ProjectCommunityNotificationInput,
  type ProjectCommunityNotificationResult,
} from '../../modules/community/index.js';
import { loadCommunityCommentRecord } from './community-comment-shared-postgres.js';
import { resolveCommunityTargetRow } from './community-target-shared-postgres.js';

export interface CommunityNotificationWorkerFaultInjector {
  afterAuthorityWrite?(): void | Promise<void>;
  beforeAttemptFence?(): void | Promise<void>;
}

interface PreferenceRow { channel: string; enabled: boolean }

/**
 * CS-05 `community_comment_notification` projection repository. One
 * read-committed transaction holds the attempt-ownership check, the
 * authority re-read (comment + parent + resolved target + accounts), the
 * preference gate, the deduplicated notification insert, and the attempt
 * fence — a lost lease rolls everything back and reports `lease_lost`.
 */
export function createPostgresCommunityNotificationWorkerRepository(
  db: Kysely<DatabaseSchema>,
  options: { readonly faultInjector?: CommunityNotificationWorkerFaultInjector } = {},
): CommunityNotificationWorkerRepository {
  return Object.freeze<CommunityNotificationWorkerRepository>({
    async project(input: ProjectCommunityNotificationInput): Promise<ProjectCommunityNotificationResult> {
      try {
        return await db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
          const disposeCancellation = await installPostgresTransactionCancellation(transaction, input.signal);
          try {
            input.signal.throwIfAborted();
            const result = await project(transaction, input, options.faultInjector);
            if (input.signal.aborted) throw input.signal.reason;
            return result;
          } finally {
            await disposeCancellation();
          }
        });
      } catch (error: unknown) {
        if (error instanceof LeaseFenceRollbackError) {
          return { disposition: 'lease_lost', notificationCreated: false };
        }
        throw error;
      }
    },
  });
}

async function project(
  transaction: DatabaseTransaction,
  input: ProjectCommunityNotificationInput,
  faultInjector?: CommunityNotificationWorkerFaultInjector,
): Promise<ProjectCommunityNotificationResult> {
  input.signal.throwIfAborted();
  if (!await ownsAttempt(transaction, input)) throw new LeaseFenceRollbackError();
  const event = input.event;
  const comment = await loadCommunityCommentRecord(transaction, event.commentId, 'none');
  if (comment === null) {
    await fenceAttempt(transaction, input, faultInjector);
    return ineligible();
  }
  // The durable comment is the authority: its immutable facts must equal
  // the event's locators or the event is corrupt and fails closed.
  if (comment.authorAccountId !== event.actorAccountId
      || comment.replyToId !== event.replyToId
      || comment.target.kind !== event.target.kind
      || comment.target.id !== event.target.id
      || comment.target.collectionId !== event.target.collectionId
      || comment.target.seriesId !== event.target.seriesId
      || comment.targetGeneration !== event.targetGeneration) {
    throw new Error('community comment notification event conflicts with comment authority');
  }
  if (communityCommentEffectiveState(comment) !== 'visible') {
    await fenceAttempt(transaction, input, faultInjector);
    return ineligible();
  }
  const resolved = await resolveCommunityTargetRow(transaction, {
    kind: event.target.kind,
    id: event.target.id,
    ...(event.target.collectionId !== null ? { collectionId: event.target.collectionId } : {}),
    ...(event.target.seriesId !== null ? { seriesId: event.target.seriesId } : {}),
  }, 'none');
  if (resolved === null || resolved.target.generation !== comment.targetGeneration) {
    await fenceAttempt(transaction, input, faultInjector);
    return ineligible();
  }
  // Recipient justification: still the parent comment's author (immutable)
  // or still the active target owner. Anything else no longer justifies
  // the delivery the producer computed.
  const recipient = await readRecipientAccount(transaction, event.recipientAccountId);
  if (recipient === null) {
    await fenceAttempt(transaction, input, faultInjector);
    return ineligible();
  }
  const parentAuthor = event.replyToId === null
    ? null
    : (await loadCommunityCommentRecord(transaction, event.replyToId, 'none'))?.authorAccountId ?? null;
  const ownerAccountId = await readOwnerAccountId(transaction, resolved.ownerSubjectId);
  const justified = (parentAuthor !== null && parentAuthor === event.recipientAccountId)
    || (ownerAccountId !== null && ownerAccountId === event.recipientAccountId);
  if (!justified) {
    await fenceAttempt(transaction, input, faultInjector);
    return ineligible();
  }
  const actorActive = await readActorActive(transaction, event.actorAccountId);
  if (!actorActive) {
    await fenceAttempt(transaction, input, faultInjector);
    return ineligible();
  }
  const preferences = await readPreferences(transaction, event.recipientAccountId);
  if (!preferences.inApp || !preferences.community) {
    await fenceAttempt(transaction, input, faultInjector);
    return { disposition: 'preference_disabled', notificationCreated: false };
  }

  input.signal.throwIfAborted();
  const notificationId = stableId('notification', event.recipientAccountId,
    event.eventId, COMMUNITY_NOTIFICATION_KIND);
  const inserted = await sql`
    insert into notifications(notification_id,recipient_account_id,source_event_id,
      notification_type,actor_profile_id,subject_type,subject_id,occurred_at,retain_until)
    values(${notificationId},${event.recipientAccountId},${event.eventId},
      ${COMMUNITY_NOTIFICATION_KIND},${event.actorAccountId},
      ${COMMUNITY_NOTIFICATION_SUBJECT_TYPE},${event.commentId},${event.occurredAt},
      ${event.occurredAt}::timestamptz + interval '365 days')
    on conflict(recipient_account_id,source_event_id,notification_type) do nothing
  `.execute(transaction);
  if (Number(inserted.numAffectedRows ?? 0n) !== 1) {
    const winner = await sql<{ matches: boolean }>`
      select actor_profile_id = ${event.actorAccountId}
          and subject_type = ${COMMUNITY_NOTIFICATION_SUBJECT_TYPE}
          and subject_id = ${event.commentId}
          and occurred_at = ${event.occurredAt}::timestamptz as matches
        from notifications
        where recipient_account_id = ${event.recipientAccountId}
          and source_event_id = ${event.eventId}
          and notification_type = ${COMMUNITY_NOTIFICATION_KIND}
    `.execute(transaction);
    if (winner.rows[0]?.matches !== true) {
      throw new Error('community notification deduplication winner conflicts with authority facts');
    }
  }
  await faultInjector?.afterAuthorityWrite?.();
  await fenceAttempt(transaction, input, faultInjector);
  const created = Number(inserted.numAffectedRows ?? 0n) === 1;
  return { disposition: created ? 'applied' : 'duplicate', notificationCreated: created };
}

function ineligible(): ProjectCommunityNotificationResult {
  return { disposition: 'ineligible', notificationCreated: false };
}

/** Recipient account must still exist active (the FK guard also enforces this). */
async function readRecipientAccount(
  transaction: DatabaseTransaction,
  accountId: string,
): Promise<{ readonly accountId: string } | null> {
  const result = await sql<{ id: string }>`
    select id from accounts
    where id = ${accountId} and status = 'active' and deleted_at is null
    for share
  `.execute(transaction);
  return result.rows[0] === undefined ? null : Object.freeze({ accountId: result.rows[0].id });
}

/** The active account id behind the resolved target's owner subject. */
async function readOwnerAccountId(
  transaction: DatabaseTransaction,
  ownerSubjectId: string,
): Promise<string | null> {
  const result = await sql<{ id: string }>`
    select id from accounts
    where subject_id = ${ownerSubjectId} and status = 'active' and deleted_at is null
  `.execute(transaction);
  return result.rows[0]?.id ?? null;
}

/** Replying actor must be an active account with a profile row. */
async function readActorActive(
  transaction: DatabaseTransaction,
  accountId: string,
): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select exists (
      select 1 from accounts account
      join profiles profile on profile.account_id = account.id
      where account.id = ${accountId}
        and account.status = 'active' and account.deleted_at is null
    ) as present
  `.execute(transaction);
  return result.rows[0]?.present === true;
}

/**
 * in_app + email defaults materialize exactly like the social worker;
 * the community channel row is NOT materialized (absent = enabled default).
 * Delivery requires in_app AND community enabled.
 */
async function readPreferences(
  transaction: DatabaseTransaction,
  recipientAccountId: string,
): Promise<{ readonly inApp: boolean; readonly community: boolean }> {
  await sql`
    insert into notification_preferences(recipient_account_id,channel,enabled)
    values(${recipientAccountId},'in_app',true),(${recipientAccountId},'email',false)
    on conflict do nothing
  `.execute(transaction);
  const result = await sql<PreferenceRow>`
    select channel,enabled from notification_preferences
    where recipient_account_id = ${recipientAccountId}
    for share
  `.execute(transaction);
  const values = new Map(result.rows.map((row) => [row.channel, row.enabled]));
  if (!values.has('in_app') || !values.has('email')) {
    throw new Error('community Notification preferences are incomplete');
  }
  return {
    inApp: values.get('in_app')!,
    community: values.get('community') ?? true,
  };
}

async function ownsAttempt(
  transaction: DatabaseTransaction,
  input: ProjectCommunityNotificationInput,
): Promise<boolean> {
  const result = await sql<{ owned: boolean }>`
    select state='leased'
        and lease_generation=${input.attempt.leaseGeneration}
        and locked_until > clock_timestamp()
        and domain_event_id=${input.event.eventId}
        and event_type=${COMMUNITY_COMMENT_NOTIFICATION_EVENT_TYPE}
        and event_version=${input.event.eventVersion}
        and handler_name=${COMMUNITY_COMMENT_NOTIFICATION_HANDLER_NAME}
        and handler_mode='delivery_each_event' as owned
      from outbox_events where outbox_id=${input.attempt.outboxId}
  `.execute(transaction);
  return result.rows[0]?.owned === true;
}

async function fenceAttempt(
  transaction: DatabaseTransaction,
  input: ProjectCommunityNotificationInput,
  faultInjector?: CommunityNotificationWorkerFaultInjector,
): Promise<void> {
  input.signal.throwIfAborted();
  await faultInjector?.beforeAttemptFence?.();
  const owned = await fenceOutboxLease(
    (statement, parameters) => transaction.executeQuery<{ owned?: boolean }>(CompiledQuery.raw(statement, parameters)),
    input.attempt, input.signal);
  if (!owned) throw new LeaseFenceRollbackError();
}

function stableId(namespace: string, ...parts: readonly string[]): string {
  return createHash('sha256').update([namespace, ...parts].join('\0'), 'utf8').digest('base64url');
}

class LeaseFenceRollbackError extends Error {}
