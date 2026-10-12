import Fastify from 'fastify';
import { beforeAll, afterAll, beforeEach, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { validateAutomation } from '@know-n/colp/automation';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/unit-of-work.js';
import { registerAutomationRoutes } from '../../../src/transport/product/automation-rule-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
const BASE = '/api/v1/me/automations', ORIGIN = 'https://automation.example.test';

describeWithPostgres('BE-1 authenticated configuration and preview loop', () => {
  let f: Awaited<ReturnType<typeof automationFixture>>, app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    f = await automationFixture('automation_api');
    app = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
    installProductRouteManifestChecks(app, { requireComplete: false }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => {
      if (!(error instanceof ProductHttpError)) console.error(error);
      return sendProductError(request, reply, error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'Internal error' }));
    });
    registerAutomationRoutes(app, { identityUnitOfWork: f.identity, unitOfWork: createAutomationUnitOfWork(f.db, 'server'), allowedOrigins: [ORIGIN], cursorKey: 'automation-cursor-secret-for-test' });
    await app.ready();
  }, 180_000);
  beforeEach(async () => { await sql`truncate automation_rules, automation_binding_sets, automation_settings, automation_preview_records cascade`.execute(f.db); });
  afterAll(async () => { await app?.close(); await f?.isolated.close(); });
  const headers = (commandId = randomUUID(), ifMatch?: string) => ({ cookie: f.owner.cookie, origin: ORIGIN, 'x-csrf-token': f.owner.csrfToken,
    'known-command-id': commandId, ...(ifMatch ? { 'if-match': ifMatch } : {}) });
  const get = (path: string, cookie?: string) => app.inject({ method: 'GET', url: BASE + path, headers: { cookie: cookie ?? f.owner.cookie } });
  const post = (path: string, payload: unknown, ifMatch?: string, commandId?: string) => app.inject({ method: 'POST', url: BASE + path, headers: headers(commandId, ifMatch), payload });
  async function draft() {
    const b = await post('/binding-sets', { name: 'Folders', values: f.values }); expect(b.statusCode, b.body).toBe(201);
    const input = { definition: structuredClone(f.rule), bindingSetId: b.json().id };
    const r = await post('/rules', input); expect(r.statusCode, r.body).toBe(201);
    return { binding: b.json(), rule: r.json(), input, etag: String(r.headers.etag) };
  }
  function facts() {
    const event = JSON.parse(readFileSync('../node/tests/fixtures/automation/event-facts.json', 'utf8'));
    return { ...event, collectionId: 'collection', nodeId: 'paper', intakeDisposition: 'userDefault',
      bookmark: { ...event.bookmark, nodeId: 'paper', parent: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, ancestors: [{ serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }] } };
  }
  async function preview(input: unknown, mode: string = 'supplied') {
    const result = await post('/rules/preview', { rule: input, mode, ...(mode === 'supplied' ? { events: [facts()] } : {}) });
    expect(result.statusCode, result.body).toBe(200); return result.json();
  }
  const lifecycle = (id: string, etag: string, state: string, previewId?: string) => post(`/rules/${id}/lifecycle`, {
    state, pendingRuns: 'hold', reason: 'Fixture lifecycle', ...(previewId ? { activationPreviewId: previewId } : {}),
  }, etag);
  test('create binding -> M1 draft -> validate -> supplied/current preview -> enable blocked -> pause -> archive persists', async () => {
    const d = await draft(); expect(d.rule.desiredState).toBe('draft'); expect(validateAutomation('Rule', d.rule).valid).toBe(true);
    expect(d.rule).not.toHaveProperty('executionPolicyId'); expect(d.rule.definition.tasks).toEqual([]);
    const validated = await post('/rules/validate', d.input); expect(validated.json().valid).toBe(true);
    expect(validateAutomation('ValidationResult', validated.json()).valid).toBe(true);
    expect((await lifecycle(d.rule.id, d.etag, 'enabled')).statusCode).toBe(409);
    const supplied = await preview(d.input); expect(supplied.sideEffects).toBe(false); expect(supplied.decisions[0].satisfiedTasks).toEqual(['classify.root']);
    expect(validateAutomation('PreviewResult', supplied).valid).toBe(true);
    const current = await preview(d.input, 'currentState'); expect(current.completeHistory).toBe(false);
    expect(current.decisions[0].explanation).toContain('unknownIntent'); expect(current.decisions[0].satisfiedTasks).toEqual([]);
    const enabled = await lifecycle(d.rule.id, d.etag, 'enabled', supplied.previewId); expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ desiredState: 'enabled', effectiveState: 'blocked' });
    const fence = await f.db.selectFrom('automation_activations').selectAll().executeTakeFirstOrThrow();
    const canonical = await f.db.selectFrom('collections').select('commit_ordinal').where('id', '=', 'collection').executeTakeFirstOrThrow();
    expect(String(fence.after_ordinal)).toBe(String(canonical.commit_ordinal));
    const paused = await lifecycle(d.rule.id, String(enabled.headers.etag), 'paused'); expect(paused.json().effectiveState).toBe('paused');
    const archived = await app.inject({ method: 'DELETE', url: `${BASE}/rules/${d.rule.id}`, headers: headers(randomUUID(), String(paused.headers.etag)) });
    expect(archived.json().desiredState).toBe('archived');
    const reloaded = await createAutomationUnitOfWork(f.db, 'server').execute(f.owner, (p) => p.rules.load(f.owner.accountId, d.rule.id));
    expect(reloaded?.view.desiredState).toBe('archived');
  });
  test('preview creates no bookmarks, operations, audit, outbox, facts, runs, jobs or effects', async () => {
    const d = await draft();
    const counts = async () => (await f.isolated.runtime.pool.query(`select
      (select count(*) from nodes) nodes, (select count(*) from operations) operations, (select count(*) from audit_events) audit,
      (select count(*) from outbox_events) outbox, (select count(*) from automation_event_facts) facts,
      (select count(*) from automation_runs) runs, (select count(*) from automation_jobs) jobs, (select count(*) from automation_effect_receipts) effects`)).rows[0];
    const before = await counts(); await preview(d.input); await preview(d.input, 'currentState'); expect(await counts()).toEqual(before);
    const history = await post('/rules/preview', { rule: d.input, mode: 'retainedHistory' });
    expect(history.statusCode).toBe(422); expect(history.json().error.code).toBe('automation_unsupported_capability');
    const capabilities = (await get('/capabilities')).json(); expect(capabilities.runtimeProfiles).toEqual([]); expect(capabilities.taskTypes).toEqual([]);
  });
  test('exact preview invalidates after binding edit, rule edit, source edit or expiry', async () => {
    const d = await draft(), first = await preview(d.input);
    const changed = await app.inject({ method: 'PUT', url: `${BASE}/binding-sets/${d.binding.id}`, headers: headers(randomUUID(), `"${d.binding.revision}"`),
      payload: { name: 'Edited', values: f.values } }); expect(changed.statusCode, changed.body).toBe(200);
    expect((await lifecycle(d.rule.id, d.etag, 'enabled', first.previewId)).statusCode).toBe(409);
    const second = await preview(d.input);
    const replacement = await app.inject({ method: 'PUT', url: `${BASE}/rules/${d.rule.id}`, headers: headers(randomUUID(), d.etag),
      payload: { ...d.input, definition: { ...d.input.definition, priority: 200 }, pendingRuns: 'hold', counterPolicy: 'resetOnSemanticChange' } });
    expect(replacement.statusCode, replacement.body).toBe(200);
    expect((await lifecycle(d.rule.id, String(replacement.headers.etag), 'enabled', second.previewId)).statusCode).toBe(409);
    const updatedInput = { ...d.input, definition: replacement.json().definition };
    const current = await preview(updatedInput, 'currentState');
    await f.rename('paper', 'Changed input');
    expect((await lifecycle(d.rule.id, String(replacement.headers.etag), 'enabled', current.previewId)).statusCode).toBe(409);
    const expired = await preview(updatedInput);
    await f.db.updateTable('automation_preview_records').set({ expires_at: new Date(0) }).where('id', '=', expired.previewId).execute();
    expect((await lifecycle(d.rule.id, String(replacement.headers.etag), 'enabled', expired.previewId)).statusCode).toBe(409);
  });
  test('tenant boundaries, CSRF/Origin, command IDs, If-Match and shape errors use Product errors', async () => {
    const d = await draft(), foreign = await f.issue('foreign');
    expect((await app.inject({ method: 'GET', url: BASE + '/rules' })).statusCode).toBe(401);
    expect((await get(`/rules/${d.rule.id}`, foreign.cookie)).statusCode).toBe(404);
    expect((await get(`/binding-sets/${d.binding.id}`, foreign.cookie)).statusCode).toBe(404);
    const body = { state: 'paused', pendingRuns: 'hold', reason: 'Test' };
    const url = `${BASE}/rules/${d.rule.id}/lifecycle`;
    const base = headers(randomUUID(), d.etag);
    const noCsrf = { ...base }; delete (noCsrf as Record<string,string>)['x-csrf-token'];
    expect((await app.inject({ method: 'POST', url, payload: body, headers: noCsrf })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload: body, headers: { ...base, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await post(`/rules/${d.rule.id}/lifecycle`, body)).statusCode).toBe(428);
    expect((await post(`/rules/${d.rule.id}/lifecycle`, body, '"wrong"')).statusCode).toBe(412);
    expect((await post('/rules', { ...d.input, extra: true })).statusCode).toBe(400);
    expect((await post('/rules', { ...d.input, executionPolicyId: 'dummy' })).statusCode).toBe(422);
    expect((await post('/rules', { ...d.input, definition: { ...d.input.definition, scope: {} } })).statusCode).toBe(404);
    const invalid = await app.inject({ method: 'POST', url: BASE + '/rules', payload: d.input, headers: { ...headers(), 'known-command-id': 'invalid' } });
    expect(invalid.statusCode).toBe(400); expect(invalid.headers['cache-control']).toBe('private, no-store');
  });
  test('same command replays exactly, changed body conflicts, concurrent ETags have one winner', async () => {
    const d = await draft(); const commandId = randomUUID(), payload = { name: 'Replay', values: f.values };
    const first = await post('/binding-sets', payload, undefined, commandId), repeated = await post('/binding-sets', payload, undefined, commandId);
    expect(repeated.statusCode).toBe(201); expect(repeated.body).toBe(first.body); expect(repeated.headers.etag).toBe(first.headers.etag);
    expect((await post('/binding-sets', { ...payload, name: 'Mismatch' }, undefined, commandId)).json().error.code).toBe('automation_command_conflict');
    const result = await Promise.all(['A','B'].map((name) => app.inject({ method: 'PUT', url: `${BASE}/binding-sets/${d.binding.id}`,
      headers: headers(randomUUID(), '"1"'), payload: { name, values: f.values } })));
    expect(result.map((r) => r.statusCode).sort()).toEqual([200, 412]);
  });
  test('global pause is revision-fenced and source resume captures a fresh ordinal', async () => {
    const d = await draft(), p = await preview(d.input), enabled = await lifecycle(d.rule.id, d.etag, 'enabled', p.previewId);
    expect(enabled.statusCode).toBe(200);
    const initial = await get('/pause'); expect(initial.headers.etag).toBe('"0"');
    const paused = await post('/pause', { paused: true }, '"0"'); expect(paused.statusCode, paused.body).toBe(200);
    expect((await get(`/rules/${d.rule.id}`)).json()).toMatchObject({ desiredState: 'enabled', effectiveState: 'paused' });
    await f.rename('paper', 'During pause');
    const resumed = await post('/pause', { paused: false }, String(paused.headers.etag)); expect(resumed.statusCode).toBe(200);
    const active = await f.db.selectFrom('automation_activations').selectAll().where('disabled_after_ordinal', 'is', null).executeTakeFirstOrThrow();
    const current = await f.db.selectFrom('collections').select('commit_ordinal').where('id', '=', 'collection').executeTakeFirstOrThrow();
    expect(String(active.after_ordinal)).toBe(String(current.commit_ordinal));
    expect((await get(`/rules/${d.rule.id}`)).json().effectiveState).toBe('blocked');
  });
  test('pagination binds owner, collection of resources and limit; unused bindings can be deleted', async () => {
    for (let i = 0; i < 3; i++) expect((await post('/binding-sets', { name: String(i), values: f.values })).statusCode).toBe(201);
    const page = (await get('/binding-sets?limit=2')).json(); expect(page.items).toHaveLength(2); expect(page.nextCursor).toBeTruthy();
    const rest = (await get(`/binding-sets?limit=2&cursor=${page.nextCursor}`)).json(); expect(rest.items).toHaveLength(1);
    const foreign = await f.issue('foreign');
    expect((await get(`/binding-sets?limit=2&cursor=${page.nextCursor}`, foreign.cookie)).statusCode).toBe(400);
    expect((await get(`/rules?limit=2&cursor=${page.nextCursor}`)).statusCode).toBe(400);
    expect((await get('/rules?limit=101')).statusCode).toBe(400);
    const removed = await app.inject({ method: 'DELETE', url: `${BASE}/binding-sets/${page.items[0].id}`, headers: headers(randomUUID(), '"1"') }); expect(removed.statusCode, removed.body).toBe(204);
  });
  test('semantic rebinding pauses enabled configuration and requires a fresh preview', async () => {
    const d = await draft(), p = await preview(d.input);
    expect((await lifecycle(d.rule.id, d.etag, 'enabled', p.previewId)).statusCode).toBe(200);
    const replacement = await app.inject({ method: 'PUT', url: `${BASE}/binding-sets/${d.binding.id}`, headers: headers(randomUUID(), '"1"'),
      payload: { name: 'Rebound', values: { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } } } });
    expect(replacement.statusCode).toBe(200);
    const current = await get(`/rules/${d.rule.id}`); expect(current.json()).toMatchObject({ desiredState: 'paused', effectiveState: 'paused' });
    expect((await lifecycle(d.rule.id, String(current.headers.etag), 'enabled', p.previewId)).statusCode).toBe(409);
    const fresh = await preview(d.input);
    expect((await lifecycle(d.rule.id, String(current.headers.etag), 'enabled', fresh.previewId)).statusCode).toBe(200);
  });
  test('a new competing enabled rule invalidates a prior preview; explicit choice remains preserved', async () => {
    const a = await draft();
    const binding = await post('/binding-sets', { name: 'Competition', values: { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } } });
    const bInput = { definition: f.rule, bindingSetId: binding.json().id };
    const b = await post('/rules', bInput), bPreview = await preview(bInput), aPreview = await preview(a.input);
    expect((await lifecycle(a.rule.id, a.etag, 'enabled', aPreview.previewId)).statusCode).toBe(200);
    const stale = await lifecycle(b.json().id, String(b.headers.etag), 'enabled', bPreview.previewId);
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('automation_stale_input');
    const manual = await post('/rules/preview', { rule: bInput, mode: 'supplied', events: [{ ...facts(), intakeDisposition: 'userSelected' }] });
    expect(manual.statusCode).toBe(200); expect(manual.json().decisions[0].explanation).toContain('explicitChoice');
    expect(manual.json().decisions[0].satisfiedTasks).toEqual([]);
  });
  test('current-state reads at most 200 bookmarks and explicitly reports truncation', async () => {
    const d = await draft();
    for (let i = 0; i < 200; i++) await f.createNode(`sample_${i}`, 'root', `Paper ${i}`, `https://arxiv.org/abs/sample_${i}`);
    const result = await preview(d.input, 'currentState');
    expect(result.decisions).toHaveLength(200); expect(result.truncated).toBe(true); expect(result.completeHistory).toBe(false);
  });
  test('two equal priority placements report a conflict and never run an effect', async () => {
    const first = await draft(), p = await preview(first.input);
    expect((await lifecycle(first.rule.id, first.etag, 'enabled', p.previewId)).statusCode).toBe(200);
    const different = { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } };
    const binding = await post('/binding-sets', { name: 'Other', values: different });
    const input = { ...first.input, bindingSetId: binding.json().id };
    const conflict = await preview(input); expect(conflict.decisions[0].outcome).toBe('conflict'); expect(conflict.decisions[0].explanation).toContain(first.rule.id);
  });
});
