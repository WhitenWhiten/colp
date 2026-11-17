import { expect, test } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicationMetadataReadPort } from '../../../src/infrastructure/publication/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';

/**
 * P2 regression: an aborted statement is abandoned in the background, so its
 * pooled checkout must be destroyed instead of released. With `max=1` the old
 * behavior re-pooled the still-busy client, and the next checkout's statement
 * queued behind the abandoned one until the backend finished it.
 */
describeWithPostgres('aborted PostgreSQL statements never return a busy connection to the pool', () => {
  test('a max=1 pool serves the next checkout promptly after a failed cancel', async () => {
    const isolated = await createIsolatedPostgresRuntime('abort_pool_release', { maxConnections: 1 });
    const lockHolder = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
    let held: PoolClient | undefined;
    try {
      await runMigrations(isolated.runtime.db, 'latest');
      // Block the reader's `select ... from collections` so the statement is
      // genuinely running on its backend when the abort lands.
      held = await lockHolder.connect();
      await held.query('BEGIN');
      await held.query('LOCK TABLE collections IN ACCESS EXCLUSIVE MODE');

      const controller = new AbortController();
      const reason = new Error('client disconnected');
      const port = createPostgresPublicationMetadataReadPort({
        pool: isolated.runtime.pool,
        // The controlled cancel cannot stop this backend: the reproduction
        // reported by the review.
        cancelBackend: async () => false,
      });
      const load = port.load({
        collectionId: 'abort-pool-release-missing',
        actorSubjectId: 'actor',
        signal: controller.signal,
      });

      // Wait until the reader's backend is blocked on the lock.
      const deadline = Date.now() + 5_000;
      let waiting = 0;
      while (waiting < 1 && Date.now() < deadline) {
        const activity = await held.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
            where application_name = $1 and wait_event_type = 'Lock' and state = 'active'`,
          ['known-test-abort_pool_release'],
        );
        waiting = activity.rows[0]?.count ?? 0;
        if (waiting < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(1);

      const abortStarted = Date.now();
      controller.abort(reason);
      await expect(load).rejects.toBe(reason);
      // The request returns with the signal reason without waiting for the
      // abandoned statement (no statement_timeout, the lock is never released).
      expect(Date.now() - abortStarted).toBeLessThan(2_000);

      const checkoutStarted = Date.now();
      const probe = await Promise.race([
        isolated.runtime.pool.query<{ ok: number }>('select 1 as ok').then(
          (result) => (result.rows[0]?.ok === 1 ? 'ready' as const : 'failed' as const),
          () => 'failed' as const,
        ),
        new Promise<'blocked'>((resolve) => { setTimeout(() => resolve('blocked'), 2_000).unref(); }),
      ]);
      expect(probe, 'the next checkout must not queue behind the abandoned statement').toBe('ready');
      expect(Date.now() - checkoutStarted).toBeLessThan(2_000);
      expect(isolated.runtime.pool.waitingCount).toBe(0);
    } finally {
      if (held) { await held.query('ROLLBACK').catch(() => undefined); held.release(); }
      await lockHolder.end().catch(() => undefined);
      // The abandoned backend is still waiting on the released lock; terminate
      // it so the isolated schema can be dropped without racing its cleanup.
      await isolated.runtime.pool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where application_name = $1 and state = 'active' and pid <> pg_backend_pid()`,
        ['known-test-abort_pool_release'],
      ).catch(() => undefined);
      await isolated.close();
    }
  }, 30_000);
});
