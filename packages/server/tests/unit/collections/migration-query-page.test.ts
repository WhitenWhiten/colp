import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  MIGRATION_QUERY_PAGE_SIZE,
  forEachQueryPage,
} from '../../../migrations/lib/for-each-query-page.js';

test('forEachQueryPage walks keyset pages without loading the whole table', async () => {
  const loads: Array<{ afterId: string | undefined; limit: number }> = [];
  const visited: string[] = [];
  const pages: Readonly<Record<string, readonly { id: string }[]>> = Object.freeze({
    '': Object.freeze([{ id: 'a' }, { id: 'b' }]),
    b: Object.freeze([{ id: 'c' }]),
  });
  await forEachQueryPage({
    pageSize: 2,
    loadPage: async (afterId, limit) => {
      loads.push({ afterId, limit });
      return pages[afterId ?? ''] ?? [];
    },
    visit: async (row) => {
      visited.push(row.id);
    },
  });
  assert.deepEqual(loads, [
    { afterId: undefined, limit: 2 },
    { afterId: 'b', limit: 2 },
  ]);
  assert.deepEqual(visited, ['a', 'b', 'c']);
  assert.equal(MIGRATION_QUERY_PAGE_SIZE, 500);
});

test('forEachQueryPage stops on an empty first page', async () => {
  let loads = 0;
  await forEachQueryPage({
    pageSize: 2,
    loadPage: async () => {
      loads += 1;
      return [];
    },
    visit: async () => {
      throw new Error('visit must not run on an empty page');
    },
  });
  assert.equal(loads, 1);
});

test('forEachQueryPage rejects unordered or non-advancing keyset pages', async () => {
  await assert.rejects(
    () => forEachQueryPage({
      pageSize: 2,
      loadPage: async () => [{ id: 'b' }, { id: 'a' }],
      visit: async () => undefined,
    }),
    /strictly increasing by id/,
  );
  await assert.rejects(
    () => forEachQueryPage({
      pageSize: 1,
      loadPage: async (afterId) => (afterId === undefined ? [{ id: 'a' }] : [{ id: 'a' }]),
      visit: async () => undefined,
    }),
    /continue after the previous keyset id/,
  );
  await assert.rejects(
    () => forEachQueryPage({
      pageSize: 0,
      loadPage: async () => [],
      visit: async () => undefined,
    }),
    /positive safe integer/,
  );
});
