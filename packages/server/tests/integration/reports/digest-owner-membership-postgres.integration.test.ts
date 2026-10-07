import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('digest owner membership final-state guard', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('digest_owner_membership_guard', {
      maxConnections: 4,
      applicationName: 'known-test-digest-owner-membership-guard',
    });
    // Upgrade the pre-merge main schema, which already includes credit integrity
    // and financial locks. The new guard must append to that executed history.
    const previous = await createMigrator(isolated.runtime.db, undefined, isolated.schema)
      .migrateTo('202610101100_classification_credit_financial_locks');
    if (previous.error) throw previous.error;
    const upgraded = await runMigrations(isolated.runtime.db, 'latest');
    assert.equal(upgraded.results[0]?.migrationName, '202610101200_digest_owner_membership_guard');
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('rejects deleting an active empty series owner but permits complete teardown', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const accountId = `digest-account-${suffix}`;
    const subjectId = `digest-owner-${suffix}`;
    const seriesId = `digest-series-${suffix}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into accounts(id, subject_id, status) values ($1, $2, 'active')`,
        [accountId, subjectId]);
      await client.query(`insert into resource_id_ledger(resource_id, resource_type, committed_at)
        values ($1, 'digest_series', current_timestamp)`, [seriesId]);
      await client.query(`insert into digest_series(
        id, owner_subject_id, title, summary, slug, visibility, allow_search_indexing,
        state, resource_revision, content_revision, policy_revision, commit_ordinal)
        values ($1, $2, 'Empty active digest', null, $3, 'private', false,
          'active', 'resource-1', 'content-1', 'policy-1', 1)`,
      [seriesId, subjectId, `digest-${suffix}`]);
      await client.query(`insert into digest_members(series_id, subject_id, role)
        values ($1, $2, 'owner')`, [seriesId, subjectId]);
      await client.query('commit');

      await client.query('begin');
      await client.query('delete from digest_members where series_id = $1 and subject_id = $2',
        [seriesId, subjectId]);
      await assert.rejects(client.query('commit'),
        (error: unknown) => (error as { code?: unknown }).code === '23514');

      const retained = await client.query<{ count: string }>(
        'select count(*)::text as count from digest_members where series_id = $1 and subject_id = $2',
        [seriesId, subjectId]);
      assert.equal(retained.rows[0]?.count, '1');

      await client.query('begin');
      await client.query('delete from digest_members where series_id = $1', [seriesId]);
      await client.query('delete from digest_series where id = $1', [seriesId]);
      await client.query('commit');
      const removed = await client.query<{ count: string }>(
        'select count(*)::text as count from digest_series where id = $1', [seriesId]);
      assert.equal(removed.rows[0]?.count, '0');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }, 60_000);
});
