import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
import { createPostgresSearchAuthorityPort } from './postgres-search-authority.js';
import {
  SEARCH_CANDIDATE_BATCH_LIMIT,
  type AnonymousSearchCandidateQuery,
  type SearchCandidate,
  type SearchCandidateExclusiveTuple,
  type SearchCandidatePage,
  type SearchCandidatePort,
  type SearchCandidateQuery,
  type SearchCandidateResourceType,
  type SearchCursorSignerPort,
} from '../../modules/search/index.js';
import type {
  NodesSearchCardPort,
  NodesSearchLinkHealth,
  NodesSearchPorts,
} from '../../modules/mcp/index.js';
import type { SharedExposureFactsPort } from '../../modules/exposure/index.js';

const TYPE_ORDER: Readonly<Record<SearchCandidateResourceType, number>> = Object.freeze({
  collection: 0,
  node: 1,
  profile: 2,
  annotation: 3,
});
const LINK_HEALTH = new Set<NodesSearchLinkHealth>(['pending', 'healthy', 'redirect', 'broken']);
const RANK = 1;

interface HitRow {
  readonly type_order: number;
  readonly resource_type: 'node' | 'annotation';
  readonly resource_id: string;
  readonly collection_id: string;
  readonly title: string | null;
  readonly subject_id: string | null;
  readonly annotation_type: SearchCandidate extends { annotationType: infer T } ? T : string | null;
  readonly snippet_source: string;
}

interface AncestorRow {
  readonly origin_id: string;
  readonly collection_id: string;
  readonly title: string | null;
  readonly is_root: boolean;
  readonly depth: number;
}

interface HealthRow {
  readonly node_id: string;
  readonly collection_id: string;
  readonly status: string;
}

export function createPostgresNodesSearchPorts(input: {
  readonly db: Kysely<DatabaseSchema>;
  readonly sharedExposure: SharedExposureFactsPort;
  readonly cursors: SearchCursorSignerPort;
  readonly clock?: { now(): Date };
}): NodesSearchPorts {
  return Object.freeze({
    search: Object.freeze({
      authority: createPostgresSearchAuthorityPort(input.db),
      cursors: input.cursors,
      clock: input.clock ?? { now: () => new Date() },
      sharedExposure: input.sharedExposure,
    }),
    candidatesFor: (collectionId?: string) => createPostgresNodesSearchCandidatePort(input.db, collectionId),
    cards: createPostgresNodesSearchCardPort(input.db),
  });
}

export function createPostgresNodesSearchCandidatePort(
  db: Kysely<DatabaseSchema>,
  collectionId?: string,
): SearchCandidatePort {
  return Object.freeze({
    listAnonymousCandidates: (query: AnonymousSearchCandidateQuery) => listHits(db, {
      query: query.query,
      limit: query.limit,
      types: ['node', 'annotation'],
      collectionId,
    }),
    listCandidates: (query: SearchCandidateQuery) => listHits(db, {
      query: query.query,
      limit: query.limit,
      types: query.types,
      after: query.after,
      signal: query.signal,
      collectionId,
    }),
  });
}

export function createPostgresNodesSearchCardPort(db: Kysely<DatabaseSchema>): NodesSearchCardPort {
  return Object.freeze({
    async load(nodes: readonly { readonly id: string; readonly collectionId: string }[]) {
      if (nodes.length === 0) return Object.freeze([]);
      const requested = JSON.stringify(nodes.map((node: { readonly id: string; readonly collectionId: string }) => ({ id: node.id, collection_id: node.collectionId })));
      const ancestors = await sql<AncestorRow>`
        WITH RECURSIVE walk AS (
          SELECT child.id AS origin_id, parent.collection_id, parent.title, parent.is_root,
                 parent.parent_id, 1 AS depth
          FROM jsonb_to_recordset(${requested}::jsonb) AS requested(id text, collection_id text)
          JOIN nodes child ON child.id = requested.id AND child.collection_id = requested.collection_id
          JOIN nodes parent ON parent.collection_id = child.collection_id AND parent.id = child.parent_id
          UNION ALL
          SELECT walk.origin_id, parent.collection_id, parent.title, parent.is_root,
                 parent.parent_id, walk.depth + 1
          FROM walk
          JOIN nodes parent ON parent.collection_id = walk.collection_id AND parent.id = walk.parent_id
          WHERE walk.is_root = false AND walk.parent_id IS NOT NULL AND walk.depth < 64
        )
        SELECT origin_id, collection_id, title, is_root, depth FROM walk
      `.execute(db);
      const health = await sql<HealthRow>`
        SELECT h.node_id, h.collection_id, h.status
        FROM collection_link_health h
        JOIN jsonb_to_recordset(${requested}::jsonb) AS requested(id text, collection_id text)
          ON h.node_id = requested.id AND h.collection_id = requested.collection_id
      `.execute(db);
      const paths = new Map<string, AncestorRow[]>();
      for (const row of ancestors.rows) {
        const key = cardKey(row.collection_id, row.origin_id);
        const list = paths.get(key);
        if (list === undefined) paths.set(key, [row]);
        else list.push(row);
      }
      const statuses = new Map(health.rows.map((row) => [cardKey(row.collection_id, row.node_id), row.status]));
      return Object.freeze(nodes.map((node: { readonly id: string; readonly collectionId: string }) => {
        const key = cardKey(node.collectionId, node.id);
        const status = statuses.get(key);
        return Object.freeze({
          id: node.id,
          collectionId: node.collectionId,
          folderPath: folderPath(paths.get(key) ?? []),
          linkHealth: status !== undefined && LINK_HEALTH.has(status as NodesSearchLinkHealth)
            ? status as NodesSearchLinkHealth
            : null,
        });
      }));
    },
  });
}

async function listHits(
  db: Kysely<DatabaseSchema>,
  input: {
    readonly query: string;
    readonly limit: number;
    readonly types: readonly SearchCandidateResourceType[];
    readonly after?: SearchCandidateExclusiveTuple;
    readonly signal?: AbortSignal;
    readonly collectionId?: string;
  },
): Promise<SearchCandidatePage> {
  if (input.signal?.aborted) throw input.signal.reason;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_CANDIDATE_BATCH_LIMIT) {
    throw new Error('search candidate limit must be an integer between 1 and 100');
  }
  if (input.query.length === 0) return { items: [], hasMore: false };
  const after = input.after?.rank === RANK ? input.after : undefined;
  if (input.after !== undefined && input.after.rank < RANK) return { items: [], hasMore: false };
  const includeNodes = input.types.includes('node');
  const includeAnnotations = input.types.includes('annotation');
  const afterOrder = after === undefined ? null : TYPE_ORDER[after.resourceType];
  const afterId = after?.resourceId ?? '';
  const result = await sql<HitRow>`
    WITH node_hits AS (
      SELECT 1 AS type_order, 'node'::text AS resource_type, n.id AS resource_id, n.collection_id,
             coalesce(n.title, n.id) AS title, NULL::text AS subject_id, NULL::text AS annotation_type,
             left(coalesce(n.title, ''), 1024) AS snippet_source
      FROM nodes n
      WHERE ${includeNodes}::boolean
        AND n.deleted_at IS NULL AND NOT n.is_root
        AND (${input.collectionId ?? null}::text IS NULL OR n.collection_id = ${input.collectionId ?? null})
        AND (
          strpos(lower(normalize(coalesce(n.title, ''), NFKC)), ${input.query}) > 0
          OR strpos(lower(normalize(coalesce(n.description, ''), NFKC)), ${input.query}) > 0
          OR strpos(lower(normalize(coalesce(n.url, ''), NFKC)), ${input.query}) > 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(n.tags) = 'array' THEN n.tags ELSE '[]'::jsonb END
            ) AS tag(value)
            WHERE strpos(lower(normalize(tag.value, NFKC)), ${input.query}) > 0
          )
        )
    ), annotation_hits AS (
      SELECT 3 AS type_order, 'annotation'::text AS resource_type, a.id AS resource_id, a.collection_id,
             NULL::text AS title, a.subject_id, a.type AS annotation_type,
             left(coalesce(a.annotation_search_text, ''), 1024) AS snippet_source
      FROM annotations a
      WHERE ${includeAnnotations}::boolean
        AND a.deleted_at IS NULL AND a.type <> 'reading_state' AND a.subject_type = 'node'
        AND (${input.collectionId ?? null}::text IS NULL OR a.collection_id = ${input.collectionId ?? null})
        AND strpos(lower(coalesce(a.annotation_search_text, '')), ${input.query}) > 0
    ), hits AS (
      SELECT * FROM node_hits UNION ALL SELECT * FROM annotation_hits
    )
    SELECT type_order, resource_type, resource_id, collection_id, title, subject_id, annotation_type, snippet_source
    FROM hits
    WHERE ${afterOrder}::int IS NULL
       OR type_order > ${afterOrder}::int
       OR (type_order = ${afterOrder}::int AND resource_id COLLATE "C" > ${afterId} COLLATE "C")
    ORDER BY type_order, resource_id COLLATE "C"
    LIMIT ${input.limit + 1}
  `.execute(db, input.signal === undefined ? undefined : {
    signal: input.signal,
    inflightQueryAbortStrategy: 'cancel query',
  });
  const page = result.rows.slice(0, input.limit).flatMap(toCandidate);
  return { items: page, hasMore: result.rows.length > input.limit };
}

function toCandidate(row: HitRow): readonly SearchCandidate[] {
  if (row.resource_type === 'node') {
    const title = row.title && row.title.length > 0 ? row.title : row.resource_id;
    return [Object.freeze({
      resourceType: 'node',
      resourceId: row.resource_id,
      collectionId: row.collection_id,
      title,
      urlHost: null,
      snippetSource: row.snippet_source || title,
      rank: RANK,
      exclusive: Object.freeze({ rank: RANK, resourceType: 'node', resourceId: row.resource_id }),
    })];
  }
  if (row.subject_id === null || !isAnnotationType(row.annotation_type)) return [];
  return [Object.freeze({
    resourceType: 'annotation',
    resourceId: row.resource_id,
    collectionId: row.collection_id,
    subjectType: 'node',
    subjectId: row.subject_id,
    annotationType: row.annotation_type,
    snippetSource: row.snippet_source || row.subject_id,
    rank: RANK,
    exclusive: Object.freeze({ rank: RANK, resourceType: 'annotation', resourceId: row.resource_id }),
  })];
}

function isAnnotationType(value: string | null): value is 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom' {
  return value === 'note' || value === 'summary' || value === 'tldr'
    || value === 'highlight' || value === 'rating' || value === 'custom';
}

function folderPath(rows: readonly AncestorRow[]): string {
  const titles = [...rows]
    .filter((row) => row.is_root !== true)
    .sort((left, right) => right.depth - left.depth)
    .map((row) => row.title ?? '')
    .filter((title) => title.length > 0);
  return `/${titles.join('/')}`;
}

function cardKey(collectionId: string, id: string): string {
  return `${collectionId}\0${id}`;
}
