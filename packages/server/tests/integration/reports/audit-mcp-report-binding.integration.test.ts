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

  test('AUDIT: committed report result must not replay to another binding', async () => {
    const f = await setup();
    const port = createDurableReportWritePort(f);
    const args = { planId: f.plan.planId, idempotencyKey: 'known-key' };
    assert.equal((await port.callTool(f.context(), 'reports.commit', args)).kind, 'complete');
    const otherAccount = await setup();
    const replay = await port.callTool(otherAccount.context(), 'reports.commit', args);
    assert.equal(replay.kind, 'rejected', JSON.stringify(replay));
  });

});
