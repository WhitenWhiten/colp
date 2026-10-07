/**
 * IDENTITY (ORG-P0-a / ORG-P0-b) static net.
 * Completing the lane shrinks both allowlists to empty.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import { readSrc, rel, srcRoot, walk } from '../../support/org-layering-static.js';

const TRANSPORT_SQL_ALLOWLIST = [] as const;
const BOOTSTRAP_IDENTITY_WRITE_ALLOWLIST = [] as const;

test('transport value-imports kysely sql only on the Explore allowlist (ORG-P0-a)', () => {
  const offenders: string[] = [];
  for (const path of walk(join(srcRoot, 'transport'))) {
    const source = readSrc(path);
    const importsSql = /import\s+\{[^}]*\bsql\b[^}]*\}\s+from\s+['"]kysely['"]/u.test(source);
    if (importsSql) offenders.push(rel(path));
  }
  assert.deepEqual(offenders, [...TRANSPORT_SQL_ALLOWLIST]);
});

test('bootstrap writes account_identities only on the api.ts allowlist (ORG-P0-b)', () => {
  const offenders: string[] = [];
  for (const path of walk(join(srcRoot, 'bootstrap'))) {
    const source = readSrc(path);
    if (
      /insertInto\(\s*['"]account_identities['"]\)/u.test(source)
      || /insert\s+into\s+account_identities\b/iu.test(source)
    ) {
      offenders.push(rel(path));
    }
  }
  assert.deepEqual(offenders, [...BOOTSTRAP_IDENTITY_WRITE_ALLOWLIST]);
});
