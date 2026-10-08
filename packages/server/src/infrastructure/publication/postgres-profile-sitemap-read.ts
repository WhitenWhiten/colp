import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';
import {
  COLLECTION_DISCOVERY_CONTROL_SQL,
  accountRestrictPublicationExistsSql,
} from '../database/collection-control-sql.js';
import { SEED_COLLECTION_EXCLUSION_SQL } from './postgres-search-indexing-exclusion.js';

export const PROFILE_SITEMAP_CANDIDATE_LIMIT = 50_000;
const PROFILE_SITEMAP_PUBLIC_VISIBILITY = 'public';

export interface ProfileSitemapCandidate {
  readonly canonicalHandle: string;
  readonly updatedAt: string;
}

export interface ProfileSitemapCandidateReadPort {
  listCandidates(signal?: AbortSignal): Promise<readonly ProfileSitemapCandidate[]>;
}

interface ProfileSitemapRow {
  canonical_handle: string;
  updated_at: Date;
}

/**
 * Aggregates the exact anonymous Profile publication facts used by M-09 and
 * additionally requires the publication metadata authority's usable root.
 * The result contains no collection or attachment projection: existence of at
 * least one qualifying collection is the same indexability fact as M-09.
 */
export function buildProfileSitemapStatement(): {
  readonly text: string;
  readonly values: readonly unknown[];
} {
  return Object.freeze({
    text: `select lower(h.handle) as canonical_handle,
                  max(c.updated_at) as updated_at
             from profile_handles h
             join accounts a on a.id = h.account_id
             join profiles p on p.account_id = a.id
             join collections c on c.owner_subject_id = a.subject_id
             join nodes root
               on root.collection_id = c.id
              and root.id = c.root_node_id
              and root.is_root
              and root.deleted_at is null
            where a.status = 'active'
              and a.deleted_at is null
              and not ${accountRestrictPublicationExistsSql('a.id')}
              and c.deleted_at is null
              and c.publication_slug is not null
              and c.published_at is not null
              and c.visibility = $1
              and ${SEED_COLLECTION_EXCLUSION_SQL}
              and ${COLLECTION_DISCOVERY_CONTROL_SQL}
            group by lower(h.handle)
            order by max(c.updated_at) desc, lower(h.handle) collate "C" asc
            limit $2`,
    values: Object.freeze([PROFILE_SITEMAP_PUBLIC_VISIBILITY, PROFILE_SITEMAP_CANDIDATE_LIMIT]),
  });
}

export function createPostgresProfileSitemapReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): ProfileSitemapCandidateReadPort {
  return Object.freeze({
    async listCandidates(signal?: AbortSignal) {
      const statement = buildProfileSitemapStatement();
      const rows = signal === undefined
        ? (await runtime.pool.query<ProfileSitemapRow>(statement.text, [...statement.values])).rows
        : await listWithAbort(runtime, statement, signal);
      const records: ProfileSitemapCandidate[] = [];
      for (const row of rows) {
        throwIfAborted(signal);
        records.push(Object.freeze({
          canonicalHandle: row.canonical_handle,
          updatedAt: row.updated_at.toISOString(),
        }));
      }
      return Object.freeze(records);
    },
  });
}

async function listWithAbort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
  statement: { readonly text: string; readonly values: readonly unknown[] },
  signal: AbortSignal,
): Promise<readonly ProfileSitemapRow[]> {
  const client = await runtime.pool.connect();
  try {
    const pid = await readBackendPid(client, signal);
    const cancel = async (): Promise<void> => {
      if (pid !== undefined) await runtime.cancelBackend(pid);
    };
    const result = await withPostgresAbort(
      client.query<ProfileSitemapRow>(statement.text, [...statement.values]),
      signal,
      cancel,
    );
    return result.rows;
  } finally {
    client.release();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}
