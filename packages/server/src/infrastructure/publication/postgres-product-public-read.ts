import type { DatabaseRuntime } from '../database/index.js';
import {
  publishingInsightsWindowBounds,
  type ProductPublicCollectionLocatorReadPort,
  type ProductPublicCollectionViewCountReadPort,
} from '../../modules/publication/index.js';

export function createPostgresProductPublicCollectionLocatorReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): ProductPublicCollectionLocatorReadPort {
  return Object.freeze({
    async findCollectionIdBySlug(slug: string) {
      const result = await runtime.pool.query<{ id: string }>(
        'select id from collections where publication_slug = $1',
        [slug],
      );
      return result.rows[0]?.id ?? null;
    },
  });
}

export function createPostgresProductPublicCollectionViewCountReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): ProductPublicCollectionViewCountReadPort {
  return Object.freeze({
    async sumCollectionViews(collectionId: string) {
      const window = publishingInsightsWindowBounds(new Date());
      const result = await runtime.pool.query<{ view_count: string | number | bigint }>(
        `select coalesce(sum(d.count), 0)::bigint as view_count
           from collections c
           left join publication_insight_daily d
             on d.collection_id = c.id
            and d.event_type = 'collection_view'
            and d.day >= $2::date
            and d.day < $3::date
          where c.id = $1`,
        [collectionId, window.fromDayInclusive, window.toDayExclusive],
      );
      const viewCount = Number(result.rows[0]?.view_count ?? 0);
      if (!Number.isSafeInteger(viewCount) || viewCount < 0) {
        throw new Error('Public collection view count is invalid');
      }
      return viewCount;
    },
  });
}
