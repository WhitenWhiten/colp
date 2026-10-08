import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('Library Order query execute cancels the PostgreSQL backend on abort', async () => {
  const source = await readFile(
    new URL('../../../src/infrastructure/collections/library-order-postgres.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /executeQueryAbortable/);
  assert.match(source, /await installPostgresTransactionCancellation\(transaction, signal/g);
  assert.match(source, /finally \{\s*await disposeCancellation\(\)/gu);
});
