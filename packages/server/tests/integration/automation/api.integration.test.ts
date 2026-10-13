import Fastify from 'fastify';
import { beforeAll, afterAll, beforeEach, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { validateAutomation, type EventFacts, type PreviewResult, type HealthReport } from '@know-n/colp/automation';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { previewSnapshot, previewRule } from '../../../src/modules/automation/application/preview-service.js';
import { revalidateRule } from '../../../src/modules/automation/index.js';
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
  function facts(): EventFacts {
    const event = JSON.parse(readFileSync('../node/tests/fixtures/automation/event-facts.json', 'utf8'));
    return { ...event, collectionId: 'collection', nodeId: 'paper', intakeDisposition: 'userDefault',
      bookmark: { ...event.bookmark, nodeId: 'paper', parent: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, ancestors: [{ serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }] } };
  }
  async function preview(input: unknown, mode: string = 'supplied'): Promise<PreviewResult> {
    const result = await post('/rules/preview', { rule: input, mode, ...(mode === 'supplied' ? { events: [facts()] } : {}) });
    expect(result.statusCode, result.body).toBe(200);
    expect(validateAutomation('PreviewResult', result.json()).valid).toBe(true);
    return result.json();
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
  test.each(['folder scope', 'import policy', 'hop bound'])('review: competitors must honor their own %s', async (scenario) => {
    const d = await draft();
    const binding = await post('/binding-sets', { name: 'Scoped competitor', values: { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } } });
    const definition = structuredClone(f.rule);
    if (scenario === 'folder scope') definition.scope = { collectionId: 'collection', folderRole: 'academicRoot', includeDescendants: true };
    if (scenario === 'hop bound') definition.policy.maxHops = 1;
    const competitorInput = { definition, bindingSetId: binding.json().id };
    const competitor = await post('/rules', competitorInput); expect(competitor.statusCode, competitor.body).toBe(201);
    const checked = await preview(competitorInput);
    expect((await lifecycle(competitor.json().id, String(competitor.headers.etag), 'enabled', checked.previewId)).statusCode).toBe(200);
    const event = facts();
    if (scenario === 'import policy') { d.input.definition.policy.imports = 'include'; event.origin = 'import'; }
    if (scenario === 'hop bound') event.hopCount = 1;
    const result = await post('/rules/preview', { rule: d.input, mode: 'supplied', events: [event] });
    expect(result.statusCode, result.body).toBe(200); expect(result.json().decisions[0].outcome).toBe('matched');
  });
  test('review: restoring a competing destination invalidates a formerly conflict-free preview', async () => {
    const d = await draft();
    await f.createNode('review_competitor', 'root', 'Competing destination');
    const binding = await post('/binding-sets', { name: 'Restored competitor', values: { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'review_competitor' } } } });
    const input = { definition: f.rule, bindingSetId: binding.json().id };
    const competitor = await post('/rules', input), checked = await preview(input);
    expect((await lifecycle(competitor.json().id, String(competitor.headers.etag), 'enabled', checked.previewId)).statusCode).toBe(200);
    await f.db.updateTable('nodes').set({ deleted_at: new Date() }).where('id', '=', 'review_competitor').execute();
    const prior = await preview(d.input); expect(prior.decisions[0].outcome).toBe('matched');
    await f.db.updateTable('nodes').set({ deleted_at: null }).where('id', '=', 'review_competitor').execute();
    const enabled = await lifecycle(d.rule.id, d.etag, 'enabled', prior.previewId);
    expect(enabled.statusCode, enabled.body).toBe(409); expect(enabled.json().error.code).toBe('automation_stale_input');
    expect((await preview(d.input)).decisions[0].outcome).toBe('conflict');
  });
  test('review: an unavailable scope role never widens current-state sampling to the collection', async () => {
    const binding = await post('/binding-sets', { name: 'Missing scope', values: {} });
    const definition = { ...f.rule, scope: { collectionId: 'collection', folderRole: 'academicRoot' } };
    const input = { definition, bindingSetId: binding.json().id };
    expect((await post('/rules', input)).statusCode).toBe(201);
    const result = await post('/rules/preview', { rule: input, mode: 'currentState' });
    expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('automation_binding_unavailable');
  });
  test('review: current-state ancestry must never be silently truncated', async () => {
    const d = await draft();
    // Use canonical writes so the ancestry fixture obeys the real tree constraints.
    for (let depth = 1; depth <= 129; depth++)
      await f.createNode(`review_deep_${depth}`, depth === 1 ? 'root' : `review_deep_${depth - 1}`, `Depth ${depth}`);
    await f.createNode('review_deep_paper', 'review_deep_129', 'Deep paper', 'https://arxiv.org/abs/deep');
    try {
      const result = await post('/rules/preview', { rule: d.input, mode: 'currentState' });
      expect(result.statusCode, result.body).toBe(409); expect(result.json().error.code).toBe('automation_binding_unavailable');
    } finally {
      await f.db.updateTable('nodes').set({ deleted_at: new Date() }).where('id', '=', 'review_deep_paper').execute();
    }
  });
  test('review: an unused optional folder cannot block the intake stage', async () => {
    await f.createNode('review_optional', 'root', 'Optional unused');
    const values = { ...f.values, optionalFolder: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'review_optional' } } };
    const binding = await post('/binding-sets', { name: 'Optional role', values });
    const input = { definition: { ...f.rule, roles: [...f.rule.roles, { key: 'optionalFolder', kind: 'folder', required: false, description: 'Unused by intake' }] }, bindingSetId: binding.json().id };
    const created = await post('/rules', input); expect(created.statusCode).toBe(201);
    await f.db.updateTable('nodes').set({ deleted_at: new Date() }).where('id', '=', 'review_optional').execute();
    const checked = await preview(input); expect(checked.decisions[0].outcome).toBe('matched');
    expect(checked.decisions[0].satisfiedTasks).toEqual(['classify.root']);
    const validated = await post('/rules/validate', input); expect(validated.json().valid).toBe(true);
    expect(validated.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'optionalFolder', severity: 'warning' })]));
    const enabled = await lifecycle(created.json().id, String(created.headers.etag), 'enabled', checked.previewId);
    expect(enabled.statusCode, enabled.body).toBe(200);
    const report = await createAutomationUnitOfWork(f.db, 'server').execute(f.owner, (ports) => revalidateRule(ports, f.owner, created.json().id));
    const incident = report.incidents.find((value) => value.role === 'optionalFolder');
    expect(incident?.blockingStages).toEqual([]);
  });
  test('review: normalized validation and semantic digests agree on equivalent host predicates', async () => {
    const d = await draft(), lower = await post('/rules/validate', d.input);
    const input = { ...d.input, definition: { ...d.input.definition, match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'ARXIV.ORG.' } } };
    const upper = await post('/rules/validate', input);
    expect(upper.statusCode).toBe(200); expect(upper.json().normalizedDefinition.match.value).toBe('arxiv.org');
    expect(upper.json().semanticDigest).toBe(lower.json().semanticDigest);
    const created = await post('/rules', input); expect(created.statusCode).toBe(201);
    const checked = await preview(input);
    expect((await lifecycle(created.json().id, String(created.headers.etag), 'enabled', checked.previewId)).statusCode).toBe(200);
  });
  test('review: a schema-valid finite membership predicate larger than 4096 bytes is accepted', async () => {
    const d = await draft();
    const input = { ...d.input, definition: { ...d.input.definition, match: { kind: 'field', field: 'bookmark.title', op: 'in', value: Array(30).fill('x'.repeat(200)) } } };
    const result = await post('/rules/validate', input); expect(result.statusCode).toBe(200); expect(result.json().valid).toBe(true);
  });
  test('two equal priority placements report a conflict and never run an effect', async () => {
    const first = await draft(), p = await preview(first.input);
    expect((await lifecycle(first.rule.id, first.etag, 'enabled', p.previewId)).statusCode).toBe(200);
    const different = { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } };
    const binding = await post('/binding-sets', { name: 'Other', values: different });
    const input = { ...first.input, bindingSetId: binding.json().id };
    const conflict = await preview(input); expect(conflict.decisions[0].outcome).toBe('conflict'); expect(conflict.decisions[0].explanation).toContain(first.rule.id);
  });
  test('current-state IDs stay bounded, distinct and stable for maximum-length canonical identities', async () => {
    const d = await draft();
    const prefix = 'long_'.padEnd(127, 'a');
    const ids = [prefix + 'a', prefix + 'b'];
    for (const nodeId of ids) await f.createNode(nodeId, 'root', 'Long ID', 'https://arxiv.org/abs/long');
    const first = await preview(d.input, 'currentState');
    const stored = await f.db.selectFrom('automation_preview_records').select('result_json')
      .where('id', '=', first.previewId).executeTakeFirstOrThrow();
    expect(validateAutomation('PreviewResult', stored.result_json).valid).toBe(true);
    const repeated = await preview(d.input, 'currentState');
    expect(repeated.decisions).toEqual(first.decisions);
    expect(new Set(first.decisions.map((decision) => decision.eventId)).size).toBe(first.decisions.length);
    // The two new nodes are newest; both must reach the predicate and preserve unknown intent.
    expect(first.decisions.slice(0, 2)).toEqual([0, 1].map(() => expect.objectContaining({ outcome: 'matched', satisfiedTasks: [] })));
    expect((await lifecycle(d.rule.id, d.etag, 'enabled', first.previewId)).statusCode).toBe(200);
  });
  test.each([
    { priority: 101, target: 'parent', outcome: 'conflict' },
    { priority: 99, target: 'parent', outcome: 'matched' },
    { priority: 101, target: 'academic', outcome: 'matched' },
  ])('priority $priority to $target reports $outcome for the proposed placement', async ({ priority, target, outcome }) => {
    const d = await draft();
    const binding = await post('/binding-sets', { name: 'Priority competitor', values: {
      academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: target } },
    } });
    expect(binding.statusCode, binding.body).toBe(201);
    const input = { definition: { ...f.rule, priority }, bindingSetId: binding.json().id };
    const competitor = await post('/rules', input), checked = await preview(input);
    expect((await lifecycle(competitor.json().id, String(competitor.headers.etag), 'enabled', checked.previewId)).statusCode).toBe(200);
    const result = await preview(d.input);
    expect(result.decisions[0]?.outcome).toBe(outcome);
    expect(result.plannedRunCount).toBe(outcome === 'conflict' ? 0 : 1);
    expect(result.decisions[0]?.satisfiedTasks).toEqual(outcome === 'conflict' ? [] : ['classify.root']);
    if (outcome === 'conflict') {
      expect(result.decisions[0]?.explanation).toContain(competitor.json().id);
      expect(result.decisions[0]?.explanation).toContain('Higher-priority');
      const enabled = await lifecycle(d.rule.id, d.etag, 'enabled', result.previewId);
      expect(enabled.statusCode, enabled.body).toBe(200);
      expect(enabled.json().desiredState).toBe('enabled');
    }
  });
  test('node.created preview honors its trigger and allows other automation stages while refusing reentry', async () => {
    const d = await draft();
    d.input.definition.on = 'node.created';
    delete d.input.definition.intake;
    const baseline = facts();
    const events: EventFacts[] = [
      baseline,
      { ...baseline, type: 'bookmark.intake' },
      { ...baseline, type: 'node.updated' },
      { ...baseline, origin: 'automation', stageId: 'otherStage', rootRunId: 'priorRun', hopCount: 1 },
      { ...baseline, origin: 'automation', stageId: 'intake', rootRunId: 'priorRun', hopCount: 1 },
      { ...baseline, origin: 'automation', stageId: 'otherStage', hopCount: d.input.definition.policy.maxHops },
      { ...baseline, origin: 'restore' },
    ].map((event, index) => ({ ...event, eventId: `trigger_${index}` }));
    const response = await post('/rules/preview', { rule: d.input, mode: 'supplied', events });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<PreviewResult>();
    expect(validateAutomation('PreviewResult', result).valid).toBe(true);
    expect(result.decisions.map((decision) => decision.outcome)).toEqual([
      'matched', 'notMatched', 'notMatched', 'matched', 'notMatched', 'notMatched', 'notMatched',
    ]);
    expect(result.decisions.every((decision) => decision.satisfiedTasks.length === 0)).toBe(true);
    expect(result.plannedRunCount).toBe(2);
  });

  test.each([true, false])('priority-resolved rules can both enable, high first=$0', async (highFirst) => {
    const low = await draft();
    const binding = await post('/binding-sets', { name: 'High priority', values: {
      academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } },
    } });
    const input = { definition: { ...f.rule, priority: 200 }, bindingSetId: binding.json().id };
    const created = await post('/rules', input);
    const high = { rule: created.json(), etag: String(created.headers.etag), input };
    for (const candidate of highFirst ? [high, low] : [low, high]) {
      const checked = await preview(candidate.input);
      const enabled = await lifecycle(candidate.rule.id, candidate.etag, 'enabled', checked.previewId);
      expect(enabled.statusCode, enabled.body).toBe(200);
    }
    expect((await get('/rules')).json().items.every((rule: { desiredState: string }) => rule.desiredState === 'enabled')).toBe(true);
    expect((await preview(low.input)).decisions[0]?.outcome).toBe('conflict');
    expect((await preview(high.input)).decisions[0]?.outcome).toBe('matched');
  });
  test.each([true, false])('unused required=$0 binding agrees across validation, preview, activation and health', async (required) => {
    const d = await draft();
    d.input.definition.roles.push({ key: 'unused', kind: 'folder', required, description: 'No consumer in this stage' });
    const created = await post('/rules', d.input);
    expect(created.statusCode, created.body).toBe(201);
    const validated = await post('/rules/validate', d.input);
    expect(validated.json().valid).toBe(true);
    if (required) expect(validated.json().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'unused', severity: 'warning' }),
    ]));
    const checked = await preview(d.input);
    expect(checked.decisions[0]?.outcome).toBe('matched');
    expect((await lifecycle(created.json().id, String(created.headers.etag), 'enabled', checked.previewId)).statusCode).toBe(200);
    const report: HealthReport = await createAutomationUnitOfWork(f.db, 'server').execute(f.owner,
      (ports) => revalidateRule(ports, f.owner, created.json().id));
    expect(report.incidents.filter((incident) => incident.role === 'unused').every((incident) =>
      incident.severity === 'warning' && incident.blockingStages.length === 0)).toBe(true);
  });
  test.each<{ satisfies: Array<'classify.root'> }>([{ satisfies: [] }, { satisfies: ['classify.root'] }])('placement satisfies only the declaration $satisfies', async ({ satisfies }) => {
    const d = await draft(); d.input.definition.intake!.satisfies = satisfies;
    expect((await post('/rules/validate', d.input)).json().valid).toBe(true);
    const checked = await preview(d.input);
    expect(checked.decisions[0]).toMatchObject({ outcome: 'matched', satisfiedTasks: satisfies });
    expect(checked.plannedRunCount).toBe(1);
    const preserved = await post('/rules/preview', { rule: d.input, mode: 'supplied', events: [{ ...facts(), intakeDisposition: 'unknown' }] });
    expect(preserved.json().decisions[0].satisfiedTasks).toEqual([]);
    expect(preserved.json().plannedRunCount).toBe(0);
  });
  test('equal-priority incompatible destinations still block activation', async () => {
    const first = await draft(), checked = await preview(first.input);
    expect((await lifecycle(first.rule.id, first.etag, 'enabled', checked.previewId)).statusCode).toBe(200);
    const binding = await post('/binding-sets', { name: 'Tied', values: {
      academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } },
    } });
    const input = { definition: f.rule, bindingSetId: binding.json().id };
    const created = await post('/rules', input), tied = await preview(input);
    const enabled = await lifecycle(created.json().id, String(created.headers.etag), 'enabled', tied.previewId);
    expect(enabled.statusCode).toBe(409);
    expect(enabled.json().error.code).toBe('automation_rule_conflict');
  });
  test('200 full-depth current-state facts remain digestible and every member stays pinned', async () => {
    const d = await draft(), original = facts();
    original.bookmark.ancestors = Array.from({ length: 128 }, (_, index) => ({ serverUuid: 'server', collectionId: 'collection', nodeId: `depth_${index}` }));
    expect(validateAutomation('EventFacts', original).valid).toBe(true);
    const events = Array.from({ length: 200 }, (_, index) => ({ ...structuredClone(original), eventId: `sample_${index}` }));
    const uow = createAutomationUnitOfWork(f.db, 'server');
    // Port fixture exercises aggregate bounds independently of canonical tree read cost.
    const digest = () => uow.execute(f.owner, (ports) => previewSnapshot({ ...ports,
      sample: async () => ({ events, truncated: false, revisions: {} }) }, f.owner, { mode: 'currentState', rule: d.input }));
    const result = await uow.execute(f.owner, (ports) => previewRule({ ...ports,
      sample: async () => ({ events, truncated: false, revisions: {} }) }, f.owner, { mode: 'currentState', rule: d.input }));
    expect(result.decisions).toHaveLength(200);
    expect(validateAutomation('PreviewResult', result).valid).toBe(true);
    const initial = (await digest()).configDigest;
    expect((await digest()).configDigest).toBe(initial);
    events[199]!.bookmark.title = 'Changed last member';
    expect((await digest()).configDigest).not.toBe(initial);
    events[199]!.bookmark.title = original.bookmark.title;
    events[199]!.bookmark.ancestors![127]!.nodeId = 'changedAncestor';
    expect((await digest()).configDigest).not.toBe(initial);
  });

  test('maximum competitor snapshots are individually bounded and the last competitor stays pinned', async () => {
    const d = await draft();
    await createAutomationUnitOfWork(f.db, 'server').execute(f.owner, async (ports) => {
      const original = (await ports.rules.load(f.owner.accountId, d.rule.id))!;
      const binding = (await ports.bindings.load(f.owner.accountId, d.binding.id))!;
      const collection = (await ports.reads.readCollection(f.owner, 'collection'))!;
      const folder = await ports.reads.readFolder(f.owner, f.folder);
      if (folder.status !== 'valid') throw new Error('Fixture folder unavailable');
      const resolution = { ...folder, snapshot: { ...folder.snapshot,
        ancestors: Array.from({ length: 128 }, (_, index) => ({ ...f.folder, nodeId: `ancestor_${index}` })) } };
      const competitors = Array.from({ length: 499 }, (_, index) => ({ ...original, view: { ...original.view,
        id: `competitor_${index}`, desiredState: 'enabled' as const,
        definition: { ...original.view.definition, name: `Competitor ${index}` },
      } }));
      const prepared = { ...ports, rules: { ...ports.rules, list: async () => competitors },
        bindings: { ...ports.bindings, load: async () => binding },
        reads: { readCollection: async () => collection, readFolder: async () => resolution } };
      const input = { mode: 'supplied' as const, rule: d.input, events: [facts()] };
      const first = await previewSnapshot(prepared, f.owner, input);
      expect(first.alternatives).toHaveLength(499);
      competitors[498]!.view.definition.priority += 1;
      expect((await previewSnapshot(prepared, f.owner, input)).configDigest).not.toBe(first.configDigest);
    });
  });
  test('cyclic role constraints are rejected consistently by validate and create', async () => {
    const d = await draft();
    d.input.definition.roles[0]!.mustBeWithinRole = 'academicRoot';
    const validated = await post('/rules/validate', d.input);
    expect(validated.statusCode).toBe(200);
    expect(validated.json().valid).toBe(false);
    expect(validated.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalidGraph' })]));
    const created = await post('/rules', d.input);
    expect(created.statusCode).toBe(422);
    expect(created.json().error.code).toBe('automation_invalid_graph');
  });

});
