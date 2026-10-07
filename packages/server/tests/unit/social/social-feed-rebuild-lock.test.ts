import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { test } from 'vitest';
import { createPostgresSocialFeedWorkerRepository } from '../../../src/infrastructure/social/index.js';

test('Feed rebuild evicts a PostgreSQL session when advisory unlock fails', async () => {
  const controller = new AbortController();
  const unlockFailure = new Error('connection failed while unlocking');
  const releases: Array<Error | boolean | undefined> = [];
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        controller.abort(new Error('stop after acquiring the lock'));
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (text === 'rollback') return { rows: [], rowCount: null };
      if (text.includes('pg_advisory_unlock')) throw unlockFailure;
      throw new Error(`Unexpected query: ${text}`);
    },
    release(error?: Error | boolean) { releases.push(error); },
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresSocialFeedWorkerRepository(pool);

  await assert.rejects(repository.rebuildCollectionScope({
    aggregateScope: 'collection-lock-scope',
    maxEvents: 1,
    maxRecipients: 1,
    signal: controller.signal,
  }), /stop after acquiring the lock/u);

  assert.equal(queries.filter((query) => query.includes('pg_advisory_unlock')).length, 1);
  assert.deepEqual(releases, [unlockFailure]);
});

test('Feed rebuild does not unlock a scope it failed to acquire', async () => {
  const releases: Array<Error | boolean | undefined> = [];
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: false }], rowCount: 1 };
      }
      if (text === 'rollback') return { rows: [], rowCount: null };
      throw new Error(`Unexpected query: ${text}`);
    },
    release(error?: Error | boolean) { releases.push(error); },
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresSocialFeedWorkerRepository(pool);

  await assert.rejects(repository.rebuildCollectionScope({
    aggregateScope: 'busy-collection-scope',
    maxEvents: 1,
    maxRecipients: 1,
  }), /already leased/u);

  assert.equal(queries.some((query) => query.includes('pg_advisory_unlock')), false);
  assert.deepEqual(releases, [undefined]);
});
