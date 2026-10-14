/**
 * CANON-SIDECAR (CANON-P0-c) static net.
 * Completing the lane shrinks lockForCanonicalMutation to the single ports file.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import { readSrc, rel, srcRoot, walk } from '../../support/org-layering-static.js';

const CANONICAL_LOCK_ALLOWLIST = [
  'src/infrastructure/collections/canonical-mutation-postgres-ports.ts',
  // In-memory port: returns the collection row canonical-bookmark-move-batch.ts
  // already locked FOR UPDATE; it takes no lock and issues no SQL.
  'src/infrastructure/collections/canonical-bookmark-move-plan.ts',
] as const;

test('Canonical lockForCanonicalMutation exists in exactly one collections infra file (CANON-P0-c)', () => {
  const offenders: string[] = [];
  for (const path of walk(join(srcRoot, 'infrastructure', 'collections'))) {
    const source = readSrc(path);
    if (/lockForCanonicalMutation\s*\(/u.test(source)) offenders.push(rel(path));
  }
  assert.deepEqual(offenders.sort(), [...CANONICAL_LOCK_ALLOWLIST].sort());
});
