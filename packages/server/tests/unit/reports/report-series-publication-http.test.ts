import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import type { Account } from '../../../src/modules/identity/index.js';
import type { DigestSeries, ReportTransactionPorts, ReportUnitOfWork } from '../../../src/modules/reports/index.js';
import type { ReportRoutesDependencies } from '../../../src/transport/product/report-route-contract.js';
import { registerPrimaryReportRoutes } from '../../../src/transport/product/report-private-primary-routes.js';

// Session admission has its own carrier/CSRF tests. Keep the actual route,
// bearer inspection and report commands here; replace only the signed-in actor.
vi.mock('../../../src/transport/product/report-route-helpers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/transport/product/report-route-helpers.js')>(),
  mutationActor: async () => ({ principalId: 'account-1', subjectId: 'owner-1' }),
}));

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function fixture(scopes: readonly string[] = ['product:write']) {
  let series: DigestSeries = {
    id: 'series-1', ownerSubjectId: 'owner-1', title: 'Private digest', summary: null,
    slug: 'review-digest', visibility: 'private', allowSearchIndexing: false, state: 'active',
    resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const complete = vi.fn();
  const ports = {
    receipts: { claim: async () => ({ kind: 'claimed' }), complete },
    series: {
      lockById: async () => series,
      insert: async (value: DigestSeries) => { series = value; },
      update: async (_id: string, patch: Partial<DigestSeries>) => (series = { ...series, ...patch }),
    },
    members: { ensureOwner: async () => undefined },
    revision: { next: () => 'r2', matches: (current: string, expected: string) => expected === `"${current}"` },
    ids: { nextResourceId: () => 'series-1', nextEventId: () => 'event-1', nextOutboxId: () => 'outbox-1' },
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    audit: { append: vi.fn() }, outbox: { append: vi.fn() },
  } as unknown as ReportTransactionPorts;
  const execute = vi.fn(async <T>(work: (p: ReportTransactionPorts) => Promise<T>) => work(ports));
  const unitOfWork: ReportUnitOfWork = { execute };
  const publishGuard = vi.fn(() => unitOfWork);
  const app = Fastify();
  apps.push(app);
  const bearer = { account: { id: 'account-1', subjectId: 'owner-1' } as Account,
    subjectId: 'owner-1', credentialId: 'credential-1', scopes, expiresAt: new Date('2099-01-01') };
  app.decorate('productBearerAuthority', {
    inspect: async () => bearer, requireRead: async () => bearer, requireWrite: async () => bearer,
  });
  registerPrimaryReportRoutes(app, {
    unitOfWork, rateLimiter: { consume: () => ({ allowed: true }) },
    reportPublishGuard: { reportsUnitOfWorkFor: publishGuard },
  } as unknown as ReportRoutesDependencies);
  const request = (method: 'POST' | 'PATCH', payload: Record<string, unknown>, machine = true) => app.inject({
    method, url: method === 'POST' ? '/api/v1/reports' : '/api/v1/reports/series-1',
    headers: { 'known-command-id': '123e4567-e89b-42d3-a456-426614174000', 'if-match': '"r1"',
      ...(machine ? { authorization: 'Bearer fixture' } : {}) },
    payload: { ...(method === 'POST' ? { title: 'Digest', slug: 'review-digest' } : {}), ...payload },
  });
  return { request, execute, complete, publishGuard, series: () => series };
}

for (const method of ['POST', 'PATCH'] as const) {
  for (const visibility of ['public', 'unlisted'] as const) {
    test.each([['product:write'], ['product:write', 'reports:publish']])(
      `${method} ${visibility} requires an approved series plan even with scopes %j`, async (...scopes) => {
        const f = fixture(scopes);
        const response = await f.request(method, { visibility });
        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('approved report plan');
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.publishGuard).not.toHaveBeenCalled();
        expect(f.series().visibility).toBe('private');
      },
    );

    test(`${method} ${visibility} preserves interactive publication`, async () => {
      const f = fixture();
      const response = await f.request(method, { visibility }, false);
      expect(response.statusCode, response.body).toBe(method === 'POST' ? 201 : 200);
      expect(f.series().visibility).toBe(visibility);
      expect(f.complete).toHaveBeenCalledOnce();
    });
  }

  test.each(['private', 'protected'] as const)(`${method} %s preserves ordinary machine writes`, async visibility => {
    const f = fixture();
    const response = await f.request(method, { visibility });
    expect(response.statusCode, response.body).toBe(method === 'POST' ? 201 : 200);
    expect(f.series().visibility).toBe(visibility);
  });
}

test('metadata-only machine PATCH remains available', async () => {
  const f = fixture();
  const response = await f.request('PATCH', { title: 'Updated draft' });
  expect(response.statusCode, response.body).toBe(200);
  expect(f.series()).toMatchObject({ title: 'Updated draft', visibility: 'private' });
});
