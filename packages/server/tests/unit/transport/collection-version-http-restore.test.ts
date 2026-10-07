import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test, vi } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createProductCollectionVersionCursorSigner,
  strongEntityTag,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type CollectionVersionStorePort,
} from '../../../src/modules/collections/index.js';
import { createMemoryCollectionVersionRestoreReceiptStore } from '../../support/collection-version-restore-receipts-memory.js';
import * as deleteNodeModule from '../../../src/modules/collections/application/delete-collection-node.js';
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
import {
  createMemoryPorts,
  createState,
  seedCollection,
  seedNode,
  type MemoryState,
} from '../../support/move-collection-node-memory.js';

const COL = 'col_owner_01';
const ROOT = 'root_owner_01';
const UNSORTED = 'folder_unsorted_01';
const BM_A = 'bm_inbox_a';
const BM_B = 'bm_inbox_b';
const EXTRA = 'folder_extra_01';
const NOW = new Date('2026-08-24T08:00:00.000Z');
const MATCH = strongEntityTag('rev-1');
const RESTORE = (versionId: string) =>
  `/api/v1/collections/${COL}/versions/${versionId}/restore`;

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/collection_version_restore_http_test',
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
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
});

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

function liveMembers(state: MemoryState): CollectionTreeLiveMember[] {
  return [...state.nodes.values()]
    .filter((node) =>
      node.collectionId === COL
      && !node.isRoot
      && node.deletedAt === null
      && (node.kind === 'folder' || node.kind === 'bookmark'))
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      parentId: node.parentId ?? ROOT,
      title: node.title,
      url: node.kind === 'bookmark' ? node.url : null,
      positionToken: node.positionToken ?? node.id,
    }));
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

function restoreMutations(state: MemoryState) {
  const base = createMemoryPorts(state);
  return {
    ...base,
    canonical: {
      async execute(input: Parameters<typeof base.canonical.execute>[0]) {
        if (input.mutation.action === 'delete') {
          const node = state.nodes.get(input.mutation.target.resourceId)!;
          const parentId = node.parentId!;
          node.deletedAt = state.now;
          const collection = state.collections.get(input.collectionId)!;
          collection.commitOrdinal += 1n;
          const resourceRevision = `del-${collection.commitOrdinal}`;
          const contentRevision = `cnt-${collection.commitOrdinal}`;
          const parentChildrenRevision = `pch-${collection.commitOrdinal}`;
          const parent = state.nodes.get(parentId);
          if (parent) parent.childrenRevision = parentChildrenRevision;
          collection.contentRevision = contentRevision;
          return {
            operationId: input.operationId,
            collectionId: input.collectionId,
            resourceId: node.id,
            action: 'delete' as const,
            allocation: {
              commitOrdinal: collection.commitOrdinal,
              resourceRevision,
              contentRevision,
              childrenRevisions: { [parentId]: parentChildrenRevision },
              deletedResourceRevisions: { [node.id]: resourceRevision },
            },
          };
        }
        return base.canonical.execute(input);
      },
      bootstrapOwnedCollection: base.canonical.bootstrapOwnedCollection,
    },
  };
}

function memoryStore(state: MemoryState, rows: CollectionVersionRecord[]): CollectionVersionStorePort {
  const ownedLive = async (collectionId: string, ownerSubjectId: string) => {
    const row = state.collections.get(collectionId);
    if (!row || row.ownerSubjectId !== ownerSubjectId || row.deletedAt) return null;
    return {
      collectionId: row.id,
      ownerSubjectId: row.ownerSubjectId,
      contentRevision: row.contentRevision,
      rootNodeId: row.rootNodeId,
    };
  };
  return {
    async lockOwnedLive(collectionId, ownerSubjectId) {
      return ownedLive(collectionId, ownerSubjectId);
    },
    async getOwnedLive(collectionId, ownerSubjectId) {
      return ownedLive(collectionId, ownerSubjectId);
    },
    async loadLiveMembers() { return liveMembers(state); },
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
    async list() { return rows; },
    async insert(row) { rows.push(row); },
    async count() { return rows.length; },
    async deleteOldest(_accountId, _collectionId, excludeVersionId) {
      const victim = rows.find((row) => row.versionId !== excludeVersionId);
      if (victim) rows.splice(rows.indexOf(victim), 1);
    },
    async findLatestManualCreatedAt() { return null; },
  };
}

async function harness(input: { readonly enabled: boolean }) {
  const config = loadConfig({
    ...baseEnv,
    KNOWN_FEATURE_COLLECTION_HISTORY: input.enabled ? 'true' : 'false',
  });
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'hvowner',
  });
  const state = createState();
  seedCollection(state, {
    collectionId: COL, rootId: ROOT, ownerSubjectId: owner.subjectId, contentRevision: 'rev-1',
  });
  seedNode(state, {
    id: UNSORTED, parentId: ROOT, kind: 'folder', title: 'Unsorted', positionToken: 'a', collectionId: COL,
  });
  seedNode(state, {
    id: BM_A, parentId: UNSORTED, kind: 'bookmark', title: 'Repo A',
    url: 'https://example.test/a', positionToken: 'a', collectionId: COL,
  });
  seedNode(state, {
    id: BM_B, parentId: UNSORTED, kind: 'bookmark', title: 'Repo B',
    url: 'https://example.test/b', positionToken: 'm', collectionId: COL,
  });
  const rows: CollectionVersionRecord[] = [];
  const receipts: MemoryProductCommandReceipts = new Map();
  const versions = memoryStore(state, rows);
  const restoreReceipts = createMemoryCollectionVersionRestoreReceiptStore();
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
        mutations: restoreMutations(state),
        restoreReceipts,
        commandIds: { next: () => randomUUID() },
      }),
    },
    collectionVersionCursors: signer,
  });
  apps.push(app);
  return { app, owner, state, rows };
}

function snapshotRow(
  ownerAccountId: string,
  members: CollectionTreeLiveMember[],
  overrides: Partial<CollectionVersionRecord> = {},
): CollectionVersionRecord {
  const treeJson = members.map((member) => ({
    id: member.id,
    kind: member.kind,
    parentId: member.parentId,
    title: member.title,
    url: member.url,
    ...(member.kind === 'folder'
      ? { childIds: members.filter((child) => child.parentId === member.id).map((child) => child.id) }
      : {}),
  }));
  return {
    versionId: 'ver-1',
    accountId: ownerAccountId,
    collectionId: COL,
    contentRevision: 'rev-1',
    kind: 'manual',
    label: 'Snapshot',
    etag: '"ver-1"',
    nodeCount: treeJson.length,
    treeJson,
    createdAt: NOW,
    ...overrides,
  };
}

describe('POST /api/v1/collections/:collectionId/versions/:versionId/restore', () => {
  test('anonymous requests are 401 authentication_required', async () => {
    const { app } = await harness({ enabled: true });
    const response = await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: {},
    });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
  });

  test('flag off 404 resource_not_found without feature_temporarily_unavailable', async () => {
    const { app, owner } = await harness({ enabled: false });
    assert.match(app.printRoutes(), /restore/u);
    const response = await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(JSON.stringify(response.json()).includes('feature_temporarily_unavailable'), false);
  });

  test('missing If-Match is 428 precondition_required', async () => {
    const { app, owner } = await harness({ enabled: true });
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, randomUUID()),
      payload: {},
    }), 428, 'precondition_required');
  });

  test('wrong contentEtag is 412 precondition_failed', async () => {
    const { app, owner } = await harness({ enabled: true });
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': '"other"' }),
      payload: {},
    }), 412, 'precondition_failed');
  });

  test('version-row ETag as If-Match is 412 precondition_failed', async () => {
    const { app, owner, state, rows } = await harness({ enabled: true });
    rows.push(snapshotRow(owner.accountId, liveMembers(state)));
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': '"ver-1"' }),
      payload: {},
    }), 412, 'precondition_failed');
  });

  test('missing snapshot node id is 409 revision_conflict', async () => {
    const { app, owner, state, rows } = await harness({ enabled: true });
    rows.push(snapshotRow(owner.accountId, liveMembers(state)));
    state.nodes.delete(BM_B);
    assertProductErrorEnvelope(await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    }), 409, 'revision_conflict');
  });

  test('equivalent live tree is 200 noop', async () => {
    const { app, owner, state, rows } = await harness({ enabled: true });
    rows.push(snapshotRow(owner.accountId, liveMembers(state)));
    const response = await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      noop: boolean;
      updatedNodeIds: string[];
      movedNodeIds: string[];
      deletedNodeIds: string[];
    };
    assert.equal(body.noop, true);
    assert.deepEqual(body.updatedNodeIds, []);
    assert.deepEqual(body.movedNodeIds, []);
    assert.deepEqual(body.deletedNodeIds, []);
  });

  test('same Known-Command-Id replays and mutates once', async () => {
    const deleteSpy = vi.spyOn(deleteNodeModule, 'deleteCollectionNode');
    const { app, owner, state, rows } = await harness({ enabled: true });
    rows.push(snapshotRow(owner.accountId, liveMembers(state)));
    seedNode(state, {
      id: EXTRA, parentId: ROOT, kind: 'folder', title: 'Extra', positionToken: 'z', collectionId: COL,
    });
    const commandId = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, commandId, { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(first.statusCode, 200);
    const body = first.json() as { deletedNodeIds: string[]; noop: boolean };
    assert.equal(body.noop, false);
    assert.equal(body.deletedNodeIds.includes(EXTRA), true);
    assert.ok(state.nodes.get(EXTRA)?.deletedAt);
    const second = await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, commandId, { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), body);
    assert.equal(deleteSpy.mock.calls.length, 1);
  });

  test('same Known-Command-Id against two version ids is 409 command_id_reused', async () => {
    const { app, owner, state, rows } = await harness({ enabled: true });
    const members = liveMembers(state);
    rows.push(snapshotRow(owner.accountId, members));
    rows.push(snapshotRow(owner.accountId, members, { versionId: 'ver-2', etag: '"ver-2"' }));
    const commandId = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: RESTORE('ver-1'),
      headers: mutationHeaders(owner, commandId, { 'if-match': MATCH }),
      payload: {},
    });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({
      method: 'POST',
      url: RESTORE('ver-2'),
      headers: mutationHeaders(owner, commandId, { 'if-match': MATCH }),
      payload: {},
    });
    assertProductErrorEnvelope(second, 409, 'command_id_reused');
  });
});
