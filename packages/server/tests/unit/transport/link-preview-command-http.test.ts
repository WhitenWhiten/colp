/**
 * LP-05 Product HTTP: an owner's or editor's preview request, over the real
 * app with in-memory ports (identity, receipts, store).
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
import { createMemoryObjectStore } from '../../support/link-preview-fixtures.js';
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

type Bookmark = { url: string; mode: BookmarkPreviewMode };

async function harness(input: { readonly enabled?: boolean } = {}) {
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({ factory, subject: 'lp-owner', displayName: 'Owner', handle: 'lpowner' });
  const editor = await issueTestSession({ factory, subject: 'lp-editor', displayName: 'Editor', handle: 'lpeditor' });
  const viewer = await issueTestSession({ factory, subject: 'lp-viewer', displayName: 'Viewer', handle: 'lpviewer' });
  const outsider = await issueTestSession({ factory, subject: 'lp-outsider', displayName: 'Outsider', handle: 'lpoutside' });
  const bookmarks = new Map<string, Bookmark>([
    ['bm_a', { url: 'https://a.example.com/x', mode: 'auto' }],
    ['bm_b', { url: 'https://b.example.com/y', mode: 'auto' }],
    ['bm_hidden', { url: 'https://c.example.com/z', mode: 'none' }],
  ]);
  const enqueued: LinkPreviewTargetIdentity[][] = [];
  const receipts: MemoryProductCommandReceipts = new Map();
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
        return identities.length;
      },
    },
  });
  const app = buildApiApp({
    config: loadConfig({ ...baseEnv, KNOWN_FEATURE_LINK_PREVIEW: input.enabled === false ? 'false' : 'true' }),
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    // api.ts composes the preview surface only while the feature is on.
    ...(input.enabled === false ? {} : {
      linkPreview: {
        store: createMemoryObjectStore(),
        publicAccess: { isServable: async () => false, isReadableBySubject: async () => false },
        commands: { execute: async (work) => work(ports()) },
      },
    }),
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
