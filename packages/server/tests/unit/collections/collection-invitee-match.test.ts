/**
 * C-01 / S-03 invite matching: bound invites are subject-only; unbound
 * invites match product email only. Another account with the same email
 * must not accept an invite already bound to someone else.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  acceptInvite,
  CollaborationError,
  inviteMatchesInvitee,
  purgePendingUnboundInvitesForEmail,
  type CollaborationCommandPorts,
  type CollaborationInviteRecord,
} from '../../../src/modules/access-policy/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';

const NOW = new Date('2026-08-19T00:00:00.000Z');
const COLLECTION = 'col-match';
const OWNER_SUBJECT = 'subject-owner';
const BOUND_SUBJECT = 'subject-bound';
const THIEF_SUBJECT = 'subject-thief';
const SHARED_EMAIL = 'shared@example.test';
const UNBOUND_EMAIL = 'unknown@example.test';

function invite(overrides: Partial<CollaborationInviteRecord> = {}): CollaborationInviteRecord {
  return {
    id: 'invite-1',
    collectionId: COLLECTION,
    role: 'editor',
    emailNormalized: SHARED_EMAIL,
    invitedSubjectId: BOUND_SUBJECT,
    invitedBySubjectId: OWNER_SUBJECT,
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    resolvedAt: null,
    acceptedSubjectId: null,
    collectionTitleSnapshot: 'Match collection',
    ...overrides,
  };
}

describe('inviteMatchesInvitee', () => {
  test('bound invite matches only the bound subject', () => {
    const bound = invite();
    assert.equal(inviteMatchesInvitee(bound, { subjectId: BOUND_SUBJECT, email: SHARED_EMAIL }), true);
    assert.equal(inviteMatchesInvitee(bound, { subjectId: THIEF_SUBJECT, email: SHARED_EMAIL }), false);
    assert.equal(inviteMatchesInvitee(bound, { subjectId: BOUND_SUBJECT, email: 'other@example.test' }), true);
  });

  test('unbound invite matches only the normalized product email', () => {
    const unbound = invite({ invitedSubjectId: null, emailNormalized: UNBOUND_EMAIL });
    assert.equal(inviteMatchesInvitee(unbound, { subjectId: THIEF_SUBJECT, email: UNBOUND_EMAIL }), true);
    assert.equal(inviteMatchesInvitee(unbound, { subjectId: THIEF_SUBJECT, email: '  UNKNOWN@example.test  ' }), true);
    assert.equal(inviteMatchesInvitee(unbound, { subjectId: BOUND_SUBJECT, email: SHARED_EMAIL }), false);
  });
});

describe('acceptInvite subject-bound matching', () => {
  test('a different account with the same email cannot accept a bound invite', async () => {
    const record = invite();
    const members: Array<{ collectionId: string; subjectId: string; role: 'owner' | 'editor' | 'viewer'; grantedAt: Date }> = [
      { collectionId: COLLECTION, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW },
    ];
    await assert.rejects(
      () => acceptInvite(createAcceptPorts(record, members), {
        actor: {
          principalId: 'principal-thief',
          subjectId: THIEF_SUBJECT,
          kind: 'account',
          email: SHARED_EMAIL,
        },
        command: { commandId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', fingerprint: 'a'.repeat(64) },
        collectionId: COLLECTION,
        inviteId: record.id,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CollaborationError);
        assert.equal(error.code, 'conceal');
        return true;
      },
    );
    assert.equal(record.status, 'pending');
    assert.equal(members.some((row) => row.subjectId === THIEF_SUBJECT), false);
  });

  test('the bound subject can accept even if the product email later differs', async () => {
    const record = invite();
    const members: Array<{ collectionId: string; subjectId: string; role: 'owner' | 'editor' | 'viewer'; grantedAt: Date }> = [
      { collectionId: COLLECTION, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW },
    ];
    const result = await acceptInvite(createAcceptPorts(record, members), {
      actor: {
        principalId: 'principal-bound',
        subjectId: BOUND_SUBJECT,
        kind: 'account',
        email: 'new@example.test',
      },
      command: { commandId: '11111111-2222-4333-8444-555555555555', fingerprint: 'b'.repeat(64) },
      collectionId: COLLECTION,
      inviteId: record.id,
    });
    assert.equal(result.kind, 'accepted');
    assert.equal(record.status, 'accepted');
    assert.equal(members.some((row) => row.subjectId === BOUND_SUBJECT && row.role === 'editor'), true);
  });
});

describe('purgePendingUnboundInvitesForEmail after P9 email change', () => {
  test('pending unbound invites for the old mailbox cannot be accepted later; bound and new-mailbox invites survive', async () => {
    const oldMailbox = 'old@example.test';
    const newMailbox = 'new@example.test';
    const unboundOld = invite({
      id: 'invite-unbound-old',
      invitedSubjectId: null,
      emailNormalized: oldMailbox,
    });
    const boundOld = invite({
      id: 'invite-bound-old',
      invitedSubjectId: BOUND_SUBJECT,
      emailNormalized: oldMailbox,
    });
    const unboundNew = invite({
      id: 'invite-unbound-new',
      invitedSubjectId: null,
      emailNormalized: newMailbox,
    });
    const rows = [unboundOld, boundOld, unboundNew];
    const purged = await purgePendingUnboundInvitesForEmail({
      async revokePendingUnboundInvitesByEmail(emailNormalized, now) {
        let count = 0;
        for (const row of rows) {
          if (
            row.status === 'pending'
            && row.invitedSubjectId === null
            && row.emailNormalized === emailNormalized
          ) {
            row.status = 'revoked';
            row.resolvedAt = now;
            count += 1;
          }
        }
        return count;
      },
    }, oldMailbox, NOW);
    assert.equal(purged, 1);
    assert.equal(unboundOld.status, 'revoked');
    assert.equal(boundOld.status, 'pending');
    assert.equal(unboundNew.status, 'pending');

    const laterMembers: Array<{
      collectionId: string;
      subjectId: string;
      role: 'owner' | 'editor' | 'viewer';
      grantedAt: Date;
    }> = [
      { collectionId: COLLECTION, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW },
    ];
    await assert.rejects(
      () => acceptInvite(createAcceptPorts(unboundOld, laterMembers), {
        actor: {
          principalId: 'principal-later',
          subjectId: THIEF_SUBJECT,
          kind: 'account',
          email: oldMailbox,
        },
        command: { commandId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef', fingerprint: 'c'.repeat(64) },
        collectionId: COLLECTION,
        inviteId: unboundOld.id,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CollaborationError);
        assert.equal(error.code, 'invite_not_pending');
        return true;
      },
    );
    assert.equal(laterMembers.some((row) => row.subjectId === THIEF_SUBJECT), false);

    const boundMembers: Array<{
      collectionId: string;
      subjectId: string;
      role: 'owner' | 'editor' | 'viewer';
      grantedAt: Date;
    }> = [
      { collectionId: COLLECTION, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW },
    ];
    const boundResult = await acceptInvite(createAcceptPorts(boundOld, boundMembers), {
      actor: {
        principalId: 'principal-bound',
        subjectId: BOUND_SUBJECT,
        kind: 'account',
        email: newMailbox,
      },
      command: { commandId: '11111111-2222-4333-8444-555555555556', fingerprint: 'd'.repeat(64) },
      collectionId: COLLECTION,
      inviteId: boundOld.id,
    });
    assert.equal(boundResult.kind, 'accepted');
    assert.equal(boundOld.status, 'accepted');
  });
});

function createAcceptPorts(
  record: CollaborationInviteRecord,
  members: Array<{ collectionId: string; subjectId: string; role: 'owner' | 'editor' | 'viewer'; grantedAt: Date }>,
): CollaborationCommandPorts {
  const receipts = createOneShotReceipts();
  return {
    receipts,
    clock: { async now() { return new Date(NOW); } },
    identity: { async findVerifiedActiveAccountByEmail() { return null; } },
    facts: {
      async loadCollectionFacts() {
        return {
          collectionId: COLLECTION,
          ownerSubjectId: OWNER_SUBJECT,
          visibility: 'private',
          policyRevision: 'policy-0',
          membershipRole: null,
          deleted: false,
        };
      },
    },
    collections: {
      async lockForUpdate() {
        return {
          collectionId: COLLECTION,
          ownerSubjectId: OWNER_SUBJECT,
          visibility: 'private' as const,
          policyRevision: 'policy-0',
          contentRevision: 'content-0',
          title: 'Match collection',
          deletedAt: null,
        };
      },
      async bumpPolicyRevision() { return 'policy-1'; },
    },
    store: {
      async expireOverdueInvites() { return 0; },
      async countMembersAndPending() { return members.length; },
      async countPendingInvites() { return 0; },
      async countPendingInvitesForInvitee() { return 0; },
      async findMembership(collectionId, subjectId) {
        const row = members.find((item) => item.collectionId === collectionId && item.subjectId === subjectId);
        return row ?? null;
      },
      async findPendingByEmail() { return null; },
      async findInviteById(inviteId) {
        return inviteId === record.id ? record : null;
      },
      async revokePendingUnboundInvitesByEmail() { return 0; },
      async insertInvite() {},
      async updateInvite(_inviteId, patch) {
        Object.assign(record, patch);
        return true;
      },
      async insertMembership(row) { members.push(row); },
      async updateMembershipRole() { return true; },
      async deleteMembership() { return true; },
    },
    audit: { async append() {} },
    inviteEmail: {
      enabled: true,
      async insertDeliveryIfAbsent() { return 'inserted'; },
      async suppressIfUnsent() { return true; },
    },
    inviteOutbox: { async appendInviteCreated() {} },
  };
}

function createOneShotReceipts(): ProductCommandReceiptPort {
  const rows = new Map<string, { fingerprint: string; status: 'in_progress' | 'completed'; result?: ProductCommandResult }>();
  const keyOf = (binding: ProductCommandBinding) => `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = keyOf(binding);
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.status === 'in_progress') return { kind: 'in_progress', retryAfterSeconds: 1 };
      assert.ok(existing.result);
      return { kind: 'replay', result: existing.result };
    },
    async complete(binding, fingerprint, result) {
      const existing = rows.get(keyOf(binding));
      if (!existing || existing.fingerprint !== fingerprint) throw new Error('complete without claim');
      existing.status = 'completed';
      existing.result = {
        status: result.status,
        body: result.body.slice(),
        stableHeaders: { ...result.stableHeaders },
        mediaType: result.mediaType,
        contractVersion: result.contractVersion,
        targetIdentity: result.targetIdentity,
      };
    },
    async purgeExpired() { return 0; },
    async deletePrincipalReceipts() { return 0; },
  };
}
