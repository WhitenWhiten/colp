import { sql, type Kysely } from 'kysely';
import type {
  BookmarkIconSourceReadPort,
  BookmarkIconSourceRow,
  BookmarkIconSourceWritePort,
  FaviconSourceMembershipReadPort,
  IconSourceMode,
} from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

interface SourceRow {
  node_id: string;
  collection_id: string;
  source_mode: IconSourceMode;
  revision: string;
  updated_at: Date;
}

function mapSource(row: SourceRow): BookmarkIconSourceRow {
  return Object.freeze({
    nodeId: row.node_id,
    collectionId: row.collection_id,
    sourceMode: row.source_mode,
    revision: BigInt(row.revision),
    updatedAt: row.updated_at,
  });
}

const SOURCE_COLUMNS = sql`node_id, collection_id, source_mode, revision, updated_at`;

/**
 * FO-01 per-node icon source storage adapter. A missing row exposes the virtual
 * `inherit` state at revision 1; the first CAS write inserts with revision 2.
 * `uploaded` is only ever written by the real Product upload and `none` by the
 * explicit Product delete (flowing through the same port from
 * bookmark-favicon-command).
 */
export function createPostgresFaviconSourcePort(
  transaction: DatabaseTransaction,
): BookmarkIconSourceWritePort {
  return Object.freeze({
    async findByNodeId(nodeId) {
      const row = (await sql<SourceRow>`
        select ${SOURCE_COLUMNS}
        from bookmark_icon_sources
        where node_id = ${nodeId}
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapSource(row);
    },
    async update(input) {
      const updated = (await sql<SourceRow>`
        update bookmark_icon_sources
        set source_mode = ${input.sourceMode},
            revision = revision + 1,
            updated_at = greatest(${input.updatedAt}::timestamptz,
              updated_at + interval '1 microsecond')
        where node_id = ${input.nodeId} and revision = ${input.expectedRevision}
        returning ${SOURCE_COLUMNS}
      `.execute(transaction)).rows[0];
      if (updated !== undefined) return { kind: 'updated' as const, row: mapSource(updated) };
      if (input.expectedRevision === 1n) {
        try {
          const inserted = (await sql<SourceRow>`
            insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
            values (${input.nodeId}, ${input.collectionId}, ${input.sourceMode}, 2, ${input.updatedAt})
            returning ${SOURCE_COLUMNS}
          `.execute(transaction)).rows[0];
          if (inserted !== undefined) return { kind: 'updated' as const, row: mapSource(inserted) };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Concurrent first write: another transaction inserted the row.
        }
      }
      const current = (await sql<{ revision: string }>`
        select revision from bookmark_icon_sources where node_id = ${input.nodeId}
      `.execute(transaction)).rows[0];
      return {
        kind: 'stale' as const,
        currentRevision: current === undefined ? 1n : BigInt(current.revision),
      };
    },
    async setMode(input) {
      await sql`
        insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
        values (${input.nodeId}, ${input.collectionId}, ${input.sourceMode}, 2, ${input.updatedAt})
        on conflict (node_id) do update
          set source_mode = excluded.source_mode,
              revision = bookmark_icon_sources.revision + 1,
              updated_at = greatest(excluded.updated_at,
                bookmark_icon_sources.updated_at + interval '1 microsecond')
      `.execute(transaction);
    },
  } satisfies BookmarkIconSourceWritePort);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505';
}

/**
 * Batch icon-source mode lookup for the shared/public read surfaces. A missing
 * row is the virtual `inherit` state and is deliberately omitted from the map
 * so consumers keep the pre-FO-01 behavior for untouched bookmarks.
 */
export function createPostgresFaviconSourceModeReadPort(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
): { findModesByNodeIds(nodeIds: readonly string[]): Promise<ReadonlyMap<string, IconSourceMode>> } {
  return Object.freeze({
    async findModesByNodeIds(nodeIds) {
      if (nodeIds.length === 0) return new Map();
      const rows = await db
        .selectFrom('bookmark_icon_sources')
        .select(['node_id', 'source_mode'])
        .where('node_id', 'in', [...nodeIds])
        .execute();
      return new Map(rows.map((row) => [row.node_id, row.source_mode]));
    },
  });
}

/**
 * FO-02: does any non-owner member read this collection? A private collection
 * with a member is shared-readable; only unshared private online bookmarks
 * expose the provider directUrl.
 */
export function createPostgresFaviconSourceMembershipPort(
  transaction: DatabaseTransaction,
): FaviconSourceMembershipReadPort {
  return Object.freeze({
    async hasNonOwnerMember(collectionId: string, ownerSubjectId: string) {
      const row = (await sql<{ exists: boolean }>`
        select exists (
          select 1 from collection_members
          where collection_id = ${collectionId} and subject_id <> ${ownerSubjectId}
        ) as exists
      `.execute(transaction)).rows[0];
      return row?.exists === true;
    },
  });
}