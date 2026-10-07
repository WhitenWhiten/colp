import { test, expect } from 'vitest';
import { createMcpReportPlan } from '../../../src/modules/mcp/report-plan.js';
import { createCredentialPlanPort } from '../../../src/infrastructure/auth/account-credential-grants-postgres.js';
import { grantMatchesPlan } from '../../../src/modules/auth/application/account-credentials/grant-plan.js';
import type { CredentialGrantRecord } from '../../../src/modules/auth/application/account-credentials/grant-types.js';

test('CG-01: production projection preserves exact actions despite shared report scopes', async () => {
  const plan = await createMcpReportPlan({
    planId: 'fixture-plan',
    operations: [{ type: 'report', action: 'series.update', targetId: 'series-1', expectedRevision: 'r1', patch: { visibility: 'unlisted' } }],
    binding: { kind: 'authenticated', principalId: 'account-1', clientId: 'client-1', credentialBindingId: 'binding-1', resourceAudience: 'https://fixture.example.test/mcp', securityEpoch: 'epoch-1' },
    requiredScopes: ['reports:write'], reportRevision: 'r1', expiresAt: new Date(Date.now() + 60000).toISOString(),
    store: { save: async () => {}, get: async () => undefined, update: async () => {} },
  });
  expect(plan.approval.status).toBe('pending');
  const port = createCredentialPlanPort({
    getCollectionPlan: async () => undefined, approveCollectionPlan: async () => {},
    getReportPlan: async () => plan, approveReportPlan: async () => {}, transaction: {} as never,
  });
  const projected = await port.getPlan('report', plan.planId);
  expect(projected).not.toBe(null);
  const grant: CredentialGrantRecord = {
    id: 'grant-1', credentialId: 'child-1', ownerAccountId: 'account-1', resource: { kind: 'report', id: 'series-1' },
    actions: ['report.issue.write'], state: 'active', revision: 1n,
    expiresAt: new Date(Date.now() + 120000), createdAt: new Date(), revokedAt: null, revokeReason: null,
  };
  expect(await port.verifyDigest(projected!)).toBe(true);
  expect(grantMatchesPlan(grant, projected!)).toBe(false);
  expect(projected!.requiredActions).toEqual(['report.metadata.write']);
  expect(grantMatchesPlan({ ...grant, actions: ['report.issue.withdraw'] }, projected!)).toBe(false);
  expect(grantMatchesPlan({ ...grant, actions: ['report.metadata.write'] }, projected!)).toBe(true);
  expect(grantMatchesPlan({ ...grant, actions: ['report.metadata.write', 'report.issue.write'] }, projected!)).toBe(true);
  expect(grantMatchesPlan(grant, { ...projected!, requiredActions: null })).toBe(false);
  expect(Object.hasOwn(projected!, 'operations')).toBe(false);
});

test('CG-01: mixed metadata and issue operations require both exact actions', async () => {
  const plan = await createMcpReportPlan({
    planId: 'mixed-plan',
    operations: [
      { type: 'report', action: 'series.update', targetId: 'series-1', expectedRevision: 'r1', patch: { title: 'Revised' } },
      { type: 'report', action: 'edition.attach', seriesId: 'series-1', sourceCollectionId: 'col-1', patch: { issueKey: 'issue-1', titleSnapshot: 'Issue' } },
    ],
    binding: { kind: 'authenticated', principalId: 'account-1', clientId: 'client-1', credentialBindingId: 'binding-1', resourceAudience: 'https://fixture.example.test/mcp', securityEpoch: 'epoch-1' },
    requiredScopes: ['reports:write'], reportRevision: 'r1', expiresAt: new Date(Date.now() + 60000).toISOString(),
    store: { save: async () => {}, get: async () => undefined, update: async () => {} },
  });
  const port = createCredentialPlanPort({
    getCollectionPlan: async () => undefined, approveCollectionPlan: async () => {},
    getReportPlan: async () => plan, approveReportPlan: async () => {}, transaction: {} as never,
  });
  const projected = (await port.getPlan('report', plan.planId))!;
  const grant: CredentialGrantRecord = {
    id: 'grant-1', credentialId: 'child-1', ownerAccountId: 'account-1', resource: { kind: 'report', id: 'series-1' },
    actions: ['report.metadata.write'], state: 'active', revision: 1n,
    expiresAt: new Date(Date.now() + 120000), createdAt: new Date(), revokedAt: null, revokeReason: null,
  };
  expect(grantMatchesPlan(grant, projected)).toBe(false);
  expect(grantMatchesPlan({ ...grant, actions: ['report.issue.write'] }, projected)).toBe(false);
  expect(grantMatchesPlan({ ...grant, actions: ['report.metadata.write', 'report.issue.write'] }, projected)).toBe(true);
  expect(grantMatchesPlan({ ...grant, actions: ['report.metadata.write', 'report.issue.write'] }, { ...projected, requiredScopes: ['reports:publish'] })).toBe(false);
});
