import { sql, type Kysely } from 'kysely';
import {
  type CollectionFollowCombinedQueryPorts,
  type CollectionFollowStateReadInput,
  type CollectionFollowStateReadPort,
  type CollectionFollowStateResult,
  type FollowedCollectionFact,
  type FollowedCollectionsCursorKeyring,
  type FollowedCollectionsReadInput,
  type FollowedCollectionsReadPort,
} from '../../modules/social/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { databaseNow } from '../database/time.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';

export type { CollectionFollowCombinedQueryPorts };

export interface PostgresCollectionFollowQueryUnitOfWork {
  execute<Result>(
    work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export interface PostgresCollectionFollowQueryUnitOfWorkOptions {
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
}

export function createPostgresCollectionFollowStateReadPort(
  transaction: DatabaseTransaction,
): CollectionFollowStateReadPort {
  return Object.freeze({
    async readState(input: CollectionFollowStateReadInput): Promise<CollectionFollowStateResult | null> {
      const target = await sql<{
        owner_subject_id: string;
        visibility: string;
        deleted_at: Date | null;
      }>`
        select collection.owner_subject_id, collection.visibility, collection.deleted_at
          from collections collection
         where collection.id=${input.collectionId}
      `.execute(transaction);
      const row = target.rows[0];
      if (!row || row.deleted_at !== null
          || (row.visibility !== 'public' && row.visibility !== 'unlisted')) {
        return null;
      }

      const count = await sql<{ count: string }>`
        select count(*)::text as count
          from collection_follows
         where collection_id=${input.collectionId}
      `.execute(transaction);
      const followerCount = Number(count.rows[0]?.count ?? 0);
      if (row.owner_subject_id === input.actorSubjectId) {
        return Object.freeze({ following: false, followerCount, followedAt: null });
      }

      const mine = await sql<{ followed_at: Date }>`
        select followed_at
          from collection_follows
         where collection_id=${input.collectionId}
           and follower_profile_id=${input.actorProfileId}
      `.execute(transaction);
      const followedAt = mine.rows[0]?.followed_at ?? null;
      return Object.freeze({
        following: followedAt !== null,
        followerCount,
        followedAt,
      });
    },
  });
}

export function createPostgresCollectionFollowListReadPort(
  transaction: DatabaseTransaction,
): FollowedCollectionsReadPort {
  // Every surviving follow row is returned; rows whose target can no longer be
  // opened (soft-deleted, no longer public/unlisted, owner inactive) grey out
  // as availability='unavailable' instead of vanishing. Hard deletion cascades
  // the follow row itself. The availability predicate mirrors what the public
  // GET /c/{slug} would allow (publication_slug is immutable once published,
  // so it stays legible on tombstones). Unavailable rows must not leak the
  // summary — it may have been rewritten after the collection went dark.
  return Object.freeze({
    async listFollowedCollections(input: FollowedCollectionsReadInput): Promise<readonly FollowedCollectionFact[]> {
      const after = input.after;
      const rows = after
        ? (await sql<ListRow>`
            select collection.id as collection_id,
                   collection.publication_slug as slug,
                   collection.title,
                   collection.summary,
                   collection.kind,
                   owner_profile.account_id as owner_profile_id,
                   lower(owner_handle.handle) as owner_handle,
                   owner_profile.display_name as owner_display_name,
                   owner_profile.avatar_url as owner_avatar_url,
                   collection.updated_at,
                   follow.followed_at,
                   (collection.deleted_at is null
                     and collection.visibility in ('public','unlisted')
                     and collection.publication_slug is not null
                     and owner_account.status='active'
                     and owner_account.deleted_at is null) as available
              from collection_follows follow
              join collections collection
                on collection.id=follow.collection_id
              join accounts owner_account
                on owner_account.subject_id=collection.owner_subject_id
              join profiles owner_profile
                on owner_profile.account_id=owner_account.id
              join profile_handles owner_handle
                on owner_handle.account_id=owner_profile.account_id
             where follow.follower_profile_id=${input.followerProfileId}
               and (follow.followed_at,follow.collection_id) < (${after.followedAt}::timestamptz,${after.collectionId}::text)
             order by follow.followed_at desc,follow.collection_id desc
             limit ${input.limit + 1}
          `.execute(transaction)).rows
        : (await sql<ListRow>`
            select collection.id as collection_id,
                   collection.publication_slug as slug,
                   collection.title,
                   collection.summary,
                   collection.kind,
                   owner_profile.account_id as owner_profile_id,
                   lower(owner_handle.handle) as owner_handle,
                   owner_profile.display_name as owner_display_name,
                   owner_profile.avatar_url as owner_avatar_url,
                   collection.updated_at,
                   follow.followed_at,
                   (collection.deleted_at is null
                     and collection.visibility in ('public','unlisted')
                     and collection.publication_slug is not null
                     and owner_account.status='active'
                     and owner_account.deleted_at is null) as available
              from collection_follows follow
              join collections collection
                on collection.id=follow.collection_id
              join accounts owner_account
                on owner_account.subject_id=collection.owner_subject_id
              join profiles owner_profile
                on owner_profile.account_id=owner_account.id
              join profile_handles owner_handle
                on owner_handle.account_id=owner_profile.account_id
             where follow.follower_profile_id=${input.followerProfileId}
             order by follow.followed_at desc,follow.collection_id desc
             limit ${input.limit + 1}
          `.execute(transaction)).rows;
      return Object.freeze(rows.map((row) => Object.freeze({
        collectionId: row.collection_id,
        slug: row.slug ?? '',
        title: row.title,
        summary: row.available ? row.summary : null,
        kind: row.kind,
        owner: Object.freeze({
          profileId: row.owner_profile_id,
          handle: row.owner_handle,
          displayName: row.owner_display_name,
          avatarUrl: safeAvatarUrl(row.owner_avatar_url),
        }),
        updatedAt: row.updated_at,
        followedAt: row.followed_at,
        availability: (row.available ? 'available' : 'unavailable') as FollowedCollectionFact['availability'],
      })));
    },
  });
}

interface ListRow {
  collection_id: string;
  slug: string | null;
  title: string;
  summary: string | null;
  kind: FollowedCollectionFact['kind'];
  owner_profile_id: string;
  owner_handle: string;
  owner_display_name: string;
  owner_avatar_url: string | null;
  updated_at: Date;
  followed_at: Date;
  available: boolean;
}

function safeAvatarUrl(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    return value;
  } catch {
    return null;
  }
}

export function createPostgresCollectionFollowQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cursors?: FollowedCollectionsCursorKeyring,
  options: PostgresCollectionFollowQueryUnitOfWorkOptions = {},
): PostgresCollectionFollowQueryUnitOfWork {
  const unit = createUnitOfWork(db, {
    isolationLevel: 'repeatable read',
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  const missingCursors: FollowedCollectionsCursorKeyring = Object.freeze({
    followedCollections: Object.freeze({
      seal: () => { throw new TypeError('Followed collections cursor keyring is required'); },
      verify: () => { throw new TypeError('Followed collections cursor keyring is required'); },
    }),
    destroy() {},
  });
  const keyring = cursors ?? missingCursors;
  return Object.freeze({
    execute<Result>(
      work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(db, work, execution.signal, keyring, options);
      }
      return unit.execute(({ transaction }) => work(createQueryPorts(transaction, keyring)));
    },
  });
}

function createQueryPorts(
  transaction: DatabaseTransaction,
  cursors: FollowedCollectionsCursorKeyring,
): CollectionFollowCombinedQueryPorts {
  return Object.freeze({
    reads: Object.freeze({
      ...createPostgresCollectionFollowStateReadPort(transaction),
      ...createPostgresCollectionFollowListReadPort(transaction),
    }),
    cursors,
    clock: { now: () => databaseNow(transaction) },
  });
}

async function executeAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>,
  signal: AbortSignal,
  cursors: FollowedCollectionsCursorKeyring,
  options: PostgresCollectionFollowQueryUnitOfWorkOptions,
): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('repeatable read').execute(async (transaction) => {
    const disposeCancellation = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      await options.faultInjector?.beforeCallback?.(transaction);
      const result = await work(createQueryPorts(transaction, cursors));
      await options.faultInjector?.afterCallbackBeforeCommit?.(transaction);
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      await disposeCancellation();
    }
  });
}
