import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

test('P3-36 PostgreSQL adapter keeps owner predicates and safe DTO selection explicit', () => {
  const source = readFileSync(new URL('../../../src/infrastructure/sync/product-sync-center-postgres.ts', import.meta.url), 'utf8');
  assert.match(source, /where\(['"]account_id['"],\s*['"]=|where\(['"]replica\.account_id['"],\s*['"]=|account_id\s*=\s*\$\{/u);
  assert.match(source, /orderBy\(['"]conflict\.created_at['"],\s*['"]desc['"]\)/u);
  assert.match(source, /orderBy\(['"]conflict\.conflict_id['"],\s*['"]desc['"]\)/u);
  assert.match(source, /limit:\s*pageLimit/u);
  assert.match(source, /parsed\.limit/u);
  assert.doesNotMatch(source, /acknowledged_cursor|browser_profile_id|payload_ciphertext|base_payload|incoming_payload/u);
});
