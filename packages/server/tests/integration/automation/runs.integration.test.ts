import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateAutomation } from '@know-n/colp/automation';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { registerAutomationRoutes } from '../../../src/transport/product/automation-rule-routes.js';
import { automationRunRoutes } from '../../../src/transport/product/automation-run-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
const BASE = '/api/v1/me/automations';
describeWithPostgres('M1 run history API', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>, app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    f = await automationRuntimeFixture('aw16');
    app = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationRoutes(app, { identityUnitOfWork: f.identity, unitOfWork: f.uow, allowedOrigins: ['https://automation.example.test'], cursorKey: 'run-cursor-secret' }, automationRunRoutes('run-cursor-secret'));
    await f.createNode('run-first', 'root', 'First', 'https://arxiv.org/first');
    await f.createNode('run-second', 'root', 'Second', 'https://arxiv.org/second');
    await f.inspect();
  });
  afterEach(async () => { await app?.close(); await f?.isolated.close(); });
  const get = (path: string, cookie?: string) => app.inject({ method: 'GET', url: BASE + path, headers: { cookie: cookie ?? f.owner.cookie } });
  test('reads pinned M1 runs newest first, scopes history and cursor, and hides foreign ownership', async () => {
    const first = await get('/runs?limit=1'); expect(first.statusCode, first.body).toBe(200);
    expect(validateAutomation('RunPage', first.json()).valid).toBe(true);
    const run = first.json().items[0]; expect(run).toMatchObject({ ruleRevision: '1', bindingRevision: '1', executionPolicyRevision: null, kind: 'intake', jobIds: [] });
    expect(run).toMatchObject({ held: false, explanation: expect.stringContaining('pinned rule') });
    expect(run).not.toHaveProperty('explanation_json');
    const second = await get(`/runs?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`);
    expect(second.json().items).toHaveLength(1); expect(second.json().items[0].id).not.toBe(run.id);
    const filtered = await get('/runs?collectionId=collection&nodeId=run-first'); expect(filtered.json().items).toHaveLength(1);
    const tampered = await get(`/runs?limit=1&collectionId=collection&nodeId=run-first&cursor=${encodeURIComponent(first.json().nextCursor)}`);
    expect(tampered.statusCode).toBe(400);
    const foreign = await f.issue('foreign'); expect((await get(`/runs/${run.id}`, foreign.cookie)).statusCode).toBe(404);
    expect((await get('/runs', foreign.cookie)).json().items).toEqual([]);
  });
  test('cancel has optimistic concurrency and command replay without erasing completed effects', async () => {
    const run = (await get('/runs')).json().items[0];
    const request = { method: 'POST' as const, url: `${BASE}/runs/${run.id}/cancel`, payload: { reason: 'Cancel fixture' },
      headers: { cookie: f.owner.cookie, origin: 'https://automation.example.test', 'x-csrf-token': f.owner.csrfToken,
        'known-command-id': randomUUID(), 'if-match': `"${run.revision}"` } };
    const response = await app.inject(request); expect(response.statusCode, response.body).toBe(200); expect(response.json().status).toBe('cancelled');
    expect(response.json().explanation).toContain('Cancelled by the Owner');
    expect((await app.inject(request)).body).toBe(response.body);
    expect((await app.inject({ ...request, headers: { ...request.headers, 'known-command-id': randomUUID() } })).statusCode).toBe(412);
  });
});
