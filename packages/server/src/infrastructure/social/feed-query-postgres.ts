import { CompiledQuery, type Kysely } from 'kysely';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type FeedPageReadInput, type FeedPageReadPort, type FeedQueryFact,
} from '../../modules/social/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  accountRestrictPublicationExistsSql,
  collectionHidePublicExistsSql,
} from '../governance/collection-control-sql.js';

interface FeedRow {
  feed_item_id: string; source_event_id: string; kind: FeedQueryFact['kind'];
  actor_profile_id: string; handle: string; display_name: string; avatar_url: string | null;
  collection_id: string | null; published_at: Date;
  collection_title: string | null; publication_slug: string | null;
  hidden_public: boolean | null;
}
export interface FeedPageStatement { readonly text: string; readonly values: readonly unknown[]; }
export interface FeedPageStatementOptions {
  readonly includeCollectionFollowers?: boolean;
}

const OWNER_ONLY_COLLECTION_AUTHORITY = `left join lateral (
               select lower(actor_handle.handle) handle,actor_profile.display_name,actor_profile.avatar_url,
                      collection.title,collection.publication_slug,
                      ${collectionHidePublicExistsSql('collection.id')} hidden_public
                 from follows current_follow
                 join profiles recipient_profile
                   on recipient_profile.account_id=current_follow.actor_profile_id
                 join accounts recipient_account on recipient_account.id=recipient_profile.account_id
                   and recipient_account.status='active' and recipient_account.deleted_at is null
                 join profiles actor_profile
                   on actor_profile.account_id=current_follow.target_profile_id
                 join accounts actor_account on actor_account.id=actor_profile.account_id
                   and actor_account.status='active' and actor_account.deleted_at is null
                 join profile_handles actor_handle on actor_handle.account_id=actor_profile.account_id
                 join collections collection on collection.id=item.collection_id
                   and collection.deleted_at is null and collection.visibility='public'
                   and collection.publication_slug is not null and collection.published_at is not null
                   and collection.owner_subject_id=actor_account.subject_id
                where current_follow.actor_profile_id=item.recipient_profile_id
                  and current_follow.target_profile_id=item.actor_profile_id
                  and current_follow.followed_at <= item.published_at
                  and item.kind='collection_change'
                limit 1
             ) collection_authority on true`;

const UNION_COLLECTION_AUTHORITY = `left join lateral (
               select handle,display_name,avatar_url,title,publication_slug,hidden_public
                 from (
               select lower(actor_handle.handle) handle,actor_profile.display_name,actor_profile.avatar_url,
                      collection.title,collection.publication_slug,
                      ${collectionHidePublicExistsSql('collection.id')} hidden_public
                 from follows current_follow
                 join profiles recipient_profile
                   on recipient_profile.account_id=current_follow.actor_profile_id
                 join accounts recipient_account on recipient_account.id=recipient_profile.account_id
                   and recipient_account.status='active' and recipient_account.deleted_at is null
                 join profiles actor_profile
                   on actor_profile.account_id=current_follow.target_profile_id
                 join accounts actor_account on actor_account.id=actor_profile.account_id
                   and actor_account.status='active' and actor_account.deleted_at is null
                 join profile_handles actor_handle on actor_handle.account_id=actor_profile.account_id
                 join collections collection on collection.id=item.collection_id
                   and collection.deleted_at is null and collection.visibility='public'
                   and collection.publication_slug is not null and collection.published_at is not null
                   and collection.owner_subject_id=actor_account.subject_id
                where current_follow.actor_profile_id=item.recipient_profile_id
                  and current_follow.target_profile_id=item.actor_profile_id
                  and current_follow.followed_at <= item.published_at
                  and item.kind='collection_change'
               union all
               select lower(actor_handle.handle) handle,actor_profile.display_name,actor_profile.avatar_url,
                      collection.title,collection.publication_slug,
                      ${collectionHidePublicExistsSql('collection.id')} hidden_public
                 from collection_follows current_collection_follow
                 join profiles recipient_profile
                   on recipient_profile.account_id=current_collection_follow.follower_profile_id
                 join accounts recipient_account on recipient_account.id=recipient_profile.account_id
                   and recipient_account.status='active' and recipient_account.deleted_at is null
                 join profiles actor_profile
                   on actor_profile.account_id=item.actor_profile_id
                 join accounts actor_account on actor_account.id=actor_profile.account_id
                   and actor_account.status='active' and actor_account.deleted_at is null
                 join profile_handles actor_handle on actor_handle.account_id=actor_profile.account_id
                 join collections collection on collection.id=item.collection_id
                   and collection.deleted_at is null and collection.visibility='public'
                   and collection.publication_slug is not null and collection.published_at is not null
                where current_collection_follow.follower_profile_id=item.recipient_profile_id
                  and current_collection_follow.collection_id=item.collection_id
                  and current_collection_follow.followed_at <= item.published_at
                  and item.kind='collection_change'
                 ) collection_authority_source
                limit 1
             ) collection_authority on true`;

export function createPostgresFeedPageReadPort(
  database: Pick<Kysely<DatabaseSchema>, 'executeQuery'>,
  options: FeedPageStatementOptions = {},
): FeedPageReadPort {
  return Object.freeze({ async loadPage(input: FeedPageReadInput) {
    const statement = buildFeedPageStatement(input, options);
    // Pre-query abort only; in-flight cancel is owned by the Feed query UoW.
    const result = await database.executeQuery<FeedRow>(CompiledQuery.raw(statement.text,
      [...statement.values]), input.signal ? { signal: input.signal } : undefined);
    return Object.freeze(result.rows.map((row) => Object.freeze({
      feedItemId: row.feed_item_id, sourceEventId: row.source_event_id, kind: row.kind,
      actor: Object.freeze({ profileId: row.actor_profile_id, handle: row.handle,
        displayName: row.display_name, avatarUrl: safeAvatarUrl(row.avatar_url) }),
      collectionId: row.collection_id, publishedAt: row.published_at,
      collectionTitle: row.kind === 'collection_change' ? (row.collection_title ?? null) : null,
      publicationSlug: row.kind === 'collection_change' ? (row.publication_slug ?? null) : null,
      hiddenPublic: row.kind === 'collection_change' && row.hidden_public === true,
      summary: null,
    })));
  } });
}

/**
 * Exact current-authority SELECT used by the application and query-plan evidence.
 * collection_authority is owner-follow UNION ALL a live public collection_follows
 * row only when includeCollectionFollowers is explicitly true — the same
 * fail-closed polarity as the fan-out recipient statement, so a caller that
 * omits the option can never bypass the collection-follow flag. Omitted or
 * false is owner-follow only.
 */
export function buildFeedPageStatement(
  input: FeedPageReadInput,
  options: FeedPageStatementOptions = {},
): FeedPageStatement {
  validate(input); const values: unknown[] = [input.principalId];
  const parameter = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const filters = [
    `item.recipient_profile_id=$1`, `item.state='visible'`,
    `not ${accountRestrictPublicationExistsSql('item.actor_profile_id')}`,
  ];
  if (input.kind) filters.push(`item.kind=${parameter(input.kind)}`);
  if (input.after) {
    const publishedAt = parameter(input.after.publishedAt);
    const sourceEventId = parameter(input.after.sourceEventId);
    const feedItemId = parameter(input.after.feedItemId);
    filters.push(`(item.published_at,item.source_event_id,item.feed_item_id)
      < (${publishedAt}::timestamptz,${sourceEventId}::text,${feedItemId}::text)`);
  }
  const limit = parameter(input.limit + 1);
  const collectionAuthority = options.includeCollectionFollowers === true
    ? UNION_COLLECTION_AUTHORITY
    : OWNER_ONLY_COLLECTION_AUTHORITY;
  return Object.freeze({
    text: `select item.feed_item_id,item.source_event_id,item.kind,item.actor_profile_id,
                  coalesce(collection_authority.handle, follow_authority.handle) handle,
                  coalesce(collection_authority.display_name, follow_authority.display_name) display_name,
                  coalesce(collection_authority.avatar_url, follow_authority.avatar_url) avatar_url,
                  item.collection_id,item.published_at,
                  collection_authority.title collection_title,
                  collection_authority.publication_slug publication_slug,
                  collection_authority.hidden_public hidden_public
             from social_feed_items item
             ${collectionAuthority}
             left join lateral (
               select lower(actor_handle.handle) handle,actor_profile.display_name,actor_profile.avatar_url
                 from follows current_follow
                 join profiles recipient_profile
                   on recipient_profile.account_id=current_follow.target_profile_id
                 join accounts recipient_account on recipient_account.id=recipient_profile.account_id
                   and recipient_account.status='active' and recipient_account.deleted_at is null
                 join profiles actor_profile
                   on actor_profile.account_id=current_follow.actor_profile_id
                 join accounts actor_account on actor_account.id=actor_profile.account_id
                   and actor_account.status='active' and actor_account.deleted_at is null
                 join profile_handles actor_handle on actor_handle.account_id=actor_profile.account_id
                where current_follow.actor_profile_id=item.actor_profile_id
                  and current_follow.target_profile_id=item.recipient_profile_id
                  and date_trunc('milliseconds', current_follow.followed_at) <= item.published_at
                  and item.kind='follow_activity'
                limit 1
             ) follow_authority on true
            where ${filters.join(' and ')}
              and (
                (item.kind='collection_change' and collection_authority.handle is not null)
                or
                (item.kind='follow_activity' and follow_authority.handle is not null)
              )
            order by item.published_at desc,item.source_event_id desc,item.feed_item_id desc
            limit ${limit}`,
    values: Object.freeze(values),
  });
}

function validate(input: FeedPageReadInput): void {
  if (!input || typeof input.principalId !== 'string' || !input.principalId
    || input.principalId.length > SOCIAL_IDENTITY_MAX_LENGTH
    || input.principalId.trim() !== input.principalId
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || (input.kind !== undefined && input.kind !== 'collection_change' && input.kind !== 'follow_activity')
    || (input.after !== undefined && (!(input.after.publishedAt instanceof Date)
      || !Number.isFinite(input.after.publishedAt.getTime())
      || !validIdentity(input.after.sourceEventId) || !validIdentity(input.after.feedItemId)))) {
    throw new TypeError('invalid Feed page read input');
  }
}
function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.length > 0
  && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value; }
function safeAvatarUrl(value: string | null): string | null { if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
    ? url.href : null; } catch { return null; } }
