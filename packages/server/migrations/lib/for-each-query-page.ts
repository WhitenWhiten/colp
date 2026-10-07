import { sql } from 'kysely';

/** Bounded keyset page for migration backfills that must not load a whole table. */
export const MIGRATION_QUERY_PAGE_SIZE = 500;

export function keysetIdPredicate(afterId: string | undefined) {
  return afterId === undefined ? sql`true` : sql`id > ${afterId}`;
}

export async function forEachQueryPage<Row extends { readonly id: string }>(
  options: {
    readonly pageSize?: number;
    readonly loadPage: (afterId: string | undefined, limit: number) => Promise<readonly Row[]>;
    readonly visit: (row: Row) => Promise<void>;
  },
): Promise<void> {
  const pageSize = options.pageSize ?? MIGRATION_QUERY_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new TypeError('Migration query page size must be a positive safe integer.');
  }
  let afterId: string | undefined;
  for (;;) {
    const rows = await options.loadPage(afterId, pageSize);
    if (rows.length === 0) return;
    let previousId: string | undefined;
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error('Migration query page is missing a keyset id.');
      }
      if (previousId !== undefined && row.id <= previousId) {
        throw new Error('Migration query page must be strictly increasing by id.');
      }
      if (afterId !== undefined && row.id <= afterId) {
        throw new Error('Migration query page must continue after the previous keyset id.');
      }
      previousId = row.id;
      await options.visit(row);
    }
    if (rows.length < pageSize) return;
    afterId = rows[rows.length - 1]!.id;
  }
}
