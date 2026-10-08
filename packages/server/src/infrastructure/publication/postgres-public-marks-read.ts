import type { DatabaseRuntime } from '../database/index.js';

/**
 * Batch public annotation marks read (BE-01/BE-02).
 *
 * Overlay on the `annotations` side table: folder and bookmark nodes (any
 * kind) can carry tldr/note marks, and collections can carry a curator tldr.
 * Only `visibility='public'` rows are ever exposed — private, protected, and
 * unlisted marks never leave this port, regardless of the requesting
 * projection, because the Product public surface must not leak non-public
 * curation.
 */

export interface PublicNodeMark {
  readonly tldr: string | null;
  readonly note: string | null;
}

export interface PublicMarksReadPort {
  /** Latest `updated_at` public tldr/note per node; missing ids are absent. */
  findPublicMarksByNodeIds(
    collectionId: string,
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, PublicNodeMark>>;
  /** Latest `updated_at` public tldr per collection; missing ids are absent. */
  findPublicMarksForCollections(
    collectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

interface NodeMarkRow {
  readonly subject_id: string;
  readonly type: 'tldr' | 'note';
  readonly value_json: unknown;
}

interface CollectionMarkRow {
  readonly subject_id: string;
  readonly value_json: unknown;
}

export function createPostgresPublicMarksReadPort(
  runtime: Pick<DatabaseRuntime, 'pool'>,
): PublicMarksReadPort {
  return Object.freeze({
    async findPublicMarksByNodeIds(collectionId: string, nodeIds: readonly string[]) {
      if (nodeIds.length === 0) return new Map();
      const result = await runtime.pool.query<NodeMarkRow>(
        `select distinct on (subject_id, type) subject_id, type, value_json
           from annotations
          where collection_id = $1
            and subject_type = 'node'
            and subject_id = any($2::text[])
            and type in ('tldr', 'note')
            and visibility = 'public'
            and deleted_at is null
          order by subject_id, type, updated_at desc, id collate "C" desc`,
        [collectionId, nodeIds],
      );
      return composeNodeMarks(result.rows);
    },
    async findPublicMarksForCollections(collectionIds: readonly string[]) {
      if (collectionIds.length === 0) return new Map();
      const result = await runtime.pool.query<CollectionMarkRow>(
        `select distinct on (subject_id) subject_id, value_json
           from annotations
          where collection_id = any($1::text[])
            and subject_type = 'collection'
            and type = 'tldr'
            and visibility = 'public'
            and deleted_at is null
          order by subject_id, updated_at desc, id collate "C" desc`,
        [collectionIds],
      );
      const marks = new Map<string, string>();
      for (const row of result.rows) {
        const value = markText(row.value_json);
        if (value !== null) marks.set(row.subject_id, value);
      }
      return marks;
    },
  });
}

function composeNodeMarks(rows: readonly NodeMarkRow[]): ReadonlyMap<string, PublicNodeMark> {
  const marks = new Map<string, { tldr: string | null; note: string | null }>();
  for (const row of rows) {
    const existing = marks.get(row.subject_id) ?? { tldr: null, note: null };
    const value = markText(row.value_json);
    if (value !== null) existing[row.type] = value;
    marks.set(row.subject_id, existing);
  }
  return new Map([...marks.entries()].map(([id, mark]) => (
    [id, Object.freeze({ tldr: mark.tldr, note: mark.note })]
  )));
}

/** String annotation values pass through; structured values serialize as JSON. */
function markText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}