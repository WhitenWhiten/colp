import { test, expect } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/postgres-search-candidate.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('search cancellation owns an independent control connection', () => {
  test.each([1, 2, 10])('returns every connection when the %i-connection pool is saturated', async maxConnections => {
    const isolated = await createIsolatedPostgresRuntime(`search_cancel_${maxConnections}`, { maxConnections });
    const locks = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
    let held: PoolClient | undefined;
    try {
      await runMigrations(isolated.runtime.db, 'latest');
      held = await locks.connect(); await held.query('BEGIN');
      await held.query('LOCK TABLE collections IN ACCESS EXCLUSIVE MODE');
      const controller = new AbortController();
      const jobs = Array.from({ length: maxConnections }, () => createPostgresSearchCandidatePort(isolated.runtime.db)
        .listCandidates({ query: 'needle', types: ['collection'], projection: { kind: 'anonymous' }, limit: 10,
          timeoutMs: 5000, signal: controller.signal }).then(() => 'success', error => error));
      const deadline = Date.now() + 2000;
      let waiting = 0;
      while (waiting < maxConnections && Date.now() < deadline) {
        await held.query('SELECT pg_stat_clear_snapshot()');
        const result = await held.query<{ count: number }>("select count(*)::int count from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
          [`known-test-search_cancel_${maxConnections}`]);
        waiting = result.rows[0]!.count;
        if (waiting < maxConnections) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(maxConnections);
      const reason = new Error('client disconnected'), started = Date.now(); controller.abort(reason);
      const outcomes = await Promise.all(jobs);
      expect(outcomes.every(value => value === reason)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(isolated.runtime.pool.waitingCount).toBe(0);
      expect(isolated.runtime.pool.idleCount).toBe(isolated.runtime.pool.totalCount);
    } finally {
      if (held) { await held.query('ROLLBACK'); held.release(); }
      await locks.end(); await isolated.close();
    }
  });
});
