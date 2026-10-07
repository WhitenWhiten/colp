import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  acceptInvite,
  acceptInviteCommandScope,
  ALREADY_MEMBER_MESSAGE,
  CollaborationError,
  COLLABORATION_MEMBER_LIMIT,
  declineInviteCommandScope,
  inviteMember,
  inviteMemberCommandScope,
  INVITE_ALREADY_PENDING_MESSAGE,
  removeMember,
  removeMemberCommandScope,
  revokeInviteCommandScope,
  updateMemberRole,
  updateMemberRoleCommandScope,
  type CollaborationCommandPorts,
  type CollaborationCommandResult,
  type CollaborationInviteView,
  type InviteMemberInput,
  type MembershipRole,
} from '../../../src/modules/access-policy/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';

const NOW = new Date('2026-08-19T00:00:00.000Z');
const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_C = '11111111-2222-4333-8444-555555555555';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const COLLECTION_A = 'col-collab-a';
const COLLECTION_B = 'col-collab-b';
const OWNER_SUBJECT = 'subject-owner';
const OWNER_EMAIL = 'owner@example.test';
const EDITOR_SUBJECT = 'subject-editor';
const EDITOR_EMAIL = 'editor@example.test';
const INVITEE_SUBJECT = 'subject-invitee';
const INVITEE_EMAIL = 'invitee@example.test';
const UNKNOWN_EMAIL = 'unknown@example.test';
const UNVERIFIED_EMAIL = 'unverified@example.test';
const UNVERIFIED_SUBJECT = 'subject-unverified';
const OWNER_PRINCIPAL = 'principal-owner';
const EDITOR_PRINCIPAL = 'principal-editor';
const INVITEE_PRINCIPAL = 'principal-invitee';

const INVITE_VIEW_KEYS = [
  'collectionId',
  'createdAt',
  'email',
  'expiresAt',
  'inviteId',
  'role',
  'status',
] as const;

interface ReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
}

interface MemberRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}

interface InviteRow {
  id: string;
  collectionId: string;
  role: 'editor' | 'viewer';
  emailNormalized: string;
  invitedSubjectId: string | null;
  invitedBySubjectId: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expiresAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
  acceptedSubjectId: string | null;
  collectionTitleSnapshot: string;
}

interface CollectionRow {
  id: string;
  ownerSubjectId: string;
  visibility: 'private' | 'protected' | 'public' | 'unlisted';
  title: string;
  policyRevision: string;
  contentRevision: string;
  deletedAt: Date | null;
  policyBumpCount: number;
}

interface AccountRow {
  subjectId: string;
  email: string;
  status: 'active' | 'disabled' | 'deleted';
  deletedAt: Date | null;
  emailVerified: boolean;
}

interface MemoryState {
  now: Date;
  receipts: Map<string, ReceiptRow>;
  collections: Map<string, CollectionRow>;
  members: MemberRow[];
  invites: InviteRow[];
  accounts: AccountRow[];
  audit: Array<Readonly<Record<string, unknown>>>;
  inviteSeq: number;
  revisionSeq: number;
}

function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

function ownerActor() {
  return {
    principalId: OWNER_PRINCIPAL,
    subjectId: OWNER_SUBJECT,
    kind: 'account' as const,
    email: OWNER_EMAIL,
  };
}

function editorActor() {
  return {
    principalId: EDITOR_PRINCIPAL,
    subjectId: EDITOR_SUBJECT,
    kind: 'account' as const,
    email: EDITOR_EMAIL,
  };
}

function inviteeActor() {
  return {
    principalId: INVITEE_PRINCIPAL,
    subjectId: INVITEE_SUBJECT,
    kind: 'account' as const,
    email: INVITEE_EMAIL,
  };
}

function createState(): MemoryState {
  return {
    now: new Date(NOW),
    receipts: new Map(),
    collections: new Map([
      [COLLECTION_A, {
        id: COLLECTION_A,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
        title: 'Collection A',
        policyRevision: 'policy-0',
        contentRevision: 'content-0',
        deletedAt: null,
        policyBumpCount: 0,
      }],
      [COLLECTION_B, {
        id: COLLECTION_B,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
        title: 'Collection B',
        policyRevision: 'policy-b0',
        contentRevision: 'content-b0',
        deletedAt: null,
        policyBumpCount: 0,
      }],
    ]),
    members: [
      { collectionId: COLLECTION_A, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW },
      { collectionId: COLLECTION_B, subjectId: OWNER_SUBJECT, role: 'owner', grantedAt: NOW },
    ],
    invites: [],
    accounts: [
      {
        subjectId: OWNER_SUBJECT, email: OWNER_EMAIL, status: 'active',
        deletedAt: null, emailVerified: true,
      },
      {
        subjectId: EDITOR_SUBJECT, email: EDITOR_EMAIL, status: 'active',
        deletedAt: null, emailVerified: true,
      },
      {
        subjectId: INVITEE_SUBJECT, email: INVITEE_EMAIL, status: 'active',
        deletedAt: null, emailVerified: true,
      },
      {
        subjectId: UNVERIFIED_SUBJECT, email: UNVERIFIED_EMAIL, status: 'active',
        deletedAt: null, emailVerified: false,
      },
    ],
    audit: [],
    inviteSeq: 0,
    revisionSeq: 0,
  };
}

function createMemoryReceipts(state: MemoryState): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = receiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing) {
        state.receipts.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return { kind: 'replay', result: existing.result };
    },
    async complete(binding, fingerprint, result): Promise<void> {
      const key = receiptKey(binding);
      const existing = state.receipts.get(key);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new Error('complete without matching claim');
      }
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
    async purgeExpired() {
      return 0;
    },
    async deletePrincipalReceipts() {
      return 0;
    },
  };
}

function createMemoryPorts(state: MemoryState): CollaborationCommandPorts {
  return {
    receipts: createMemoryReceipts(state),
    clock: { async now() { return new Date(state.now); } },
    ids: {
      nextInviteId() {
        state.inviteSeq += 1;
        return `invite-${state.inviteSeq}`;
      },
    },
    identity: {
      async findVerifiedActiveAccountByEmail(email) {
        const row = state.accounts.find((account) => account.email === email);
        if (!row || row.status !== 'active' || row.deletedAt !== null || !row.emailVerified) {
          return null;
        }
        return { id: `acct-${row.subjectId}`, subjectId: row.subjectId, email: row.email };
      },
    },
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
        if (!collection) throw new Error('missing collection for policy bump');
        state.revisionSeq += 1;
        collection.policyBumpCount += 1;
        collection.policyRevision = `policy-${state.revisionSeq}`;
        return collection.policyRevision;
      },
    },
    store: {
      async expireOverdueInvites(collectionId, now) {
        let count = 0;
        for (const invite of state.invites) {
          if (
            invite.collectionId === collectionId
            && invite.status === 'pending'
            && invite.expiresAt.getTime() <= now.getTime()
          ) {
            invite.status = 'expired';
            invite.resolvedAt = now;
            count += 1;
          }
        }
        return count;
      },
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
      async revokePendingUnboundInvitesByEmail(emailNormalized, now) {
        let count = 0;
        for (const invite of state.invites) {
          if (
            invite.status === 'pending'
            && invite.invitedSubjectId === null
            && invite.emailNormalized === emailNormalized
          ) {
            invite.status = 'revoked';
            invite.resolvedAt = now;
            count += 1;
          }
        }
        return count;
      },
      async insertInvite(row) {
        state.invites.push({ ...row });
      },
      async updateInvite(inviteId, patch) {
        const invite = state.invites.find((row) => row.id === inviteId);
        if (!invite) return false;
        Object.assign(invite, patch);
        return true;
      },
      async insertMembership(row) {
        state.members.push({ ...row });
      },
      async updateMembershipRole(collectionId, subjectId, role) {
        const member = state.members.find((row) => (
          row.collectionId === collectionId && row.subjectId === subjectId
        ));
        if (!member) return false;
        member.role = role;
        return true;
      },
      async deleteMembership(collectionId, subjectId) {
        const index = state.members.findIndex((row) => (
          row.collectionId === collectionId && row.subjectId === subjectId
        ));
        if (index < 0) return false;
        state.members.splice(index, 1);
        return true;
      },
    },
    audit: {
      async append(event) {
        state.audit.push({ ...event });
      },
    },
    inviteEmail: {
      enabled: true,
      async insertDeliveryIfAbsent() {
        return 'inserted';
      },
      async suppressIfUnsent() {
        return true;
      },
    },
    inviteOutbox: {
      async appendInviteCreated() {},
    },
  };
}

function inviteInput(overrides: Partial<InviteMemberInput> = {}): InviteMemberInput {
  return {
    actor: ownerActor(),
    command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
    collectionId: COLLECTION_A,
    email: UNKNOWN_EMAIL,
    role: 'editor',
    ...overrides,
  };
}

function asInvited(result: CollaborationCommandResult): {
  readonly invite: CollaborationInviteView;
  readonly policyRevision: string;
} {
  assert.equal(result.kind, 'invited');
  if (result.kind !== 'invited') throw new Error('unreachable');
  return result;
}

function assertNoAccountFound(result: object): void {
  assert.equal(Object.hasOwn(result, 'accountFound'), false);
  if ('invite' in result && result.invite && typeof result.invite === 'object') {
    assert.equal(Object.hasOwn(result.invite, 'accountFound'), false);
    assert.equal(Object.hasOwn(result.invite, 'invitedSubjectId'), false);
  }
}

function assertCollaborationError(
  error: unknown,
  code: CollaborationError['code'],
): asserts error is CollaborationError {
  assert.ok(error instanceof CollaborationError, `expected CollaborationError, got ${String(error)}`);
  assert.equal(error.code, code);
}

describe('collection invite commands (in-memory ports)', () => {
  test('unknown email and verified email both insert pending with identical key sets and no accountFound', async () => {
    const unknownState = createState();
    const unknown = asInvited(await inviteMember(createMemoryPorts(unknownState), inviteInput({
      email: UNKNOWN_EMAIL,
    })));
    const verifiedState = createState();
    const verified = asInvited(await inviteMember(createMemoryPorts(verifiedState), inviteInput({
      email: INVITEE_EMAIL,
      command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
    })));

    assertNoAccountFound(unknown);
    assertNoAccountFound(verified);
    assert.deepEqual(Object.keys(unknown).sort(), Object.keys(verified).sort());
    assert.deepEqual(Object.keys(unknown.invite).sort(), [...INVITE_VIEW_KEYS].sort());
    assert.deepEqual(Object.keys(unknown.invite).sort(), Object.keys(verified.invite).sort());
    assert.equal(unknown.invite.status, 'pending');
    assert.equal(verified.invite.status, 'pending');
    assert.equal(unknownState.invites[0]?.invitedSubjectId, null);
    assert.equal(verifiedState.invites[0]?.invitedSubjectId, INVITEE_SUBJECT);
    assert.equal(unknownState.invites[0]?.emailNormalized, UNKNOWN_EMAIL);
    assert.equal(verifiedState.invites[0]?.emailNormalized, INVITEE_EMAIL);
  });

  test('unverified occupancy does not bind invited_subject_id', async () => {
    const state = createState();
    const result = asInvited(await inviteMember(createMemoryPorts(state), inviteInput({
      email: UNVERIFIED_EMAIL,
    })));
    assert.equal(result.invite.status, 'pending');
    assert.equal(state.invites[0]?.emailNormalized, UNVERIFIED_EMAIL);
    assert.equal(state.invites[0]?.invitedSubjectId, null);
  });

  test('already a member → already_member', async () => {
    const state = createState();
    state.members.push({
      collectionId: COLLECTION_A, subjectId: INVITEE_SUBJECT, role: 'viewer', grantedAt: NOW,
    });
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({ email: INVITEE_EMAIL })),
      (error: unknown) => {
        assertCollaborationError(error, 'already_member');
        assert.equal(error.message, ALREADY_MEMBER_MESSAGE);
        assert.equal(error.message.includes(INVITEE_EMAIL), false);
        return true;
      },
    );
    assert.equal(state.invites.length, 0);
  });

  test('same email already pending → invite_already_pending without leaking prior invite state', async () => {
    const state = createState();
    const first = asInvited(await inviteMember(createMemoryPorts(state), inviteInput({
      email: UNKNOWN_EMAIL,
      role: 'editor',
    })));
    const prior = state.invites[0];
    assert.ok(prior);
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({
        email: '  UNKNOWN@example.test  ',
        role: 'viewer',
        command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
      })),
      (error: unknown) => {
        assertCollaborationError(error, 'invite_already_pending');
        assert.equal(error.message, INVITE_ALREADY_PENDING_MESSAGE);
        const serialized = `${error.message}\n${error.stack ?? ''}`;
        assert.equal(serialized.includes('editor'), false);
        assert.equal(serialized.includes('viewer'), false);
        assert.equal(serialized.includes(prior.expiresAt.toISOString()), false);
        assert.equal(serialized.includes(UNKNOWN_EMAIL), false);
        assert.equal(serialized.includes('registered'), false);
        return true;
      },
    );
    assert.equal(first.invite.role, 'editor');
    assert.equal(state.invites.length, 1);
  });

  test('expired pending invite cannot be accepted', async () => {
    const state = createState();
    const invited = asInvited(await inviteMember(createMemoryPorts(state), inviteInput({
      email: INVITEE_EMAIL,
    })));
    const invite = state.invites[0];
    assert.ok(invite);
    invite.expiresAt = new Date(state.now.getTime() - 1);
    await assert.rejects(
      () => acceptInvite(createMemoryPorts(state), {
        actor: inviteeActor(),
        command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
        collectionId: COLLECTION_A,
        inviteId: invited.invite.inviteId,
      }),
      (error: unknown) => {
        assertCollaborationError(error, 'invite_expired');
        return true;
      },
    );
    assert.equal(state.invites[0]?.status, 'expired');
    assert.equal(
      state.members.some((row) => row.subjectId === INVITEE_SUBJECT && row.collectionId === COLLECTION_A),
      false,
    );
  });

  test('invite self → self_invite', async () => {
    const state = createState();
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({ email: OWNER_EMAIL })),
      (error: unknown) => {
        assertCollaborationError(error, 'self_invite');
        assert.equal(error.message.includes(OWNER_EMAIL), false);
        return true;
      },
    );
  });

  test('editor actor invite → insufficient_role', async () => {
    const state = createState();
    state.members.push({
      collectionId: COLLECTION_A, subjectId: EDITOR_SUBJECT, role: 'editor', grantedAt: NOW,
    });
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({
        actor: editorActor(),
        email: UNKNOWN_EMAIL,
      })),
      (error: unknown) => {
        assertCollaborationError(error, 'insufficient_role');
        return true;
      },
    );
    assert.equal(state.invites.length, 0);
  });

  test('owner target role change and remove → owner_immutable', async () => {
    const state = createState();
    await assert.rejects(
      () => updateMemberRole(createMemoryPorts(state), {
        actor: ownerActor(),
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
        collectionId: COLLECTION_A,
        subjectId: OWNER_SUBJECT,
        role: 'editor',
      }),
      (error: unknown) => {
        assertCollaborationError(error, 'owner_immutable');
        return true;
      },
    );
    await assert.rejects(
      () => removeMember(createMemoryPorts(state), {
        actor: ownerActor(),
        command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
        collectionId: COLLECTION_A,
        subjectId: OWNER_SUBJECT,
      }),
      (error: unknown) => {
        assertCollaborationError(error, 'owner_immutable');
        return true;
      },
    );
    assert.equal(
      state.members.some((row) => row.subjectId === OWNER_SUBJECT && row.role === 'owner'),
      true,
    );
  });

  test('invalid email and invalid role', async () => {
    const state = createState();
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({ email: 'not-an-email' })),
      (error: unknown) => {
        assertCollaborationError(error, 'invalid_email');
        assert.equal(String(error).includes('not-an-email'), false);
        return true;
      },
    );
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({ role: 'owner' })),
      (error: unknown) => {
        assertCollaborationError(error, 'invalid_role');
        return true;
      },
    );
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({ role: 'commenter' })),
      (error: unknown) => {
        assertCollaborationError(error, 'invalid_role');
        return true;
      },
    );
  });

  test('101st pending+members → member_limit', async () => {
    const state = createState();
    for (let index = 0; index < 50; index += 1) {
      state.members.push({
        collectionId: COLLECTION_A,
        subjectId: `member-${index}`,
        role: 'viewer',
        grantedAt: NOW,
      });
    }
    const pendingNeeded = COLLABORATION_MEMBER_LIMIT
      - state.members.filter((row) => row.collectionId === COLLECTION_A).length;
    for (let index = 0; index < pendingNeeded; index += 1) {
      state.invites.push({
        id: `seed-invite-${index}`,
        collectionId: COLLECTION_A,
        role: 'viewer',
        emailNormalized: `pending-${index}@example.test`,
        invitedSubjectId: null,
        invitedBySubjectId: OWNER_SUBJECT,
        status: 'pending',
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
        createdAt: NOW,
        resolvedAt: null,
        acceptedSubjectId: null,
        collectionTitleSnapshot: 'Collection A',
      });
    }
    assert.equal(
      state.members.filter((row) => row.collectionId === COLLECTION_A).length + state.invites.length,
      COLLABORATION_MEMBER_LIMIT,
    );
    await assert.rejects(
      () => inviteMember(createMemoryPorts(state), inviteInput({ email: UNKNOWN_EMAIL })),
      (error: unknown) => {
        assertCollaborationError(error, 'member_limit');
        return true;
      },
    );
  });

  test('different fingerprint with the same command id → reused', async () => {
    const state = createState();
    const first = await inviteMember(createMemoryPorts(state), inviteInput());
    assert.equal(first.kind, 'invited');
    const second = await inviteMember(createMemoryPorts(state), inviteInput({
      command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      email: INVITEE_EMAIL,
    }));
    assert.deepEqual(second, { kind: 'reused' });
    assert.equal(state.invites.length, 1);
  });

  test('inviteId cannot be accepted across collections', async () => {
    const state = createState();
    const invited = asInvited(await inviteMember(createMemoryPorts(state), inviteInput({
      email: INVITEE_EMAIL,
    })));
    await assert.rejects(
      () => acceptInvite(createMemoryPorts(state), {
        actor: inviteeActor(),
        command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
        collectionId: COLLECTION_B,
        inviteId: invited.invite.inviteId,
      }),
      (error: unknown) => {
        assertCollaborationError(error, 'conceal');
        return true;
      },
    );
    assert.equal(state.invites[0]?.status, 'pending');
    assert.equal(
      state.members.some((row) => row.collectionId === COLLECTION_B && row.subjectId === INVITEE_SUBJECT),
      false,
    );
  });

  test('PATCH editor↔viewer', async () => {
    const state = createState();
    const invited = asInvited(await inviteMember(createMemoryPorts(state), inviteInput({
      email: INVITEE_EMAIL,
      role: 'editor',
    })));
    const accepted = await acceptInvite(createMemoryPorts(state), {
      actor: inviteeActor(),
      command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
      collectionId: COLLECTION_A,
      inviteId: invited.invite.inviteId,
    });
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') throw new Error('unreachable');
    assert.equal(accepted.membership.role, 'editor');

    const toViewer = await updateMemberRole(createMemoryPorts(state), {
      actor: ownerActor(),
      command: { commandId: COMMAND_C, fingerprint: 'c'.repeat(64) },
      collectionId: COLLECTION_A,
      subjectId: INVITEE_SUBJECT,
      role: 'viewer',
    });
    assert.equal(toViewer.kind, 'updated');
    if (toViewer.kind !== 'updated') throw new Error('unreachable');
    assert.equal(toViewer.membership.role, 'viewer');

    const toEditor = await updateMemberRole(createMemoryPorts(state), {
      actor: ownerActor(),
      command: { commandId: '22222222-3333-4444-8555-666666666666', fingerprint: 'd'.repeat(64) },
      collectionId: COLLECTION_A,
      subjectId: INVITEE_SUBJECT,
      role: 'editor',
    });
    assert.equal(toEditor.kind, 'updated');
    if (toEditor.kind !== 'updated') throw new Error('unreachable');
    assert.equal(toEditor.membership.role, 'editor');
    assert.equal(
      state.members.find((row) => row.subjectId === INVITEE_SUBJECT)?.role,
      'editor',
    );
  });

  test('non-replay duplicate accept returns current membership and does not bump revision', async () => {
    const state = createState();
    const invited = asInvited(await inviteMember(createMemoryPorts(state), inviteInput({
      email: INVITEE_EMAIL,
    })));
    const first = await acceptInvite(createMemoryPorts(state), {
      actor: inviteeActor(),
      command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
      collectionId: COLLECTION_A,
      inviteId: invited.invite.inviteId,
    });
    assert.equal(first.kind, 'accepted');
    const collection = state.collections.get(COLLECTION_A);
    assert.ok(collection);
    const bumpsAfterFirstAccept = collection.policyBumpCount;
    const revisionAfterFirstAccept = collection.policyRevision;
    const contentRevision = collection.contentRevision;

    const second = await acceptInvite(createMemoryPorts(state), {
      actor: inviteeActor(),
      command: { commandId: COMMAND_C, fingerprint: 'e'.repeat(64) },
      collectionId: COLLECTION_A,
      inviteId: invited.invite.inviteId,
    });
    assert.equal(second.kind, 'accepted');
    if (second.kind !== 'accepted') throw new Error('unreachable');
    assert.equal(second.membership.subjectId, INVITEE_SUBJECT);
    assert.equal(second.membership.role, 'editor');
    assert.equal(second.policyRevision, revisionAfterFirstAccept);
    assert.equal(collection.policyBumpCount, bumpsAfterFirstAccept);
    assert.equal(collection.policyRevision, revisionAfterFirstAccept);
    assert.equal(collection.contentRevision, contentRevision);
    assert.equal(
      state.members.filter((row) => (
        row.collectionId === COLLECTION_A && row.subjectId === INVITEE_SUBJECT
      )).length,
      1,
    );
  });

  test('frozen command scopes follow collection:{id}:members and collaboration-invite:{id}', () => {
    assert.equal(inviteMemberCommandScope(COLLECTION_A), `collection:${COLLECTION_A}:members:invite`);
    assert.equal(
      revokeInviteCommandScope(COLLECTION_A),
      `collection:${COLLECTION_A}:members:invite:revoke`,
    );
    assert.equal(updateMemberRoleCommandScope(COLLECTION_A), `collection:${COLLECTION_A}:members:role`);
    assert.equal(removeMemberCommandScope(COLLECTION_A), `collection:${COLLECTION_A}:members:remove`);
    assert.equal(acceptInviteCommandScope('invite-1'), 'collaboration-invite:invite-1:accept');
    assert.equal(declineInviteCommandScope('invite-1'), 'collaboration-invite:invite-1:decline');
  });
});
