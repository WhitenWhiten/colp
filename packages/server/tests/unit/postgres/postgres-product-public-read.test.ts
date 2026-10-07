import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresProductPublicCollectionLocatorReadPort } from '../../../src/infrastructure/publication/index.js';

test('resolves the immutable publication slug without duplicating authorization SQL', async () => {
  let captured: { sql: string; values?: readonly unknown[] } | undefined;
  const runtime = {
    pool: {
      async query(sql: string, values?: readonly unknown[]) {
        captured = { sql, values };
        return { rows: [{ id: 'collection-1' }] };
      },
    } as unknown as DatabaseRuntime['pool'],
  };
  const id = await createPostgresProductPublicCollectionLocatorReadPort(runtime)
    .findCollectionIdBySlug('published');
  assert.equal(id, 'collection-1');
  assert.match(captured?.sql ?? '', /publication_slug = \$1/u);
  assert.doesNotMatch(captured?.sql ?? '', /visibility|collection_members|nodes/iu);
  assert.deepEqual(captured?.values, ['published']);
});
