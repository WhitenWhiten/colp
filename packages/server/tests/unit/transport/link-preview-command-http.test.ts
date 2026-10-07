/**
 * LP-05 Product HTTP: preview requests and the per-bookmark preview mode,
 * over the real app with in-memory ports (identity, receipts, store).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import {
  type BookmarkPreviewMode,
  type LinkPreviewCommandPorts,
  type LinkPreviewTargetIdentity,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  issueTestSession,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';
import { loadConfig } from '../../support/test-config.js';

const ORIGIN = 'https://app.example.test';
const COL = 'col_preview_01';
const REQUESTS = `/api/v1/collections/${COL}/link-preview-requests`;
const MODE = `/api/v1/collections/${COL}/nodes/bm_a/preview-image-mode`;
const OBJECT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = new Date('2026-09-26T08:00:00.000Z');
const baseEnv = {
  DATABASE_URL: 'postgres://localhost/link_preview_command_http_test',
  PRODUCT_ORIGIN: ORIGIN,
  ALLOWED_ORIGINS: ORIGIN,
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

type Bookmark = { url: string; mode: BookmarkPreviewMode; revision: bigint };

async function harness(input: { readonly enabled?: boolean } = {}) {
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({ factory, subject: 'lp-owner', displayName: 'Owner', handle: 'lpowner' });
  const editor = await issueTestSession({ factory, subject: 'lp-editor', displayName: 'Editor', handle: 'lpeditor' });
  const viewer = await issueTestSession({ factory, subject: 'lp-viewer', displayName: 'Viewer', handle: 'lpviewer' });
  const outsider = await issueTestSession({ factory, subject: 'lp-outsider', displayName: 'Outsider', handle: 'lpoutside' });
  const bookmarks = new Map<string, Bookmark>([
    ['bm_a', { url: 'https://a.example.com/x', mode: 'auto', revision: 1n }],
    ['bm_b', { url: 'https://b.example.com/y', mode: 'auto', revision: 1n }],
    ['bm_hidden', { url: 'https://c.example.com/z', mode: 'none', revision: 2n }],
  ]);
  const enqueued: LinkPreviewTargetIdentity[][] = [];
  const receipts: MemoryProductCommandReceipts = new Map();
  const readyKeys = new Set<string>();
  const ports = (): LinkPreviewCommandPorts => ({
    accessPolicy: {
      async loadCollectionFacts({ collectionId, actorSubjectId }) {
        if (collectionId !== COL) return null;
        const roles: Record<string, 'editor' | 'viewer'> = { [editor.subjectId]: 'editor', [viewer.subjectId]: 'viewer' };
        return {
          collectionId: COL, ownerSubjectId: owner.subjectId, visibility: 'private', policyRevision: 'p1',
          membershipRole: roles[actorSubjectId] ?? null, deleted: false,
        };
      },
    },
    receipts: createMemoryProductCommandReceiptPort(receipts),
    previews: {
      async loadBookmarks(collectionId, nodeIds) {
        if (collectionId !== COL) return [];
        return nodeIds.flatMap((nodeId) => {
          const bookmark = bookmarks.get(nodeId);
          return bookmark ? [{ nodeId, ...bookmark }] : [];
        });
      },
      async enqueue(identities) {
        enqueued.push([...identities]);
        for (const identity of identities) readyKeys.add(identity.urlKey);
        return identities.length;
      },
      async writeMode({ nodeId, mode, expectedRevision }) {
        const bookmark = bookmarks.get(nodeId)!;
        if (bookmark.revision !== expectedRevision) return { kind: 'stale', currentRevision: bookmark.revision };
        bookmark.mode = mode;
        bookmark.revision += 1n;
        return { kind: 'written', revision: bookmark.revision };
      },
    },
    reads: {
      async findReadyByUrlKeys(keys) {
        return new Map(keys.filter((key) => readyKeys.has(key)).map((key) => [key, { objectId: OBJECT, width: 800, height: 400 }]));
      },
      async findVetoedNodeIds() {
        return new Set();
      },
    },
    productOrigin: ORIGIN,
  });
  const app = buildApiApp({
    config: loadConfig({ ...baseEnv, KNOWN_FEATURE_LINK_PREVIEW: input.enabled === false ? 'false' : 'true' }),
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    linkPreviewCommands: { execute: async (work) => work(ports()) },
  });
  apps.push(app);
  return { app, owner, editor, viewer, outsider, bookmarks, enqueued };
}

function writeHeaders(client: { cookie: string; csrfToken: string }, extra: Record<string, string> = {}) {
  return {
    cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrfToken,
    'known-command-id': randomUUID(), 'content-type': 'application/json', ...extra,
  };
}

describe('POST link-preview-requests', () => {
  test('anonymous is 401 and the flag-off surface is 404', async () => {
    const { app } = await harness();
    const anonymous = await app.inject({ method: 'POST', url: REQUESTS, headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: { nodeIds: ['bm_a'] } });
    assert.equal(anonymous.statusCode, 401);
    const off = await harness({ enabled: false });
    const response = await off.app.inject({ method: 'POST', url: REQUESTS, headers: writeHeaders(off.owner), payload: { nodeIds: ['bm_a'] } });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
  });

  test('owner and editor queue visible bookmarks; unknown and hidden ids are skipped; replays return the stored 202', async () => {
    const { app, owner, editor, enqueued } = await harness();
    const headers = writeHeaders(owner);
    const payload = { nodeIds: ['bm_a', 'bm_hidden', 'nope', 'bm_b'] };
    const first = await app.inject({ method: 'POST', url: REQUESTS, headers, payload });
    assert.equal(first.statusCode, 202, first.body);
    assert.deepEqual(first.json(), { enqueued: 2 });
    assert.deepEqual(enqueued[0]!.map((identity) => identity.normalizedUrl), ['https://a.example.com/x', 'https://b.example.com/y']);
    const replay = await app.inject({ method: 'POST', url: REQUESTS, headers, payload: { nodeIds: ['bm_b', 'nope', 'bm_hidden', 'bm_a'] } });
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.json(), { enqueued: 2 });
    assert.equal(enqueued.length, 1, 'a replay never enqueues again');
    const reused = await app.inject({ method: 'POST', url: REQUESTS, headers, payload: { nodeIds: ['bm_a'] } });
    assertProductErrorEnvelope(reused, 409, 'command_id_reused');
    const byEditor = await app.inject({ method: 'POST', url: REQUESTS, headers: writeHeaders(editor), payload: { nodeIds: ['bm_a'] } });
    assert.equal(byEditor.statusCode, 202);
  });

  test('viewers are 403, outsiders 404, and malformed bodies 422', async () => {
    const { app, owner, viewer, outsider } = await harness();
    assert.equal((await app.inject({ method: 'POST', url: REQUESTS, headers: writeHeaders(viewer), payload: { nodeIds: ['bm_a'] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: REQUESTS, headers: writeHeaders(outsider), payload: { nodeIds: ['bm_a'] } })).statusCode, 404);
    for (const payload of [
      {},
      { nodeIds: [] },
      { nodeIds: ['bm_a', 'bm_a'] },
      { nodeIds: Array.from({ length: 101 }, (_, i) => `n${i}`) },
      { nodeIds: ['bm_a'], extra: true },
      { nodeIds: ['has space'] },
    ]) {
      const response = await app.inject({ method: 'POST', url: REQUESTS, headers: writeHeaders(owner), payload });
      assertProductErrorEnvelope(response, 422, 'invalid_document');
    }
  });
});

describe('GET/PUT preview-image-mode', () => {
  test('GET returns the virtual first revision; PUT enforces If-Match and changes the ETag', async () => {
    const { app, owner, bookmarks } = await harness();
    const read = await app.inject({ method: 'GET', url: MODE, headers: { cookie: owner.cookie } });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers.etag, '"preview-mode:1"');
    assert.deepEqual(read.json(), { nodeId: 'bm_a', mode: 'auto', previewImage: null, etag: '"preview-mode:1"' });

    const missing = await app.inject({ method: 'PUT', url: MODE, headers: writeHeaders(owner), payload: { mode: 'none' } });
    assertProductErrorEnvelope(missing, 428, 'precondition_required');
    const weak = await app.inject({ method: 'PUT', url: MODE, headers: writeHeaders(owner, { 'if-match': 'W/"x"' }), payload: { mode: 'none' } });
    assertProductErrorEnvelope(weak, 400, 'invalid_request');
    const stale = await app.inject({ method: 'PUT', url: MODE, headers: writeHeaders(owner, { 'if-match': '"preview-mode:7"' }), payload: { mode: 'none' } });
    assertProductErrorEnvelope(stale, 412, 'precondition_failed');

    const headers = writeHeaders(owner, { 'if-match': '"preview-mode:1"' });
    const hidden = await app.inject({ method: 'PUT', url: MODE, headers, payload: { mode: 'none' } });
    assert.equal(hidden.statusCode, 200, hidden.body);
    assert.equal(hidden.headers.etag, '"preview-mode:2"');
    assert.equal(hidden.json().mode, 'none');
    assert.equal(bookmarks.get('bm_a')!.mode, 'none');
    // Same command id, same body: the stored response, not a second write or a 412.
    const replay = await app.inject({ method: 'PUT', url: MODE, headers, payload: { mode: 'none' } });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers.etag, '"preview-mode:2"');
    assert.equal(bookmarks.get('bm_a')!.revision, 2n);
  });

  test('restoring auto shows the cached image right away', async () => {
    const { app, owner } = await harness();
    await app.inject({ method: 'POST', url: REQUESTS, headers: writeHeaders(owner), payload: { nodeIds: ['bm_a'] } });
    await app.inject({ method: 'PUT', url: MODE, headers: writeHeaders(owner, { 'if-match': '"preview-mode:1"' }), payload: { mode: 'none' } });
    const restored = await app.inject({ method: 'PUT', url: MODE, headers: writeHeaders(owner, { 'if-match': '"preview-mode:2"' }), payload: { mode: 'auto' } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().previewImage, { url: `${ORIGIN}/api/v1/link-preview/${OBJECT}`, width: 800, height: 400 });
  });

  test('viewers are 403, unknown nodes and outsiders 404, bad modes 422', async () => {
    const { app, owner, viewer, outsider } = await harness();
    assert.equal((await app.inject({ method: 'GET', url: MODE, headers: { cookie: viewer.cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: MODE, headers: { cookie: outsider.cookie } })).statusCode, 404);
    const unknown = `/api/v1/collections/${COL}/nodes/missing/preview-image-mode`;
    assert.equal((await app.inject({ method: 'GET', url: unknown, headers: { cookie: owner.cookie } })).statusCode, 404);
    const bad = await app.inject({ method: 'PUT', url: MODE, headers: writeHeaders(owner, { 'if-match': '"preview-mode:1"' }), payload: { mode: 'hidden' } });
    assertProductErrorEnvelope(bad, 422, 'invalid_document');
  });
});
