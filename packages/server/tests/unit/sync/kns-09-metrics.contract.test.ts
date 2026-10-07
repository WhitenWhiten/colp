/**
 * Owner: KNS-09 (Release). Fixture: Known-Backend/docs/runbooks/sync-trash-and-mount-roles.md.
 * Run: npm --prefix Known-Backend run test:unit -- tests/unit/sync/kns-09-metrics.contract.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

describe('KNS-09 backend low-cardinality trash metrics', () => {
  test('restore and mount counters stay unlabeled and omit URL or title', () => {
    const trash = [
      'product-sync-trash-postgres.ts',
      'product-sync-trash-shared-postgres.ts',
      'product-sync-trash-batch-postgres.ts',
      'product-sync-trash-empty-postgres.ts',
    ].map((file) => readFileSync(resolve(backendRoot, 'src/infrastructure/sync', file), 'utf8')).join('\n');
    const mount = readFileSync(
      resolve(backendRoot, 'src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts'), 'utf8');
    const runbook = readFileSync(
      resolve(backendRoot, 'docs/runbooks/sync-trash-and-mount-roles.md'), 'utf8');
    for (const name of [
      'sync_trash_list_total',
      'sync_trash_restore_total.applied',
      'sync_trash_restore_total.purged',
      'sync_trash_restore_total.precondition_failed',
      'sync_trash_restore_total.not_found',
      'sync_trash_restore_total.invalid_request',
      'sync_trash_restore_batch_total.applied',
      'sync_trash_restore_batch_total.partial',
      'sync_trash_restore_subtree_total.applied',
      'sync_trash_restore_subtree_total.partial',
      'sync_trash_empty_total.purged',
      'sync_trash_empty_total.skipped',
      'sync_trash_empty_total.fence_lost',
      'sync_mount_role_conflict_total',
    ]) {
      assert.match(`${trash}\n${mount}`, new RegExp(name.replaceAll('.', '\\.')));
      assert.match(runbook, new RegExp(name.replaceAll('.', '\\.')));
    }
    assert.doesNotMatch(trash, /increment\([^)]*(?:url|title|nodeId|collectionId)/iu);
    assert.doesNotMatch(mount, /increment\([^)]*(?:url|title|nodeId|collectionId)/iu);
  });
});
