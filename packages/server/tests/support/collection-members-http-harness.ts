/**
 * SC-02 collection member and invite Product HTTP (Fastify inject).
 */
import assert from 'node:assert/strict';
import { afterEach } from 'vitest';
import { loadConfig } from './test-config.js';
import { createMemoryCollaborationInviteRateLimiter } from '../../src/infrastructure/rate-limit/index.js';
import {
  ALREADY_MEMBER_MESSAGE,
  COLLABORATION_MEMBERS_LIST_LIMIT,
  COLLABORATION_MY_INVITES_LIST_LIMIT,
  COLLABORATION_PENDING_INVITE_LIMIT,
  INVITE_ALREADY_PENDING_MESSAGE,
  type CollaborationCommandPorts,
  type CollaborationHttpPorts,
  inviteMatchesInvitee,
  type CollaborationInviteRecord,
  type CollaborationMembershipRecord,
  type CollaborationQueryPort,
  type CollaborationUnitOfWork,
  type MembershipRole,
} from '../../src/modules/access-policy/index.js';

export {
  ALREADY_MEMBER_MESSAGE,
  COLLABORATION_MEMBERS_LIST_LIMIT,
  COLLABORATION_MY_INVITES_LIST_LIMIT,
  COLLABORATION_PENDING_INVITE_LIMIT,
  INVITE_ALREADY_PENDING_MESSAGE,
};
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../src/modules/commands/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from './better-auth-test-factory.js';
import { createTestCollaborationListCursors } from './collaboration-list-cursors.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from './product-http-harness.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';

export const ORIGIN = 'https://known.example';
export const INSTANT = '2026-08-19T12:00:00.000Z';
export const UNKNOWN_EMAIL = 'unknown-invitee@example.test';
export const INVITE_201_KEYS = ['collectionId', 'expiresAt', 'inviteId', 'policyEtag', 'role'] as const;
export const FORBIDDEN_201_KEYS = [
  'accountFound', 'emailQueued', 'found', 'queued', 'deliveryId', 'emailStatus',
];

export const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
export const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
export const COMMAND_C = '11111111-2222-4333-8444-555555555555';
export const COMMAND_D = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const COMMAND_E = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
export const COMMAND_F = 'cccccccc-dddd-4eee-8fff-000000000001';

export interface ReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
}

export interface MemberRow {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
  grantedAt: Date;
}

export interface InviteRow extends CollaborationInviteRecord {}

export interface CollectionRow {
  id: string;
  ownerSubjectId: string;
  visibility: 'private' | 'protected' | 'public' | 'unlisted';
  title: string;
  policyRevision: string;
  contentRevision: string;
  deletedAt: Date | null;
  policyBumpCount: number;
}

export interface AccountRow {
  id: string;
  subjectId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'active' | 'disabled' | 'deleted';
  deletedAt: Date | null;
  emailVerified: boolean;
}

export interface MemoryState {
  now: Date;
  receipts: Map<string, ReceiptRow>;
  collections: Map<string, CollectionRow>;
  members: MemberRow[];
  invites: InviteRow[];
  accounts: AccountRow[];
  audit: Array<Readonly<Record<string, unknown>>>;
  deliveries: string[];
  inviteSeq: number;
  revisionSeq: number;
}

export interface Harness {
  readonly app: ReturnType<typeof buildApiApp>;
  readonly state: MemoryState;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly identityUnitOfWork: IdentityUnitOfWork;
}

export const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

export function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

export function createState(now = new Date(INSTANT)): MemoryState {
  return {
    now,
    receipts: new Map(),
    collections: new Map(),
    members: [],
    invites: [],
    accounts: [],
    audit: [],
    deliveries: [],
    inviteSeq: 0,
    revisionSeq: 0,
  };
}

export function createMemoryReceipts(state: MemoryState): ProductCommandReceiptPort {
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

export function expirePending(state: MemoryState, predicate: (invite: InviteRow) => boolean, now: Date): number {
  let count = 0;
  for (const invite of state.invites) {
    if (invite.status === 'pending' && invite.expiresAt.getTime() <= now.getTime() && predicate(invite)) {
      invite.status = 'expired';
      invite.resolvedAt = now;
      count += 1;
    }
  }
  return count;
}

export function takeKeyset<T>(
  rows: readonly T[],
  limit: number,
  idOf: (row: T) => string,
  timeOf: (row: T) => Date,
  after?: { readonly time: Date; readonly id: string },
): T[] {
  const sorted = [...rows].sort((left, right) => {
    const delta = timeOf(left).getTime() - timeOf(right).getTime();
    if (delta !== 0) return delta;
    return idOf(left) < idOf(right) ? -1 : idOf(left) > idOf(right) ? 1 : 0;
  });
  const filtered = after
    ? sorted.filter((row) => {
        const time = timeOf(row).getTime();
        const bound = after.time.getTime();
        return time > bound || (time === bound && idOf(row) > after.id);
      })
    : sorted;
  return filtered.slice(0, limit + 1);
}

export function createMemoryQuery(state: MemoryState): CollaborationQueryPort {
  return {
    async loadCollection(collectionId) {
      const collection = state.collections.get(collectionId);
      if (!collection) return null;
      return {
        id: collection.id,
        title: collection.title,
        ownerSubjectId: collection.ownerSubjectId,
        visibility: collection.visibility,
        policyRevision: collection.policyRevision,
        deletedAt: collection.deletedAt,
      };
    },
    async listMembers(input) {
      const rows = state.members
        .filter((row) => row.collectionId === input.collectionId)
        .map((row) => {
          const account = state.accounts.find((item) => item.subjectId === row.subjectId);
          return {
            subjectId: row.subjectId,
            role: row.role,
            displayName: account?.displayName ?? 'Member',
            email: account?.email ?? null,
            avatarUrl: account?.avatarUrl ?? null,
            grantedAt: row.grantedAt,
          };
        });
      return takeKeyset(
        rows,
        input.limit,
        (row) => row.subjectId,
        (row) => row.grantedAt,
        input.after ? { time: input.after.grantedAt, id: input.after.subjectId } : undefined,
      );
    },
    async listPendingInvites(input) {
      const rows = state.invites
        .filter((row) => (
          row.collectionId === input.collectionId
          && row.status === 'pending'
          && row.expiresAt.getTime() > input.now.getTime()
        ))
        .map((row) => ({
          inviteId: row.id,
          email: row.emailNormalized,
          role: row.role,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        }));
      return takeKeyset(
        rows,
        input.limit,
        (row) => row.inviteId,
        (row) => row.createdAt,
        input.after ? { time: input.after.createdAt, id: input.after.inviteId } : undefined,
      );
    },
    async listMyPendingInvites(input) {
      const rows = state.invites
        .filter((row) => (
          row.status === 'pending'
          && row.expiresAt.getTime() > input.now.getTime()
          && inviteMatchesInvitee(row, input)
        ))
        .map((row) => ({
          inviteId: row.id,
          collectionId: row.collectionId,
          collectionTitle: row.collectionTitleSnapshot,
          role: row.role,
          email: row.emailNormalized,
          expiresAt: row.expiresAt,
          invitedAt: row.createdAt,
        }));
      return takeKeyset(
        rows,
        input.limit,
        (row) => row.inviteId,
        (row) => row.invitedAt,
        input.after ? { time: input.after.createdAt, id: input.after.inviteId } : undefined,
      );
    },
  };
}

export function createMemoryPorts(state: MemoryState): CollaborationHttpPorts {
  const commandPorts: CollaborationCommandPorts = {
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
        return { id: row.id, subjectId: row.subjectId, email: row.email };
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
        return expirePending(state, (invite) => invite.collectionId === collectionId, now);
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
      async insertInvite(row: CollaborationInviteRecord) {
        state.invites.push({ ...row });
      },
      async updateInvite(inviteId, patch) {
        const invite = state.invites.find((row) => row.id === inviteId);
        if (!invite) return false;
        Object.assign(invite, patch);
        return true;
      },
      async insertMembership(row: CollaborationMembershipRecord) {
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
      async insertDeliveryIfAbsent(input) {
        state.deliveries.push(input.inviteId);
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
  return { ...commandPorts, query: createMemoryQuery(state) };
}

export function createHarness(): Harness {
  const state = createState();
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const unitOfWork: CollaborationUnitOfWork = {
    execute(work) {
      return work(createMemoryPorts(state));
    },
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: ORIGIN,
    PUBLICATION_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  const app = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productCollaboration: {
      identityUnitOfWork,
      allowedOrigins: [ORIGIN],
      unitOfWork,
      rateLimiter: createMemoryCollaborationInviteRateLimiter({
        keySecret: Buffer.alloc(32, 19),
        environment: 'test',
      }),
      cursors: createTestCollaborationListCursors(),
      now: () => new Date(state.now),
    },
  });
  apps.push(app);
  return { app, state, factory, identityUnitOfWork };
}

export function seedCollection(
  state: MemoryState,
  input: {
    readonly id: string;
    readonly ownerSubjectId: string;
    readonly visibility?: CollectionRow['visibility'];
    readonly title?: string;
  },
): void {
  state.collections.set(input.id, {
    id: input.id,
    ownerSubjectId: input.ownerSubjectId,
    visibility: input.visibility ?? 'private',
    title: input.title ?? 'Team notes',
    policyRevision: 'policy-0',
    contentRevision: 'content-0',
    deletedAt: null,
    policyBumpCount: 0,
  });
  state.members.push({
    collectionId: input.id,
    subjectId: input.ownerSubjectId,
    role: 'owner',
    grantedAt: new Date(state.now),
  });
}

export function seedPrincipal(
  state: MemoryState,
  input: {
    readonly id: string;
    readonly subjectId: string;
    readonly email: string;
    readonly displayName: string;
    readonly avatarUrl?: string | null;
  },
): void {
  state.accounts.push({
    id: input.id,
    subjectId: input.subjectId,
    email: input.email,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl ?? null,
    status: 'active',
    deletedAt: null,
    emailVerified: true,
  });
}

export async function session(
  harness: Harness,
  input: {
    readonly subject: string;
    readonly email: string;
    readonly displayName: string;
    readonly avatarUrl?: string | null;
  },
) {
  const handle = input.subject.replace(/[^a-z0-9]/giu, '').slice(0, 16).toLowerCase() || 'userhandle';
  const client = await issueTestSession({
    factory: harness.factory,
    subject: input.subject,
    handle,
    email: input.email,
    displayName: input.displayName,
  });
  seedPrincipal(harness.state, {
    id: client.accountId,
    subjectId: client.subjectId,
    email: input.email,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl ?? null,
  });
  return client;
}

export function writeHeaders(
  client: { cookie: string; csrfToken: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: ORIGIN,
    'x-csrf-token': client.csrfToken,
    ...extra,
  };
}

export function inviteUrl(collectionId: string): string {
  return `/api/v1/collections/${collectionId}/members/invites`;
}

export function membersUrl(collectionId: string): string {
  return `/api/v1/collections/${collectionId}/members`;
}

export function etagOf(state: MemoryState, collectionId: string): string {
  return `"${state.collections.get(collectionId)!.policyRevision}"`;
}

export function assertProductError(
  response: { statusCode: number; json: () => { error?: { code?: string; message?: string } } },
  status: number,
  code: string,
): { code: string; message: string } {
  assert.equal(response.statusCode, status);
  const error = response.json().error;
  assert.ok(error);
  assert.equal(error.code, code);
  return { code: error.code ?? '', message: error.message ?? '' };
}

export function assertNoForbidden201Keys(body: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(body).sort(), [...INVITE_201_KEYS]);
  for (const key of FORBIDDEN_201_KEYS) {
    assert.equal(key in body, false, `forbidden 201 key ${key}`);
  }
}

