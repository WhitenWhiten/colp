import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { searchCollectionDiscoverySql } from './collection-discovery-sql.js';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  SEARCH_CANDIDATE_BATCH_LIMIT,
  SEARCH_MAX_TIMEOUT_MS,
  normalizeSearchQuery,
  searchWordSimilarityThreshold,
  type SearchCandidate,
  type SearchCandidatePort,
  type SearchCandidateQuery,
  type SearchCandidateResourceType,
} from '../../modules/search/index.js';
import type { DatabaseSchema } from '../database/index.js';
import {
  accountRestrictPublicationExistsSql,
  bookmarkDiscoveryExistsSql,
} from '../database/collection-control-sql.js';

type AnnotationType = 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom';

interface CandidateRow {
  readonly resource_type: SearchCandidateResourceType;
  readonly resource_id: string;
  readonly collection_id: string | null;
  readonly title: string | null;
  readonly url_host: string | null;
  readonly handle: string | null;
  readonly display_name: string | null;
  readonly subject_type: 'collection' | 'node' | null;
  readonly subject_id: string | null;
  readonly annotation_type: AnnotationType | null;
  readonly snippet_source: string;
  readonly rank: number;
}

const RESOURCE_ORDER: Readonly<Record<SearchCandidateResourceType, number>> = Object.freeze({
  collection: 0,
  node: 1,
  profile: 2,
  annotation: 3,
});

export function createPostgresSearchCandidatePort(
  db: Kysely<DatabaseSchema>,
): SearchCandidatePort {
  const listCandidates = async (input: SearchCandidateQuery) => {
      if (input.signal?.aborted) throw input.signal.reason;
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_CANDIDATE_BATCH_LIMIT) {
        throw new Error('search candidate limit must be an integer between 1 and 100');
      }
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SEARCH_MAX_TIMEOUT_MS) {
        throw new Error('search candidate timeout must be an integer between 1 and 5000 milliseconds');
      }
      if (input.types.length === 0 || new Set(input.types).size !== input.types.length
        || input.types.some((type) => !Object.hasOwn(RESOURCE_ORDER, type))) {
        throw new Error('search candidate types are invalid');
      }
      if (input.projection.kind === 'account'
        && (!input.projection.accountId || !input.projection.principalId || !input.projection.subjectId
          || !input.projection.securityEpoch)) {
        throw new Error('search candidate account projection is invalid');
      }
      const query = normalizeSearchQuery(input.query);
      if (query === null) return { items: [], hasMore: false };
      const wordSimilarityThreshold = searchWordSimilarityThreshold(query);
      const handlePrefixPattern = escapeLikePrefix(query);
      const actorAccountId = input.projection.kind === 'account' ? input.projection.accountId : null;
      const actorPrincipalId = input.projection.kind === 'account' ? input.projection.principalId : null;
      const actorSubjectId = input.projection.kind === 'account' ? input.projection.subjectId : null;
      const actorSecurityEpoch = input.projection.kind === 'account' ? input.projection.securityEpoch : null;
      const verifiedPrincipalId = sql`(SELECT principal_id FROM verified_actor)`;
      const verifiedSubjectId = sql`(SELECT subject_id FROM verified_actor)`;
      // OFFSET 0 keeps this probe on the candidate collection id. Unnested, the
      // planner scans every collection the actor owns or has joined.
      const isCollectionMember = sql`(
        c.owner_subject_id = ${verifiedSubjectId}
        OR EXISTS (
          SELECT 1 FROM collection_members member
          WHERE member.collection_id = c.id
            AND member.subject_id = ${verifiedSubjectId}
          OFFSET 0
        )
      )`;

      const collectionPublicBranch = sql`
        SELECT 'collection'::text AS resource_type, c.id AS resource_id,
          c.id AS collection_id, c.title, NULL::text AS url_host,
          NULL::text AS handle, NULL::text AS display_name,
          NULL::text AS subject_type, NULL::text AS subject_id, NULL::text AS annotation_type,
          coalesce(c.title,'') || ' ' || coalesce(c.summary,'') AS snippet_source,
          greatest(
            public.word_similarity(${query}, c.search_text),
            ts_rank_cd(c.search_vector, plainto_tsquery('english'::regconfig, ${query}))
          ) AS raw_rank
        FROM collections c
        WHERE c.deleted_at IS NULL
          AND c.visibility='public'
          AND c.allow_search_indexing=true
          AND ${sql.raw(searchCollectionDiscoverySql('c'))}
          AND (
            ${query} OPERATOR(public.<%) c.search_text
            OR c.search_vector @@ plainto_tsquery('english'::regconfig, ${query})
          )
      `;
      const collectionMemberBranch = sql`
        WITH search_hits AS MATERIALIZED (
          SELECT c.id, c.title, c.owner_subject_id,
            coalesce(c.title,'') || ' ' || coalesce(c.summary,'') AS snippet_source,
            greatest(
              public.word_similarity(${query}, c.search_text),
              ts_rank_cd(c.search_vector, plainto_tsquery('english'::regconfig, ${query}))
            ) AS raw_rank
          FROM collections c
          WHERE c.deleted_at IS NULL AND c.allow_search_indexing=true
            AND (
              ${query} OPERATOR(public.<%) c.search_text
              OR c.search_vector @@ plainto_tsquery('english'::regconfig, ${query})
            )
        )
        SELECT 'collection'::text AS resource_type, c.id AS resource_id,
          c.id AS collection_id, c.title, NULL::text AS url_host,
          NULL::text AS handle, NULL::text AS display_name,
          NULL::text AS subject_type, NULL::text AS subject_id, NULL::text AS annotation_type,
          c.snippet_source, c.raw_rank
        FROM search_hits c
        WHERE ${isCollectionMember}
      `;
      const nodePublicBranch = sql`
        -- Recall node IDs through the search indexes before joining the tiny
        -- public Collection set; otherwise PostgreSQL can scan every Node in
        -- each Collection and apply the trigram predicate last.
        WITH RECURSIVE search_hits AS MATERIALIZED (
          SELECT n.id
          FROM nodes n
          WHERE n.deleted_at IS NULL
            AND NOT n.is_root
            AND n.visibility='inherit'
            AND (
              ${query} OPERATOR(public.<%) n.search_text
              OR n.search_vector @@ plainto_tsquery('english'::regconfig, ${query})
            )
        ), matched AS MATERIALIZED (
          SELECT 'node'::text AS resource_type, n.id AS resource_id,
            n.collection_id, n.title, n.search_url_host AS url_host,
            NULL::text AS handle, NULL::text AS display_name,
            NULL::text AS subject_type, NULL::text AS subject_id,
            NULL::text AS annotation_type,
            coalesce(n.title,'') || ' ' || coalesce(n.description,'') AS snippet_source,
            greatest(
              public.word_similarity(${query}, n.search_text),
              ts_rank_cd(n.search_vector, plainto_tsquery('english'::regconfig, ${query}))
            ) AS raw_rank,
            n.parent_id AS path_parent_id,
            n.parent_id IS NOT DISTINCT FROM c.root_node_id
              AND root_node.parent_id IS NULL AS direct_root_child,
            root_node.id AS root_id, root_node.deleted_at AS root_deleted_at,
            root_node.visibility AS root_visibility
          FROM search_hits hit
          JOIN nodes n ON n.id=hit.id
          JOIN collections c ON c.id=n.collection_id
          LEFT JOIN nodes root_node
            ON root_node.collection_id=c.id AND root_node.id=c.root_node_id
          WHERE c.deleted_at IS NULL
            AND c.visibility='public'
            AND c.allow_search_indexing=true
            AND ${sql.raw(searchCollectionDiscoverySql('c'))}
            AND NOT ${sql.raw(bookmarkDiscoveryExistsSql('n.id', 'c.id'))}
        ), path_seeds AS MATERIALIZED (
          SELECT DISTINCT collection_id, path_parent_id
            FROM matched
           WHERE NOT direct_root_child
        ), ancestor_walk(
          collection_id,path_parent_id,id,parent_id,visibility,deleted_at,path,depth
        ) AS (
          SELECT seed.collection_id,seed.path_parent_id,p.id,p.parent_id,p.visibility,
                 p.deleted_at,ARRAY[p.id]::text[],1
            FROM path_seeds seed
            JOIN nodes p ON p.collection_id=seed.collection_id AND p.id=seed.path_parent_id
          UNION ALL
          SELECT walk.collection_id,walk.path_parent_id,p.id,p.parent_id,p.visibility,
                 p.deleted_at,walk.path || p.id,walk.depth + 1
            FROM ancestor_walk walk
            JOIN nodes p ON p.collection_id=walk.collection_id AND p.id=walk.parent_id
           WHERE NOT p.id=ANY(walk.path) AND walk.depth < 256
        ), ancestor_flags AS MATERIALIZED (
          SELECT collection_id,path_parent_id,
                 bool_or(deleted_at IS NOT NULL OR visibility IN ('private','protected')
                   OR parent_id=ANY(path) OR (depth=256 AND parent_id IS NOT NULL)) AS restricted
            FROM ancestor_walk
           GROUP BY collection_id,path_parent_id
        )
        SELECT matched.resource_type,matched.resource_id,matched.collection_id,matched.title,
               matched.url_host,matched.handle,matched.display_name,matched.subject_type,
               matched.subject_id,matched.annotation_type,matched.snippet_source,matched.raw_rank
          FROM matched
          LEFT JOIN ancestor_flags flags
            ON flags.collection_id=matched.collection_id
           AND flags.path_parent_id=matched.path_parent_id
         WHERE (
           matched.direct_root_child AND (
             matched.root_id IS NULL OR (
               matched.root_deleted_at IS NULL
               AND matched.root_visibility NOT IN ('private','protected')
             )
           )
         ) OR (
           NOT matched.direct_root_child AND NOT coalesce(flags.restricted,false)
         )
      `;
      const nodeMemberBranch = sql`
        WITH search_hits AS MATERIALIZED (
          SELECT n.id, n.collection_id, n.title, n.search_url_host AS url_host,
            coalesce(n.title,'') || ' ' || coalesce(n.description,'') AS snippet_source,
            greatest(
              public.word_similarity(${query}, n.search_text),
              ts_rank_cd(n.search_vector, plainto_tsquery('english'::regconfig, ${query}))
            ) AS raw_rank
          FROM nodes n
          WHERE n.deleted_at IS NULL AND NOT n.is_root
            AND (
              ${query} OPERATOR(public.<%) n.search_text
              OR n.search_vector @@ plainto_tsquery('english'::regconfig, ${query})
            )
        )
        SELECT 'node'::text AS resource_type, n.id AS resource_id,
          n.collection_id, n.title, n.url_host,
          NULL::text AS handle, NULL::text AS display_name,
          NULL::text AS subject_type, NULL::text AS subject_id, NULL::text AS annotation_type,
          n.snippet_source, n.raw_rank
        FROM search_hits n
        JOIN collections c ON c.id=n.collection_id
        WHERE c.deleted_at IS NULL AND c.allow_search_indexing=true
          AND ${isCollectionMember}
      `;
      const profileBranch = sql`
        SELECT 'profile'::text AS resource_type, h.handle AS resource_id,
          NULL::text AS collection_id, NULL::text AS title, NULL::text AS url_host,
          h.handle AS handle, p.display_name AS display_name,
          NULL::text AS subject_type, NULL::text AS subject_id, NULL::text AS annotation_type,
          h.handle || ' ' || p.display_name AS snippet_source,
          matched.raw_rank
        FROM profile_matches matched
        JOIN accounts a ON a.id=matched.account_id
        JOIN profiles p ON p.account_id=matched.account_id
        JOIN profile_handles h ON h.account_id=matched.account_id AND h.handle=matched.handle
        WHERE a.status = 'active'
          AND a.deleted_at is null
          AND NOT ${sql.raw(accountRestrictPublicationExistsSql('a.id'))}
          AND EXISTS (
            SELECT 1 FROM collections owned
            WHERE owned.owner_subject_id=a.subject_id
              AND owned.deleted_at IS NULL
              AND owned.visibility='public'
              AND owned.allow_search_indexing=true
              AND ${sql.raw(searchCollectionDiscoverySql('owned'))}
          )
      `;
      const annotationPublicBranch = sql`
        WITH RECURSIVE matched AS MATERIALIZED (
          SELECT 'annotation'::text AS resource_type, a.id AS resource_id,
            a.collection_id, NULL::text AS title, NULL::text AS url_host,
            NULL::text AS handle, NULL::text AS display_name,
            a.subject_type, a.subject_id, a.type AS annotation_type,
            a.annotation_search_text AS snippet_source,
            greatest(
              public.word_similarity(${query}, a.annotation_search_text),
              ts_rank_cd(a.annotation_search_vector, plainto_tsquery('simple'::regconfig, ${query}))
            ) AS raw_rank,
            subject_node.id AS subject_node_id,
            subject_node.parent_id AS path_parent_id,
            subject_node.is_root AS subject_is_root,
            subject_node.deleted_at AS subject_deleted_at,
            subject_node.visibility AS subject_visibility
          FROM annotations a
          JOIN collections c ON c.id=a.collection_id
          LEFT JOIN nodes subject_node ON a.subject_type='node'
            AND subject_node.collection_id=a.collection_id AND subject_node.id=a.subject_id
          WHERE a.deleted_at IS NULL
            AND a.type <> 'reading_state'
            AND c.deleted_at IS NULL
            AND c.visibility='public'
            AND c.allow_search_indexing=true
            AND a.visibility='public'
            AND ${sql.raw(searchCollectionDiscoverySql('c'))}
            AND (
              a.subject_type <> 'node'
              OR NOT ${sql.raw(bookmarkDiscoveryExistsSql('a.subject_id', 'a.collection_id'))}
            )
            AND (
              ${query} OPERATOR(public.<%) a.annotation_search_text
              OR a.annotation_search_vector @@ plainto_tsquery('simple'::regconfig, ${query})
            )
        ), path_seeds AS MATERIALIZED (
          SELECT DISTINCT collection_id, path_parent_id
            FROM matched
           WHERE subject_type='node' AND subject_node_id IS NOT NULL
             AND NOT subject_is_root AND subject_deleted_at IS NULL
             AND subject_visibility='inherit'
        ), ancestor_walk(
          collection_id,path_parent_id,id,parent_id,visibility,deleted_at,path,depth
        ) AS (
          SELECT seed.collection_id,seed.path_parent_id,p.id,p.parent_id,p.visibility,
                 p.deleted_at,ARRAY[p.id]::text[],1
            FROM path_seeds seed
            JOIN nodes p ON p.collection_id=seed.collection_id AND p.id=seed.path_parent_id
          UNION ALL
          SELECT walk.collection_id,walk.path_parent_id,p.id,p.parent_id,p.visibility,
                 p.deleted_at,walk.path || p.id,walk.depth + 1
            FROM ancestor_walk walk
            JOIN nodes p ON p.collection_id=walk.collection_id AND p.id=walk.parent_id
           WHERE NOT p.id=ANY(walk.path) AND walk.depth < 256
        ), ancestor_flags AS MATERIALIZED (
          SELECT collection_id,path_parent_id,
                 bool_or(deleted_at IS NOT NULL OR visibility IN ('private','protected')
                   OR parent_id=ANY(path) OR (depth=256 AND parent_id IS NOT NULL)) AS restricted
            FROM ancestor_walk
           GROUP BY collection_id,path_parent_id
        )
        SELECT matched.resource_type,matched.resource_id,matched.collection_id,matched.title,
               matched.url_host,matched.handle,matched.display_name,matched.subject_type,
               matched.subject_id,matched.annotation_type,matched.snippet_source,matched.raw_rank
          FROM matched
          LEFT JOIN ancestor_flags flags
            ON flags.collection_id=matched.collection_id
           AND flags.path_parent_id=matched.path_parent_id
         WHERE (matched.subject_type='collection' AND matched.subject_id=matched.collection_id)
            OR (matched.subject_type='node' AND matched.subject_node_id IS NOT NULL
              AND NOT matched.subject_is_root AND matched.subject_deleted_at IS NULL
              AND matched.subject_visibility='inherit'
              AND NOT coalesce(flags.restricted,false))
      `;
      const annotationMemberBranch = sql`
        -- Recall annotation IDs through the member search indexes before joining
        -- Collection authority; a wide select here can fall back to a heap scan.
        WITH search_hits AS MATERIALIZED (
          SELECT a.id
          FROM annotations a
          WHERE a.deleted_at IS NULL AND a.type <> 'reading_state'
            AND ${query} OPERATOR(public.<%) a.annotation_search_text
          UNION
          SELECT a.id
          FROM annotations a
          WHERE a.deleted_at IS NULL AND a.type <> 'reading_state'
            AND a.annotation_search_vector @@ plainto_tsquery('simple'::regconfig, ${query})
        )
        SELECT 'annotation'::text AS resource_type, a.id AS resource_id,
          a.collection_id, NULL::text AS title, NULL::text AS url_host,
          NULL::text AS handle, NULL::text AS display_name,
          a.subject_type, a.subject_id, a.type AS annotation_type,
          a.annotation_search_text AS snippet_source,
          greatest(
            public.word_similarity(${query}, a.annotation_search_text),
            ts_rank_cd(a.annotation_search_vector, plainto_tsquery('simple'::regconfig, ${query}))
          ) AS raw_rank
        FROM search_hits hit
        JOIN annotations a ON a.id=hit.id
        JOIN collections c ON c.id=a.collection_id
        WHERE c.deleted_at IS NULL AND c.allow_search_indexing=true
          AND ${isCollectionMember}
          AND (a.visibility <> 'private' OR a.creator_principal_id=${verifiedPrincipalId})
      `;

      const after = input.after;
      if (after && (!isNormalizedSearchRank(after.rank)
        || !Object.hasOwn(RESOURCE_ORDER, after.resourceType)
        || after.resourceId.length === 0)) {
        throw new Error('search candidate continuation tuple is invalid');
      }
      const afterResourceOrder = after ? RESOURCE_ORDER[after.resourceType] : null;
      const continuation = after
        ? sql`(
            scored.rank < ${after.rank}::double precision
            OR (scored.rank = ${after.rank}::double precision
              AND scored.resource_order > ${afterResourceOrder}::integer)
            OR (scored.rank = ${after.rank}::double precision
              AND scored.resource_order = ${afterResourceOrder}::integer
              AND scored.resource_id COLLATE "C" > ${after.resourceId} COLLATE "C")
          )`
        : sql`true`;

      // Each branch runs the recall for one resource type and one authorization side
      // (public or member), applies the shared continuation, the type filter, the
      // positive-rank filter, the tie keys and a per-branch LIMIT. The branch keeps at
      // most limit+1 rows, so the UNION that follows stays bounded.
      const rankedBranch = (
        name: string,
        branch: RawBuilder<unknown>,
      ): RawBuilder<unknown> => sql`${sql.raw(name)} AS (
          SELECT scored.* FROM (
            SELECT inner_branch.*,
              round(least(1.0,greatest(0.0,raw_rank))::numeric,6)::double precision AS rank,
              CASE resource_type
                WHEN 'collection' THEN 0
                WHEN 'node' THEN 1
                WHEN 'profile' THEN 2
                WHEN 'annotation' THEN 3
                ELSE 2147483647
              END AS resource_order
            FROM (${branch}) inner_branch
            WHERE raw_rank > 0
              AND resource_type = ANY(${input.types}::text[])
          ) scored
          WHERE ${continuation}
          ORDER BY rank DESC, resource_order ASC, resource_id COLLATE "C" ASC
          LIMIT ${input.limit + 1}
        )`;

      const accountSearch = input.projection.kind === 'account';
      const requestedTypes = new Set(input.types);
      const recallBranches: ReadonlyArray<readonly [string, RawBuilder<unknown>, SearchCandidateResourceType, boolean]> = [
        ['branch_collection_public', collectionPublicBranch, 'collection', false],
        ['branch_node_public', nodePublicBranch, 'node', false],
        ['branch_profile', profileBranch, 'profile', false],
        ['branch_annotation_public', annotationPublicBranch, 'annotation', false],
        ['branch_collection_member', collectionMemberBranch, 'collection', true],
        ['branch_node_member', nodeMemberBranch, 'node', true],
        ['branch_annotation_member', annotationMemberBranch, 'annotation', true],
      ];
      const selectedBranches = recallBranches.filter(([, , type, member]) =>
        requestedTypes.has(type) && (!member || accountSearch));
      const branchCtes = selectedBranches.map(([name, branch]) => rankedBranch(name, branch));
      const branchNames = selectedBranches.map(([name]) => name);
      const wantsMember = selectedBranches.some((entry) => entry[3]);
      const candidateArm = (name: string): RawBuilder<unknown> =>
        sql`SELECT * FROM ${sql.raw(name)}`;
      const candidatesCte = sql`candidates AS (
          ${sql.join(branchNames.map(candidateArm), sql` UNION ALL `)}
        )`;
      const scoredCte = sql`scored AS (
          SELECT DISTINCT ON (resource_type, resource_id) resource_type,resource_id,collection_id,title,url_host,handle,display_name,
            subject_type,subject_id,annotation_type,snippet_source,rank,resource_order
          FROM candidates
          ORDER BY resource_type, resource_id, rank DESC
        )`;
      const leadingCtes: RawBuilder<unknown>[] = [];
      if (wantsMember) {
        leadingCtes.push(sql`verified_actor AS MATERIALIZED (
          SELECT a.id AS principal_id,a.subject_id
          FROM accounts a
          WHERE ${accountSearch}::boolean
            AND a.id=${actorAccountId}::text AND a.id=${actorPrincipalId}::text
            AND a.subject_id=${actorSubjectId}::text
            AND a.security_epoch::text=${actorSecurityEpoch}::text
            AND a.status='active' AND a.deleted_at IS NULL
        )`);
      }
      if (requestedTypes.has('profile')) {
        leadingCtes.push(sql`profile_hits AS (
          SELECT h.account_id,h.handle,
            greatest(
              CASE WHEN h.search_handle COLLATE "C" = ${query} COLLATE "C" THEN 1.0 ELSE 0.0 END,
              CASE WHEN h.search_handle COLLATE "C" LIKE ${handlePrefixPattern} ESCAPE '\\' THEN 0.92 ELSE 0.0 END,
              public.word_similarity(${query}, h.search_handle) * 0.9
            ) AS raw_rank
          FROM profile_handles h
          WHERE h.search_handle COLLATE "C" = ${query} COLLATE "C"
            OR h.search_handle COLLATE "C" LIKE ${handlePrefixPattern} ESCAPE '\\'
            OR h.search_handle OPERATOR(public.%) ${query}
          UNION ALL
          SELECT p.account_id,h.handle,
            greatest(
              CASE WHEN p.search_display_name = ${query} THEN 1.0 ELSE 0.0 END,
              public.word_similarity(${query}, p.search_display_name) * 0.82,
              least(0.82, ts_rank_cd(p.search_display_vector,
                plainto_tsquery('simple'::regconfig, ${query})))
            ) AS raw_rank
          FROM profiles p JOIN profile_handles h ON h.account_id=p.account_id
          WHERE ${query} OPERATOR(public.<%) p.search_display_name
            OR p.search_display_vector @@ plainto_tsquery('simple'::regconfig, ${query})
        )`, sql`profile_matches AS (
          SELECT account_id,handle,max(raw_rank) AS raw_rank
          FROM profile_hits GROUP BY account_id,handle
        )`);
      }
      const candidateQuery = sql<CandidateRow>`WITH ${sql.join(
        [...leadingCtes, ...branchCtes, candidatesCte, scoredCte],
        sql`, `,
      )}
        SELECT resource_type,resource_id,collection_id,title,url_host,handle,display_name,
          subject_type,subject_id,annotation_type,
          search_strip_unsafe_text(snippet_source) AS snippet_source,rank
        FROM scored
        WHERE ${continuation}
          AND scored.resource_type = ANY(${input.types}::text[])
        ORDER BY rank DESC, resource_order ASC, resource_id COLLATE "C" ASC
        LIMIT ${input.limit + 1}`;

      const result = await db.transaction().execute(async (transaction) => {
        await sql<{ backend_pid: number }>`SELECT pg_backend_pid() AS backend_pid,
          set_config('pg_trgm.word_similarity_threshold',${wordSimilarityThreshold},true),
          set_config('statement_timeout',${`${input.timeoutMs}ms`},true)`.execute(transaction);
        if (input.signal?.aborted) throw input.signal.reason;
        const disposeCancellation = input.signal
          ? await installPostgresTransactionCancellation(transaction, input.signal) : undefined;
        try {
          const queryResult = await candidateQuery.execute(transaction);
          if (input.signal?.aborted) {
            throw input.signal.reason;
          }
          return queryResult;
        } catch (error: unknown) {
          if (input.signal?.aborted) {
            throw input.signal.reason;
          }
          throw error;
        } finally {
          await disposeCancellation?.();
        }
      });

      const hasMore = result.rows.length > input.limit;
      const items = result.rows.slice(0, input.limit).map(mapCandidate);
      if (input.signal?.aborted) throw input.signal.reason;
      return { items, hasMore };
    };
  return {
    listCandidates,
    listAnonymousCandidates(input) {
      return listCandidates({ ...input, types: ['collection', 'node', 'profile', 'annotation'],
        projection: { kind: 'anonymous' }, timeoutMs: SEARCH_MAX_TIMEOUT_MS });
    },
  };
}

function mapCandidate(row: CandidateRow): SearchCandidate {
  const rank = Number(row.rank);
  if (!isNormalizedSearchRank(rank)) {
    throw new Error('PostgreSQL returned an invalid normalized search rank');
  }
  if (typeof row.snippet_source !== 'string' || [...row.snippet_source].length > 1024
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(row.snippet_source)) {
    throw new Error('PostgreSQL returned an invalid search snippet source');
  }
  const base = {
    resourceId: row.resource_id,
    snippetSource: row.snippet_source,
    rank,
    exclusive: { rank, resourceType: row.resource_type, resourceId: row.resource_id },
  } as const;
  switch (row.resource_type) {
    case 'collection':
      if (row.collection_id !== row.resource_id || row.title === null) return invalidRow();
      return { ...base, resourceType: 'collection', collectionId: row.collection_id,
        title: row.title, urlHost: null };
    case 'node':
      if (row.collection_id === null || row.title === null) return invalidRow();
      return { ...base, resourceType: 'node', collectionId: row.collection_id,
        title: row.title, urlHost: row.url_host };
    case 'profile':
      if (row.collection_id !== null || row.handle !== row.resource_id || row.display_name === null) return invalidRow();
      return { ...base, resourceType: 'profile', collectionId: null,
        handle: row.handle, displayName: row.display_name };
    case 'annotation':
      if (row.collection_id === null || row.subject_type === null || row.subject_id === null
        || row.annotation_type === null) return invalidRow();
      return { ...base, resourceType: 'annotation', collectionId: row.collection_id,
        subjectType: row.subject_type, subjectId: row.subject_id, annotationType: row.annotation_type };
    default:
      return invalidRow();
  }
}

function invalidRow(): never {
  throw new Error('PostgreSQL returned an invalid discriminated search candidate');
}

function escapeLikePrefix(value: string): string {
  return `${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function isNormalizedSearchRank(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1
    && Number(value.toFixed(6)) === value;
}
