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

  test.each(['content', 'policy', 'missing', 'series', 'period', 'unchanged'] as const)('approved publish checks authoritative source: %s', async mode => {
    const f = await setup(true);
    const sourceId = 'src-' + randomUUID(), rootId = 'root-' + randomUUID();
    const subjectId = String(f.context().authorization.accountSubjectId);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`INSERT INTO resource_id_ledger(resource_id,resource_type)
        VALUES ($1,'collection'),($2,'node')`, [sourceId,rootId]);
      await client.query(`INSERT INTO collections(id,owner_subject_id,title,kind,visibility,allow_search_indexing,
        publication_slug,published_at,root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,commit_ordinal)
        VALUES ($1,$2,'Source','bookmarks','public',true,$3,current_timestamp,$4,true,'sr1','source-content-1','sp1',1)`,
        [sourceId,subjectId,sourceId,rootId]);
      await client.query(`INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,position_token,resource_revision,children_revision)
        VALUES ($1,$2,NULL,'folder',true,'Root',NULL,'nr1','nc1')`, [rootId,sourceId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const edition = await attachDigestEdition(f.reports, { actor: { principalId: f.binding.principalId, subjectId },
      commandId: randomUUID(), seriesId: f.seriesId, sourceCollectionId: sourceId, issueKey: 'issue-1', titleSnapshot: 'Approved issue' });
    if (edition.kind !== 'succeeded') throw new Error('fixture');
    const series = await f.reports.execute(ports => ports.series.lockById(f.seriesId));
    let plan = await createMcpReportPlan({ planId: randomUUID(), binding: f.binding,
      requiredScopes: ['reports:write','reports:publish'], reportRevision: series!.resourceRevision,
      sourceRevisions: { [sourceId]: 'source-content-1' }, expiresAt: new Date(Date.now()+60000).toISOString(), store: f.store,
      operations: [{ type: 'report', action: mode === 'period' ? 'edition.update' : 'edition.publish', targetId: edition.value.id,
        expectedRevision: edition.value.resourceRevision, patch: mode === 'period'
          ? { periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-02T00:00:00Z' } : {} }] });
    if (mode !== 'content') {
      const planned = await createDurableReportWritePort(f).callTool(f.context(), 'reports.plan', {
        operations: plan.operations, reportRevision: series!.resourceRevision,
      });
      assert.equal(planned.kind, 'complete', JSON.stringify(planned));
      if (planned.kind !== 'complete') throw new Error('fixture');
      plan = planned.structuredContent as typeof plan;
      assert.ok(plan.sourceRevisions[sourceId]?.startsWith('source.'));
    }
    await approveMcpReportPlan(f.store, plan.planId, f.binding);
    if (mode === 'series') await f.reports.execute(ports => ports.series.update(f.seriesId, { title: 'Changed report', resourceRevision: 'changed-report-revision' }));
    if (mode === 'content') await isolated.runtime.pool.query("UPDATE collections SET content_revision='source-content-2' WHERE id=$1", [sourceId]);
    if (mode === 'policy') await isolated.runtime.pool.query("UPDATE collections SET policy_revision='source-policy-2' WHERE id=$1", [sourceId]);
    if (mode === 'missing') {
      const deletion = await isolated.runtime.pool.connect();
      try {
        await deletion.query('BEGIN');
        await deletion.query('SET CONSTRAINTS ALL DEFERRED');
        await deletion.query('UPDATE collections SET deleted_at=current_timestamp WHERE id=$1', [sourceId]);
        await deletion.query('UPDATE nodes SET deleted_at=current_timestamp WHERE id=$1', [rootId]);
        await deletion.query('COMMIT');
      } catch (error) { await deletion.query('ROLLBACK'); throw error; }
      finally { deletion.release(); }
    }
    const output = await createDurableReportWritePort(f).callTool(f.context(), 'reports.commit',
      { planId: plan.planId, idempotencyKey: 'publish-key' });
    const persisted = await isolated.runtime.db.selectFrom('digest_editions').selectAll().where('id','=',edition.value.id).executeTakeFirstOrThrow();
    assert.equal(output.kind, mode === 'unchanged' || mode === 'period' ? 'complete' : 'rejected', JSON.stringify({ output, editionState: persisted.state }));
    assert.equal(persisted.state, mode === 'unchanged' ? 'published' : 'draft');
    if (mode === 'period') {
      assert.equal(persisted.period_start?.toISOString(), '2026-09-01T00:00:00.000Z');
      assert.equal(persisted.period_end?.toISOString(), '2026-09-02T00:00:00.000Z');
    }
  });

});
