/**
 * CANON-FACTS (CANON-P0-b) static net.
 * Completing the lane shrinks the allowlist to empty.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import { readSrc, rel, srcRoot, walk } from '../../support/org-layering-static.js';

const ACCESS_POLICY_COLLECTIONS_SQL_ALLOWLIST = [] as const;

const COLLECTIONS_TABLE_QUERY =
  /(?:selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*['"]collections['"]|\bFROM\s+collections\b|\bJOIN\s+collections\b/iu;

test('access-policy does not query the collections table (CANON-P0-b)', () => {
  const offenders: string[] = [];
  for (const directory of [
    join(srcRoot, 'infrastructure', 'access-policy'),
    join(srcRoot, 'modules', 'access-policy'),
  ]) {
    for (const path of walk(directory)) {
      const source = readSrc(path);
      if (COLLECTIONS_TABLE_QUERY.test(source)) offenders.push(rel(path));
    }
  }
  assert.deepEqual(offenders.sort(), [...ACCESS_POLICY_COLLECTIONS_SQL_ALLOWLIST].sort());
});

test('collection header read leaf does not import access-policy (CANON-P0-b)', () => {
  const source = readSrc(join(srcRoot, 'infrastructure', 'collections', 'collection-header-read.ts'));
  assert.doesNotMatch(source, /access-policy/u);
});
