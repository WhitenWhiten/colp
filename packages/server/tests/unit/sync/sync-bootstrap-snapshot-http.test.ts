import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerSyncSnapshotRoutes } from '../../../src/transport/colp-sync/sync-snapshot-routes.js';

describe('P3-09 syncSnapshot HTTP boundary', () => {
  it('mounts the public contract and maps schema/cursor/Session failures to COLP Problems', async () => {
    const app = Fastify();
    registerSyncSnapshotRoutes(app, {
      path: '/private/snapshot', allowedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
      credentialVerifier: { async verify() { return {} as never; } },
      application: { async query() { throw Object.assign(new Error('hidden'), { code: 'snapshot_expired' }); } },
      rateLimit: { maxRequests: 10, windowMs: 60_000 }, allowInsecureLoopback: true,
    });
    await app.ready();
    const headers = { authorization: 'Bearer marker', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'x-forwarded-proto': 'https' };
    expect((await app.inject({ method: 'GET', url: '/private/snapshot?sessionId=ses_1&limit=0', headers })).json()).toMatchObject({ code: 'invalid_query' });
    expect((await app.inject({ method: 'GET', url: '/private/snapshot?sessionId=ses_1&limit=2', headers })).json()).toMatchObject({ code: 'snapshot_expired' });
    expect((await app.inject({ method: 'GET', url: '/private/snapshot?sessionId=ses_1&sessionId=ses_2', headers })).json()).toMatchObject({ code: 'invalid_query' });
    await app.close();
  });

  it.each([
    ['invalid_cursor_scope', 400], ['authentication_required', 401], ['origin_not_allowed', 403],
    ['resource_not_found', 404], ['snapshot_expired', 409], ['stale_replica', 410],
    ['replica_retired', 410], ['rate_limited', 429], ['service_unavailable', 503],
  ] as const)('maps expected Snapshot authority failure %s without returning 500', async (code, status) => {
    const app = Fastify();
    registerSyncSnapshotRoutes(app, {
      path: '/private/snapshot', allowedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
      credentialVerifier: { async verify() { return {} as never; } },
      application: { async query() { throw Object.assign(new Error('hidden'), { code }); } },
      rateLimit: { maxRequests: 10, windowMs: 60_000 }, allowInsecureLoopback: true,
    });
    const response = await app.inject({ method: 'GET', url: '/private/snapshot?sessionId=ses_1&limit=100',
      headers: { authorization: 'Bearer marker', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
    expect(response.statusCode).toBe(status);
    expect(response.statusCode).not.toBe(500);
    expect(response.json()).toMatchObject({ code, status });
    await app.close();
  });
});
