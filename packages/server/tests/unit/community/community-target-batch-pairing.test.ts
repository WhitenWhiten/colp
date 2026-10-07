import assert from 'node:assert/strict';
import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { test } from 'vitest';
import { resolveCommunityTargetRows } from '../../../src/infrastructure/community/community-target-batch-postgres.js';
import type { TargetRow } from '../../../src/infrastructure/community/community-target-shared-postgres.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/index.js';
import type { CommunityTargetQuery } from '../../../src/modules/community/index.js';

async function resolveRows(rows: TargetRow[], queries: CommunityTargetQuery[]) {
  const postgres = new PostgresDialect({ pool: {} as never });
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createDriver: () => new DummyDriver(),
    createAdapter: () => postgres.createAdapter(),
    createQueryCompiler: () => postgres.createQueryCompiler(),
    createIntrospector: (database) => postgres.createIntrospector(database),
  }, plugins: [{
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({ ...result,
      rows: rows as unknown as Record<string, unknown>[] }),
  }] });
  try {
    return await db.transaction().execute((transaction) => resolveCommunityTargetRows(transaction, queries));
  } finally { await db.destroy(); }
}

function row(kind: string, id: string, parent: string | null = null): TargetRow {
  return { kind, id, collection_id: kind === 'bookmark' ? parent : null,
    series_id: kind === 'digest_edition' ? parent : null,
    generation: 'generation-1', owner_subject_id: 'owner', title: id, href: `/target/${id}` };
}

test('batch pairing preserves order, duplicates, kind and parent identity, and missing rows', async () => {
  const rows = [row('bookmark', 'same', 'collection-a'), row('bookmark', 'same', 'collection-b'),
    row('collection', 'same'), row('digest_edition', 'same', 'series-a'),
    row('digest_edition', 'same', 'series-b')];
  const queries: CommunityTargetQuery[] = [
    { kind: 'bookmark', id: 'same', collectionId: 'collection-b' },
    { kind: 'bookmark', id: 'same', collectionId: 'missing' },
    { kind: 'collection', id: 'same' },
    { kind: 'digest_edition', id: 'same', seriesId: 'series-b' },
    { kind: 'digest_edition', id: 'same', seriesId: 'missing' },
    { kind: 'bookmark', id: 'same', collectionId: 'collection-b' },
  ];
  const result = await resolveRows(rows, queries);
  assert.deepEqual(result.map((value) => value?.target ?? null), [
    { kind: 'bookmark', id: 'same', collectionId: 'collection-b', seriesId: null, generation: 'generation-1' },
    null,
    { kind: 'collection', id: 'same', collectionId: null, seriesId: null, generation: 'static-v1' },
    { kind: 'digest_edition', id: 'same', collectionId: null, seriesId: 'series-b', generation: 'static-v1' },
    null,
    { kind: 'bookmark', id: 'same', collectionId: 'collection-b', seriesId: null, generation: 'generation-1' },
  ]);
});

test('large unread batches inspect returned identities only linearly', async () => {
  const count = 10_000;
  let idReads = 0;
  const rows = Array.from({ length: count }, (_, index) => ({ ...row('collection', `c${index}`),
    get id() { idReads += 1; return `c${index}`; },
  }));
  const result = await resolveRows(rows,
    Array.from({ length: count }, (_, index) => ({ kind: 'collection', id: `c${index}` })));
  assert.equal(result.length, count);
  assert.equal(result[count - 1]?.target.id, `c${count - 1}`);
  // Allow several linear passes without pinning the implementation to one map.
  // A per-query rows.find performs 50,015,000 reads for this fixture.
  assert.ok(idReads <= count * 4, `quadratic target pairing: ${idReads} identity reads`);
});
