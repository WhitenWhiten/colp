import { test, expect } from 'vitest';
import { inviteMember, revokeInvite, updateMemberRole, removeMember } from '../../../src/modules/access-policy/application/collaboration-commands.js';
import type { CollaborationCommandPorts } from '../../../src/modules/access-policy/application/ports.js';
import { mapCollaborationHttpError } from '../../../src/transport/product/product-collaboration-routes.js';

for (const operation of ['invite', 'revoke', 'update', 'remove'] as const) {
  for (const visibility of ['private', 'protected', 'unlisted'] as const) {
  for (const ifMatch of [undefined, '"guessed"', '"secret-revision-27"']) {
  test(`AUTH-02: ${operation} conceals ${visibility} from outsiders with ${ifMatch}`,  async () => {
    let authorizationCalls = 0;
    const ports = {
      receipts: { claim: async () => ({ kind: 'claimed' }) },
      collections: { lockForUpdate: async () => ({ deletedAt: null, policyRevision: 'secret-revision-27', ownerSubjectId: 'owner' }) },
      facts: { loadCollectionFacts: async () => { authorizationCalls++; return { visibility, ownerSubjectId: 'owner', membershipRole: null, deleted: false, policyRevision: 'secret-revision-27' }; } },
    } as unknown as CollaborationCommandPorts;
    const input = {
      actor: { kind: 'account' as const, principalId: 'outsider', subjectId: 'outsider', email: 'outsider@example.test' },
      command: { commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a', fingerprint: 'a'.repeat(64) },
      collectionId: 'private-collection', inviteId: 'invite', subjectId: 'victim', email: 'target@example.test', role: 'viewer', ifMatch,
    };
    const fn = { invite: inviteMember, revoke: revokeInvite, update: updateMemberRole, remove: removeMember }[operation];
    const error = await fn(ports, input).then(() => null, error => error);
    const http = mapCollaborationHttpError(error);
    expect(http.statusCode).toBe(404);
    expect(error.currentEtag).toBeUndefined();
    expect(authorizationCalls).toBe(1);
  });
}


}
}

for (const operation of [inviteMember, revokeInvite, updateMemberRole, removeMember]) {
  test(`AUTH-02: ${operation.name} preserves authorized stale-version response`, async () => {
    const ports = {
      receipts: { claim: async () => ({ kind: 'claimed' }) },
      collections: { lockForUpdate: async () => ({ deletedAt: null, policyRevision: '27', ownerSubjectId: 'owner' }) },
      facts: { loadCollectionFacts: async () => ({ visibility: 'private', ownerSubjectId: 'owner', membershipRole: 'owner', deleted: false, policyRevision: '27' }) },
    } as unknown as CollaborationCommandPorts;
    const error = await operation(ports, {
      actor: { kind: 'account', principalId: 'owner', subjectId: 'owner', email: 'owner@example.test' },
      command: { commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a', fingerprint: 'a'.repeat(64) },
      collectionId: 'private-collection', inviteId: 'invite', subjectId: 'victim', email: 'target@example.test', role: 'viewer', ifMatch: '"stale"',
    }).then(() => null, error => error);
    expect(mapCollaborationHttpError(error).statusCode).toBe(412);
    expect(error.currentEtag).toBe('"27"');
  });
}

test('AUTH-02: pretending to self-leave does not reveal revision to a nonmember', async () => {
  const ports = {
    receipts: { claim: async () => ({ kind: 'claimed' }) },
    collections: { lockForUpdate: async () => ({ deletedAt: null, policyRevision: '27', ownerSubjectId: 'owner' }) },
    store: { findMembership: async () => null },
  } as unknown as CollaborationCommandPorts;
  const error = await removeMember(ports, {
    actor: { kind: 'account', principalId: 'outsider', subjectId: 'outsider', email: 'outsider@example.test' },
    command: { commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a', fingerprint: 'a'.repeat(64) },
    collectionId: 'private-collection', subjectId: 'outsider', ifMatch: '"stale"',
  }).then(() => null, error => error);
  expect(mapCollaborationHttpError(error).statusCode).toBe(404);
  expect(error.currentEtag).toBeUndefined();
});
