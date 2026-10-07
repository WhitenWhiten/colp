/**
 * Exact live fan-out recipient page SELECT shared by the worker and capacity evidence.
 * Ordered by actor_profile_id ASC so follows_target_actor_fanout_idx can satisfy the plan.
 *
 * `includeCollectionFollowers` is the statement-level guard for
 * `KNOWN_FEATURE_COLLECTION_FOLLOW`. Off keeps this owner-only text and `$1..$4` binding
 * byte-identical. On unions `collection_follows` then keysets the combined page.
 */
export interface FanoutRecipientPageInput {
  readonly ownerProfileId: string;
  readonly collectionId?: string;
  readonly occurredAt: Date;
  readonly afterRecipientProfileId: string | null;
  readonly limit: number;
  readonly includeCollectionFollowers?: boolean;
}

export interface FanoutRecipientPageStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

const OWNER_FOLLOWER_PAGE_TEXT = `select follow.actor_profile_id
    from follows follow
    join accounts account on account.id=follow.actor_profile_id
    join profiles profile on profile.account_id=account.id
    where follow.target_profile_id=$1
      and follow.followed_at <= $2
      and account.status='active'
      and account.deleted_at is null
      and ($3::text is null or follow.actor_profile_id > $3)
    order by follow.actor_profile_id
    limit $4`;

/**
 * Each arm keysets and limits on its own index before the UNION dedup: the
 * global top-$4 recipients are always contained in the per-arm top-$4 pages,
 * so correctness is unchanged while the planner never materialises the full
 * recipient corpus per page (an unbounded UNION hash-aggregated every
 * follower on every keyset page).
 */
const COLLECTION_FOLLOWER_UNION_TEXT = `select actor_profile_id
    from (
      (select follow.actor_profile_id
        from follows follow
        join accounts account on account.id=follow.actor_profile_id
        join profiles profile on profile.account_id=account.id
        where follow.target_profile_id=$1
          and follow.followed_at <= $2
          and account.status='active'
          and account.deleted_at is null
          and ($3::text is null or follow.actor_profile_id > $3)
        order by follow.actor_profile_id
        limit $4)
      union
      (select collection_follow.follower_profile_id
        from collection_follows collection_follow
        join accounts account on account.id=collection_follow.follower_profile_id
        join profiles profile on profile.account_id=account.id
        where collection_follow.collection_id=$5
          and collection_follow.followed_at <= $2
          and account.status='active'
          and account.deleted_at is null
          and ($3::text is null or collection_follow.follower_profile_id > $3)
        order by collection_follow.follower_profile_id
        limit $4)
    ) recipients
    order by actor_profile_id
    limit $4`;

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

export function buildFanoutRecipientPageStatement(
  input: FanoutRecipientPageInput,
): FanoutRecipientPageStatement {
  if (!isIdentity(input.ownerProfileId)
    || !(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())
    || !Number.isInteger(input.limit) || input.limit < 1
    || (input.afterRecipientProfileId !== null && !isIdentity(input.afterRecipientProfileId))
    || (input.includeCollectionFollowers === true && !isIdentity(input.collectionId))) {
    throw new TypeError('invalid fan-out recipient page input');
  }
  if (input.includeCollectionFollowers === true) {
    return Object.freeze({
      text: COLLECTION_FOLLOWER_UNION_TEXT,
      values: Object.freeze([
        input.ownerProfileId,
        input.occurredAt,
        input.afterRecipientProfileId,
        input.limit,
        input.collectionId,
      ] as const),
    });
  }
  return Object.freeze({
    text: OWNER_FOLLOWER_PAGE_TEXT,
    values: Object.freeze([
      input.ownerProfileId,
      input.occurredAt,
      input.afterRecipientProfileId,
      input.limit,
    ] as const),
  });
}
