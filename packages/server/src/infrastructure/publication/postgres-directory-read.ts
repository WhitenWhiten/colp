import type { PoolClient } from 'pg';
import {
  PublicationDirectoryAnchorNotFoundError,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryReadRequest,
  type PublicationDirectoryRecord,
} from '../../modules/publication/index.js';
import {
  COLLECTION_DISCOVERY_CONTROL_SQL,
  accountRestrictPublicationExistsSql,
  collectionPublicVisibleNodeCountSql,
} from '../database/collection-control-sql.js';
import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';

interface DirectoryRow {
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  kind: PublicationDirectoryRecord['kind'];
  visibility: PublicationDirectoryRecord['visibility'];
  publication_slug: string;
  tags: unknown;
  language: unknown;
  node_count: string | number;
  updated_at: Date;
  ordering_updated_at_micros: string;
  protected_authorized: boolean;
}

/** Catalog tags live in extensions after Canonical materialize; root tags are a one-line fallback. */
export const COLLECTION_CATALOG_TAGS_INDEX_SQL =
  `coalesce(case when jsonb_typeof(payload_json->'extensions'->'tags') = 'array' then payload_json->'extensions'->'tags' end, case when jsonb_typeof(payload_json->'tags') = 'array' then payload_json->'tags' end, '[]'::jsonb)`;

export const COLLECTION_CATALOG_TAGS_SQL =
  COLLECTION_CATALOG_TAGS_INDEX_SQL.replaceAll('payload_json', 'c.payload_json');

export const COLLECTION_CATALOG_LANGUAGE_SQL =
  `coalesce(nullif(c.payload_json->'extensions'->>'language', ''), nullif(c.payload_json->>'language', ''))`;

export function createPostgresPublicationNodeCountReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): {
  loadByPublicationSlug(publicationSlug: string): Promise<number | null>;
} {
  return Object.freeze({
    async loadByPublicationSlug(publicationSlug: string) {
      const result = await runtime.pool.query<{ live_node_count: string | number }>(
        `select ${collectionPublicVisibleNodeCountSql('c')} as live_node_count
           from collections c
          where publication_slug = $1
          limit 1`,
        [publicationSlug],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const nodeCount = Number(row.live_node_count);
      if (!Number.isSafeInteger(nodeCount) || nodeCount < 0) {
        throw new Error('Publication Directory node count is invalid');
      }
      return nodeCount;
    },
  });
}

export function createPostgresPublicationDirectoryReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): PublicationDirectoryReadPort {
  return Object.freeze({
    async loadPage(request: PublicationDirectoryReadRequest) {
      validateRequest(request);
      const client = await runtime.pool.connect();
      try {
        // The exact backend PID (only when the request is abortable) enables a
        // controlled pg_cancel_backend on abort.
        const pid = await readBackendPid(client, request.signal);
        const cancel = async (): Promise<void> => {
          if (pid !== undefined) await runtime.cancelBackend(pid);
        };
        const anchorId = request.after
          ? await withPostgresAbort(
            resolveAnchorId(client, request.after.idLocator),
            request.signal,
            cancel,
          )
          : undefined;
        const statement = buildPublicationDirectoryStatement(request, anchorId);
        const result = await withPostgresAbort(
          client.query<DirectoryRow>(statement.text, [...statement.values]),
          request.signal,
          cancel,
        );
        return Object.freeze(result.rows.map(mapRecord));
      } finally {
        client.release();
      }
    },
  });
}

export interface PublicationDirectoryStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Builds the exact wide SELECT used by production and PostgreSQL plan evidence. */
export function buildPublicationDirectoryStatement(
  request: PublicationDirectoryReadRequest,
  anchorId?: string,
): PublicationDirectoryStatement {
  validateRequest(request);
  if ((request.after === undefined) !== (anchorId === undefined)) {
    throw new TypeError('Publication Directory anchor must match the continuation');
  }
  const values: unknown[] = [];
  const parameter = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const subjectId = request.principal === 'anonymous' ? undefined : request.principal.subjectId;
  const visibility = subjectId === undefined
    ? `c.visibility = 'public'`
    : `(c.visibility = 'public' or (
         c.visibility = 'protected' and (
           c.owner_subject_id = ${parameter(subjectId)}
           or exists (select 1 from collection_members member
                       where member.collection_id = c.id and member.subject_id = ${parameter(subjectId)})
         )
       ))`;
  const filters = [
    'c.deleted_at is null',
    'c.publication_slug is not null',
    'c.published_at is not null',
    visibility,
    COLLECTION_DISCOVERY_CONTROL_SQL,
  ];
  const creatorParameter = request.filter.creator ? parameter(request.filter.creator) : undefined;
  if (subjectId === undefined) {
    // Account publication restriction is an owner-level control. Keep the
    // subject-id join optional (legacy rows may have no account row), but if
    // an account exists its active restriction must remove the collection from
    // every anonymous directory page and cursor traversal. Member reads keep
    // their existing protected collection semantics.
    filters.push(`not exists (select 1 from accounts directory_owner
                              where directory_owner.subject_id = ${creatorParameter ?? 'c.owner_subject_id'}
                                and ${accountRestrictPublicationExistsSql('directory_owner.id')})`);
  }
  if (request.filter.tag) {
    // jsonb_exists ('?') returns true for scalar-string tags, so the array-only guard
    // keeps malformed scalar/object payloads out of tag matches.
    filters.push(`jsonb_typeof(${COLLECTION_CATALOG_TAGS_SQL}) = 'array'`);
    filters.push(`${COLLECTION_CATALOG_TAGS_SQL} ? ${parameter(request.filter.tag)}`);
  }
  if (creatorParameter) filters.push(`c.owner_subject_id = ${creatorParameter}`);
  if (request.filter.kind) filters.push(`c.kind = ${parameter(request.filter.kind)}`);
  if (request.filter.updatedSince) filters.push(`c.updated_at >= ${parameter(request.filter.updatedSince)}::timestamptz`);
  if (request.filter.q) {
    const q = parameter(escapeLikePattern(request.filter.q));
    filters.push(`c.directory_search_text like '%' || ${q} || '%' escape '\\'`);
  }
  if (request.after && anchorId) {
    const updatedAt = parameter(request.after.orderingUpdatedAtMicros);
    const id = parameter(anchorId);
    const exactTimestamp = `(timestamp with time zone 'epoch'
      + (${updatedAt}::bigint / 1000000) * interval '1 second'
      + (${updatedAt}::bigint % 1000000) * interval '1 microsecond')`;
    // Keep the timestamp range as a standalone index condition. The equivalent
    // top-level OR makes PostgreSQL choose BitmapOr + Sort on sparse final pages.
    filters.push(`c.updated_at <= ${exactTimestamp}`);
    filters.push(`(c.updated_at < ${exactTimestamp} or c.id collate "C" > ${id}::text collate "C")`);
  }
  const limit = parameter(request.limit + 1);
  return Object.freeze({
    text: `select c.id, c.owner_subject_id, c.title, c.summary, c.kind, c.visibility,
                  c.publication_slug,
                  ${COLLECTION_CATALOG_TAGS_SQL} as tags,
                  ${COLLECTION_CATALOG_LANGUAGE_SQL} as language,
                  ${collectionPublicVisibleNodeCountSql('c')} as node_count,
                  c.updated_at,
                  (extract(epoch from c.updated_at) * 1000000)::bigint::text as ordering_updated_at_micros,
                  case when c.visibility = 'protected' then ${subjectId === undefined ? 'false' : 'true'} else false end as protected_authorized
             from collections c
            where ${filters.join(' and ')}
            order by c.updated_at desc, c.id collate "C" asc
            limit ${limit}`,
    values: Object.freeze(values),
  });
}

/** Escapes LIKE wildcards so user input always matches as literal data (trigram-friendly). */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

async function resolveAnchorId(client: PoolClient, locator: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select id from collections
      where publication_locator_sha256_128(id) = $1`,
    [locator],
  );
  if (result.rows.length !== 1) throw new PublicationDirectoryAnchorNotFoundError();
  return result.rows[0]!.id;
}

function validateRequest(request: PublicationDirectoryReadRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500) {
    throw new RangeError('Publication Directory read limit must be between 1 and 500');
  }
  if (request.after && (!/^-?\d{1,20}$/u.test(request.after.orderingUpdatedAtMicros) || !/^[0-9a-f]{32}$/u.test(request.after.idLocator))) {
    throw new TypeError('Publication Directory continuation is invalid');
  }
}

function mapRecord(row: DirectoryRow): PublicationDirectoryRecord {
  const tags = Array.isArray(row.tags)
    // The COLP DirectoryCollection wire schema requires unique tags, so a stored
    // payload with duplicate string tags deduplicates at the read boundary.
    ? [...new Set(row.tags.filter((tag): tag is string => typeof tag === 'string'))]
    : [];
  const nodeCount = Number(row.node_count);
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0) throw new Error('Publication Directory node count is invalid');
  return Object.freeze({
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    visibility: row.visibility,
    publicationSlug: row.publication_slug,
    tags: Object.freeze(tags),
    language: typeof row.language === 'string' && row.language !== '' ? row.language : null,
    nodeCount,
    updatedAt: row.updated_at.toISOString(),
    orderingUpdatedAtMicros: row.ordering_updated_at_micros,
    protectedAuthorized: row.protected_authorized,
  });
}
