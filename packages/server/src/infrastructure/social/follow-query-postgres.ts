import { CompiledQuery, type Kysely } from 'kysely';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type FollowPageReadInput,
  type FollowPageReadPort,
  type FollowProfileFact,
} from '../../modules/social/index.js';
import type { DatabaseSchema } from '../database/runtime.js';

interface Row {
  profile_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  followed_at: Date;
}

export interface FollowPageStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export function createPostgresFollowPageReadPort(
  database: Pick<Kysely<DatabaseSchema>, 'executeQuery'>,
): FollowPageReadPort {
  const targetExists = async (profileId: string, signal?: AbortSignal): Promise<boolean> => Boolean((await database.executeQuery(
    CompiledQuery.raw(`select true as present
      from profiles p
      join accounts a on a.id=p.account_id
      join profile_handles h on h.account_id=p.account_id
      where p.account_id=$1 and a.status='active' and a.deleted_at is null`, [profileId]),
    signal ? { signal, inflightQueryAbortStrategy: 'cancel query' } : undefined,
  )).rows[0]);

  const list = async (
    input: FollowPageReadInput,
    direction: 'followers' | 'following',
  ): Promise<readonly FollowProfileFact[] | null> => {
    const statement = buildFollowPageStatement(input, direction);
    const result = await database.executeQuery<Row>(
      CompiledQuery.raw(statement.text, [...statement.values]),
      input.signal ? { signal: input.signal, inflightQueryAbortStrategy: 'cancel query' } : undefined,
    );
    if (result.rows.length === 0 && !await targetExists(input.targetProfileId, input.signal)) return null;
    return Object.freeze(result.rows.map((row) => Object.freeze({
      profile: Object.freeze({
        profileId: row.profile_id,
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: safeAvatarUrl(row.avatar_url),
      }),
      followedAt: row.followed_at,
    })));
  };

  return Object.freeze({
    listFollowers: (input: FollowPageReadInput) => list(input, 'followers'),
    listFollowing: (input: FollowPageReadInput) => list(input, 'following'),
  });
}

/** Builds the exact production SELECT used by PostgreSQL query-plan evidence. */
export function buildFollowPageStatement(
  input: FollowPageReadInput,
  direction: 'followers' | 'following',
): FollowPageStatement {
  validateInput(input);
  if (direction !== 'followers' && direction !== 'following') {
    throw new TypeError('invalid Follow direction');
  }
  const related = direction === 'followers' ? 'actor_profile_id' : 'target_profile_id';
  const fixed = direction === 'followers' ? 'target_profile_id' : 'actor_profile_id';
  const values: unknown[] = [input.targetProfileId];
  let fence = '';
  if (input.after) {
    values.push(input.after.followedAt, input.after.profileId);
    fence = `and (f.followed_at,f.${related}) < ($2::timestamptz,$3::text)`;
  }
  values.push(input.limit + 1);
  return Object.freeze({
    text: `select f.${related} as profile_id,lower(h.handle) as handle,
                  p.display_name,p.avatar_url,f.followed_at
      from follows f
      join profiles target_profile on target_profile.account_id=f.${fixed}
      join accounts target_account on target_account.id=target_profile.account_id
        and target_account.status='active' and target_account.deleted_at is null
      join profile_handles target_handle on target_handle.account_id=target_profile.account_id
      join profiles p on p.account_id=f.${related}
      join accounts a on a.id=p.account_id and a.status='active' and a.deleted_at is null
      join profile_handles h on h.account_id=p.account_id
      where f.${fixed}=$1 ${fence}
      order by f.followed_at desc,f.${related} desc
      limit $${values.length}`,
    values: Object.freeze(values),
  });
}

function validateInput(input: FollowPageReadInput): void {
  if (!input || typeof input !== 'object'
      || typeof input.targetProfileId !== 'string' || input.targetProfileId.length === 0
      || input.targetProfileId.length > SOCIAL_IDENTITY_MAX_LENGTH
      || input.targetProfileId.trim() !== input.targetProfileId
      || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || (input.after !== undefined && (
        !(input.after.followedAt instanceof Date)
        || !Number.isFinite(input.after.followedAt.getTime())
        || typeof input.after.profileId !== 'string'
        || input.after.profileId.length === 0
        || input.after.profileId.length > SOCIAL_IDENTITY_MAX_LENGTH
        || input.after.profileId.trim() !== input.after.profileId
      ))) {
    throw new TypeError('invalid Follow page read input');
  }
}

function safeAvatarUrl(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    return parsed.href;
  } catch {
    return null;
  }
}
