/**
 * LP-03 link preview PostgreSQL repository (raw pool, like the shared favicon
 * cache). Every write that finishes a fetch is fenced by the claim lease, so
 * a worker that lost its lease can never overwrite a newer result.
 *
 * Scheduling: a claimable row has `next_attempt_at <= now()`. Terminal
 * outcomes park at 'infinity'; `enqueue` makes a stale row due again:
 * ready after 30 days (at most one retry a day while refreshes fail), none
 * after 14 days, and a failed row that exhausted its retries after 7 days.
 */
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import {
  type LinkPreviewSource,
  type LinkPreviewTargetIdentity,
} from '../../modules/collections/index.js';
import { readBackendPid, withPostgresAbort } from '../database/query-abort.js';
import { bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';
import { PUBLICATION_TARGET_ACCESS_MAX_DEPTH } from '../publication/target-access-facts.js';

/** Transient failures retry with backoff until this count, then park. */
export const LINK_PREVIEW_MAX_FAILURES = 8;

export interface LinkPreviewClaim {
  readonly urlKey: string;
  readonly normalizedUrl: string;
  readonly site: string;
  readonly objectId: string | null;
  readonly digest: string | null;
  readonly failures: number;
  readonly leaseOwner: string;
}

export interface LinkPreviewReadyInput {
  readonly claim: LinkPreviewClaim;
  readonly objectId: string;
  readonly width: number;
  readonly height: number;
  readonly mime: string;
  readonly digest: string;
  readonly source: LinkPreviewSource;
  readonly retentionSeconds: number;
}

export interface LinkPreviewSweepClaim {
  readonly afterUrl: string | null;
  readonly collectionId: string;
  readonly contentRevision: string;
  readonly leaseOwner: string;
}

export interface LinkPreviewSweepUrlPage {
  readonly urls: readonly string[];
  /** True when a reachable cycle or an ancestry walk past the legal depth was skipped. */
  readonly corrupted: boolean;
}

export interface LinkPreviewRepositoryOptions {
  /** Independent `pg_cancel_backend` for the checked-out connection. */
  readonly cancelBackend?: (backendPid: number) => Promise<boolean>;
}

export interface LinkPreviewRepository {
  enqueue(identities: readonly LinkPreviewTargetIdentity[]): Promise<number>;
  claimDue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }):
    Promise<LinkPreviewClaim[]>;
  renewLease(claim: LinkPreviewClaim, leaseDurationMs: number): Promise<boolean>;
  /** Ledger row for an object version; written before the PUT. */
  recordObject(input: {
    readonly objectId: string; readonly urlKey: string; readonly digest: string; readonly retentionSeconds: number;
  }): Promise<void>;
  completeReady(input: LinkPreviewReadyInput): Promise<{ readonly written: boolean; readonly generic: boolean }>;
  completeNone(claim: LinkPreviewClaim): Promise<boolean>;
  completeFailure(claim: LinkPreviewClaim): Promise<boolean>;
  claimSweep(input: {
    readonly leaseOwner: string; readonly leaseDurationMs: number; readonly resweepAfterMs: number;
  }): Promise<LinkPreviewSweepClaim | null>;
  listSweepUrls(
    collectionId: string,
    limit: number,
    afterUrl?: string | null,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LinkPreviewSweepUrlPage>;
  completeSweep(claim: LinkPreviewSweepClaim, nextUrl?: string | null): Promise<void>;
  /** Drops the lease after a cancelled scan. Does not finish the sweep or move the cursor. */
  releaseSweep(claim: LinkPreviewSweepClaim): Promise<void>;
  pruneStale(input: { readonly olderThanMs: number; readonly limit: number; readonly retentionSeconds: number }):
    Promise<number>;
  listCollectable(limit: number): Promise<string[]>;
  forgetObject(objectId: string): Promise<void>;
}

interface ClaimRow {
  url_key: string;
  normalized_url: string;
  site: string;
  object_id: string | null;
  digest: string | null;
  failures: number;
}

/**
 * Idempotent enqueue shared by the worker sweep and the Product request
 * command: inserts new targets, bumps `last_requested_at`, and makes a stale
 * parked row due again (see the module comment for the stale rules).
 */
export const LINK_PREVIEW_ENQUEUE_SQL = `
  INSERT INTO link_preview_targets AS t (url_key, normalized_url, site)
  SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
  ON CONFLICT (url_key) DO UPDATE SET
    last_requested_at = clock_timestamp(),
    next_attempt_at = CASE
      WHEN t.next_attempt_at <= clock_timestamp() THEN t.next_attempt_at
      WHEN t.status = 'ready' AND t.fetched_at < clock_timestamp() - interval '30 days'
        AND t.updated_at < clock_timestamp() - interval '1 day' THEN clock_timestamp()
      WHEN t.status = 'none' AND t.updated_at < clock_timestamp() - interval '14 days' THEN clock_timestamp()
      WHEN t.status = 'failed' AND t.next_attempt_at = 'infinity'
        AND t.updated_at < clock_timestamp() - interval '7 days' THEN clock_timestamp()
      ELSE t.next_attempt_at
    END
`;

/** Deduplicated array parameters for LINK_PREVIEW_ENQUEUE_SQL; null when there is nothing to enqueue. */
export function linkPreviewEnqueueParams(
  identities: readonly LinkPreviewTargetIdentity[],
): [string[], string[], string[]] | null {
  // One statement may not touch the same key twice (ON CONFLICT DO UPDATE).
  const rows = [...new Map(identities.map((identity) => [identity.urlKey, identity])).values()];
  if (rows.length === 0) return null;
  return [rows.map((row) => row.urlKey), rows.map((row) => row.normalizedUrl), rows.map((row) => row.site)];
}

export function createPostgresLinkPreviewRepository(
  pool: Pool,
  options: LinkPreviewRepositoryOptions = {},
): LinkPreviewRepository {
  return {
    async enqueue(identities) {
      const params = linkPreviewEnqueueParams(identities);
      if (params === null) return 0;
      const result = await pool.query(LINK_PREVIEW_ENQUEUE_SQL, params);
      return result.rowCount ?? 0;
    },

    async claimDue({ limit, leaseOwner, leaseDurationMs }) {
      const result = await pool.query<ClaimRow>(`
        WITH candidate AS (
          SELECT url_key FROM link_preview_targets
           WHERE next_attempt_at <= clock_timestamp()
             AND (lease_until IS NULL OR lease_until <= clock_timestamp())
           ORDER BY next_attempt_at, url_key
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        UPDATE link_preview_targets t
           SET lease_owner = $2, lease_until = clock_timestamp() + $3 * interval '1 millisecond'
          FROM candidate c WHERE t.url_key = c.url_key
        RETURNING t.url_key, t.normalized_url, t.site, t.object_id, t.digest, t.failures
      `, [limit, leaseOwner, leaseDurationMs]);
      return result.rows.map((row) => ({
        urlKey: row.url_key,
        normalizedUrl: row.normalized_url,
        site: row.site,
        objectId: row.object_id,
        digest: row.digest,
        failures: row.failures,
        leaseOwner,
      }));
    },

    async renewLease(claim, leaseDurationMs) {
      const result = await pool.query(`
        UPDATE link_preview_targets
           SET lease_until = clock_timestamp() + $3 * interval '1 millisecond'
         WHERE url_key = $1 AND lease_owner = $2 AND lease_until > clock_timestamp()
      `, [claim.urlKey, claim.leaseOwner, leaseDurationMs]);
      return result.rowCount === 1;
    },

    async recordObject({ objectId, urlKey, digest, retentionSeconds }) {
      await pool.query(`
        INSERT INTO link_preview_objects (object_id, url_key, digest, deletable_at)
        VALUES ($1, $2, $3, clock_timestamp() + $4 * interval '1 second')
      `, [objectId, urlKey, digest, retentionSeconds]);
    },

    async completeReady(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Extend the displaced version's retention before publishing the new
        // one: a cached copy of the old URL must outlive its cache lifetime.
        if (input.claim.objectId !== null && input.claim.objectId !== input.objectId) {
          await client.query(`
            UPDATE link_preview_objects
               SET deletable_at = greatest(deletable_at, clock_timestamp() + $2 * interval '1 second')
             WHERE object_id = $1
          `, [input.claim.objectId, input.retentionSeconds]);
        }
        const updated = await client.query<{ generic: boolean }>(`
          UPDATE link_preview_targets
             SET status = 'ready', object_id = $3, width = $4, height = $5, mime = $6, digest = $7, source = $8,
                 failures = 0, fetched_at = clock_timestamp(), next_attempt_at = 'infinity',
                 lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
           WHERE url_key = $1 AND lease_owner = $2 AND lease_until > clock_timestamp()
          RETURNING generic
        `, [
          input.claim.urlKey, input.claim.leaseOwner, input.objectId, input.width, input.height,
          input.mime, input.digest, input.source,
        ]);
        if (updated.rowCount !== 1) {
          await client.query('ROLLBACK');
          return { written: false, generic: false };
        }
        // URL counts are attacker-controlled. Fetching one user's bookmarks
        // must never change another user's presentation. Only trusted operator
        // actions may set/clear the shared suppression flag; refresh preserves it.
        const generic = updated.rows[0]!.generic;
        await client.query('COMMIT');
        return { written: true, generic };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async completeNone(claim) {
      // A page that stopped publishing an image keeps the copy it had.
      const result = await pool.query(`
        UPDATE link_preview_targets
           SET status = CASE WHEN object_id IS NULL THEN 'none' ELSE status END,
               failures = 0, fetched_at = clock_timestamp(), next_attempt_at = 'infinity',
               lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
         WHERE url_key = $1 AND lease_owner = $2 AND lease_until > clock_timestamp()
      `, [claim.urlKey, claim.leaseOwner]);
      return result.rowCount === 1;
    },

    async completeFailure(claim) {
      // A failed refresh never clears a good image; only an empty row fails.
      const result = await pool.query(`
        UPDATE link_preview_targets
           SET status = CASE WHEN object_id IS NULL THEN 'failed' ELSE status END,
               failures = failures + 1,
               next_attempt_at = CASE
                 WHEN failures + 1 >= $3 THEN 'infinity'
                 ELSE clock_timestamp() + least(interval '1 day', interval '1 minute' * power(2, failures))
               END,
               lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
         WHERE url_key = $1 AND lease_owner = $2 AND lease_until > clock_timestamp()
      `, [claim.urlKey, claim.leaseOwner, LINK_PREVIEW_MAX_FAILURES]);
      return result.rowCount === 1;
    },

    async claimSweep({ leaseOwner, leaseDurationMs, resweepAfterMs }) {
      const claimed = await pool.query<{ collection_id: string }>(`
        WITH candidate AS (
          SELECT c.id FROM collections c
          LEFT JOIN link_preview_collection_sweeps s ON s.collection_id = c.id
           WHERE c.visibility IN ('public', 'unlisted') AND c.deleted_at IS NULL
             AND (s.collection_id IS NULL OR (
               (s.cursor_url IS NOT NULL OR s.content_revision IS DISTINCT FROM c.content_revision
                 OR s.swept_at IS NULL
                 OR s.swept_at < clock_timestamp() - $3 * interval '1 millisecond')
               AND (s.lease_until IS NULL OR s.lease_until <= clock_timestamp())))
           ORDER BY s.swept_at NULLS FIRST, c.id
           LIMIT 1
        )
        INSERT INTO link_preview_collection_sweeps AS s (collection_id, lease_owner, lease_until)
        SELECT id, $1, clock_timestamp() + $2 * interval '1 millisecond' FROM candidate
        ON CONFLICT (collection_id) DO UPDATE
           SET lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until
         WHERE s.lease_until IS NULL OR s.lease_until <= clock_timestamp()
        RETURNING s.collection_id
      `, [leaseOwner, leaseDurationMs, resweepAfterMs]);
      const collectionId = claimed.rows[0]?.collection_id;
      if (collectionId === undefined) return null;
      // Read the revision after the lease: an edit racing the listing below
      // leaves a newer revision and earns another sweep.
      const revision = await pool.query<{ content_revision: string; after_url: string | null }>(`
        SELECT c.content_revision,
          CASE WHEN s.cursor_revision = c.content_revision THEN s.cursor_url ELSE NULL END AS after_url
        FROM collections c JOIN link_preview_collection_sweeps s ON s.collection_id = c.id
        WHERE c.id = $1
      `, [collectionId]);
      return { collectionId, contentRevision: revision.rows[0]?.content_revision ?? '',
        afterUrl: revision.rows[0]?.after_url ?? null, leaseOwner };
    },

    async listSweepUrls(collectionId, limit, afterUrl = null, query) {
      // Only what anonymous readers can see: no private/protected subtrees, no
      // moderation-hidden bookmarks, and never a bookmark the owner vetoed.
      // Root is depth 0. readParentAncestry accepts a parent at depth 256, so
      // that parent's child is still legal; a live child past it is corrupt.
      // LIMIT only pages URLs. The pool statement_timeout still bounds the
      // statement; cycle and depth stop the walk, not LIMIT.
      const result = await queryWithSignal<{ urls: string[] | null; corrupted: boolean }>(pool, options.cancelBackend, `
        WITH RECURSIVE tree AS (
          SELECT n.id, n.kind, n.url, n.visibility IN ('private', 'protected') AS restricted,
                 ARRAY[n.id] AS path, 0 AS depth, false AS cycle
            FROM collections c JOIN nodes n ON n.id = c.root_node_id AND n.collection_id = c.id
           WHERE c.id = $1 AND c.visibility IN ('public', 'unlisted')
             AND c.deleted_at IS NULL AND n.deleted_at IS NULL
          UNION ALL
          SELECT child.id, child.kind, child.url, child.visibility IN ('private', 'protected'),
                 parent.path || child.id, parent.depth + 1, child.id = ANY(parent.path)
            FROM nodes child JOIN tree parent ON child.parent_id = parent.id
           WHERE child.collection_id = $1 AND child.deleted_at IS NULL
             AND NOT parent.restricted AND NOT parent.cycle AND parent.depth <= $4
        ),
        flags AS (
          SELECT COALESCE(bool_or(
            cycle OR (
              depth > $4 AND NOT restricted AND NOT cycle AND EXISTS (
                SELECT 1 FROM nodes child
                 WHERE child.collection_id = $1 AND child.parent_id = tree.id AND child.deleted_at IS NULL
              )
            )
          ), false) AS corrupted
          FROM tree
        )
        SELECT COALESCE((
          SELECT array_agg(page.url ORDER BY page.url)
            FROM (
              SELECT DISTINCT t.url COLLATE "C" AS url
                FROM tree t
               WHERE t.kind = 'bookmark' AND NOT t.restricted AND NOT t.cycle AND t.url IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM bookmark_preview_prefs p WHERE p.node_id = t.id AND p.mode = 'none')
                 AND NOT ${bookmarkHidePublicExistsSql('t.id', '$1')}
                 AND ($3::text IS NULL OR t.url COLLATE "C" > $3 COLLATE "C")
               ORDER BY url
               LIMIT $2
            ) page
        ), ARRAY[]::text[]) AS urls,
        COALESCE((SELECT corrupted FROM flags), false) AS corrupted
      `, [collectionId, limit, afterUrl, PUBLICATION_TARGET_ACCESS_MAX_DEPTH], query?.signal);
      const row = result.rows[0];
      const urls = Array.isArray(row?.urls) ? row.urls.filter((url): url is string => typeof url === 'string') : [];
      return { urls, corrupted: row?.corrupted === true };
    },

    async completeSweep({ collectionId, contentRevision, leaseOwner }, nextUrl = null) {
      await pool.query(`
        UPDATE link_preview_collection_sweeps
           SET content_revision = CASE WHEN $4::text IS NULL THEN $2 ELSE content_revision END,
               swept_at = CASE WHEN $4::text IS NULL THEN clock_timestamp() ELSE swept_at END,
               cursor_url = $4, cursor_revision = CASE WHEN $4::text IS NULL THEN NULL ELSE $2 END,
               lease_owner = NULL, lease_until = NULL
         WHERE collection_id = $1 AND lease_owner = $3 AND lease_until > clock_timestamp()
      `, [collectionId, contentRevision, leaseOwner, nextUrl]);
    },

    async releaseSweep({ collectionId, leaseOwner }) {
      await pool.query(`
        UPDATE link_preview_collection_sweeps
           SET lease_owner = NULL, lease_until = NULL
         WHERE collection_id = $1 AND lease_owner = $2
      `, [collectionId, leaseOwner]);
    },

    async pruneStale({ olderThanMs, limit, retentionSeconds }) {
      const result = await pool.query<{ pruned: number }>(`
        WITH doomed AS (
          SELECT url_key FROM link_preview_targets
           WHERE last_requested_at < clock_timestamp() - $1 * interval '1 millisecond'
             AND (lease_until IS NULL OR lease_until <= clock_timestamp())
           ORDER BY last_requested_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        ), gone AS (
          DELETE FROM link_preview_targets t USING doomed d WHERE t.url_key = d.url_key
          RETURNING t.object_id
        ), retained AS (
          UPDATE link_preview_objects o
             SET deletable_at = greatest(o.deletable_at, clock_timestamp() + $3 * interval '1 second')
            FROM gone WHERE o.object_id = gone.object_id
        )
        SELECT count(*)::int AS pruned FROM gone
      `, [olderThanMs, limit, retentionSeconds]);
      return result.rows[0]?.pruned ?? 0;
    },

    async listCollectable(limit) {
      const result = await pool.query<{ object_id: string }>(`
        SELECT o.object_id FROM link_preview_objects o
         WHERE o.deletable_at <= clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM link_preview_targets t WHERE t.object_id = o.object_id)
         ORDER BY o.deletable_at
         LIMIT $1
      `, [limit]);
      return result.rows.map((row) => row.object_id);
    },

    async forgetObject(objectId) {
      await pool.query(`
        DELETE FROM link_preview_objects o
         WHERE o.object_id = $1
           AND NOT EXISTS (SELECT 1 FROM link_preview_targets t WHERE t.object_id = o.object_id)
      `, [objectId]);
    },
  };
}

async function queryWithSignal<Row extends QueryResultRow>(
  pool: Pool,
  cancelBackend: ((backendPid: number) => Promise<boolean>) | undefined,
  text: string,
  values: readonly unknown[],
  signal: AbortSignal | undefined,
): Promise<QueryResult<Row>> {
  if (signal === undefined) return pool.query<Row>(text, [...values]);
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const client = await pool.connect();
  try {
    const pid = await readBackendPid(client, signal);
    return await withPostgresAbort(
      client.query<Row>(text, [...values]),
      signal,
      async () => {
        if (pid !== undefined && cancelBackend) await cancelBackend(pid);
      },
    );
  } finally {
    // withPostgresAbort waits for pg_cancel_backend and the statement before
    // throwing, so this checkout is not returned while a cancel is in flight.
    client.release();
  }
}
