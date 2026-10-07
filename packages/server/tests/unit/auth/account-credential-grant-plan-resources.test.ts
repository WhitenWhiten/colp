import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reportSeriesResourceIds } from '../../../src/infrastructure/auth/account-credential-grants-postgres.js';
import { grantMatchesPlan } from '../../../src/modules/auth/application/account-credentials/grant-plan.js';
import type { McpReportPlan, McpReportPlanOperation } from '../../../src/modules/mcp/index.js';
import type { CredentialGrantRecord, StoredCredentialPlan } from '../../../src/modules/auth/index.js';

function reportPlan(operations: readonly McpReportPlanOperation[]): McpReportPlan {
  return {
    planId: 'plan-1',
    operations,
    operationsDigest: 'sha-256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    binding: {
      kind: 'authenticated',
      principalId: 'account-1',
      clientId: 'client-1',
      credentialBindingId: 'binding-1',
      resourceAudience: 'https://app.example.test/collections/-/mcp',
      securityEpoch: 'epoch-1',
    },
    requiredScopes: ['reports:write', 'reports:publish'],
    reportRevision: '1',
    sourceRevisions: {},
    expiresAt: '2026-12-01T00:00:00.000Z',
    approval: { status: 'pending' },
    status: 'pending',
  };
}

test('report Plan resource ids resolve edition targets to the series id', async () => {
  const editions = new Map([['edition-1', 'series-1'], ['edition-2', 'series-2']]);
  const lookup = async (editionId: string) => editions.get(editionId) ?? null;

  assert.deepEqual(await reportSeriesResourceIds(reportPlan([{
    type: 'report', action: 'edition.publish', targetId: 'edition-1', expectedRevision: '1', patch: {},
  }]), lookup), ['series-1']);
  assert.deepEqual(await reportSeriesResourceIds(reportPlan([{
    type: 'report', action: 'edition.update', targetId: 'edition-1', expectedRevision: '1',
    patch: { titleSnapshot: 'Issue' },
  }]), lookup), ['series-1']);
  assert.deepEqual(await reportSeriesResourceIds(reportPlan([
    {
      type: 'report', action: 'series.update', targetId: 'series-1', expectedRevision: '1',
      patch: { visibility: 'unlisted' },
    },
    {
      type: 'report', action: 'edition.publish', targetId: 'edition-1', expectedRevision: '1', patch: {},
    },
  ]), lookup), ['series-1']);
  assert.deepEqual(await reportSeriesResourceIds(reportPlan([
    {
      type: 'report', action: 'series.update', targetId: 'series-1', expectedRevision: '1',
      patch: { visibility: 'unlisted' },
    },
    {
      type: 'report', action: 'edition.publish', targetId: 'edition-2', expectedRevision: '1', patch: {},
    },
  ]), lookup), ['series-1', 'series-2']);
  assert.deepEqual(await reportSeriesResourceIds(reportPlan([{
    type: 'report', action: 'edition.attach', seriesId: 'series-1', sourceCollectionId: 'col-1',
    patch: { issueKey: 'i-1', titleSnapshot: 'Issue' },
  }]), lookup), ['series-1']);
  const missing = await reportSeriesResourceIds(reportPlan([{
    type: 'report', action: 'edition.publish', targetId: 'missing-edition', expectedRevision: '1', patch: {},
  }]), lookup);
  assert.deepEqual(missing, []);
  assert.equal(missing.includes('missing-edition'), false);
  assert.deepEqual(await reportSeriesResourceIds(reportPlan([{
    type: 'report', action: 'series.create', patch: { title: 'New digest' },
  }]), lookup), []);
});

test('grantMatchesPlan stays exact on one series id', () => {
  const grant: CredentialGrantRecord = {
    id: 'grant-1',
    credentialId: 'child-1',
    ownerAccountId: 'account-1',
    resource: { kind: 'report', id: 'series-1' },
    actions: Object.freeze(['report.issue.publish']),
    state: 'active',
    revision: 1n,
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    revokedAt: null,
    revokeReason: null,
  };
  const stored = (resourceIds: readonly string[]): StoredCredentialPlan => ({
    planKind: 'report',
    planId: 'plan-1',
    operationsDigest: 'sha-256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    requiredScopes: Object.freeze(['reports:write', 'reports:publish']),
      requiredActions: ['report.issue.publish'],
    status: 'pending',
    approvalStatus: 'pending',
    expiresAt: '2026-12-01T00:00:00.000Z',
    binding: {
      kind: 'authenticated',
      principalId: 'account-1',
      clientId: 'client-1',
      credentialBindingId: 'binding-1',
      resourceAudience: 'https://app.example.test/collections/-/mcp',
      securityEpoch: 'epoch-1',
    },
    resourceIds: Object.freeze([...resourceIds]),
  });
  assert.equal(grantMatchesPlan(grant, stored(['series-1'])), true);
  assert.equal(grantMatchesPlan(grant, stored(['edition-1'])), false);
  assert.equal(grantMatchesPlan(grant, stored([])), false);
  assert.equal(grantMatchesPlan(grant, stored(['series-1', 'series-2'])), false);
});
