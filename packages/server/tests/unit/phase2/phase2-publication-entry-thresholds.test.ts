import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  defaultPostgresPublicationEntryThresholdsPath,
  loadPostgresPublicationEntryThresholds,
} from '../../../scripts/evidence/postgres-publication-entry.js';

test('Phase 2 Publication entry thresholds lock the 10k / 500 / 4 MiB envelope', () => {
  const thresholds = loadPostgresPublicationEntryThresholds();
  assert.equal(thresholds.nodeCount, 10_000);
  assert.equal(thresholds.pageSize, 500);
  assert.equal(thresholds.maxPageBytes, 4 * 1024 * 1024);
  assert.ok(thresholds.pageP95Ms <= 1_500);
});

test('Phase 2 Publication entry thresholds fail closed when the artifact is absent', () => {
  assert.throws(
    () => loadPostgresPublicationEntryThresholds(resolve('does-not-exist-phase2-thresholds.json')),
    /missing or invalid/u,
  );
  assert.match(
    defaultPostgresPublicationEntryThresholdsPath(),
    /tests[\\/]fixtures[\\/]phase2[\\/]publication-entry-thresholds\.json$/u,
  );
});
