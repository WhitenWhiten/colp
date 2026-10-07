import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('MCP approval decision execute cancels the PostgreSQL backend on abort', async () => {
  const source = await readFile(
    new URL('../../../src/infrastructure/database/mcp-write-approval-port.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /execution\.signal/);
  assert.match(source, /await installPostgresTransactionCancellation\(transaction, signal/);
  assert.match(source, /finally \{\s*await disposeCancellation\(\)/u);
});
