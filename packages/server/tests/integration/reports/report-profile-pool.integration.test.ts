import { test, expect } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresReportsUnitOfWork } from '../../../src/infrastructure/reports/unit-of-work.js';
import { loadPublicProjectionData } from '../../../src/modules/reports/application/public-projection-loader.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('report projection uses its transaction for curator facts', () => {
  test.each([1, 2, 10])('does not reenter a saturated %i-connection pool', async maxConnections => {
    const isolated = await createIsolatedPostgresRuntime(`report_profiles_${maxConnections}`, { maxConnections });
    try {
      await runMigrations(isolated.runtime.db, 'latest');
      const reports = createPostgresReportsUnitOfWork(isolated.runtime.db);
      const series = { id: 'series', ownerSubjectId: 'owner', title: 'Report', summary: null, slug: 'report',
        visibility: 'public' as const, allowSearchIndexing: true, state: 'active' as const,
        resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1' };
      let entered = 0, ownerReads = 0;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const started = Date.now();
      const results = await Promise.all(Array.from({ length: maxConnections }, () => reports.execute(async ports => {
        if (++entered === maxConnections) release(); await barrier;
        expect(ports.ownerProfiles).toBeDefined();
        const result = await loadPublicProjectionData({ ...ports, ownerProfiles: { findManyByOwnerSubjectIds: ids => {
          ownerReads++; return ports.ownerProfiles!.findManyByOwnerSubjectIds(ids);
        } } }, series);
        return result;
      })));
      expect(entered).toBe(maxConnections); expect(ownerReads).toBe(maxConnections);
      expect(results.every(result => result.owner === null)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(isolated.runtime.pool.waitingCount).toBe(0);
      expect(isolated.runtime.pool.idleCount).toBe(isolated.runtime.pool.totalCount);
    } finally { await isolated.close(); }
  });
});
