import { CompiledQuery, type Kysely } from 'kysely';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type PublicActivityActorLookupResult,
  type PublicActivityPageReadInput,
  type PublicActivityPageReadPort,
  type PublicActivityQueryFact,
} from '../../modules/social/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { accountRestrictPublicationExistsSql, collectionHidePublicExistsSql } from '../governance/collection-control-sql.js';

interface ActorRow { actor_profile_id: string; }
interface ActivityRow {
  activity_id: string;
  source_event_id: string;
  kind: 'collection_change';
  collection_id: string;
  collection_title: string;
  publication_slug: string;
  published_at: Date;
}

export interface PublicActivityPageStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export function createPostgresPublicActivityPageReadPort(
  database: Pick<Kysely<DatabaseSchema>, 'executeQuery'>,
): PublicActivityPageReadPort {
  return Object.freeze({
    async resolveActor(handle: string, signal?: AbortSignal): Promise<PublicActivityActorLookupResult> {
      if (!validHandle(handle)) return { found: false };
      const result = await database.executeQuery<ActorRow>(CompiledQuery.raw(
        `select p.account_id as actor_profile_id
           from profile_handles h
           join accounts a on a.id = h.account_id
           join profiles p on p.account_id = h.account_id
          where lower(h.handle) collate "C" = $1 collate "C"
            and a.status = 'active'
            and a.deleted_at is null
            and not ${accountRestrictPublicationExistsSql('a.id')}
          limit 1`,
        [handle],
      ), signal ? { signal } : undefined);
      const row = result.rows[0];
      return row ? { found: true, actorProfileId: row.actor_profile_id } : { found: false };
    },
    async loadPage(input: PublicActivityPageReadInput) {
      const statement = buildPublicActivityPageStatement(input);
      const result = await database.executeQuery<ActivityRow>(CompiledQuery.raw(statement.text,
        [...statement.values]), input.signal ? { signal: input.signal } : undefined);
      return Object.freeze(result.rows.map((row) => Object.freeze({
        activityId: row.activity_id,
        sourceEventId: row.source_event_id,
        kind: row.kind,
        collectionId: row.collection_id,
        collectionTitle: row.collection_title,
        publicationSlug: row.publication_slug,
        publishedAt: row.published_at,
      })));
    },
  });
}

/** Exclusive keyset page of actor-scoped public collection-change activity. */
export function buildPublicActivityPageStatement(input: PublicActivityPageReadInput): PublicActivityPageStatement {
  validate(input);
  const values: unknown[] = [input.actorProfileId];
  const parameter = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const filters = [
    `item.actor_profile_id=$1`, `item.state='visible'`, `item.kind='collection_change'`,
    // Governance: hide_public on the collection must withdraw its derived
    // public activity rows (plan: 旧事件不能复活已撤回内容). Delist does not
    // apply here: it only removes discovery, and the activity feed is a
    // direct derived output of the collection change.
    `not ${collectionHidePublicExistsSql('collection.id')}`,
  ];
  if (input.after) {
    const publishedAt = parameter(input.after.publishedAt);
    const sourceEventId = parameter(input.after.sourceEventId);
    const activityId = parameter(input.after.activityId);
    filters.push(`(item.published_at,item.source_event_id,item.activity_id)
      < (${publishedAt}::timestamptz,${sourceEventId}::text,${activityId}::text)`);
  }
  const limit = parameter(input.limit + 1);
  return Object.freeze({
    text: `select item.activity_id,item.source_event_id,item.kind,item.collection_id,
                  collection.title collection_title,collection.publication_slug publication_slug,
                  item.published_at
             from social_public_activity item
             join profiles actor_profile
               on actor_profile.account_id=item.actor_profile_id
             join accounts actor_account on actor_account.id=actor_profile.account_id
               and actor_account.status='active' and actor_account.deleted_at is null
             join profile_handles actor_handle on actor_handle.account_id=actor_profile.account_id
             join collections collection on collection.id=item.collection_id
               and collection.deleted_at is null and collection.visibility='public'
               and collection.publication_slug is not null and collection.published_at is not null
               and collection.owner_subject_id=actor_account.subject_id
            where ${filters.join(' and ')}
            order by item.published_at desc,item.source_event_id desc,item.activity_id desc
            limit ${limit}`,
    values: Object.freeze(values),
  });
}

function validate(input: PublicActivityPageReadInput): void {
  if (!input || typeof input.actorProfileId !== 'string' || !input.actorProfileId
    || input.actorProfileId.length > SOCIAL_IDENTITY_MAX_LENGTH
    || input.actorProfileId.trim() !== input.actorProfileId
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || (input.after !== undefined && (!(input.after.publishedAt instanceof Date)
      || !Number.isFinite(input.after.publishedAt.getTime())
      || !validIdentity(input.after.sourceEventId) || !validIdentity(input.after.activityId)))) {
    throw new TypeError('invalid public Activity page read input');
  }
}
function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value;
}
function validHandle(value: string): boolean {
  return value !== '.' && value !== '..' && /^[a-z0-9._~-]{1,64}$/u.test(value);
}
