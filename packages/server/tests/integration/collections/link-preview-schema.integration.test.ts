/**
 * LP-01: link preview tables apply on the full migration chain and refuse
 * rows that break the object shape the read path relies on.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const KEY = 'a'.repeat(64);

describeWithPostgres('link preview schema', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('link_preview_schema');
    await runMigrations(isolated.runtime.db, 'latest');
  });
  afterAll(async () => isolated?.close());

  const insert = (values: Record<string, unknown>) => {
    const row = { url_key: KEY, normalized_url: 'https://example.com/', site: 'example.com', ...values };
    const columns = Object.keys(row);
    return isolated.runtime.pool.query(
      `INSERT INTO link_preview_targets (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const rejects = async (values: Record<string, unknown>, constraint: string) => {
    await assert.rejects(insert(values), (error: { constraint?: string }) => error.constraint === constraint);
  };

  test('a pending target defaults to an empty, due row', async () => {
    await insert({});
    const { rows } = await isolated.runtime.pool.query('SELECT * FROM link_preview_targets WHERE url_key=$1', [KEY]);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].object_id, null);
    assert.equal(rows[0].generic, false);
    assert.ok(rows[0].next_attempt_at.getTime() <= Date.now());
    await isolated.runtime.pool.query('DELETE FROM link_preview_targets');
  });

  test('constraints reject malformed keys, statuses and partial image descriptions', async () => {
    await rejects({ url_key: 'not-a-digest' }, 'link_preview_targets_url_key');
    await rejects({ status: 'done' }, 'link_preview_targets_status');
    await rejects({ source: 'screenshot' }, 'link_preview_targets_source');
    await rejects({ status: 'ready' }, 'link_preview_targets_ready_has_object');
    await rejects({ object_id: randomUUID() }, 'link_preview_targets_object_shape');
    await rejects(
      { object_id: randomUUID(), width: 0, height: 10, mime: 'image/png', digest: 'd' },
      'link_preview_targets_object_shape',
    );
    await insert({
      status: 'ready', object_id: randomUUID(), width: 1200, height: 630, mime: 'image/png', digest: 'd', source: 'og',
    });
  });

  test('owner preference mode is limited to auto and none', async () => {
    const { rows } = await isolated.runtime.pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'bookmark_preview_prefs_mode'
    `);
    assert.match(rows[0].definition, /'auto'.*'none'/u);
  });
});
