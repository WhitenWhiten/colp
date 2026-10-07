import { CompiledQuery } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseRuntime } from '../database/index.js';
import {
  ABOUT_MAX,
  isCanonicalPublicProfileHandle,
  isValidAvatarUrl,
  type PublicProfileFacts,
  type PublicProfileFactsReadPort,
  type PublicProfileOwnerFactsReadPort,
} from '../../modules/identity/index.js';

interface PublicProfileFactsRow {
  profile_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  about: string;
  owner_subject_id: string;
}

export function createPostgresPublicProfileFactsReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): PublicProfileFactsReadPort & PublicProfileOwnerFactsReadPort {
  return publicProfileFactsReader((text, values) => runtime.pool.query<PublicProfileFactsRow>(text, values));
}

/** Identity normalization with reads owned by the caller's database snapshot. */
export function createPostgresTransactionPublicProfileFactsReadPort(transaction: DatabaseTransaction) {
  return publicProfileFactsReader((text, values) => transaction.executeQuery(CompiledQuery.raw(text, values)) as Promise<{ rows: PublicProfileFactsRow[] }>);
}

function publicProfileFactsReader(query: (text: string, values: unknown[]) => Promise<{ rows: PublicProfileFactsRow[] }>) {
  return Object.freeze({
    async findByCanonicalHandle(canonicalHandle: string) {
      if (!isCanonicalPublicProfileHandle(canonicalHandle)) {
        throw new TypeError('Public Profile facts lookup requires a canonical handle');
      }
      const statement = buildPublicProfileFactsStatement(canonicalHandle);
      const result = await query(statement.text, [...statement.values]);
      const row = result.rows[0];
      if (!row) return null;
      const facts = mapPublicProfileFacts(row);
      if (facts === null) throw new Error('PostgreSQL returned invalid public Profile facts');
      return facts;
    },
    async findByOwnerSubjectId(ownerSubjectId: string) {
      if (typeof ownerSubjectId !== 'string' || ownerSubjectId.length === 0
          || ownerSubjectId.length > 512 || ownerSubjectId.trim() !== ownerSubjectId) {
        throw new TypeError('Public Profile owner lookup requires a canonical subject identity');
      }
      const result = await query(
        `${publicProfileFactsSelect()} where a.subject_id = $1
           and a.status = 'active'
           and a.deleted_at is null
         limit 1`,
        [ownerSubjectId],
      );
      const row = result.rows[0];
      return row ? mapPublicProfileFacts(row) : null;
    },
    async findManyByOwnerSubjectIds(ownerSubjectIds: readonly string[]) {
      const unique = [...new Set(ownerSubjectIds)];
      if (unique.length > PUBLIC_PROFILE_OWNER_BATCH_MAX) {
        throw new RangeError('Public Profile owner batch lookup exceeds its bound');
      }
      for (const id of unique) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 512 || id.trim() !== id) {
          throw new TypeError('Public Profile owner lookup requires a canonical subject identity');
        }
      }
      const facts = new Map<string, PublicProfileFacts>();
      if (unique.length === 0) return facts;
      const result = await query(
        `select distinct on (a.subject_id) p.account_id as profile_id,
                lower(h.handle) as handle, p.display_name, p.avatar_url,
                p.about, a.subject_id as owner_subject_id
           from profile_handles h
           join accounts a on a.id = h.account_id
           join profiles p on p.account_id = h.account_id
          where a.subject_id = any($1::text[])
            and a.status = 'active'
            and a.deleted_at is null
          order by a.subject_id, lower(h.handle)`,
        [unique],
      );
      for (const row of result.rows) {
        const mapped = mapPublicProfileFacts(row);
        if (mapped !== null) facts.set(mapped.ownerSubjectId, mapped);
      }
      return facts;
    },
  });
}

/** Bounded batch ceiling for owner-subject lookups (directory page caps). */
const PUBLIC_PROFILE_OWNER_BATCH_MAX = 2_048;

export interface PublicProfileFactsStatement {
  readonly text: string;
  readonly values: readonly [string];
}

export function buildPublicProfileFactsStatement(canonicalHandle: string): PublicProfileFactsStatement {
  if (!isCanonicalPublicProfileHandle(canonicalHandle)) {
    throw new TypeError('Public Profile facts lookup requires a canonical handle');
  }
  return Object.freeze({
    text: `${publicProfileFactsSelect()} where lower(h.handle) collate "C" = $1 collate "C"
              and a.status = 'active'
              and a.deleted_at is null
            limit 1`,
    values: Object.freeze([canonicalHandle] as const),
  });
}

function publicProfileFactsSelect(): string {
  return `select p.account_id as profile_id, lower(h.handle) as handle,
                 p.display_name, p.avatar_url, p.about,
                 a.subject_id as owner_subject_id
            from profile_handles h
            join accounts a on a.id = h.account_id
            join profiles p on p.account_id = h.account_id`;
}

function mapPublicProfileFacts(row: PublicProfileFactsRow): PublicProfileFacts | null {
  // Fail closed on the avatar value (FIX-M-003): a stored avatar_url that
  // violates the HttpsUrl contract is never served to anonymous readers — it
  // is downgraded to null instead of corrupting the whole row, so a profile
  // whose remaining facts are valid stays reachable with a safe avatar (the
  // projection layer keeps its own safe-avatar fallback on top of this). The
  // forward migration backfills legacy violations to NULL; this sanitization
  // is the defense in depth for rows that slip through during rollout.
  if (!/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(row.profile_id)
      || !isCanonicalPublicProfileHandle(row.handle)
      || typeof row.display_name !== 'string'
      || typeof row.owner_subject_id !== 'string'
      || row.owner_subject_id.length === 0) {
    return null;
  }
  return Object.freeze({
    profileId: row.profile_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: typeof row.avatar_url === 'string' && isValidAvatarUrl(row.avatar_url)
      ? row.avatar_url
      : null,
    about: publicAbout(row.about),
    ownerSubjectId: row.owner_subject_id,
  });
}

function publicAbout(value: unknown): string {
  if (typeof value !== 'string' || value.length > ABOUT_MAX) return '';
  if (value.length > 0 && value.trim().length === 0) return '';
  return value;
}
