import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createProductCollectionVersionCursorSigner,
  strongEntityTag,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type CollectionVersionStorePort,
} from '../../../src/modules/collections/index.js';
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
const BM_A = 'bm_inbox_a';
const BM_B = 'bm_inbox_b';
const NOW = new Date('2026-08-24T08:00:00.000Z');
const MATCH = strongEntityTag('rev-1');
const LIST = `/api/v1/collections/${COL}/versions`;
const ITEM = (versionId: string) => `/api/v1/collections/${COL}/versions/${versionId}`;

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/collection_version_http_test',
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

function member(id: string, overrides: Partial<CollectionTreeLiveMember> = {}): CollectionTreeLiveMember {
  return {
    id,
    kind: 'bookmark',
    parentId: ROOT,
    title: id,
    url: `https://example.test/${id}`,
    positionToken: id,
    ...overrides,
  };
}

function unsortedMembers(): CollectionTreeLiveMember[] {
  return [
    member(UNSORTED, { kind: 'folder', title: 'Unsorted', url: null, positionToken: 'a' }),
    member(BM_A, { parentId: UNSORTED, title: 'Repo A', positionToken: 'a' }),
    member(BM_B, { parentId: UNSORTED, title: 'Repo B', positionToken: 'm' }),
  ];
}

function versionReceipts(receipts: MemoryProductCommandReceipts) {
  const base = createMemoryProductCommandReceiptPort(receipts);
  return {
    claim: (binding: Parameters<typeof base.claim>[0], fingerprint: string) =>
      base.claim(binding, fingerprint),
    complete: (
      binding: Parameters<typeof base.complete>[0],
      fingerprint: string,
      result: Parameters<typeof base.complete>[2],
    ) => base.complete(binding, fingerprint, result),
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

function memoryStore(input: {
  readonly ownerSubjectId: string;
  readonly accountId: string;
  readonly members: CollectionTreeLiveMember[];
  readonly rows: CollectionVersionRecord[];
}): CollectionVersionStorePort {
  const { members, rows } = input;
  const ownedLive = async (collectionId: string, ownerSubjectId: string) => {
    if (collectionId !== COL || ownerSubjectId !== input.ownerSubjectId) return null;
    return {
      collectionId: COL,
      ownerSubjectId: input.ownerSubjectId,
      contentRevision: 'rev-1',
      rootNodeId: ROOT,
    };
  };
  return {
    async lockOwnedLive(collectionId, ownerSubjectId) {
      return ownedLive(collectionId, ownerSubjectId);
    },
    async getOwnedLive(collectionId, ownerSubjectId) {
      return ownedLive(collectionId, ownerSubjectId);
    },
    async loadLiveMembers(collectionId) {
      return collectionId === COL ? members : [];
    },
    async getByCollectionAndRevision(accountId, collectionId, contentRevision) {
      return rows.find((row) =>
        row.accountId === accountId
        && row.collectionId === collectionId
        && row.contentRevision === contentRevision) ?? null;
    },
    async getById(accountId, collectionId, versionId) {
      return rows.find((row) =>
        row.accountId === accountId
        && row.collectionId === collectionId
        && row.versionId === versionId) ?? null;
    },
    async list(accountId, collectionId, query) {
      const sorted = rows
        .filter((row) => row.accountId === accountId && row.collectionId === collectionId)
        .sort((left, right) => {
          const time = right.createdAt.getTime() - left.createdAt.getTime();
          if (time !== 0) return time;
          return right.versionId < left.versionId ? -1 : right.versionId > left.versionId ? 1 : 0;
        });
      const filtered = query.after
        ? sorted.filter((row) => {
          const time = row.createdAt.getTime() - query.after!.createdAt.getTime();
          if (time !== 0) return time < 0;
          return row.versionId < query.after!.versionId;
        })
        : sorted;
      return filtered.slice(0, query.limit + 1);
    },
    async insert(row) { rows.push(row); },
    async count(_accountId, collectionId) {
      return rows.filter((row) => row.collectionId === collectionId).length;
    },
    async deleteOldest() { rows.shift(); },
    async findLatestManualCreatedAt() {
      const manuals = rows.filter((row) => row.kind === 'manual');
      return manuals.at(-1)?.createdAt ?? null;
    },
  };
}

async function harness(input: {
  readonly enabled: boolean;
  readonly members?: CollectionTreeLiveMember[];
  readonly rows?: CollectionVersionRecord[];
}) {
  const config = loadConfig({
    ...baseEnv,
    KNOWN_FEATURE_COLLECTION_HISTORY: input.enabled ? 'true' : 'false',
  });
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'hvowner',
  });
  const outsider = await issueTestSession({
    factory, subject: 'outsider-subject', displayName: 'Outsider', handle: 'hvout',
  });
  const members = [...(input.members ?? unsortedMembers())];
  const rows = [...(input.rows ?? [])];
  const receipts: MemoryProductCommandReceipts = new Map();
  let nextId = 0;
  const versions = memoryStore({
    ownerSubjectId: owner.subjectId,
    accountId: owner.accountId,
    members,
    rows,
  });
  const signer = createProductCollectionVersionCursorSigner({
    current: { id: 'cv-http-v1', key: 'collection-versions-http-cursor-secret-material' },
  });
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    collectionVersions: {
      execute: async (work) => work({
        versions,
        receipts: versionReceipts(receipts),
        clock: { now: () => NOW },
        ids: { nextVersionId: () => `ver-${++nextId}` },
      }),
    },
    collectionVersionCursors: signer,
  });
  apps.push(app);
  return { app, owner, outsider, members, rows, signer };
}

describe('POST/GET /api/v1/collections/:collectionId/versions', () => {
  test('anonymous requests are 401 authentication_required', async () => {
    const { app } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST',
      url: LIST,
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: {},
    });
    assertProductErrorEnvelope(created, 401, 'authentication_required');
    const listed = await app.inject({ method: 'GET', url: LIST });
    assertProductErrorEnvelope(listed, 401, 'authentication_required');
    const item = await app.inject({ method: 'GET', url: ITEM('ver-1') });
    assertProductErrorEnvelope(item, 401, 'authentication_required');
  });

  test('flag off 404 resource_not_found without feature_temporarily_unavailable', async () => {
    const { app, owner } = await harness({ enabled: false });
    assert.match(app.printRoutes(), /versions/u);
    const created = await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    assertProductErrorEnvelope(created, 404, 'resource_not_found');
    assert.equal(JSON.stringify(created.json()).includes('feature_temporarily_unavailable'), false);
    const listed = await app.inject({
      method: 'GET', url: LIST, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(listed, 404, 'resource_not_found');
    assert.equal(JSON.stringify(listed.json()).includes('feature_temporarily_unavailable'), false);
    const item = await app.inject({
      method: 'GET', url: ITEM('ver-1'), headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(item, 404, 'resource_not_found');
    assert.equal(JSON.stringify(item.json()).includes('feature_temporarily_unavailable'), false);
  });

  test('owner create 201 then list length 1; same revision second create is 200', async () => {
    const { app, owner } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    const body = created.json() as {
      versionId: string;
      nodeCount: number;
      kind: string;
      label: string;
      changeCounts: { added: number };
    };
    assert.equal(body.kind, 'manual');
    assert.equal(body.nodeCount, 3);
    assert.equal(body.label, 'Snapshot 2026-08-24T08:00:00Z');
    assert.equal(Object.hasOwn(body, 'treeJson'), false);
    assert.equal(created.headers['cache-control'], 'private, no-store');
    assert.equal(created.headers.location, ITEM(body.versionId));
    const listed = await app.inject({
      method: 'GET', url: LIST, headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 200);
    const page = listed.json() as { items: Array<{ versionId: string; changes?: unknown }>; nextCursor: string | null };
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.versionId, body.versionId);
    assert.equal(Object.hasOwn(page.items[0] ?? {}, 'changes'), false);
    assert.equal(page.nextCursor, null);
    const second = await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(second.statusCode, 200);
    assert.equal((second.json() as { versionId: string }).versionId, body.versionId);
    const listedAgain = await app.inject({
      method: 'GET', url: LIST, headers: { cookie: owner.cookie },
    });
    assert.equal((listedAgain.json() as { items: unknown[] }).items.length, 1);
  });

  test('empty tree create is 201 nodeCount 0; empty list is items []', async () => {
    const empty = await harness({ enabled: true, members: [] });
    const created = await empty.app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(empty.owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    assert.equal((created.json() as { nodeCount: number }).nodeCount, 0);
    const listed = await harness({ enabled: true, members: [] });
    const page = await listed.app.inject({
      method: 'GET', url: LIST, headers: { cookie: listed.owner.cookie },
    });
    assert.equal(page.statusCode, 200);
    assert.deepEqual(page.json(), { items: [], nextCursor: null });
  });

  test('non-owner and If-Match 428/412', async () => {
    const { app, owner, outsider } = await harness({ enabled: true });
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(outsider, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    }), 404, 'resource_not_found');
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID()),
      payload: {},
    }), 428, 'precondition_required');
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': '"other"' }),
      payload: {},
    }), 412, 'precondition_failed');
  });

  test('more than 2000 live members is 400 invalid_request', async () => {
    const members = Array.from({ length: 2001 }, (_, index) =>
      member(`bm-${index}`, { positionToken: `p${index}` }));
    const { app, owner } = await harness({ enabled: true, members });
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    }), 400, 'invalid_request');
  });

  test('manual create within 10s cooldown is 429 rate_limited', async () => {
    const { app, owner, rows } = await harness({ enabled: true });
    rows.push({
      versionId: 'ver-recent',
      accountId: owner.accountId,
      collectionId: COL,
      contentRevision: 'rev-old',
      kind: 'manual',
      label: 'Recent',
      etag: '"ver-recent"',
      nodeCount: 0,
      treeJson: [],
      createdAt: new Date(NOW.getTime() - 1_000),
    });
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    }), 429, 'rate_limited');
  });

  test('GET list with more than 2000 live members and a seeded snapshot is 200', async () => {
    const members = Array.from({ length: 2001 }, (_, index) =>
      member(`bm-${String(index).padStart(4, '0')}`, {
        positionToken: `p${String(index).padStart(4, '0')}`,
      }));
    const { app, owner, rows } = await harness({ enabled: true, members });
    const subset = members.slice(0, 2);
    rows.push({
      versionId: 'ver-seeded',
      accountId: owner.accountId,
      collectionId: COL,
      contentRevision: 'rev-old',
      kind: 'manual',
      label: 'Seeded',
      etag: '"ver-seeded"',
      nodeCount: subset.length,
      treeJson: subset.map((row) => ({
        id: row.id,
        kind: row.kind,
        parentId: row.parentId,
        title: row.title,
        url: row.url,
      })),
      createdAt: NOW,
    });
    const listed = await app.inject({
      method: 'GET', url: LIST, headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json() as { items?: unknown[]; error?: { code: string; message: string } };
    assert.notEqual(body.error?.code, 'invalid_request');
    assert.equal(JSON.stringify(body).includes('cannot include more than 2000'), false);
    assert.equal(Array.isArray(body.items), true);
    assert.equal((body.items as unknown[]).length, 1);
  });

  test('GET by id with more than 2000 live members and a seeded snapshot is 200', async () => {
    const members = Array.from({ length: 2001 }, (_, index) =>
      member(`bm-${String(index).padStart(4, '0')}`, {
        positionToken: `p${String(index).padStart(4, '0')}`,
      }));
    const { app, owner, rows } = await harness({ enabled: true, members });
    const subset = members.slice(0, 2);
    rows.push({
      versionId: 'ver-seeded',
      accountId: owner.accountId,
      collectionId: COL,
      contentRevision: 'rev-old',
      kind: 'manual',
      label: 'Seeded',
      etag: '"ver-seeded"',
      nodeCount: subset.length,
      treeJson: subset.map((row) => ({
        id: row.id,
        kind: row.kind,
        parentId: row.parentId,
        title: row.title,
        url: row.url,
      })),
      createdAt: NOW,
    });
    const item = await app.inject({
      method: 'GET', url: ITEM('ver-seeded'), headers: { cookie: owner.cookie },
    });
    assert.equal(item.statusCode, 200);
    const body = item.json() as { error?: { code: string; message: string }; versionId?: string };
    assert.notEqual(body.error?.code, 'invalid_request');
    assert.equal(JSON.stringify(body).includes('cannot include more than 2000'), false);
    assert.equal(body.versionId, 'ver-seeded');
  });

  test('GET by id includes removed changes; outsider is 404', async () => {
    const { app, owner, outsider, members } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST',
      url: LIST,
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    const versionId = (created.json() as { versionId: string }).versionId;
    const gone = members.findIndex((row) => row.id === BM_B);
    members.splice(gone, 1);
    const item = await app.inject({
      method: 'GET', url: ITEM(versionId), headers: { cookie: owner.cookie },
    });
    assert.equal(item.statusCode, 200);
    const body = item.json() as {
      changeCounts: { removed: number };
      changes: Array<{ type: string; nodeId: string }>;
      truncated: boolean;
    };
    assert.equal(body.changeCounts.removed, 1);
    assert.equal(body.changes.some((change) => change.type === 'removed' && change.nodeId === BM_B), true);
    assert.equal(body.truncated, false);
    assert.equal(Object.hasOwn(body, 'treeJson'), false);
    assertProductErrorEnvelope(await app.inject({
      method: 'GET', url: ITEM(versionId), headers: { cookie: outsider.cookie },
    }), 404, 'resource_not_found');
  });

  test('list first page accepts limit; continuation is cursor only', async () => {
    const { app, owner, rows } = await harness({ enabled: true, members: [] });
    for (const [index, versionId] of ['ver-a', 'ver-b', 'ver-c'].entries()) {
      rows.push({
        versionId,
        accountId: owner.accountId,
        collectionId: COL,
        contentRevision: `rev-${versionId}`,
        kind: 'manual',
        label: versionId,
        etag: `"${versionId}"`,
        nodeCount: 0,
        treeJson: [],
        createdAt: new Date(NOW.getTime() + index * 1000),
      });
    }
    const first = await app.inject({
      method: 'GET', url: `${LIST}?limit=1`, headers: { cookie: owner.cookie },
    });
    assert.equal(first.statusCode, 200);
    const page = first.json() as { items: Array<{ versionId: string }>; nextCursor: string | null };
    assert.deepEqual(page.items.map((item) => item.versionId), ['ver-c']);
    assert.ok(page.nextCursor);
    const continued = await app.inject({
      method: 'GET',
      url: `${LIST}?cursor=${encodeURIComponent(page.nextCursor)}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(continued.statusCode, 200);
    const next = continued.json() as { items: Array<{ versionId: string }>; nextCursor: string | null };
    assert.deepEqual(next.items.map((item) => item.versionId), ['ver-b']);
    assert.ok(next.nextCursor);
  });
});
