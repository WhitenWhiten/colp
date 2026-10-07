import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresReportUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import { createPostgresMcpReportPlanStore } from '../../../src/infrastructure/auth/account-credential-grants-postgres.js';
import { createDurableReportWritePort } from '../../../src/bootstrap/account-credential-grant-composition.js';
import { createDigestSeries, attachDigestEdition, listPublicReportDirectory } from '../../../src/modules/reports/index.js';
import { createMcpReportPlan, approveMcpReportPlan } from '../../../src/modules/mcp/report-plan.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('AUDIT report MCP production boundaries', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('audit_report_boundaries', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());

  async function setup(publicSeries = false) {
    const suffix = randomUUID();
    const accountId = `a-${suffix}`, subjectId = `s-${suffix}`;
    await isolated.runtime.pool.query("INSERT INTO accounts(id,subject_id,status) VALUES ($1,$2,'active')", [accountId,subjectId]);
    const reports = createPostgresReportUnitOfWork(isolated.runtime.db);
    const created = await createDigestSeries(reports, { actor: { principalId: accountId, subjectId },
      commandId: randomUUID(), title: 'Private original',
      ...(publicSeries ? { visibility: 'public' as const, slug: 'audit-' + suffix } : {}) });
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') throw new Error('fixture');
    const binding = { kind: 'authenticated' as const, principalId: accountId, clientId: 'client',
      credentialBindingId: `cred-${suffix}`, resourceAudience: 'https://known.example/mcp', securityEpoch: 'e1' };
    const store = createPostgresMcpReportPlanStore(isolated.runtime.db);
    const plan = await createMcpReportPlan({ planId: randomUUID(), binding, requiredScopes: ['reports:write'],
      reportRevision: created.value.resourceRevision, expiresAt: new Date(Date.now()+60000).toISOString(), store,
      operations: [{ type: 'report', action: 'series.update', targetId: created.value.id,
        expectedRevision: created.value.resourceRevision, patch: { title: 'Private committed title' } }] });
    const context = (principal = binding) => createMcpApplicationContext({ principal, scopes: ['reports:write', 'reports:publish'],
      abortSignal: new AbortController().signal, budgets: { maxDepth: 16, maxNodes: 100, maxBytes: 65536, maxOperations: 20 },
      correlationId: suffix, authorization: { accountSubjectId: subjectId } });
    return { reports, store, plan, binding, context, seriesId: created.value.id };
  }

  test('AUDIT: private series must not exhaust the anonymous directory', async () => {
    const f = await setup();
    const prefix = 'private-' + randomUUID();
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`INSERT INTO resource_id_ledger(resource_id,resource_type)
        SELECT $1 || '-' || n, 'digest_series' FROM generate_series(1,2001) n`, [prefix]);
      await client.query(`INSERT INTO digest_series(id,owner_subject_id,title,visibility,state,
        allow_search_indexing,resource_revision,content_revision,policy_revision,commit_ordinal)
        SELECT $1 || '-' || n, $2, 'Private draft', 'private', 'active', false, 'r1', 'c1', 'p1', 1
        FROM generate_series(1,2001) n`, [prefix, f.context().authorization.accountSubjectId]);
      await client.query(`INSERT INTO digest_members(series_id,subject_id,role)
        SELECT $1 || '-' || n, $2, 'owner' FROM generate_series(1,2001) n`, [prefix, f.context().authorization.accountSubjectId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const result = await listPublicReportDirectory(f.reports,
      { active: { id: 'audit', secret: Buffer.alloc(32,7).toString('base64') } }, 1);
    assert.deepEqual(result.items, []);
    // Keep the 2,001-row private-capacity regression above, then expose only
    // enough rows to prove traversal across one keyset boundary. Walking every
    // fixture row adds no coverage and can outlive the cursor under shard load.
    const publicSeriesCount = 101;
    await isolated.runtime.pool.query(`UPDATE digest_series SET visibility='public', slug=id
      WHERE id IN (SELECT id FROM digest_series WHERE id LIKE $1 ORDER BY id LIMIT $2)`,
    [prefix + '-%', publicSeriesCount]);
    const config = { active: { id: 'audit', secret: Buffer.alloc(32,7).toString('base64') } };
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await listPublicReportDirectory(f.reports, config, 100, cursor);
      for (const item of page.items) {
        assert.ok(!seen.has(item.id), 'keyset pages must not repeat a series');
        seen.add(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.size, publicSeriesCount);

  });

});
