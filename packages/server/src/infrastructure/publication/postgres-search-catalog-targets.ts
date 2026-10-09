import type { DatabaseRuntime } from '../database/index.js';
import {
  COLLECTION_CATALOG_LANGUAGE_SQL,
  COLLECTION_CATALOG_TAGS_SQL,
} from './postgres-directory-read.js';

export interface SearchCatalogDisplayRef {
  readonly resourceType: 'collection' | 'node' | 'profile' | 'annotation';
  readonly resourceId: string;
}

export interface SearchCatalogDisplayFacts {
  readonly ownerAccountId: string;
  readonly tags: readonly string[];
  readonly language: string | null;
}

interface TargetRow {
  resource_type: SearchCatalogDisplayRef['resourceType'];
  resource_id: string;
  owner_account_id: string;
  tags: unknown;
  language: unknown;
}

export function searchCatalogDisplayKey(
  item: Pick<SearchCatalogDisplayRef, 'resourceType' | 'resourceId'>,
): string {
  return `${item.resourceType}:${item.resourceId}`;
}

export function createPostgresSearchCatalogDisplayTargetPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): {
  load(items: readonly SearchCatalogDisplayRef[]): Promise<ReadonlyMap<string, SearchCatalogDisplayFacts>>;
} {
  return Object.freeze({
    async load(items: readonly SearchCatalogDisplayRef[]) {
      const facts = new Map<string, SearchCatalogDisplayFacts>();
      if (items.length === 0) return facts;
      const collectionIds = idsOf(items, 'collection');
      const nodeIds = idsOf(items, 'node');
      const profileHandles = idsOf(items, 'profile');
      const annotationIds = idsOf(items, 'annotation');
      const result = await runtime.pool.query<TargetRow>(
        `select resource_type, resource_id, owner_account_id, tags, language from (
           select 'collection'::text as resource_type, c.id as resource_id, a.id as owner_account_id,
                  ${COLLECTION_CATALOG_TAGS_SQL} as tags, ${COLLECTION_CATALOG_LANGUAGE_SQL} as language
             from collections c
             join accounts a on a.subject_id = c.owner_subject_id
            where c.id = any($1::text[])
              and a.status = 'active' and a.deleted_at is null
           union all
           select 'node', n.id, a.id, ${COLLECTION_CATALOG_TAGS_SQL}, ${COLLECTION_CATALOG_LANGUAGE_SQL}
             from nodes n
             join collections c on c.id = n.collection_id
             join accounts a on a.subject_id = c.owner_subject_id
            where n.id = any($2::text[])
              and a.status = 'active' and a.deleted_at is null
           union all
           select 'profile', h.handle, a.id, '[]'::jsonb, null
             from profile_handles h
             join accounts a on a.id = h.account_id
            where h.handle = any($3::text[])
              and a.status = 'active' and a.deleted_at is null
           union all
           select 'annotation', an.id, a.id, ${COLLECTION_CATALOG_TAGS_SQL}, ${COLLECTION_CATALOG_LANGUAGE_SQL}
             from annotations an
             join collections c on c.id = an.collection_id
             join accounts a on a.subject_id = c.owner_subject_id
            where an.id = any($4::text[])
              and a.status = 'active' and a.deleted_at is null
         ) targets`,
        [collectionIds, nodeIds, profileHandles, annotationIds],
      );
      for (const row of result.rows) {
        if (row.resource_type !== 'collection' && row.resource_type !== 'node'
          && row.resource_type !== 'profile' && row.resource_type !== 'annotation') continue;
        if (typeof row.resource_id !== 'string' || typeof row.owner_account_id !== 'string') continue;
        facts.set(searchCatalogDisplayKey({
          resourceType: row.resource_type, resourceId: row.resource_id,
        }), Object.freeze({
          ownerAccountId: row.owner_account_id,
          tags: asTags(row.tags),
          language: typeof row.language === 'string' && row.language.length > 0 ? row.language : null,
        }));
      }
      return facts;
    },
  });
}

function idsOf(
  items: readonly SearchCatalogDisplayRef[],
  type: SearchCatalogDisplayRef['resourceType'],
): string[] {
  return [...new Set(items.filter((item) => item.resourceType === type).map((item) => item.resourceId))];
}

function asTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.filter((item): item is string => typeof item === 'string'))]);
}
