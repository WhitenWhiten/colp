import { fenceOutboxLease } from '../outbox/lease-fence.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import type {
  ProjectPublicActivityInput,
  ProjectPublicActivityResult,
  PublicActivityWorkerRepository,
  SocialCollectionChangeConsumerEvent,
} from '../../modules/social/index.js';

const HANDLER = 'social.publish-public-activity';

export function stablePublicActivityId(eventId: string): string {
  return createHash('sha256').update(`social.public-activity.v1\0${eventId}`).digest('base64url');
}

class LeaseFenceRollbackError extends Error {}

export function createPostgresPublicActivityWorkerRepository(pool: Pool): PublicActivityWorkerRepository {
  return Object.freeze({
    async projectCollectionChange(input: ProjectPublicActivityInput): Promise<ProjectPublicActivityResult> {
      try {
        return await inTransaction(pool, (client) => project(client, input), input);
      } catch (error: unknown) {
        if (error instanceof LeaseFenceRollbackError) {
          return { disposition: 'lease_lost', itemCount: 0 };
        }
        throw error;
      }
    },
  });
}

async function project(
  client: PoolClient,
  input: ProjectPublicActivityInput,
): Promise<ProjectPublicActivityResult> {
  input.signal.throwIfAborted();
  if (!(await ownsLiveLease(client, input))) {
    return { disposition: 'lease_lost', itemCount: 0 };
  }
  const authority = await readAuthority(client, input.event.collectionId);
  const publicNow = authority?.discoverable === true
    && authority.owner_profile_id === input.event.ownerProfileId;
  const shouldPublish = publicNow && input.event.producerDiscoverability !== 'remove';
  if (!shouldPublish) {
    const reason = input.event.producerDiscoverability === 'remove'
      ? 'source_removed' : 'discoverability_revoked';
    const withdrawnCount = await withdrawVisible(client, input.event.collectionId, reason);
    input.signal.throwIfAborted();
    return { disposition: 'withdrawn', itemCount: withdrawnCount };
  }
  const inserted = await insertVisible(client, input.event);
  input.signal.throwIfAborted();
  return { disposition: inserted === 1 ? 'applied' : 'duplicate', itemCount: inserted };
}

async function ownsLiveLease(client: PoolClient, input: ProjectPublicActivityInput): Promise<boolean> {
  const lease = await client.query<{ owned: boolean }>(`select
      state='leased' and lease_generation=$2 and locked_until > current_timestamp
        and domain_event_id=$3 and event_type='social.collection-change'
        and event_version=$4 and handler_name=$7
        and aggregate_scope=$5 and commit_ordinal=$6 as owned
    from outbox_events where outbox_id=$1`,
  [input.attempt.outboxId, input.attempt.leaseGeneration, input.event.eventId,
    input.event.eventVersion, input.event.collectionId, input.event.commitOrdinal, HANDLER]);
  return lease.rows[0]?.owned === true;
}

async function readAuthority(client: PoolClient, collectionId: string): Promise<{
  owner_profile_id: string | null;
  discoverable: boolean;
} | null> {
  const row = await client.query<{ owner_profile_id: string | null; discoverable: boolean }>(`select account.id as owner_profile_id,
      collection.deleted_at is null and collection.visibility='public'
        and collection.publication_slug is not null and collection.published_at is not null
        and account.status='active' and account.deleted_at is null
        and profile.account_id is not null as discoverable
    from collections collection
    left join accounts account on account.subject_id=collection.owner_subject_id
    left join profiles profile on profile.account_id=account.id
    where collection.id=$1`, [collectionId]);
  return row.rows[0] ?? null;
}

async function insertVisible(client: PoolClient, event: SocialCollectionChangeConsumerEvent): Promise<number> {
  const activityId = stablePublicActivityId(event.eventId);
  const inserted = await client.query(`insert into social_public_activity(
      activity_id,source_event_id,actor_profile_id,collection_id,kind,
      published_at,publication_revision,discoverability_recheck_key,state)
    values($1,$2,$3,$4,'collection_change',$5,$6,$7,'visible')
    on conflict (source_event_id) do nothing`,
  [activityId, event.eventId, event.ownerProfileId, event.collectionId,
    event.occurredAt, event.publicationRevision, event.discoverabilityRecheckKey]);
  return inserted.rowCount ?? 0;
}

async function withdrawVisible(
  client: PoolClient,
  collectionId: string,
  reason: 'source_removed' | 'discoverability_revoked',
): Promise<number> {
  const withdrawn = await client.query(`update social_public_activity
       set state='withdrawn', withdrawn_at=current_timestamp, withdrawal_reason=$2
     where collection_id=$1 and state='visible'`, [collectionId, reason]);
  return withdrawn.rowCount ?? 0;
}

async function inTransaction<Result>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<Result>,
  input: { readonly attempt: { readonly outboxId: string; readonly leaseGeneration: string }; readonly signal: AbortSignal },
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    if (!await fenceOutboxLease((statement, parameters) => client.query(statement, parameters),
      input.attempt, input.signal)) throw new LeaseFenceRollbackError();
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await rollbackTransaction(error, () => client.query('rollback'), 'Public activity projection');
    throw error;
  } finally {
    client.release();
  }
}
