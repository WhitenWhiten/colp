import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { ProductSyncCenterUnitOfWork } from '../../../src/modules/sync/product-sync-center.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork, issueTestSession } from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'https://app.example.test';
async function identity() { const state = createIdentityMemoryState(new Date('2026-07-28T00:00:00.000Z'));
  const unitOfWork = createIdentityMemoryUnitOfWork(state);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: unitOfWork });
  const client = await issueTestSession({ factory,
    subject: 'subject-a', handle: 'subject-a' }); return { unitOfWork, factory, client }; }

function config() {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://known:known@127.0.0.1:5432/known',
    OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web', OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/auth', OIDC_TOKEN_ENDPOINT: 'https://issuer.example/token',
    LOG_LEVEL: 'silent' });
}

function unitOfWork(calls: Array<Record<string, unknown>>): ProductSyncCenterUnitOfWork {
  return { execute: async (work) => work({
    async getStatus(input) { calls.push({ kind: 'status', ...input }); return { devices: [{ id: 'device-a', name: 'Chrome' }], replicas: [{
      id: 'replica-a', deviceId: 'device-a', name: 'Work', collectionId: 'collection-a', kind: 'browser_extension',
      status: 'active', leaseExpiresAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-07-28T00:00:00.000Z',
      lastAckAt: null, acknowledgedCommitOrdinal: null, lifecycleRevision: '3', etag: '"3"',
    }] }; },
    async getConflicts(input) { calls.push({ kind: 'conflicts', ...input }); return { items: [{
      id: 'conflict-a', collectionId: 'collection-a', targetId: 'node-a', type: 'concurrent_field_update',
      field: '/title', status: 'open', allowedResolutions: ['server', 'incoming'], revision: 'conflict-r1',
      etag: '"conflict-r1"', createdAt: '2026-07-28T00:00:00.000Z', summary: { current: 'Current title', incoming: 'Incoming title' },
    }], page: { nextCursor: null } }; },
    async resolveConflict(input) { calls.push({ kind: 'resolve', ...input }); return { kind: 'committed', result: { conflictId: input.conflictId,
      status: 'resolved', revision: 'conflict-r2', etag: '"conflict-r2"', resolvedAt: '2026-07-28T01:00:00.000Z' } }; },
    async retireReplica(input) { calls.push({ kind: 'retire', ...input }); return { kind: 'committed', result: { replicaId: input.replicaId,
      status: 'retired', lifecycleRevision: '4', etag: '"4"', retiredAt: '2026-07-28T01:00:00.000Z' } }; },
    async listTrash() { throw new Error('unexpected listTrash'); },
    async getTrashDetail() { throw new Error('unexpected getTrashDetail'); },
    async restoreTrash() { throw new Error('unexpected restoreTrash'); },
    async restoreTrashBatch() { throw new Error('unexpected restoreTrashBatch'); },
    async restoreTrashSubtree() { throw new Error('unexpected restoreTrashSubtree'); },
    async emptyTrash() { throw new Error('unexpected emptyTrash'); },
  }) };
}

function headers(cookie: string, extra: Record<string, string> = {}) { return { cookie, ...extra }; }

describe('P3-36 Product Sync Center HTTP', () => {
  test('returns private account-scoped safe status and Conflict summaries', async () => {
    const auth = await identity(); const calls: Array<Record<string, unknown>> = []; const app = buildApiApp({ config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork(calls) });
    try {
      const status = await app.inject({ method: 'GET', url: '/api/v1/sync/status', headers: headers(auth.client.cookie) });
      const conflicts = await app.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=20', headers: headers(auth.client.cookie) });
      assert.equal(status.statusCode, 200); assert.equal(conflicts.statusCode, 200);
      assert.equal(status.headers['cache-control'], 'private, no-store');
      assert.equal(conflicts.headers['cache-control'], 'private, no-store');
      assert.deepEqual(calls.map((call) => call.accountId), [auth.client.accountId, auth.client.accountId]);
      for (const forbidden of ['token', 'sessionId', 'cursor', 'browserProfileId', 'nativeId', 'url', 'principalId', 'base', 'currentSecret', 'incomingSecret']) {
        assert.equal(status.body.includes(forbidden), false); assert.equal(conflicts.body.includes(forbidden), false);
      }
    } finally { await app.close(); }
  });

  test('requires Product mutation admission and passes strong fences plus command ids', async () => {
    const auth = await identity(); const calls: Array<Record<string, unknown>> = []; const app = buildApiApp({ config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork(calls) });
    try {
      const commandId = randomUUID(); const mutationHeaders = headers(auth.client.cookie, { origin: ORIGIN, 'x-csrf-token': auth.client.csrfToken,
        'known-command-id': commandId, 'if-match': '"conflict-r1"', 'content-type': 'application/json' });
      const resolved = await app.inject({ method: 'POST', url: '/api/v1/sync/conflicts/conflict-a/resolution',
        headers: mutationHeaders, payload: { resolution: 'incoming' } });
      assert.equal(resolved.statusCode, 200);
      const retired = await app.inject({ method: 'DELETE', url: '/api/v1/sync/replicas/replica-a', headers: headers(auth.client.cookie, {
        origin: ORIGIN, 'x-csrf-token': auth.client.csrfToken, 'known-command-id': randomUUID(), 'if-match': '"3"',
      }) });
      assert.equal(retired.statusCode, 200);
      assert.equal(calls[0]!.commandId, commandId); assert.equal(calls[0]!.expectedRevision, 'conflict-r1');
      assert.equal(calls[1]!.expectedLifecycleRevision, '3');
    } finally { await app.close(); }
  });

  test('rejects unknown/duplicate query, missing or inexact mutation admission', async () => {
    const auth = await identity(); const app = buildApiApp({ config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority, productSyncCenterUnitOfWork: unitOfWork([]) });
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/sync/status?queueDepth=1', headers: headers(auth.client.cookie) })).statusCode, 400);
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=1&limit=2', headers: headers(auth.client.cookie) })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sync/conflicts/conflict-a/resolution', headers: headers(auth.client.cookie, {
        'known-command-id': randomUUID(), 'if-match': '"r1"', 'content-type': 'application/json' }), payload: { resolution: 'server' } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/sync/replicas/replica-a', headers: headers(auth.client.cookie, {
        origin: 'https://attacker.example.test', 'x-csrf-token': auth.client.csrfToken,
        'known-command-id': randomUUID(), 'if-match': '"3"' }) })).statusCode, 403);
      const duplicate = await app.inject({ method: 'DELETE', url: '/api/v1/sync/replicas/replica-a', headers: headers(auth.client.cookie, {
        origin: ORIGIN, 'x-csrf-token': auth.client.csrfToken, 'known-command-id': `${randomUUID()},${randomUUID()}`, 'if-match': '"3"' }) });
      assert.equal(duplicate.statusCode, 400);
    } finally { await app.close(); }
  });

  test('rejects raw duplicate mutation admission headers before normalization', async () => {
    const auth = await identity(); const app = buildApiApp({ config: config(), identityUnitOfWork: auth.unitOfWork, browserSessionAuthority: auth.factory.authority,
      productSyncCenterUnitOfWork: unitOfWork([]) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      for (const duplicate of ['Origin', 'X-CSRF-Token', 'Known-Command-Id', 'If-Match']) {
        const response = await rawRetire(origin, auth.client.cookie, auth.client.csrfToken, duplicate);
        assert.equal(response.statusCode, 400, duplicate);
        assert.equal(JSON.parse(response.body).error.code, 'invalid_request', duplicate);
      }
    } finally { await app.close(); }
  });
});

async function rawRetire(origin: string, cookie: string, csrf: string, duplicate: string) {
  const headers: Record<string, string | string[]> = { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf,
    'Known-Command-Id': randomUUID(), 'If-Match': '"3"' };
  headers[duplicate] = duplicate === 'Origin' ? [ORIGIN, ORIGIN]
    : duplicate === 'X-CSRF-Token' ? [csrf, csrf]
      : duplicate === 'Known-Command-Id' ? [randomUUID(), randomUUID()] : ['"3"', '"4"'];
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = httpRequest(`${origin}/api/v1/sync/replicas/replica-a`, { method: 'DELETE', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end();
  });
}
