import { createProductCreditsClient } from '../../../generated/openapi/product-v1.client.js';
import type { components } from '../../../generated/openapi/product-v1.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCreditLedgerReadPort } from '../../../src/infrastructure/identity/index.js';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { createCreditLedgerCursorCodec } from '../../../src/modules/identity/index.js';
import { registerCreditLedgerRoutes } from '../../../src/transport/product/credit-ledger-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { installClassificationExtensionCors } from '../../../src/transport/classification-extension-cors.js';
import {
  createCreditTestDatabase,
  grantCredits,
  seedCreditAccount,
} from '../../support/credit-ledger-fixture.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const cursorCodec = createCreditLedgerCursorCodec({ active: { id: 'credit-http-test', secret: Buffer.alloc(32, 7).toString('base64') }, retained: [] });
const RAW_SESSION = 'credit-ledger-http-session';
const ENTRY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describeWithPostgres('CR05 credit ledger HTTP over PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let accountId: string;
  let otherAccountId: string;
  let app: FastifyInstance;
  let origin: string;

  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_ledger_http');
    await runMigrations(isolated.runtime.db, 'latest');
    accountId = (await seedCreditAccount(isolated.runtime.db, 'http-owner')).accountId;
    otherAccountId = (await seedCreditAccount(isolated.runtime.db, 'http-other')).accountId;
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'http-first', amount: 5 });
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'http-second', amount: 3 });
    await grantCredits(isolated.runtime.db, { accountId: otherAccountId, grantKey: 'http-other', amount: 1 });
    app = createApp(createPostgresCreditLedgerReadPort(isolated.runtime.db), accountId);
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await isolated?.close();
  });

  test.each([true, false])('reports the authoritative managed billing mode only when requested (enabled=%s)', async enabled => {
    const server = createApp(createPostgresCreditLedgerReadPort(isolated.runtime.db), accountId, undefined, enabled);
    try {
      const legacy = await server.inject({ method: 'GET', url: '/api/v1/me/credits', headers: sessionHeaders() });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).not.toHaveProperty('managedClassificationBillingMode');
      const current = await server.inject({ method: 'GET', url: '/api/v1/me/credits?includeBillingMode=true', headers: sessionHeaders() });
      expect(current.statusCode).toBe(200);
      expect(current.json().managedClassificationBillingMode).toBe(enabled ? 'managed' : 'legacy_free');
      expect(current.json().prices).toEqual(legacy.json().prices);
      for (const query of ['includeBillingMode=invalid', 'includeBillingMode=true&includeBillingMode=false']) {
        expect((await server.inject({ method: 'GET', url: '/api/v1/me/credits?' + query, headers: sessionHeaders() })).statusCode).toBe(400);
      }
    } finally { await server.close(); }
  });

  test('returns one fixed snapshot, filters entries, and excludes later writes from continuation', async () => {
    const first = await app.inject({
      method: 'GET', url: '/api/v1/me/credits/ledger?limit=1', headers: sessionHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as LedgerPage;
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(firstBody.items[0]!.entryId).toMatch(ENTRY_UUID);
    expect(firstBody.snapshot.ledgerSequence).toBe('2');

    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'http-late', amount: 7 });
    const second = await app.inject({
      method: 'GET', url: `/api/v1/me/credits/ledger?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      headers: sessionHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as LedgerPage;
    expect(secondBody.snapshot).toEqual(firstBody.snapshot);
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]!.sequence).toBe('1');
    expect(secondBody.nextCursor).toBeNull();

    const filtered = await app.inject({
      method: 'GET', url: '/api/v1/me/credits/ledger?kind=grant&from=2026-09-18T00:00:00%2B09:00&to=2026-09-20T00:00:00Z&limit=100',
      headers: sessionHeaders(),
    });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as LedgerPage).items.every((item) => item.kind === 'grant')).toBe(true);
  });

  test('keeps detail account scoped and rejects bearer, HEAD, validators, and invalid query', async () => {
    const entry = await isolated.runtime.db.selectFrom('credit_ledger_entries').select('id')
      .where('account_id', '=', accountId).orderBy('sequence', 'desc').executeTakeFirstOrThrow();
    const own = await app.inject({
      method: 'GET', url: `/api/v1/me/credits/ledger/${entry.id}`, headers: sessionHeaders({ 'if-none-match': '"old"' }),
    });
    expect(own.statusCode).toBe(200);
    expect(own.headers.etag).toBeUndefined();

    const foreign = await isolated.runtime.db.selectFrom('credit_ledger_entries').select('id')
      .where('account_id', '=', otherAccountId).executeTakeFirstOrThrow();
    const hidden = await app.inject({
      method: 'GET', url: `/api/v1/me/credits/ledger/${foreign.id}`, headers: sessionHeaders(),
    });
    expect(hidden.statusCode).toBe(404);

    expect((await app.inject({ method: 'GET', url: '/api/v1/me/credits', headers: { authorization: 'Bearer ignored' } })).statusCode)
      .toBe(401);
    expect((await app.inject({ method: 'HEAD', url: '/api/v1/me/credits', headers: sessionHeaders() })).statusCode)
      .toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/credits?unknown=x', headers: sessionHeaders() })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/credits/ledger?limit=1.0', headers: sessionHeaders() })).statusCode)
      .toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/credits/ledger?kind=grant&kind=spend', headers: sessionHeaders() })).statusCode)
      .toBe(400);
  });

  test('generated SDK reads overview, filtered pages and detail over real HTTP', async () => {
    const client = createProductCreditsClient({ origin, sessionCookie: sessionHeaders().cookie });
    const overview = await client.overview();
    expect(overview.accountId).toBe(accountId);
    expect(overview.prices[0]?.unitPoints).toBe(1);
    const page = await client.ledger({ kind: 'grant', limit: 1 });
    expect(page.accountId).toBe(accountId);
    expect(page.snapshot.balance).toEqual(overview.balance);
    expect((await client.entry(page.items[0]!.entryId)).entry).toEqual(page.items[0]);
    expect((await client.ledger({ cursor: page.nextCursor! })).snapshot).toEqual(page.snapshot);
  });

  test('keeps the original cursor lifetime and rejects invalid calendar dates, filters and bodies', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/me/credits/ledger?limit=1', headers: sessionHeaders() });
    const payload = cursorCodec.verify(first.json<LedgerPage>().nextCursor!, new Date());
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 86_400_000).toISOString();
    const token = cursorCodec.sign({ ...payload, issuedAt, expiresAt });
    const next = await app.inject({ method: 'GET', url: `/api/v1/me/credits/ledger?cursor=${encodeURIComponent(token)}`, headers: sessionHeaders() });
    expect(next.statusCode).toBe(200);
    const continued = cursorCodec.verify(next.json<LedgerPage>().nextCursor!, new Date());
    expect(continued.issuedAt).toBe(issuedAt);
    expect(continued.expiresAt).toBe(expiresAt);
    const expired = { ...payload, issuedAt: new Date(Date.now() - 86_460_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const getCursor = (value: typeof payload) => app.inject({ method: 'GET', url: `/api/v1/me/credits/ledger?cursor=${encodeURIComponent(cursorCodec.sign(value))}`, headers: sessionHeaders() });
    expect((await getCursor(expired)).json().error.code).toBe('cursor_expired');
    expect((await getCursor({ ...expired, accountId: otherAccountId })).json().error.code).toBe('invalid_cursor');
    expect((await getCursor({ ...expired, filters: { ...expired.filters, kind: 'invalid' } })).json().error.code).toBe('invalid_cursor');
    for (const date of ['2026-02-30T00:00:00Z', '2026-09-19T24:00:00Z', '0000-01-01T00:00:00Z']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/me/credits/ledger?from=${encodeURIComponent(date)}`, headers: sessionHeaders() })).statusCode).toBe(400);
    }
    const precision = await app.inject({ method: 'GET', url: '/api/v1/me/credits/ledger?from=2026-09-19T00:00:00.000001Z&to=2026-09-19T00:00:00.000002Z', headers: sessionHeaders() });
    expect(precision.statusCode).toBe(200);
    const body = await app.inject({ method: 'GET', url: '/api/v1/me/credits', headers: sessionHeaders({ 'content-type': 'application/json' }), payload: '{}' });
    expect(body.statusCode).toBe(400);
    expect(body.headers['cache-control']).toBe('private, no-store');
  });

  test('returns exact credit errors, rate limits before the database, and scopes extension CORS', async () => {
    const busyApp = createApp({
      ...createPostgresCreditLedgerReadPort(isolated.runtime.db),
      readLatest: async () => ({ kind: 'reconciling' as const }),
    }, accountId);
    await busyApp.ready();
    const busy = await busyApp.inject({ method: 'GET', url: '/api/v1/me/credits', headers: sessionHeaders() });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe('credits_reconciling');
    await busyApp.close();

    const limitedApp = createApp(createPostgresCreditLedgerReadPort(isolated.runtime.db), accountId,
      createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }));
    await limitedApp.ready();
    expect((await limitedApp.inject({ method: 'GET', url: '/api/v1/me/credits', headers: sessionHeaders() })).statusCode).toBe(200);
    const limited = await limitedApp.inject({ method: 'GET', url: '/api/v1/me/credits', headers: sessionHeaders() });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    await limitedApp.close();

    const cors = await app.inject({ method: 'OPTIONS', url: '/api/v1/me/credits', headers: { origin: EXTENSION_ORIGIN } });
    expect(cors.statusCode).toBe(204);
    expect(cors.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    expect(cors.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(String(cors.headers['access-control-allow-headers'])).not.toMatch(/Authorization|Cookie/u);
    const nonCredit = await app.inject({ method: 'OPTIONS', url: '/api/v1/me', headers: { origin: EXTENSION_ORIGIN } });
    expect(nonCredit.headers['access-control-allow-origin']).toBeUndefined();
  });
});

type LedgerPage = components['schemas']['CreditLedgerPage'];

function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `__Host-known_session=${RAW_SESSION}`, ...extra };
}

function createApp(
  reads: Parameters<typeof registerCreditLedgerRoutes>[1]['reads'],
  account: string,
  limiter = createFixedWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
  creditEnabled = true,
): FastifyInstance {
  const now = new Date();
  const identityPorts = {
    sessions: {
      findByTokenHash: async () => ({ id: 'credit-http-session', accountId: account,
        csrfTokenHash: 'csrf', tokenHash: 'ignored', securityEpoch: 0n, createdAt: now,
        lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60_000), revokedAt: null }),
    },
    accounts: {
      findById: async () => ({ id: account, subjectId: `subject-${account}`, status: 'active' as const,
        email: null, securityEpoch: 0n, createdAt: now, deletedAt: null }),
    },
    clock: { now: async () => now },
  } as unknown as IdentityPorts;
  const identityUnitOfWork = {
    execute: async <Result>(work: (ports: IdentityPorts) => Promise<Result>) => work(identityPorts),
  } as unknown as IdentityUnitOfWork;
  const app = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductRouteManifestChecks(app, { requireComplete: false });
  installProductAdmission(app);
  installClassificationExtensionCors(app, {
    allowedOrigins: [], betterAuth: { enabled: true, trustedOrigins: [EXTENSION_ORIGIN] },
  });
  app.setErrorHandler((error, request, reply) => sendProductError(request, reply,
    error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'test failure' })));
  registerCreditLedgerRoutes(app, {
    creditEnabled,
    identityUnitOfWork,
    reads,
    cursor: cursorCodec,
    rateLimiter: limiter,
  });
  return app;
}
