/**
 * Owner: KNS-08 (QA). Fixture: see Known-Extension/e2e/kns-08-ids.ts.
 * Run: see Known-Extension/e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { ProductSyncCenterUnitOfWork } from '../../../src/modules/sync/product-sync-center.js';
import { encodeTrashDeletionId } from '../../../src/modules/sync/product-sync-trash.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork, issueTestSession } from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'https://app.example.test';
const DELETION = encodeTrashDeletionId('op-delete-a', 'node-a');

async function identity() {
  const state = createIdentityMemoryState(new Date('2026-07-28T00:00:00.000Z'));
  const unitOfWork = createIdentityMemoryUnitOfWork(state);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: unitOfWork });
  const client = await issueTestSession({ factory, subject: 'subject-a', handle: 'subject-a' });
  return { unitOfWork, factory, client };
}

function config() {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://known:known@127.0.0.1:5432/known',
    OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web', OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/auth', OIDC_TOKEN_ENDPOINT: 'https://issuer.example/token',
    LOG_LEVEL: 'silent' });
}

function unitOfWork(calls: Array<Record<string, unknown>>, restoreError?: { code: string }): ProductSyncCenterUnitOfWork {
  return { execute: async (work) => work({
    async getStatus() { return { devices: [], replicas: [] }; },
    async getConflicts() { return { items: [], page: { nextCursor: null } }; },
    async resolveConflict() { throw new Error('unexpected resolve'); },
    async retireReplica() { throw new Error('unexpected retire'); },
    async listTrash(input) {
      calls.push({ kind: 'list', ...input });
      if (input.collectionId === 'missing-collection') {
        throw Object.assign(new Error('not found'), { code: 'resource_not_found' });
      }
      return { items: [{
        deletionId: DELETION, nodeId: 'node-a', kind: 'bookmark', title: 'Saved',
        originalParentId: 'folder-a', originalParentTitle: 'Folder',
        deletedAt: '2026-07-28T00:00:00.000Z', purgeAfter: '2026-08-27T00:00:00.000Z', revision: 'delete-r1',
      }], page: { nextCursor: null } };
    },
    async getTrashDetail(input) {
      calls.push({ kind: 'detail', ...input });
      if (input.deletionId !== DELETION) throw Object.assign(new Error('not found'), { code: 'resource_not_found' });
      return {
        deletionId: DELETION, nodeId: 'node-a', kind: 'bookmark', title: 'Saved',
        originalParentId: 'folder-a', originalParentTitle: 'Folder',
        deletedAt: '2026-07-28T00:00:00.000Z', purgeAfter: '2026-08-27T00:00:00.000Z', revision: 'delete-r1',
        url: 'https://example.test/saved', collectionId: 'collection-a', etag: '"delete-r1"',
      };
    },
    async restoreTrash(input) {
      calls.push({ kind: 'restore', ...input });
      if (restoreError) throw Object.assign(new Error(restoreError.code), restoreError);
      return { kind: 'committed', result: {
        deletionId: input.deletionId, nodeId: 'node-a', parentId: 'folder-a',
        revision: 'restored-r2', etag: '"restored-r2"', restoredAt: '2026-07-28T01:00:00.000Z',
      } };
    },
    async restoreTrashBatch(input) {
      calls.push({ kind: 'restore-batch', ...input });
      if (restoreError) throw Object.assign(new Error(restoreError.code), restoreError);
      return { kind: 'committed', result: {
        collectionId: input.collectionId,
        results: input.items.map((item) => ({
          deletionId: item.deletionId, outcome: 'applied' as const, nodeId: 'node-a',
          parentId: 'folder-a', revision: 'restored-r2', restoredAt: '2026-07-28T01:00:00.000Z',
        })),
        summary: { applied: input.items.length, preconditionFailed: 0, purged: 0, notFound: 0 },
      } };
    },
    async restoreTrashSubtree(input) {
      calls.push({ kind: 'restore-subtree', ...input });
      if (restoreError) throw Object.assign(new Error(restoreError.code), restoreError);
      return { kind: 'committed', result: {
        collectionId: 'collection-a',
        results: [{
          deletionId: input.deletionId, outcome: 'applied' as const, nodeId: 'node-a',
          parentId: 'folder-a', revision: 'restored-r2', restoredAt: '2026-07-28T01:00:00.000Z',
        }],
        summary: { applied: 1, preconditionFailed: 0, purged: 0, notFound: 0 },
      } };
    },
    async emptyTrash(input) {
      calls.push({ kind: 'empty', ...input });
      if (restoreError) throw Object.assign(new Error(restoreError.code), restoreError);
      return { kind: 'committed', result: {
        collectionId: input.collectionId, results: [],
        summary: { purged: 0, skipped: 0, remaining: 0 },
      } };
    },
  }) };
}

function headers(cookie: string, extra: Record<string, string> = {}) { return { cookie, origin: ORIGIN, ...extra }; }

describe('KNS-06 Product Sync trash HTTP', () => {
  test('lists and details trash without leaking unauthorized collections', async () => {
    const auth = await identity();
    const calls: Array<Record<string, unknown>> = [];
    const app = buildApiApp({
      config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork(calls),
    });
    try {
      const list = await app.inject({
        method: 'GET', url: '/api/v1/sync/trash?collectionId=collection-a', headers: headers(auth.client.cookie),
      });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().items[0]?.url, undefined);
      const missing = await app.inject({
        method: 'GET', url: '/api/v1/sync/trash?collectionId=missing-collection', headers: headers(auth.client.cookie),
      });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, 'resource_not_found');
      const unknown = await app.inject({
        method: 'GET', url: `/api/v1/sync/trash/${encodeURIComponent('not-a-deletion')}`,
        headers: headers(auth.client.cookie),
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error.code, 'resource_not_found');
      assert.equal(unknown.json().error.message, missing.json().error.message);
    } finally { await app.close(); }
  });

  test('restore requires CSRF, If-Match, and Known-Command-Id and maps 412/428', async () => {
    const auth = await identity();
    const calls: Array<Record<string, unknown>> = [];
    const app = buildApiApp({
      config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork(calls),
    });
    try {
      const missingMatch = await app.inject({
        method: 'POST', url: `/api/v1/sync/trash/${DELETION}/restore`,
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
        }),
      });
      assert.equal(missingMatch.statusCode, 428);
      const restored = await app.inject({
        method: 'POST', url: `/api/v1/sync/trash/${DELETION}/restore`,
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'if-match': '"delete-r1"', 'known-command-id': randomUUID(),
        }),
      });
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().nodeId, 'node-a');
    } finally { await app.close(); }
    const staleApp = buildApiApp({
      config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork([], { code: 'precondition_failed' }),
    });
    try {
      const stale = await staleApp.inject({
        method: 'POST', url: `/api/v1/sync/trash/${DELETION}/restore`,
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'if-match': '"stale"', 'known-command-id': randomUUID(),
        }),
      });
      assert.equal(stale.statusCode, 412);
      assert.equal(stale.json().error.code, 'precondition_failed');
    } finally { await staleApp.close(); }
    const purgedApp = buildApiApp({
      config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork([], { code: 'resource_purged' }),
    });
    try {
      const purged = await purgedApp.inject({
        method: 'POST', url: `/api/v1/sync/trash/${DELETION}/restore`,
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'if-match': '"delete-r1"', 'known-command-id': randomUUID(),
        }),
      });
      assert.equal(purged.statusCode, 410);
      assert.equal(purged.json().error.code, 'resource_purged');
    } finally { await purgedApp.close(); }
  });

  test('batch restore requires CSRF and Known-Command-Id and rejects empty selection', async () => {
    const auth = await identity();
    const calls: Array<Record<string, unknown>> = [];
    const app = buildApiApp({
      config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork(calls),
    });
    try {
      const empty = await app.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
          'content-type': 'application/json',
        }),
        payload: { collectionId: 'collection-a', items: [] },
      });
      assert.equal(empty.statusCode, 422);
      assert.equal(empty.json().error.code, 'invalid_document');
      const restored = await app.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
          'content-type': 'application/json',
        }),
        payload: { collectionId: 'collection-a', items: [
          { deletionId: DELETION, expectedRevision: 'delete-r1' },
        ] },
      });
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().summary.applied, 1);
      const subtree = await app.inject({
        method: 'POST', url: `/api/v1/sync/trash/${DELETION}/restore-subtree`,
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'if-match': '"delete-r1"', 'known-command-id': randomUUID(),
        }),
      });
      assert.equal(subtree.statusCode, 200);
      const emptied = await app.inject({
        method: 'POST', url: '/api/v1/sync/trash/empty',
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
          'content-type': 'application/json',
        }),
        payload: { collectionId: 'collection-a', expectedCount: 1, confirmation: 'permanently_delete' },
      });
      assert.equal(emptied.statusCode, 200);
      const missingConfirm = await app.inject({
        method: 'POST', url: '/api/v1/sync/trash/empty',
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
          'content-type': 'application/json',
        }),
        payload: { collectionId: 'collection-a', expectedCount: 1 },
      });
      assert.equal(missingConfirm.statusCode, 422);
      assert.equal(missingConfirm.json().error.code, 'invalid_document');
      const wrongConfirm = await app.inject({
        method: 'POST', url: '/api/v1/sync/trash/empty',
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
          'content-type': 'application/json',
        }),
        payload: { collectionId: 'collection-a', expectedCount: 1, confirmation: 'delete' },
      });
      assert.equal(wrongConfirm.statusCode, 422);
    } finally { await app.close(); }
    const reusedApp = buildApiApp({
      config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork([], { code: 'command_id_reused' }),
    });
    try {
      const reused = await reusedApp.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: headers(auth.client.cookie, {
          'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(),
          'content-type': 'application/json',
        }),
        payload: { collectionId: 'collection-a', items: [
          { deletionId: DELETION, expectedRevision: 'delete-r1' },
        ] },
      });
      assert.equal(reused.statusCode, 409);
      assert.equal(reused.json().error.code, 'command_id_reused');
    } finally { await reusedApp.close(); }
  });
});
