/**
 * S-04 HTTP: 21st invite is 429 + Retry-After; limiter failure is 503.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { readApiCompositionSource } from '../../support/api-composition-source.js';
import {
  createMemoryCollaborationInviteRateLimiter,
  type CollaborationInviteRateLimiter,
} from '../../../src/infrastructure/rate-limit/index.js';
import type {
  CollaborationCommandPorts,
  CollaborationHttpPorts,
  CollaborationInviteRecord,
  CollaborationMembershipRecord,
  CollaborationQueryPort,
  CollaborationUnitOfWork,
  MembershipRole,
} from '../../../src/modules/access-policy/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';

const ORIGIN = 'https://known.example';
const INSTANT = '2026-08-19T12:00:00.000Z';
const TEST_SECRET = Buffer.alloc(32, 19);

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
  members: Array<{ collectionId: string; subjectId: string; role: MembershipRole; grantedAt: Date }>;
  invites: CollaborationInviteRecord[];
  accounts: Array<{
    id: string; subjectId: string; email: string; displayName: string;
    status: 'active'; deletedAt: Date | null; emailVerified: boolean;
  }>;
  inviteSeq: number;
  revisionSeq: number;
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

function createState(): MemoryState {
  return {
    now: new Date(INSTANT),
    receipts: new Map(),
    collections: new Map(),
    members: [],
    invites: [],
    accounts: [],
    inviteSeq: 0,
    revisionSeq: 0,
  };
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

function createQuery(state: MemoryState): CollaborationQueryPort {
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
    async listMembers() { return []; },
    async listPendingInvites() { return []; },
    async listMyPendingInvites() { return []; },
  };
}

function createPorts(state: MemoryState): CollaborationHttpPorts {
  const commandPorts: CollaborationCommandPorts = {
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
        return state.members.filter((row) => row.collectionId === collectionId).length
          + state.invites.filter((row) => row.collectionId === collectionId && row.status === 'pending').length;
      },
      async countPendingInvites(collectionId) {
        return state.invites.filter((row) => row.collectionId === collectionId && row.status === 'pending').length;
      },
      async countPendingInvitesForInvitee(input) {
        return state.invites.filter((row) => row.status === 'pending' && row.emailNormalized === input.emailNormalized).length;
      },
      async findMembership() { return null; },
      async findPendingByEmail(collectionId, emailNormalized) {
        return state.invites.find((row) => (
          row.collectionId === collectionId && row.emailNormalized === emailNormalized && row.status === 'pending'
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
      async insertInvite(row: CollaborationInviteRecord) { state.invites.push({ ...row }); },
      async updateInvite() { return false; },
      async insertMembership(_row: CollaborationMembershipRecord) {},
      async updateMembershipRole() { return false; },
      async deleteMembership() { return false; },
    },
    audit: { async append() {} },
    inviteEmail: {
      enabled: true,
      async insertDeliveryIfAbsent() { return 'inserted'; },
      async suppressIfUnsent() { return true; },
    },
    inviteOutbox: { async appendInviteCreated() {} },
  };
  return { ...commandPorts, query: createQuery(state) };
}

function createHarness(rateLimiter: CollaborationInviteRateLimiter) {
  const state = createState();
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const unitOfWork: CollaborationUnitOfWork = {
    execute(work) { return work(createPorts(state)); },
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
      rateLimiter,
      cursors: createTestCollaborationListCursors(),
      now: () => new Date(state.now),
    },
  });
  apps.push(app);
  return { app, state, factory };
}

async function login(
  harness: ReturnType<typeof createHarness>,
  input: { readonly subject: string; readonly email: string; readonly displayName: string },
) {
  const handle = input.subject.replace(/[^a-z0-9]/giu, '').slice(0, 16).toLowerCase() || 'userhandle';
  const client = await issueTestSession({
    factory: harness.factory,
    subject: input.subject,
    handle,
    email: input.email,
    displayName: input.displayName,
  });
  harness.state.accounts.push({
    id: client.accountId,
    subjectId: client.subjectId,
    email: input.email,
    displayName: input.displayName,
    status: 'active',
    deletedAt: null,
    emailVerified: true,
  });
  return client;
}

function commandId(index: number): string {
  return `5de3947e-6271-4fdf-a946-${index.toString(16).padStart(12, '0')}`;
}

test('21st invite POST is 429 with Retry-After', async () => {
  const limiter = createMemoryCollaborationInviteRateLimiter({
    keySecret: TEST_SECRET,
    environment: 'test',
    inviteLimit: 20,
    now: () => Date.parse(INSTANT),
  });
  const harness = createHarness(limiter);
  const owner = await login(harness, {
    subject: 'owner-rate', email: 'owner-rate@example.test', displayName: 'Ada Owner',
  });
  harness.state.collections.set('col-rate', {
    id: 'col-rate',
    ownerSubjectId: owner.subjectId,
    visibility: 'private',
    title: 'Rate',
    policyRevision: 'policy-0',
    contentRevision: 'content-0',
    deletedAt: null,
  });
  harness.state.members.push({
    collectionId: 'col-rate', subjectId: owner.subjectId, role: 'owner', grantedAt: harness.state.now,
  });
  const headers = (index: number) => ({
    cookie: owner.cookie,
    origin: ORIGIN,
    'x-csrf-token': owner.csrfToken,
    'content-type': 'application/json',
    'known-command-id': commandId(index),
    'if-match': `"${harness.state.collections.get('col-rate')!.policyRevision}"`,
  });
  for (let index = 0; index < 20; index += 1) {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections/col-rate/members/invites',
      headers: headers(index),
      payload: { email: `rate-${index}@example.test`, role: 'viewer' },
    });
    assert.equal(response.statusCode, 201, response.payload);
  }
  const denied = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/collections/col-rate/members/invites',
    headers: headers(20),
    payload: { email: 'rate-20@example.test', role: 'viewer' },
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'rate_limited');
  assert.ok(Number(denied.headers['retry-after']) >= 1);
});

test('limiter failure is 503 without Retry-After', async () => {
  const limiter: CollaborationInviteRateLimiter = {
    policy: Object.freeze({ 'collaboration-invite': 'collaboration-invite:1:20/60' }),
    async consumeInvite() {
      return { kind: 'failed', failure: { class: 'unavailable', code: 'rate_limit_unavailable' } };
    },
    async consumeAcceptOrDecline() {
      return { kind: 'failed', failure: { class: 'unavailable', code: 'rate_limit_unavailable' } };
    },
    readiness() { return { status: 'degraded', reason: 'last_command_failed' }; },
    async close() {},
  };
  const harness = createHarness(limiter);
  const owner = await login(harness, {
    subject: 'owner-fail', email: 'owner-fail@example.test', displayName: 'Ada Owner',
  });
  harness.state.collections.set('col-fail', {
    id: 'col-fail',
    ownerSubjectId: owner.subjectId,
    visibility: 'private',
    title: 'Fail',
    policyRevision: 'policy-0',
    contentRevision: 'content-0',
    deletedAt: null,
  });
  harness.state.members.push({
    collectionId: 'col-fail', subjectId: owner.subjectId, role: 'owner', grantedAt: harness.state.now,
  });
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/collections/col-fail/members/invites',
    headers: {
      cookie: owner.cookie,
      origin: ORIGIN,
      'x-csrf-token': owner.csrfToken,
      'content-type': 'application/json',
      'known-command-id': commandId(0),
      'if-match': '"policy-0"',
    },
    payload: { email: 'fail@example.test', role: 'viewer' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.equal(response.headers['retry-after'], undefined);
});

test('CSRF missing on POST invite is 403', async () => {
  const harness = createHarness(createMemoryCollaborationInviteRateLimiter({
    keySecret: TEST_SECRET,
    environment: 'test',
  }));
  const owner = await login(harness, {
    subject: 'owner-csrf', email: 'owner-csrf@example.test', displayName: 'Ada Owner',
  });
  harness.state.collections.set('col-csrf', {
    id: 'col-csrf',
    ownerSubjectId: owner.subjectId,
    visibility: 'private',
    title: 'Csrf',
    policyRevision: 'policy-0',
    contentRevision: 'content-0',
    deletedAt: null,
  });
  harness.state.members.push({
    collectionId: 'col-csrf', subjectId: owner.subjectId, role: 'owner', grantedAt: harness.state.now,
  });
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/collections/col-csrf/members/invites',
    headers: {
      cookie: owner.cookie,
      origin: ORIGIN,
      'content-type': 'application/json',
      'known-command-id': commandId(0),
      'if-match': '"policy-0"',
    },
    payload: { email: 'csrf@example.test', role: 'viewer' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'csrf_failed');
});

test('composeCollaborationInviteRateLimiter is not given a per-process randomBytes key', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readApiCompositionSource(resolve(here, '../../..'));
  const compose = source.match(/composeCollaborationInviteRateLimiter\(\{[\s\S]*?\}\)/);
  assert.ok(compose);
  assert.equal(compose[0].includes('randomBytes'), false);
  assert.equal(source.includes('keySecret: config.collaborationInviteRateLimit.keySecret ??'), false);
  assert.match(source, /keySecret:\s*config\.collaborationInviteRateLimit\.keySecret,/);
});
