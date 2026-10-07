import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  OrganizePlanRateLimitError,
  createOrganizePlanner,
  freezeOrganizePlanEtag,
  organizePlanApplyCommandScope,
  organizePlanApplyFingerprint,
  type OrganizePlanRecord,
  type OrganizePlannerBookmark,
  type OrganizePlannerFolder,
} from '../../../src/modules/collections/index.js';
import {
  createMemoryPorts,
  createState,
} from '../../support/move-collection-node-memory.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  issueTestSession,
  productCommandReceiptKey,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';

const COL = 'col_owner_01';
const ROOT = 'root_owner_01';
const UNSORTED = 'folder_unsorted_01';
const ARCHIVES = 'folder_archives_01';
const BM_INBOX_A = 'bm_inbox_a';
const BM_INBOX_B = 'bm_inbox_b';
const BM_ROOT = 'bm_root_1';
const BM_ARCH = 'bm_arch_1';

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/organize_plan_http_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example/realms/known',
  OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function mutationHeaders(
  client: { cookie: string; csrfToken: string },
  commandId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: 'https://app.example.test',
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
    ...extra,
  };
}

function organizeReceipts(receipts: MemoryProductCommandReceipts) {
  const base = createMemoryProductCommandReceiptPort(receipts);
  return {
    claim: (binding: Parameters<typeof base.claim>[0], fingerprint: string) =>
      base.claim(binding, fingerprint),
    complete: (binding: Parameters<typeof base.complete>[0], fingerprint: string, result: Parameters<typeof base.complete>[2]) =>
      base.complete(binding, fingerprint, result),
    async lookup(binding: Parameters<typeof base.claim>[0], fingerprint: string) {
      const existing = receipts.get(productCommandReceiptKey(binding));
      if (!existing) return { kind: 'absent' as const };
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' as const };
      if (existing.expired) {
        return { kind: 'expired' as const, resultDigest: existing.resultDigest ?? null };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress' as const, retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return {
        kind: 'replay' as const,
        result: {
          status: existing.result.status,
          body: existing.result.body.slice(),
          stableHeaders: { ...existing.result.stableHeaders },
          mediaType: existing.result.mediaType,
          contractVersion: existing.result.contractVersion,
          targetIdentity: existing.result.targetIdentity,
        },
      };
    },
  };
}

function ownerTree(): {
  folders: OrganizePlannerFolder[];
  bookmarks: OrganizePlannerBookmark[];
} {
  return {
    folders: [
      { id: ROOT, parentId: '', title: 'Library' },
      { id: UNSORTED, parentId: ROOT, title: 'Unsorted' },
      { id: ARCHIVES, parentId: ROOT, title: 'Archives' },
    ],
    bookmarks: [
      { id: BM_INBOX_A, parentId: UNSORTED, title: 'Repo A', url: 'https://github.com/acme/a' },
      { id: BM_INBOX_B, parentId: UNSORTED, title: 'Repo B', url: 'https://github.com/acme/b' },
      { id: BM_ROOT, parentId: ROOT, title: 'Root tab', url: 'https://github.com/acme/root' },
      { id: BM_ARCH, parentId: ARCHIVES, title: 'Archived', url: 'https://github.com/acme/arch' },
    ],
  };
}

async function harness(input: { readonly enabled: boolean }) {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    KNOWN_FEATURE_AI_ORGANIZE: input.enabled ? 'true' : 'false',
  };
  const config = loadConfig(env);
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date()));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'ogpowner',
  });
  const outsider = await issueTestSession({
    factory, subject: 'outsider-subject', displayName: 'Outsider', handle: 'ogpout',
  });
  const plans: OrganizePlanRecord[] = [];
  const receipts: MemoryProductCommandReceipts = new Map();
  const tree = ownerTree();
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    organizePlanReads: {
      async getById(accountId, collectionId, planId) {
        return plans.find((plan) =>
          plan.accountId === accountId
          && plan.collectionId === collectionId
          && plan.planId === planId) ?? null;
      },
    },
    organizePlanMutations: {
      execute: async (work) => work({
        receipts: organizeReceipts(receipts),
        plans: {
          async expireOpen(accountId, collectionId, now) {
            for (const plan of plans) {
              if (plan.accountId === accountId && plan.collectionId === collectionId && plan.status === 'open') {
                (plan as { status: string }).status = 'expired';
                (plan as { updatedAt: Date }).updatedAt = now;
              }
            }
          },
          async insert(row) {
            if (plans.some((plan) =>
              plan.accountId === row.accountId
              && plan.collectionId === row.collectionId
              && plan.status === 'open')) {
              throw new OrganizePlanRateLimitError();
            }
            plans.push(row);
          },
          async findLatestCreatedAt(accountId, collectionId) {
            const matches = plans
              .filter((plan) => plan.accountId === accountId && plan.collectionId === collectionId)
              .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
            return matches[0]?.createdAt ?? null;
          },
          async getById(accountId, collectionId, planId) {
            return plans.find((plan) =>
              plan.accountId === accountId
              && plan.collectionId === collectionId
              && plan.planId === planId) ?? null;
          },
          async persistApplyReceipt(input) {
            const plan = plans.find((row) =>
              row.accountId === input.accountId
              && row.collectionId === input.collectionId
              && row.planId === input.planId);
            if (!plan) return;
            (plan as { applyReceipt: unknown }).applyReceipt = input.applyReceipt;
            (plan as { updatedAt: Date }).updatedAt = input.now;
          },
          async markApplied(input) {
            const plan = plans.find((row) =>
              row.accountId === input.accountId
              && row.collectionId === input.collectionId
              && row.planId === input.planId);
            if (!plan) return;
            (plan as { status: string }).status = 'applied';
            (plan as { appliedActionIds: readonly string[] }).appliedActionIds = input.appliedActionIds;
            (plan as { updatedAt: Date }).updatedAt = input.now;
          },
        },
        collections: {
          async lockOwnedLive(collectionId, ownerSubjectId) {
            if (collectionId !== COL || ownerSubjectId !== owner.subjectId) return null;
            return {
              collectionId: COL,
              ownerSubjectId: owner.subjectId,
              contentRevision: 'rev-1',
              rootNodeId: ROOT,
            };
          },
          async loadLiveTree(collectionId) {
            if (collectionId !== COL) return { folders: [], bookmarks: [] };
            return tree;
          },
        },
        mutations: createMemoryPorts(createState()),
        clock: { now: () => new Date() },
      }),
    },
    organizePlanner: createOrganizePlanner(undefined),
  });
  apps.push(app);
  return { app, owner, outsider, plans, receipts };
}

describe('POST/GET /api/v1/collections/:collectionId/organize-plans', () => {
  test('anonymous requests are 401 authentication_required', async () => {
    const { app } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans`,
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: {},
    });
    assertProductErrorEnvelope(created, 401, 'authentication_required');
    const item = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/plan-1`,
    });
    assertProductErrorEnvelope(item, 401, 'authentication_required');
  });

  test('flag off 404 resource_not_found without feature_temporarily_unavailable', async () => {
    const { app, owner } = await harness({ enabled: false });
    const routes = app.printRoutes();
    assert.match(routes, /organize-plans/u);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans`,
      headers: mutationHeaders(owner, randomUUID()),
      payload: {},
    });
    assertProductErrorEnvelope(created, 404, 'resource_not_found');
    assert.equal(JSON.stringify(created.json()).includes('feature_temporarily_unavailable'), false);
    const item = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/plan-1`,
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(item, 404, 'resource_not_found');
    assert.equal(JSON.stringify(item.json()).includes('feature_temporarily_unavailable'), false);
    const applied = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans/plan-1/apply`,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': '"plan-etag"' }),
      payload: { actionIds: ['action-1'] },
    });
    assertProductErrorEnvelope(applied, 404, 'resource_not_found');
    assert.equal(JSON.stringify(applied.json()).includes('feature_temporarily_unavailable'), false);
  });

  test('owner sees Unsorted bookmarks in actions and root bookmarks excluded', async () => {
    const { app, owner } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans`,
      headers: mutationHeaders(owner, randomUUID()),
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    const body = created.json() as {
      planId: string;
      etag: string;
      plannerId: string;
      truncated: boolean;
      actions: Array<{ nodeIds: string[]; sourceFolderId: string }>;
    };
    assert.equal(body.plannerId, 'heuristic.v1.host_cluster');
    assert.equal(body.truncated, false);
    assert.equal(created.headers['cache-control'], 'private, no-store');
    assert.equal(
      created.headers.location,
      `/api/v1/collections/${COL}/organize-plans/${body.planId}`,
    );
    const nodeIds = body.actions.flatMap((action) => action.nodeIds);
    assert.equal(nodeIds.includes(BM_INBOX_A), true);
    assert.equal(nodeIds.includes(BM_INBOX_B), true);
    assert.equal(nodeIds.includes(BM_ROOT), false);
    assert.equal(body.actions.every((action) => action.sourceFolderId === UNSORTED), true);
    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/${body.planId}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(got.statusCode, 200);
    assert.equal((got.json() as { etag: string }).etag, body.etag);
    assert.equal(got.headers['cache-control'], 'private, no-store');
    assert.equal(got.headers.etag, body.etag);
  });

  test('non-owner collectionId is 404 resource_not_found', async () => {
    const { app, outsider } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans`,
      headers: mutationHeaders(outsider, randomUUID()),
      payload: {},
    });
    assertProductErrorEnvelope(created, 404, 'resource_not_found');
  });

  test('expired GET is 404 resource_not_found', async () => {
    const { app, owner, plans } = await harness({ enabled: true });
    plans.push({
      planId: 'plan_expired_01',
      accountId: owner.accountId,
      collectionId: COL,
      collectionRevision: 'rev-1',
      plannerId: 'heuristic.v1.host_cluster',
      status: 'open',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      etag: '"expired-etag"',
      truncated: false,
      actions: [],
      appliedActionIds: null,
      applyReceipt: null,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const item = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/plan_expired_01`,
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(item, 404, 'resource_not_found');
  });

  test('applied, other-user, and unknown GET are 404 resource_not_found', async () => {
    const { app, owner, outsider, plans } = await harness({ enabled: true });
    plans.push({
      planId: 'plan_applied_01',
      accountId: owner.accountId,
      collectionId: COL,
      collectionRevision: 'rev-1',
      plannerId: 'heuristic.v1.host_cluster',
      status: 'applied',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      etag: '"applied-etag"',
      truncated: false,
      actions: [],
      appliedActionIds: ['action-1'],
      applyReceipt: null,
      createdAt: new Date('2026-08-23T08:00:00.000Z'),
      updatedAt: new Date('2026-08-23T08:00:00.000Z'),
    });
    const applied = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/plan_applied_01`,
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(applied, 404, 'resource_not_found');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans`,
      headers: mutationHeaders(owner, randomUUID()),
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    const planId = (created.json() as { planId: string }).planId;
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/${planId}`,
      headers: { cookie: outsider.cookie },
    });
    assertProductErrorEnvelope(foreign, 404, 'resource_not_found');
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/plan_unknown_01`,
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(unknown, 404, 'resource_not_found');
  });

  test('creating a new open plan expires the previous open plan in the same collection', async () => {
    const { app, owner, plans } = await harness({ enabled: true });
    plans.push({
      planId: 'plan_previous_open',
      accountId: owner.accountId,
      collectionId: COL,
      collectionRevision: 'rev-1',
      plannerId: 'heuristic.v1.host_cluster',
      status: 'open',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      etag: '"previous-etag"',
      truncated: false,
      actions: [],
      appliedActionIds: null,
      applyReceipt: null,
      createdAt: new Date(Date.now() - 11_000),
      updatedAt: new Date(Date.now() - 11_000),
    });
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${COL}/organize-plans`,
      headers: mutationHeaders(owner, randomUUID()),
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    const previous = plans.find((plan) => plan.planId === 'plan_previous_open');
    assert.equal(previous?.status, 'expired');
    const previousGet = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/plan_previous_open`,
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(previousGet, 404, 'resource_not_found');
    const nextId = (created.json() as { planId: string }).planId;
    const nextGet = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${COL}/organize-plans/${nextId}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(nextGet.statusCode, 200);
  });
});

const APPLY = `/api/v1/collections/${COL}/organize-plans/plan_open_apply/apply`;
const APPLY_ACTION = 'action_apply_1';
const APPLY_ETAG = freezeOrganizePlanEtag({
  planId: 'plan_open_apply',
  contentRevision: 'rev-1',
  actionIds: [APPLY_ACTION],
});

function openApplyPlan(accountId: string): OrganizePlanRecord {
  return {
    planId: 'plan_open_apply',
    accountId,
    collectionId: COL,
    collectionRevision: 'rev-1',
    plannerId: 'heuristic.v1.host_cluster',
    status: 'open',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    etag: APPLY_ETAG,
    truncated: false,
    actions: [{
      id: APPLY_ACTION,
      sourceFolderId: UNSORTED,
      sourceFolderTitle: 'Unsorted',
      target: { type: 'existing', folderId: ARCHIVES, title: 'Archives' },
      nodeIds: [BM_INBOX_A, BM_INBOX_B],
      count: 2,
      reason: 'Title/host overlap with "Archives".',
      confidence: 80,
    }],
    appliedActionIds: null,
    applyReceipt: null,
    createdAt: new Date('2026-08-23T08:00:00.000Z'),
    updatedAt: new Date('2026-08-23T08:00:00.000Z'),
  };
}

describe('POST /api/v1/collections/:collectionId/organize-plans/:planId/apply', () => {
  test('missing CSRF is csrf_failed', async () => {
    const { app, owner } = await harness({ enabled: true });
    const response = await app.inject({
      method: 'POST',
      url: APPLY,
      headers: {
        cookie: owner.cookie,
        origin: 'https://app.example.test',
        'known-command-id': randomUUID(),
        'content-type': 'application/json',
        'if-match': APPLY_ETAG,
      },
      payload: { actionIds: [APPLY_ACTION] },
    });
    assertProductErrorEnvelope(response, 403, 'csrf_failed');
  });

  test('missing If-Match is 428 precondition_required', async () => {
    const { app, owner, plans } = await harness({ enabled: true });
    plans.push(openApplyPlan(owner.accountId));
    const response = await app.inject({
      method: 'POST',
      url: APPLY,
      headers: mutationHeaders(owner, randomUUID()),
      payload: { actionIds: [APPLY_ACTION] },
    });
    assertProductErrorEnvelope(response, 428, 'precondition_required');
  });

  test('wrong If-Match is 412 precondition_failed', async () => {
    const { app, owner, plans } = await harness({ enabled: true });
    plans.push(openApplyPlan(owner.accountId));
    const response = await app.inject({
      method: 'POST',
      url: APPLY,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': '"not-the-plan-etag"' }),
      payload: { actionIds: [APPLY_ACTION] },
    });
    assertProductErrorEnvelope(response, 412, 'precondition_failed');
  });

  test('empty actionIds is 400 invalid_request', async () => {
    const { app, owner, plans } = await harness({ enabled: true });
    plans.push(openApplyPlan(owner.accountId));
    const missing = await app.inject({
      method: 'POST',
      url: APPLY,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': APPLY_ETAG }),
      payload: {},
    });
    assertProductErrorEnvelope(missing, 400, 'invalid_request');
    const empty = await app.inject({
      method: 'POST',
      url: APPLY,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': APPLY_ETAG }),
      payload: { actionIds: [] },
    });
    assertProductErrorEnvelope(empty, 400, 'invalid_request');
  });

  test('same Known-Command-Id replays the first apply receipt', async () => {
    const { app, owner, plans, receipts } = await harness({ enabled: true });
    plans.push(openApplyPlan(owner.accountId));
    const commandId = randomUUID();
    const actionIds = [APPLY_ACTION];
    const body = {
      planId: 'plan_open_apply',
      appliedActionIds: actionIds,
      createdFolderIds: [],
      movedNodeIds: [BM_INBOX_A, BM_INBOX_B],
    };
    const fingerprint = organizePlanApplyFingerprint({
      collectionId: COL,
      planId: 'plan_open_apply',
      actionIds,
      ifMatch: APPLY_ETAG,
    });
    receipts.set(productCommandReceiptKey({
      principalId: owner.accountId,
      commandScope: organizePlanApplyCommandScope(COL, 'plan_open_apply'),
      commandId,
    }), {
      fingerprint,
      status: 'completed',
      result: {
        status: 200,
        body: Buffer.from(JSON.stringify(body), 'utf8'),
        stableHeaders: {
          'cache-control': 'private, no-store',
          'content-type': 'application/json',
        },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
      },
    });
    const replay = await app.inject({
      method: 'POST',
      url: APPLY,
      headers: mutationHeaders(owner, commandId, { 'if-match': APPLY_ETAG }),
      payload: { actionIds },
    });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), body);
    assert.equal(replay.headers['cache-control'], 'private, no-store');
  });
});
