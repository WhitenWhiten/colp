import { describe, expect, it, vi } from 'vitest';
import { createAutoApproveTrustedPlan, type AutoApproveTrustedPlanActions } from '../../../src/modules/mcp/agent-plan-policy.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import type { Phase4bMcpPlannedChange } from '../../../src/modules/mcp/change-plan-planner.js';
import { createInMemoryMcpOauthRevocationStore } from '../../../src/modules/mcp/oauth-revocation-store.js';

const binding = { kind: 'authenticated' as const, principalId: 'owner', clientId: 'agent',
  credentialBindingId: 'key', resourceAudience: 'https://example.test/mcp', securityEpoch: 'epoch' };
const planned = { planId: 'plan', operations: [{ type: 'move_node', collectionId: 'collection' }],
  baseRevisions: { 'content.collection': 'revision' }, requiresApproval: true,
  risk: 'medium', operationsDigest: 'digest' } as Phase4bMcpPlannedChange;

describe('trusted plan commit admission', () => {
  function harness() {
    const captureVersion = vi.fn(async () => ({ versionId: 'version' }));
    const commit = vi.fn(async () => ({} as never));
    const approve = vi.fn(async () => undefined);
    const policy = createAutoApproveTrustedPlan({ readPolicy: async () => 'trusted', captureVersion,
      saveReceipt: async () => undefined, audit: async () => undefined });
    return { policy, captureVersion, commit, approve };
  }

  it.each([undefined, false])('missing or denied commit authority does no version or write work: %s', async canCommit => {
    const h = harness();
    expect(await h.policy(planned, binding, { canCommit, commit: h.commit, approve: h.approve })).toBe(planned);
    expect(h.captureVersion).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('verified commit authority restores trusted reversible single-collection commits', async () => {
    const h = harness();
    const actions: AutoApproveTrustedPlanActions = { canCommit: true, commit: h.commit, approve: h.approve };
    const result = await runWithMcpAccountSubjectId('subject', () => h.policy(planned, binding, actions));
    expect(result).toMatchObject({ status: 'consumed', approvedBy: 'policy', versionId: 'version' });
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it.each([
    { ...planned, operations: [{ type: 'delete_subtree', collectionId: 'collection' }] },
    { ...planned, baseRevisions: { 'content.collection': 'revision', 'content.other': 'revision' } },
  ])('irreversible or multiple-collection plans keep owner approval', async plan => {
    const h = harness();
    expect(await h.policy(plan as Phase4bMcpPlannedChange, binding,
      { canCommit: true, commit: h.commit, approve: h.approve })).toBe(plan);
    expect(h.captureVersion).not.toHaveBeenCalled();
  });

  it('a signed incident epoch admits fresh same-second tokens and rejects earlier rotations', async () => {
    const store = createInMemoryMcpOauthRevocationStore({ now: () => new Date('2026-10-08T00:00:00.500Z'), securityEpoch: 'new' });
    const query = { issuer: 'issuer', subject: 'subject', clientId: 'client', tokenId: 'token',
      credentialDigest: 'digest', issuedAtSeconds: Date.parse('2026-10-08T00:00:00Z') / 1000 };
    expect(await store.isRevoked(query)).toBe(true);
    expect(await store.isRevoked({ ...query, issuedSecurityEpoch: 'old' })).toBe(true);
    expect(await store.isRevoked({ ...query, issuedSecurityEpoch: 'new' })).toBe(false);
    await store.revoke(query);
    expect(await store.isRevoked({ ...query, issuedSecurityEpoch: 'new' })).toBe(true);
  });
});
