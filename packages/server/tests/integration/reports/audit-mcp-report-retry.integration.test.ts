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

  test('AUDIT: retry recovers after mutation commits but saving the plan result fails', async () => {
    const f = await setup();
    let fail = true;
    const store = { ...f.store, update: async (plan: Parameters<typeof f.store.update>[0]) => {
      if (fail) { fail = false; throw new Error('result persistence outage'); }
      await f.store.update(plan);
    } };
    const port = createDurableReportWritePort({ ...f, store });
    const args = { planId: f.plan.planId, idempotencyKey: 'retry-key' };
    assert.equal((await port.callTool(f.context(), 'reports.commit', args)).kind, 'rejected');
    const row = await isolated.runtime.db.selectFrom('digest_series').select('title').where('id','=',f.seriesId).executeTakeFirstOrThrow();
    assert.equal(row.title, 'Private committed title');
    assert.equal((await f.store.get(f.plan.planId))?.status, 'pending');
    assert.equal((await port.callTool(f.context(), 'reports.commit', { ...args, idempotencyKey: 'other-key' })).kind, 'rejected');
    const retry = await port.callTool(f.context(), 'reports.commit', args);
    assert.equal(retry.kind, 'complete', JSON.stringify(retry));
  });
  test('a later operation failure rolls back all earlier report mutations', async () => {
    const f = await setup();
    const plan = await createMcpReportPlan({ planId: randomUUID(), binding: f.binding,
      requiredScopes: ['reports:write'], reportRevision: f.plan.reportRevision,
      expiresAt: new Date(Date.now()+60000).toISOString(), store: f.store,
      operations: [...f.plan.operations, { type: 'report', action: 'edition.update',
        targetId: 'missing-edition', expectedRevision: 'r1', patch: { titleSnapshot: 'Missing' } }] });
    const output = await createDurableReportWritePort(f).callTool(f.context(), 'reports.commit',
      { planId: plan.planId, idempotencyKey: 'atomic-key' });
    assert.equal(output.kind, 'rejected');
    const row = await isolated.runtime.db.selectFrom('digest_series').selectAll()
      .where('id', '=', f.seriesId).executeTakeFirstOrThrow();
    assert.equal(row.title, 'Private original');
    assert.equal(row.resource_revision, f.plan.reportRevision);
  });

  test('the executor applies the approved series slug when publicizing', async () => {
    const f = await setup();
    const slug = 'publish-' + randomUUID();
    const plan = await createMcpReportPlan({ planId: randomUUID(), binding: f.binding,
      requiredScopes: ['reports:write', 'reports:publish'], reportRevision: f.plan.reportRevision,
      expiresAt: new Date(Date.now()+60000).toISOString(), store: f.store,
      operations: [{ ...f.plan.operations[0]!, patch: { slug, visibility: 'public' } }] });
    await approveMcpReportPlan(f.store, plan.planId, f.binding);
    const output = await createDurableReportWritePort(f).callTool(f.context(), 'reports.commit',
      { planId: plan.planId, idempotencyKey: 'publicize' });
    assert.equal(output.kind, 'complete', JSON.stringify(output));
    const row = await isolated.runtime.db.selectFrom('digest_series').selectAll()
      .where('id', '=', f.seriesId).executeTakeFirstOrThrow();
    assert.equal(row.slug, slug);
    assert.equal(row.visibility, 'public');
  });

});
