import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createDatabaseFaviconStore } from '../../../src/infrastructure/collections/favicon-database-store.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const OTHER_PNG = Buffer.concat([PNG, Buffer.from('different image')]);

describeWithPostgres('favicon database objects are created atomically', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_create_only', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('a duplicate PUT rejects instead of silently accepting a different body', async () => {
    const store = createDatabaseFaviconStore(isolated.runtime.db), id = randomUUID();
    await store.put(id, PNG, 'image/png');
    await assert.rejects(() => store.put(id, OTHER_PNG, 'image/png'), /favicon_object_already_exists/u);
    assert.deepEqual((await store.get(id))?.body, PNG);
  });

  test('concurrent writers expose exactly one successful body', async () => {
    const store = createDatabaseFaviconStore(isolated.runtime.db), id = randomUUID();
    const bodies = [PNG, OTHER_PNG];
    const results = await Promise.allSettled(bodies.map(body => store.put(id, body, 'image/png')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    assert.deepEqual((await store.get(id))?.body, bodies[winner]);
    const loser = results.find(result => result.status === 'rejected');
    assert.ok(loser?.status === 'rejected');
    assert.match(String(loser.reason), /favicon_object_already_exists/u);
  });
});
