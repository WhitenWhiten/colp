import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const INDEX = 'outbox_social_feed_rebuild_source_idx';

describeWithPostgres('social Feed rebuild source index', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('feed_rebuild_source_index');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('covers the scoped ordinal replay while retaining unresolved-state evidence', async () => {
    const result = await isolated.runtime.pool.query<{ indexdef: string }>(`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = $1
    `, [INDEX]);
    assert.equal(result.rowCount, 1);
    const definition = result.rows[0]?.indexdef ?? '';
    assert.match(definition, /\(aggregate_scope, commit_ordinal, domain_event_id\)/iu);
    assert.match(definition, /INCLUDE \(event_version, aggregate_revision, occurred_at, payload_json, state\)/iu);
    assert.match(definition, /handler_name = 'social\.publish-collection-change'/iu);
    assert.match(definition, /event_type = 'social\.collection-change'/iu);
    assert.doesNotMatch(definition, /state = 'completed'/iu);
  });
});
