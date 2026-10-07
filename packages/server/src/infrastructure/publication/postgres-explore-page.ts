import {
  EXPLORE_PREFERENCE_SCAN_ROW_BUDGET,
  publishingInsightsWindowBounds,
  type ExplorePageReadPort,
  type ExplorePageReadRequest,
  type ExplorePageRecord,
  type ExplorePageSort,
} from '../../modules/publication/index.js';
import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';
import { COLLECTION_DELIST_CONTROL_SQL, collectionHidePublicExistsSql, collectionVisibleNodeCountSql } from '../governance/collection-control-sql.js';
import {
  COLLECTION_CATALOG_LANGUAGE_SQL,
  COLLECTION_CATALOG_TAGS_SQL,
  escapeLikePattern,
} from './postgres-directory-read.js';
import { explorePreferenceHiddenSql } from './postgres-explore-preference.js';

const KINDS = new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']);

interface ExploreRow {
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  kind: string;
  visibility: string;
  publication_slug: string;
  tags: unknown;
  language: unknown;
  owner_account_id?: string;
  node_count: string | number;
  ordering_node_count: string | number;
  preference_hidden?: boolean;
  hidden_public: boolean;
  view_count: string | number | bigint;
  updated_at: Date;
  ordering_updated_at_micros: string;
}

export interface ExplorePageStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export function createPostgresExplorePageReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): ExplorePageReadPort {
  return Object.freeze({
    async loadPage(request: ExplorePageReadRequest) {
      validateRequest(request);
      const window = publishingInsightsWindowBounds(new Date());
      const client = await runtime.pool.connect();
      try {
        const pid = await readBackendPid(client, request.signal);
        const cancel = async (): Promise<void> => {
          if (pid !== undefined) await runtime.cancelBackend(pid);
        };
        const statement = buildExplorePageStatement(request, window);
        const result = await withPostgresAbort(
          client.query<ExploreRow>(statement.text, [...statement.values]),
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

/** Builds the Explore page SELECT used by production and PostgreSQL evidence. */
export function buildExplorePageStatement(
  request: ExplorePageReadRequest,
  window: { readonly fromDayInclusive: string; readonly toDayExclusive: string },
): ExplorePageStatement {
  validateRequest(request);
  const values: unknown[] = [];
  const parameter = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const fromDay = parameter(window.fromDayInclusive);
  const toDay = parameter(window.toDayExclusive);
  const pageSize = request.catalogPreference
    ? (request.scanBudget ?? EXPLORE_PREFERENCE_SCAN_ROW_BUDGET)
    : request.limit;
  const filters = [
    'c.deleted_at is null',
    'c.publication_slug is not null',
    'c.published_at is not null',
    `c.visibility = 'public'`,
    COLLECTION_DELIST_CONTROL_SQL,
  ];
  if (request.filter.tag) {
    filters.push(`jsonb_typeof(${COLLECTION_CATALOG_TAGS_SQL}) = 'array'`);
    filters.push(`${COLLECTION_CATALOG_TAGS_SQL} ? ${parameter(request.filter.tag)}`);
  }
  if (request.filter.q) {
    const q = parameter(escapeLikePattern(request.filter.q.toLocaleLowerCase('en-US')));
    filters.push(`c.directory_search_text like '%' || ${q} || '%' escape '\\'`);
  }
  if (request.filter.language) {
    filters.push(`${COLLECTION_CATALOG_LANGUAGE_SQL} = ${parameter(request.filter.language)}`);
  }
  if (request.sort === 'popular') {
    const keysets = popularKeysetPredicates(request, parameter);
    const limit = parameter(pageSize + 1);
    const hiddenSql = preferenceHiddenSelect(request, 'ranked', parameter);
    // One 30-day collection-view aggregate per statement. Viewed and zero-view
    // collections are paged independently, then at most 2*(page size + 1) rows
    // are merged. This preserves zero-view ordering without LEFT JOIN + GROUP BY
    // over every public collection on every request.
    return Object.freeze({
      text: `with view_counts as materialized (
               select d.collection_id, sum(d.count)::bigint as view_count
                 from publication_insight_daily d
                where d.event_type = 'collection_view'
                  and d.node_id = ''
                  and d.day >= ${fromDay}::date
                  and d.day < ${toDay}::date
                group by d.collection_id
             ), viewed_page as materialized (
               select c.id, c.owner_subject_id, c.title, c.summary, c.kind, c.visibility,
                      c.publication_slug, ${COLLECTION_CATALOG_TAGS_SQL} as tags, ${COLLECTION_CATALOG_LANGUAGE_SQL} as language,
                      ${collectionVisibleNodeCountSql('c')} as node_count,
                      c.live_node_count as ordering_node_count,
                      ${collectionHidePublicExistsSql('c.id')} as hidden_public, c.updated_at,
                      (extract(epoch from c.updated_at) * 1000000)::bigint::text
                        as ordering_updated_at_micros,
                      views.view_count
                 from view_counts views
                 join collections c on c.id = views.collection_id
                where ${filters.join(' and ')}
                  ${keysets.viewed ? `and ${keysets.viewed}` : ''}
                order by views.view_count desc, c.updated_at desc, c.id collate "C" asc
                limit ${limit}
             ), zero_page as materialized (
               select c.id, c.owner_subject_id, c.title, c.summary, c.kind, c.visibility,
                      c.publication_slug, ${COLLECTION_CATALOG_TAGS_SQL} as tags, ${COLLECTION_CATALOG_LANGUAGE_SQL} as language,
                      ${collectionVisibleNodeCountSql('c')} as node_count,
                      c.live_node_count as ordering_node_count,
                      ${collectionHidePublicExistsSql('c.id')} as hidden_public, c.updated_at,
                      (extract(epoch from c.updated_at) * 1000000)::bigint::text
                        as ordering_updated_at_micros,
                      0::bigint as view_count
                 from collections c
                where ${filters.join(' and ')}
                  and not exists (
                    select 1 from view_counts views where views.collection_id = c.id
                  )
                  ${keysets.zero ? `and ${keysets.zero}` : ''}
                order by c.updated_at desc, c.id collate "C" asc
                limit ${limit}
             ), ranked as (
               select * from viewed_page
               union all
               select * from zero_page
             )
             select ranked.id, ranked.owner_subject_id, ranked.title, ranked.summary,
                    ranked.kind, ranked.visibility, ranked.publication_slug, ranked.tags, ranked.language,
                    a.id as owner_account_id, ranked.hidden_public, ranked.node_count,
                    ranked.ordering_node_count, ranked.updated_at,
                    ranked.ordering_updated_at_micros, ranked.view_count${hiddenSql}
               from ranked
               join accounts a on a.subject_id = ranked.owner_subject_id
              order by ${orderBy(request.sort, 'ranked')}
              limit ${limit}`,
      values: Object.freeze(values),
    });
  }
  const keyset = keysetPredicate(request, parameter);
  const limit = parameter(pageSize + 1);
  const hiddenSql = preferenceHiddenSelect(request, 'page', parameter);
  // updated/links sorts and keysets only touch collections columns, so page
  // on collections first (index-aligned keyset) and aggregate the insight
  // window for just the limit+1 page rows instead of the whole catalog.
  return Object.freeze({
    text: `select page.id, page.owner_subject_id, page.title, page.summary, page.kind,
                  page.visibility, page.publication_slug, page.tags, page.language, a.id as owner_account_id, page.hidden_public, page.node_count,
                  page.ordering_node_count, page.updated_at, page.ordering_updated_at_micros,
                  coalesce(views.view_count, 0)::bigint as view_count${hiddenSql}
             from (
               select c.id, c.owner_subject_id, c.title, c.summary, c.kind, c.visibility,
                      c.publication_slug,
                      ${COLLECTION_CATALOG_TAGS_SQL} as tags, ${COLLECTION_CATALOG_LANGUAGE_SQL} as language,
                      ${collectionVisibleNodeCountSql('c')} as node_count,
                      c.live_node_count as ordering_node_count,
                      ${collectionHidePublicExistsSql('c.id')} as hidden_public,
                      c.updated_at,
                      (extract(epoch from c.updated_at) * 1000000)::bigint::text as ordering_updated_at_micros
                 from collections c
                where ${filters.join(' and ')}
                ${keyset ? `and ${keyset}` : ''}
                order by ${orderBy(request.sort, 'c')}
                limit ${limit}
             ) page
             join accounts a on a.subject_id = page.owner_subject_id
             left join lateral (
               select sum(d.count)::bigint as view_count
                 from publication_insight_daily d
                where d.collection_id = page.id
                  and d.event_type = 'collection_view'
                  and d.day >= ${fromDay}::date
                  and d.day < ${toDay}::date
             ) views on true
            order by ${orderBy(request.sort, 'page')}`,
    values: Object.freeze(values),
  });
}

function popularKeysetPredicates(
  request: ExplorePageReadRequest,
  parameter: (value: unknown) => string,
): { readonly viewed?: string; readonly zero?: string } {
  if (!request.after) return {};
  const exactTimestamp = microsTimestampSql(parameter, request.after.micros);
  const id = parameter(request.after.id);
  const viewCount = parameter(request.after.viewCount);
  const viewed = `(views.view_count < ${viewCount}
      or (views.view_count = ${viewCount} and c.updated_at < ${exactTimestamp})
      or (views.view_count = ${viewCount} and c.updated_at = ${exactTimestamp}
          and c.id collate "C" > ${id}::text collate "C"))`;
  // Every zero-view row follows a positive cursor. Once the cursor itself is
  // in the zero partition, continue by its updated/id tie-break tuple.
  const zero = request.after.viewCount === 0
    ? `(c.updated_at < ${exactTimestamp}
        or (c.updated_at = ${exactTimestamp}
            and c.id collate "C" > ${id}::text collate "C"))`
    : undefined;
  return { viewed, ...(zero ? { zero } : {}) };
}

function preferenceHiddenSelect(
  request: ExplorePageReadRequest,
  ref: 'ranked' | 'page',
  parameter: (value: unknown) => string,
): string {
  if (!request.catalogPreference) return '';
  const hidden = explorePreferenceHiddenSql({
    accountId: 'a.id',
    title: `${ref}.title`,
    tags: `${ref}.tags`,
    language: `${ref}.language`,
  }, request.catalogPreference, parameter);
  return `, ${hidden} as preference_hidden`;
}

function orderBy(sort: ExplorePageSort, ref: 'ranked' | 'c' | 'page'): string {
  const nodeCount = ref === 'c' ? 'c.live_node_count' : `${ref}.ordering_node_count`;
  if (sort === 'popular') {
    return `${ref}.view_count desc, ${ref}.updated_at desc, ${ref}.id collate "C" asc`;
  }
  if (sort === 'links') {
    return `${nodeCount} desc, ${ref}.updated_at desc, ${ref}.id collate "C" asc`;
  }
  return `${ref}.updated_at desc, ${ref}.id collate "C" asc`;
}

function microsTimestampSql(parameter: (value: unknown) => string, micros: string): string {
  const updatedAt = parameter(micros);
  return `(timestamp with time zone 'epoch'
      + (${updatedAt}::bigint / 1000000) * interval '1 second'
      + (${updatedAt}::bigint % 1000000) * interval '1 microsecond')`;
}

function keysetPredicate(
  request: ExplorePageReadRequest,
  parameter: (value: unknown) => string,
): string | undefined {
  if (!request.after) return undefined;
  const exactTimestamp = microsTimestampSql(parameter, request.after.micros);
  const id = parameter(request.after.id);
  if (request.sort === 'popular') {
    const viewCount = parameter(request.after.viewCount);
    return `(ranked.view_count < ${viewCount}
        or (ranked.view_count = ${viewCount} and ranked.updated_at < ${exactTimestamp})
        or (ranked.view_count = ${viewCount} and ranked.updated_at = ${exactTimestamp}
            and ranked.id collate "C" > ${id}::text collate "C"))`;
  }
  if (request.sort === 'links') {
    const nodeCount = parameter(request.after.nodeCount);
    return `(c.live_node_count < ${nodeCount}
        or (c.live_node_count = ${nodeCount} and c.updated_at < ${exactTimestamp})
        or (c.live_node_count = ${nodeCount} and c.updated_at = ${exactTimestamp}
            and c.id collate "C" > ${id}::text collate "C"))`;
  }
  return `c.updated_at <= ${exactTimestamp}
      and (c.updated_at < ${exactTimestamp} or c.id collate "C" > ${id}::text collate "C")`;
}

function validateRequest(request: ExplorePageReadRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    throw new RangeError('Explore page read limit must be between 1 and 100');
  }
  if (request.sort !== 'updated' && request.sort !== 'popular' && request.sort !== 'links') {
    throw new TypeError('Explore page sort is invalid');
  }
  if (!request.after) return;
  if (!/^-?\d{1,20}$/u.test(request.after.micros) || request.after.id.length === 0) {
    throw new TypeError('Explore page continuation is invalid');
  }
  if (request.sort === 'popular' && !isNonNegativeInt(request.after.viewCount)) {
    throw new TypeError('Explore page continuation is invalid');
  }
  if (request.sort === 'links' && !isNonNegativeInt(request.after.nodeCount)) {
    throw new TypeError('Explore page continuation is invalid');
  }
  if (request.scanBudget !== undefined
    && (!Number.isSafeInteger(request.scanBudget)
      || request.scanBudget < 1
      || request.scanBudget > EXPLORE_PREFERENCE_SCAN_ROW_BUDGET)) {
    throw new RangeError('Explore preference scan budget is invalid');
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function mapRecord(row: ExploreRow): ExplorePageRecord {
  if (row.visibility !== 'public') throw new Error('Explore page visibility is invalid');
  if (!KINDS.has(row.kind)) throw new Error('Explore page kind is invalid');
  const tags = Array.isArray(row.tags)
    ? [...new Set(row.tags.filter((tag): tag is string => typeof tag === 'string'))]
    : [];
  const nodeCount = Number(row.node_count);
  const orderingNodeCount = Number(row.ordering_node_count);
  const viewCount = Number(row.view_count);
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0) throw new Error('Explore page node count is invalid');
  if (!Number.isSafeInteger(orderingNodeCount) || orderingNodeCount < 0) {
    throw new Error('Explore page ordering node count is invalid');
  }
  if (!Number.isSafeInteger(viewCount) || viewCount < 0) throw new Error('Explore page view count is invalid');
  return Object.freeze({
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    summary: row.summary,
    kind: row.kind as ExplorePageRecord['kind'],
    visibility: 'public',
    publicationSlug: row.publication_slug,
    tags: Object.freeze(tags),
    language: typeof row.language === 'string' && row.language !== '' ? row.language : null,
    ...(typeof row.owner_account_id === 'string' ? { ownerAccountId: row.owner_account_id } : {}),
    nodeCount,
    orderingNodeCount,
    ...(typeof row.preference_hidden === 'boolean' ? { preferenceHidden: row.preference_hidden } : {}),
    viewCount,
    updatedAt: row.updated_at.toISOString(),
    orderingUpdatedAtMicros: row.ordering_updated_at_micros,
    hiddenPublic: row.hidden_public === true,
  });
}
