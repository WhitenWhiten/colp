/**
 * S-04 pending invite caps: per-collection 50, per-invitee 50, member_limit 100.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CollaborationError,
  COLLABORATION_INVITEE_PENDING_LIMIT,
  COLLABORATION_MEMBER_LIMIT,
  COLLABORATION_PENDING_INVITE_LIMIT,
  inviteMember,
  type CollaborationCommandPorts,
  type CollaborationInviteRecord,
  type InviteMemberInput,
  type MembershipRole,
} from '../../../src/modules/access-policy/index.js';
import { mapCollaborationHttpError } from '../../../src/transport/product/product-collaboration-routes.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';

const NOW = new Date('2026-08-19T00:00:00.000Z');
const COLLECTION_A = 'col-cap-a';
const OWNER_SUBJECT = 'subject-owner';
const OWNER_EMAIL = 'owner@example.test';
const OWNER_PRINCIPAL = 'principal-owner';
const UNKNOWN_EMAIL = 'unknown@example.test';
const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const FINGERPRINT_A = 'a'.repeat(64);

interface InviteRow extends CollaborationInviteRecord {}
interface MemberRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}
interface MemoryState {
  now: Date;
  receipts: Map<string, { fingerprint: string; status: 'in_progress' | 'completed'; result?: ProductCommandResult }>;
  collections: Map<string, {
    id: string;
    ownerSubjectId: string;
    visibility: 'private';
    title: string;
    policyRevision: string;
    contentRevision: string;
    deletedAt: Date | null;
  }>;
  members: MemberRow[];
  invites: InviteRow[];
  deliveries: string[];
  inviteSeq: number;
  revisionSeq: number;
}

function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

function createState(): MemoryState {
  const state: MemoryState = {
    now: NOW,
    receipts: new Map(),
    collections: new Map(),
    members: [],
    invites: [],
    deliveries: [],
    inviteSeq: 0,
    revisionSeq: 0,
  };
  state.collections.set(COLLECTION_A, {
    id: COLLECTION_A,
    ownerSubjectId: OWNER_SUBJECT,
    visibility: 'private',
    title: 'Cap collection',
    policyRevision: 'policy-0',
    contentRevision: 'content-0',
    deletedAt: null,
  });
  state.members.push({
    collectionId: COLLECTION_A, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW,
  });
  return state;
}

function createReceipts(state: MemoryState): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = receiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing) {
        state.receipts.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.status === 'in_progress') return { kind: 'in_progress', retryAfterSeconds: 1 };
      assert.ok(existing.result);
      return { kind: 'replay', result: existing.result };
    },
    async complete(binding, fingerprint, result) {
      const existing = state.receipts.get(receiptKey(binding));
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

function createPorts(state: MemoryState): CollaborationCommandPorts {
  return {
    receipts: createReceipts(state),
    clock: { async now() { return new Date(state.now); } },
    ids: {
      nextInviteId() {
        state.inviteSeq += 1;
        return `invite-${state.inviteSeq}`;
      },
    },
    identity: { async findVerifiedActiveAccountByEmail() { return null; } },
    facts: {
      async loadCollectionFacts(input) {
        const collection = state.collections.get(input.collectionId);
        if (!collection) return null;
        const membership = state.members.find((row) => (
          row.collectionId === input.collectionId && row.subjectId === input.actorSubjectId
        ));
        return {
          collectionId: collection.id,
          ownerSubjectId: collection.ownerSubjectId,
          visibility: collection.visibility,
          policyRevision: collection.policyRevision,
          membershipRole: membership?.role ?? null,
          deleted: collection.deletedAt !== null,
        };
      },
    },
    collections: {
      async lockForUpdate(collectionId) {
        const collection = state.collections.get(collectionId);
        if (!collection) return null;
        return {
          collectionId: collection.id,
          ownerSubjectId: collection.ownerSubjectId,
          visibility: collection.visibility,
          policyRevision: collection.policyRevision,
          contentRevision: collection.contentRevision,
          title: collection.title,
          deletedAt: collection.deletedAt,
        };
      },
      async bumpPolicyRevision(collectionId) {
        const collection = state.collections.get(collectionId);
        if (!collection) throw new Error('missing collection');
        state.revisionSeq += 1;
        collection.policyRevision = `policy-${state.revisionSeq}`;
        return collection.policyRevision;
      },
    },
    store: {
      async expireOverdueInvites() { return 0; },
      async countMembersAndPending(collectionId) {
        const members = state.members.filter((row) => row.collectionId === collectionId).length;
        const pending = state.invites.filter((row) => (
          row.collectionId === collectionId && row.status === 'pending'
        )).length;
        return members + pending;
      },
      async countPendingInvites(collectionId) {
        return state.invites.filter((row) => (
          row.collectionId === collectionId && row.status === 'pending'
        )).length;
      },
      async countPendingInvitesForInvitee(input) {
        return state.invites.filter((row) => {
          if (row.status !== 'pending') return false;
          if (row.emailNormalized === input.emailNormalized) return true;
          return input.invitedSubjectId !== null && row.invitedSubjectId === input.invitedSubjectId;
        }).length;
      },
      async findMembership(collectionId, subjectId) {
        return state.members.find((row) => (
          row.collectionId === collectionId && row.subjectId === subjectId
        )) ?? null;
      },
      async findPendingByEmail(collectionId, emailNormalized) {
        return state.invites.find((row) => (
          row.collectionId === collectionId
          && row.emailNormalized === emailNormalized
          && row.status === 'pending'
        )) ?? null;
      },
      async findInviteById(inviteId) {
        return state.invites.find((row) => row.id === inviteId) ?? null;
      },
      async revokePendingUnboundInvitesByEmail() { return 0; },
      async insertInvite(row) { state.invites.push({ ...row }); },
      async updateInvite() { return false; },
      async insertMembership() {},
      async updateMembershipRole() { return false; },
      async deleteMembership() { return false; },
    },
    audit: { async append() {} },
    inviteEmail: {
      enabled: true,
      async insertDeliveryIfAbsent(input) {
        state.deliveries.push(input.inviteId);
        return 'inserted';
      },
      async suppressIfUnsent() { return true; },
    },
    inviteOutbox: { async appendInviteCreated() {} },
  };
}

function pendingInvite(overrides: Partial<InviteRow> & Pick<InviteRow, 'id' | 'collectionId' | 'emailNormalized'>): InviteRow {
  return {
    role: 'viewer',
    invitedSubjectId: null,
    invitedBySubjectId: OWNER_SUBJECT,
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    createdAt: NOW,
    resolvedAt: null,
    acceptedSubjectId: null,
    collectionTitleSnapshot: 'Cap collection',
    ...overrides,
  };
}

function inviteInput(overrides: Partial<InviteMemberInput> = {}): InviteMemberInput {
  return {
    actor: {
      principalId: OWNER_PRINCIPAL,
      subjectId: OWNER_SUBJECT,
      kind: 'account',
      email: OWNER_EMAIL,
    },
    command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
    collectionId: COLLECTION_A,
    email: UNKNOWN_EMAIL,
    role: 'editor',
    ...overrides,
  };
}

test('51st pending on a collection is pending_invite_limit with no insert and no delivery', async () => {
  const state = createState();
  for (let index = 0; index < COLLABORATION_PENDING_INVITE_LIMIT; index += 1) {
    state.invites.push(pendingInvite({
      id: `seed-${index}`,
      collectionId: COLLECTION_A,
      emailNormalized: `pending-${index}@example.test`,
    }));
  }
  await assert.rejects(
    () => inviteMember(createPorts(state), inviteInput()),
    (error: unknown) => {
      assert.ok(error instanceof CollaborationError);
      assert.equal(error.code, 'pending_invite_limit');
      assert.equal(error.message.includes('@'), false);
      return true;
    },
  );
  assert.equal(state.invites.length, COLLABORATION_PENDING_INVITE_LIMIT);
  assert.equal(state.deliveries.length, 0);
});

test('invitee global pending cap of 50 across collections', async () => {
  const state = createState();
  for (let index = 0; index < COLLABORATION_INVITEE_PENDING_LIMIT; index += 1) {
    const collectionId = `col-other-${index}`;
    state.collections.set(collectionId, {
      id: collectionId,
      ownerSubjectId: OWNER_SUBJECT,
      visibility: 'private',
      title: 'Other',
      policyRevision: 'policy-0',
      contentRevision: 'content-0',
      deletedAt: null,
    });
    state.members.push({
      collectionId, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW,
    });
    state.invites.push(pendingInvite({
      id: `cross-${index}`,
      collectionId,
      emailNormalized: UNKNOWN_EMAIL,
    }));
  }
  await assert.rejects(
    () => inviteMember(createPorts(state), inviteInput()),
    (error: unknown) => {
      assert.ok(error instanceof CollaborationError);
      assert.equal(error.code, 'pending_invite_limit');
      return true;
    },
  );
  assert.equal(state.invites.length, COLLABORATION_INVITEE_PENDING_LIMIT);
  assert.equal(state.deliveries.length, 0);
});

test('members+pending still blocked by existing 100 member_limit', async () => {
  const state = createState();
  for (let index = 0; index < 50; index += 1) {
    state.members.push({
      collectionId: COLLECTION_A,
      subjectId: `member-${index}`,
      role: 'viewer',
      grantedAt: NOW,
    });
  }
  const pendingNeeded = COLLABORATION_MEMBER_LIMIT - state.members.length;
  assert.ok(pendingNeeded < COLLABORATION_PENDING_INVITE_LIMIT);
  for (let index = 0; index < pendingNeeded; index += 1) {
    state.invites.push(pendingInvite({
      id: `member-limit-${index}`,
      collectionId: COLLECTION_A,
      emailNormalized: `limit-${index}@example.test`,
    }));
  }
  assert.equal(state.members.length + state.invites.length, COLLABORATION_MEMBER_LIMIT);
  await assert.rejects(
    () => inviteMember(createPorts(state), inviteInput()),
    (error: unknown) => {
      assert.ok(error instanceof CollaborationError);
      assert.equal(error.code, 'member_limit');
      return true;
    },
  );
  assert.equal(state.deliveries.length, 0);
});

test('pending_invite_limit maps like member_limit (409 mutation_conflict)', () => {
  const pending = mapCollaborationHttpError(
    new CollaborationError('pending_invite_limit', 'This collection has reached its pending invite limit.'),
  );
  const members = mapCollaborationHttpError(
    new CollaborationError('member_limit', 'This collection has reached its member limit.'),
  );
  assert.equal(pending.statusCode, 409);
  assert.equal(pending.productCode, 'mutation_conflict');
  assert.equal(members.statusCode, 409);
  assert.equal(members.productCode, 'mutation_conflict');
});
