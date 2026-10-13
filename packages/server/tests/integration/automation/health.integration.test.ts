import Fastify from 'fastify';
import { beforeEach, afterEach, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateAutomation, type HealthReport, type DependencyReport, type HealthIncident } from '@know-n/colp/automation';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork, createAutomationHealthMonitor } from '../../../src/infrastructure/automation/index.js';
import { PostgresCollectionMutationProjectionSink, type CollectionMutationDelivery } from '../../../src/infrastructure/outbox/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { moveCollectionNode, deleteCollectionNode } from '../../../src/modules/collections/index.js';
import { registerAutomationRoutes } from '../../../src/transport/product/automation-rule-routes.js';
import { automationHealthRoutes } from '../../../src/transport/product/automation-health-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
const BASE = '/api/v1/me/automations', ORIGIN = 'https://automation.example.test';

describeWithPostgres('BE-1 dependency monitoring and incident lifecycle', () => {
  let f: Awaited<ReturnType<typeof automationFixture>>, app: ReturnType<typeof Fastify>, rule: { id: string; revision: string }, bindingId: string;
  let metrics: InMemoryMetrics;
  const headers = () => ({ cookie: f.owner.cookie, origin: ORIGIN, 'x-csrf-token': f.owner.csrfToken, 'known-command-id': randomUUID() });
  const get = (path: string, cookie?: string) => app.inject({ method: 'GET', url: BASE + path, headers: { cookie: cookie ?? f.owner.cookie } });
  const post = (path: string, payload: unknown, etag?: string) => app.inject({ method: 'POST', url: BASE + path, payload, headers: { ...headers(), ...(etag ? { 'if-match': etag } : {}) } });
  beforeEach(async () => {
    metrics = new InMemoryMetrics();
    f = await automationFixture('automation_health');
    app = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => {
      if (!(error instanceof ProductHttpError)) console.error(error);
      return sendProductError(request, reply, error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'Internal error' }));
    });
    registerAutomationRoutes(app, { identityUnitOfWork: f.identity, unitOfWork: createAutomationUnitOfWork(f.db, 'server'), allowedOrigins: [ORIGIN], cursorKey: 'automation-health-cursor-secret' }, automationHealthRoutes('automation-health-cursor-secret'));
    const bound = await post('/binding-sets', { name: 'Folders', values: { academicRoot: { ...f.values.academicRoot, allowedAncestor: { ...f.folder, nodeId: 'parent' } } } });
    expect(bound.statusCode, bound.body).toBe(201); bindingId = bound.json().id;
    const input = { definition: f.rule, bindingSetId: bindingId };
    const created = await post('/rules', input); expect(created.statusCode, created.body).toBe(201); rule = created.json();
    const preview = await post('/rules/preview', { rule: input, mode: 'currentState' }); expect(preview.statusCode).toBe(200);
    const enabled = await post(`/rules/${rule.id}/lifecycle`, { state: 'enabled', pendingRuns: 'hold', reason: 'Enable config', activationPreviewId: preview.json().previewId }, `"${rule.revision}"`);
    expect(enabled.statusCode, enabled.body).toBe(200); rule = enabled.json();
  }, 180_000);
  afterEach(async () => { await app?.close(); await f?.isolated.close(); });
  async function delivery(eventType: string): Promise<CollectionMutationDelivery> {
    const row = await f.db.selectFrom('outbox_events').selectAll().where('event_type', '=', eventType).orderBy('commit_ordinal', 'desc').executeTakeFirstOrThrow();
    return { eventId: row.domain_event_id, eventType: row.event_type, eventVersion: row.event_version, handlerName: row.handler_name,
      idempotencyKey: row.domain_event_id, aggregateId: row.aggregate_id, aggregateScope: row.aggregate_scope, commitOrdinal: row.commit_ordinal?.toString() ?? null,
      payload: row.payload_json, aggregateRevision: row.aggregate_revision, occurredAt: row.occurred_at.toISOString() };
  }
  async function move(parentId: string, nodeId = 'academic') {
    const node = await f.db.selectFrom('nodes').select(['resource_revision', 'parent_id']).where('id', '=', nodeId).executeTakeFirstOrThrow();
    const source = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', node.parent_id!).executeTakeFirstOrThrow();
    const target = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', parentId).executeTakeFirstOrThrow();
    const moved = await f.canonical.execute((ports) => moveCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection', nodeId,
      ifMatch: `"${node.resource_revision}"`, newParentId: parentId, afterId: null, beforeId: null,
      baseSourceParentRevision: source.children_revision, baseTargetParentRevision: target.children_revision }));
    expect(moved.kind).toBe('moved');
    await createAutomationHealthMonitor(f.db, 'server', metrics).onCollectionMutation(await delivery('node.moved'));
  }
  test('startup is real revalidation; enabled config reports runtime unavailable, no zero-match failure', async () => {
    await createAutomationHealthMonitor(f.db, 'server', metrics).revalidateAll();
    const result = await get(`/rules/${rule.id}/health`); expect(result.statusCode, result.body).toBe(200);
    expect(validateAutomation('HealthReport', result.json()).valid).toBe(true);
    expect(result.json()).toMatchObject({ effectiveState: 'blocked' });
    expect(result.json().incidents.map((incident: { code: string }) => incident.code)).toEqual(['runtimeUnsupported']);
    expect(metrics.get('automation.runtime.ready')).toBe(0); expect(metrics.get('automation.health.revalidated')).toBeGreaterThan(0);
    const dependencies = (await get(`/rules/${rule.id}/dependencies`)).json();
    expect(validateAutomation('DependencyReport', dependencies).valid).toBe(true);
    expect(dependencies.dependencies.some((dependency: { resourceId: string; kind: string }) => dependency.resourceId === 'parent' && dependency.kind === 'ancestor')).toBe(true);
  });
  test('rule and health reads report current health without writing incidents or dependencies', async () => {
    await createAutomationHealthMonitor(f.db, 'server', metrics).revalidateAll();
    const state = async () => ({ incidents: (await sql`SELECT id,state,last_seen,incident_json FROM automation_incidents ORDER BY id`.execute(f.db)).rows,
      dependencies: (await sql`SELECT * FROM automation_dependencies ORDER BY role,resource_kind,resource_id`.execute(f.db)).rows });
    await f.rename('academic', 'Renamed before reads');
    const before = await state();
    const health = await get(`/rules/${rule.id}/health`); expect(health.statusCode, health.body).toBe(200);
    expect(health.json().incidents.map((incident: { code: string }) => incident.code)).toContain('bindingRenamed');
    for (const path of [`/rules/${rule.id}`, '/rules', `/rules/${rule.id}/dependencies`]) expect((await get(path)).statusCode).toBe(200);
    expect(await state()).toEqual(before);
    const revalidated = await post(`/rules/${rule.id}/revalidate`, { reason: 'Record current health' }, `"${rule.revision}"`);
    expect(revalidated.statusCode, revalidated.body).toBe(200);
    expect(await state()).not.toEqual(before);
  });
  test('a rule that cannot be revalidated fails neither startup nor the core projection it rides on', async () => {
    // Fault injection: every revalidation fails while the incident table is unavailable.
    await f.rename('academic', 'Renamed while unhealthy');
    await sql`ALTER TABLE automation_incidents RENAME TO automation_incidents_hidden`.execute(f.db);
    try {
      const monitor = createAutomationHealthMonitor(f.db, 'server', metrics);
      await expect(monitor.revalidateAll()).resolves.toBeUndefined();
      expect(metrics.get('automation.health.error')).toBe(1);
      await expect(monitor.wrap(new PostgresCollectionMutationProjectionSink(f.isolated.runtime.pool)).apply(await delivery('node.updated'))).resolves.toBeUndefined();
      expect(metrics.get('automation.health.error')).toBe(2);
    } finally { await sql`ALTER TABLE automation_incidents_hidden RENAME TO automation_incidents`.execute(f.db); }
  });
  test('canonical rename delivery refreshes label without rebinding or changing semantic revision', async () => {
    await f.rename('academic', 'Renamed Academic');
    const monitor = createAutomationHealthMonitor(f.db, 'server', metrics);
    await monitor.wrap(new PostgresCollectionMutationProjectionSink(f.isolated.runtime.pool)).apply(await delivery('node.updated'));
    const incidents = await f.db.selectFrom('automation_incidents').selectAll().where('rule_id', '=', rule.id).where('code', '=', 'bindingRenamed').execute();
    expect(incidents).toHaveLength(1); expect(incidents[0]?.severity).toBe('info'); expect(incidents[0]?.incident_json.blockingStages).toEqual([]);
    expect((await get(`/binding-sets/${bindingId}`)).json()).toMatchObject({ revision: '1', values: { academicRoot: { folder: f.folder } } });
    expect((await get(`/rules/${rule.id}`)).json()).toMatchObject({ desiredState: 'enabled', revision: rule.revision });
  });
  test('moving outside ancestor blocks once; acknowledgment hides without repairing; moving back resolves', async () => {
    await move('root');
    const first = (await get(`/rules/${rule.id}/health`)).json();
    const incident = first.incidents.find((value: { code: string }) => value.code === 'scopeChanged'); expect(incident).toBeTruthy();
    await get(`/rules/${rule.id}/health`);
    const active = await f.db.selectFrom('automation_incidents').select('id').where('rule_id', '=', rule.id).where('code', '=', 'scopeChanged').where('state', '!=', 'resolved').execute();
    expect(active).toHaveLength(1);
    const acknowledged = await post(`/incidents/${incident.id}/acknowledge`, { reason: 'Seen' }); expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(acknowledged.json().state).toBe('acknowledged');
    expect((await get('/incidents')).json().items.some((value: { id: string }) => value.id === incident.id)).toBe(false);
    expect((await get(`/rules/${rule.id}/health`)).json().incidents.find((value: { id: string }) => value.id === incident.id).state).toBe('acknowledged');
    const foreign = await f.issue('foreign');
    expect((await get(`/rules/${rule.id}/health`, foreign.cookie)).statusCode).toBe(404);
    await move('parent');
    expect((await f.db.selectFrom('automation_incidents').select('state').where('id', '=', incident.id).executeTakeFirstOrThrow()).state).toBe('resolved');
    expect((await get(`/rules/${rule.id}/health`)).json().incidents.some((value: { code: string }) => value.code === 'scopeChanged')).toBe(false);
  });
  test('revoking and restoring an editor grant changes health without changing desired state', async () => {
    const editor = await f.issue('editor');
    const grant = () => f.db.insertInto('collection_members').values({ collection_id: 'collection', subject_id: editor.subjectId, role: 'editor', granted_at: new Date() }).execute();
    await grant();
    const send = (path: string, payload: unknown) => app.inject({ method: 'POST', url: BASE + path, payload, headers: { cookie: editor.cookie, origin: ORIGIN,
      'x-csrf-token': editor.csrfToken, 'known-command-id': randomUUID() } });
    const binding = await send('/binding-sets', { name: 'Editor binding', values: { academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } } } });
    expect(binding.statusCode, binding.body).toBe(201);
    const created = await send('/rules', { definition: f.rule, bindingSetId: binding.json().id }); expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const preview = await send('/rules/preview', { rule: { definition: f.rule, bindingSetId: binding.json().id }, mode: 'currentState' });
    const enabled = await app.inject({ method: 'POST', url: `${BASE}/rules/${id}/lifecycle`, payload: { state: 'enabled', pendingRuns: 'hold', reason: 'Enable editor config', activationPreviewId: preview.json().previewId },
      headers: { cookie: editor.cookie, origin: ORIGIN, 'x-csrf-token': editor.csrfToken, 'known-command-id': randomUUID(), 'if-match': String(created.headers.etag) } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    await f.db.deleteFrom('collection_members').where('collection_id', '=', 'collection').where('subject_id', '=', editor.subjectId).execute();
    const unavailable = (await get(`/rules/${id}/health`, editor.cookie)).json();
    expect(unavailable.incidents.some((value: { code: string }) => value.code === 'permissionRevoked')).toBe(true);
    expect((await get(`/rules/${id}`, editor.cookie)).json().desiredState).toBe('enabled');
    const pause = async (paused: boolean, etag: string) => app.inject({ method: 'POST', url: BASE + '/pause', payload: { paused },
      headers: { cookie: editor.cookie, origin: ORIGIN, 'x-csrf-token': editor.csrfToken, 'known-command-id': randomUUID(), 'if-match': etag } });
    const paused = await pause(true, '"0"'); expect(paused.statusCode, paused.body).toBe(200);
    await f.rename('paper', 'While editor permission is revoked and automation is paused');
    const resumed = await pause(false, String(paused.headers.etag)); expect(resumed.statusCode, resumed.body).toBe(200);
    const pin = await f.db.selectFrom('automation_activations as a').innerJoin('automation_rule_revisions as r', 'r.id', 'a.rule_revision_id')
      .select('a.after_ordinal').where('r.rule_id', '=', id).where('a.disabled_after_ordinal', 'is', null).executeTakeFirstOrThrow();
    const canonical = await f.db.selectFrom('collections').select('commit_ordinal').where('id', '=', 'collection').executeTakeFirstOrThrow();
    expect(String(pin.after_ordinal)).toBe(String(canonical.commit_ordinal));
    await grant();
    const restored = (await get(`/rules/${id}/health`, editor.cookie)).json();
    expect(restored.incidents.some((value: { code: string }) => value.code === 'permissionRevoked')).toBe(false);
    expect((await get(`/binding-sets/${binding.json().id}`, editor.cookie)).json().revision).toBe('1');
  });
  test('eligible activity with zero predicate matches never becomes a broken-rule incident', async () => {
    const input = { definition: { ...f.rule, match: { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'never-matches-fixture' } }, bindingSetId: bindingId };
    const created = await post('/rules', input); expect(created.statusCode).toBe(201);
    const preview = await post('/rules/preview', { rule: input, mode: 'currentState' }); expect(preview.statusCode).toBe(200);
    expect(preview.json().decisions.length).toBeGreaterThan(0); expect(preview.json().decisions.every((value: { outcome: string }) => value.outcome === 'notMatched')).toBe(true);
    const id = created.json().id;
    const enabled = await post(`/rules/${id}/lifecycle`, { state: 'enabled', pendingRuns: 'hold', reason: 'Zero match is valid', activationPreviewId: preview.json().previewId }, String(created.headers.etag));
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect((await get(`/rules/${id}/health`)).json().incidents.map((value: { code: string }) => value.code)).toEqual(['runtimeUnsupported']);
  });
  test('deleted canonical folder blocks despite a same-name replacement; revalidation/pause remain available', async () => {
    const node = await f.db.selectFrom('nodes').select(['resource_revision', 'title']).where('id', '=', 'academic').executeTakeFirstOrThrow();
    const removed = await f.canonical.execute((ports) => deleteCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection', nodeId: 'academic',
      ifMatch: `"${node.resource_revision}"`, recursive: false })); expect(removed.kind).toBe('deleted');
    await f.createNode('same_name', 'parent', node.title);
    await createAutomationHealthMonitor(f.db, 'server', metrics).onCollectionMutation(await delivery('node.deleted'));
    const health = await post(`/rules/${rule.id}/revalidate`, { reason: 'Check dependency' }, `"${rule.revision}"`);
    expect(health.statusCode, health.body).toBe(200); expect(health.json().incidents.some((value: { code: string }) => value.code === 'bindingDeleted')).toBe(true);
    const paused = await post(`/rules/${rule.id}/lifecycle`, { state: 'paused', pendingRuns: 'hold', reason: 'Dependency lost' }, `"${rule.revision}"`);
    expect(paused.statusCode, paused.body).toBe(200); expect(paused.json().desiredState).toBe('paused');
    expect((await get(`/binding-sets/${bindingId}`)).json().values.academicRoot.folder.nodeId).toBe('academic');
  });
  test('unseen rename/move notices survive repeated delivery and reads, and newer notices supersede them', async () => {
    await f.createNode('notice_folder', 'root', 'Original');
    const binding = await post('/binding-sets', { name: 'Notices', values: {
      academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'notice_folder' } },
    } });
    const created = await post('/rules', { definition: f.rule, bindingSetId: binding.json().id });
    expect(created.statusCode, created.body).toBe(201);
    const ruleId = created.json().id;
    const notices = async () => (await get('/incidents?limit=100')).json<{ items: HealthIncident[] }>().items
      .filter((incident) => incident.ruleId === ruleId && ['bindingRenamed', 'bindingMoved'].includes(incident.code));
    const sink = createAutomationHealthMonitor(f.db, 'server').wrap(new PostgresCollectionMutationProjectionSink(f.isolated.runtime.pool));
    await f.rename('notice_folder', 'First rename');
    const event = await delivery('node.updated');
    await sink.apply(event);
    const first = await notices();
    expect(first).toHaveLength(1);
    await sink.apply(event);
    const report = (await get(`/rules/${ruleId}/health`)).json<HealthReport>();
    expect(report.incidents).toEqual(expect.arrayContaining([first[0]]));
    await get(`/rules/${ruleId}/dependencies`);
    expect(await notices()).toEqual(first);
    await f.rename('notice_folder', 'Second rename');
    await sink.apply(await delivery('node.updated'));
    const second = await notices();
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(first[0]?.id);
    expect((await f.db.selectFrom('automation_incidents').select('state').where('id', '=', first[0]!.id).executeTakeFirstOrThrow()).state).toBe('resolved');
    await move('parent', 'notice_folder');
    await get(`/rules/${ruleId}/health`);
    const latest = await notices();
    expect(latest.map((incident) => incident.code).sort()).toEqual(['bindingMoved', 'bindingRenamed']);
    for (const incident of latest) expect((await post(`/incidents/${incident.id}/acknowledge`, { reason: 'Seen' })).statusCode).toBe(200);
    // Path identities are bounded the same way on every Owner route.
    for (const response of [await get('/rules/bad%20id/health'), await get('/rules/bad%20id/dependencies'),
      await post('/incidents/bad%20id/acknowledge', { reason: 'Seen' })]) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    }
    await get(`/rules/${ruleId}/health`);
    await sink.apply(await delivery('node.moved'));
    expect(await notices()).toEqual([]);
  });
  test('initially blocked bindings follow ancestor moves and recover through the actual outbox event', async () => {
    await f.createNode('outside', 'root', 'Outside');
    await f.createNode('other_outside', 'root', 'Other outside');
    await f.createNode('container', 'outside', 'Container');
    await f.createNode('destination', 'container', 'Destination');
    await f.createNode('allowed', 'root', 'Allowed');
    await f.createNode('inside', 'allowed', 'Inside');
    const binding = await post('/binding-sets', { name: 'Initially blocked', values: {
      academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'destination' } },
      requiredRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'allowed' } },
    } });
    const definition = { ...f.rule, roles: [{ ...f.rule.roles[0], mustBeWithinRole: 'requiredRoot' },
      { key: 'requiredRoot', kind: 'folder', required: true, description: 'Allowed subtree' }] };
    const created = await post('/rules', { definition, bindingSetId: binding.json().id });
    expect(created.statusCode, created.body).toBe(201);
    const ruleId = created.json().id;
    const report = (await get(`/rules/${ruleId}/dependencies`)).json<DependencyReport>();
    expect(report.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'academicRoot', kind: 'ancestor', resourceId: 'container', status: 'blocked' }),
    ]));
    const active = () => f.db.selectFrom('automation_incidents').select('id').where('rule_id', '=', ruleId)
      .where('code', '=', 'scopeChanged').where('state', '=', 'open').execute();
    const initial = await active();
    expect(initial).toHaveLength(1);
    await move('other_outside', 'container');
    expect(await active()).toEqual(initial);
    const ancestors = await f.db.selectFrom('automation_dependencies as d')
      .innerJoin('automation_rules as r', 'r.current_revision_id', 'd.rule_revision_id').select('d.resource_id')
      .where('r.id', '=', ruleId).where('d.role', '=', 'academicRoot').where('d.resource_kind', '=', 'ancestor').execute();
    expect(ancestors.map((row) => row.resource_id)).toContain('other_outside');
    expect(ancestors.map((row) => row.resource_id)).not.toContain('outside');
    await move('inside', 'container');
    // Read persistence before invoking any API that itself revalidates the rule.
    expect(await active()).toEqual([]);
    expect((await get(`/rules/${ruleId}/dependencies`)).json<DependencyReport>().dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'academicRoot', resourceId: 'destination', status: 'valid' }),
    ]));
  });
  test('optional dependency availability is independent of stage blocking and acknowledgment', async () => {
    await f.createNode('optional_live', 'root', 'Optional');
    const binding = await post('/binding-sets', { name: 'Optional dependency', values: {
      academicRoot: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'parent' } },
      optionalFolder: { ...f.values.academicRoot, folder: { ...f.folder, nodeId: 'optional_live' } },
    } });
    const definition = { ...f.rule, roles: [...f.rule.roles,
      { key: 'optionalFolder', kind: 'folder', required: false, description: 'Unused optional folder' }] };
    const input = { definition, bindingSetId: binding.json().id };
    const created = await post('/rules', input); expect(created.statusCode, created.body).toBe(201);
    const ruleId = created.json().id;
    await f.db.updateTable('nodes').set({ deleted_at: new Date() }).where('id', '=', 'optional_live').execute();
    // The raw delete emits no outbox event, so record health with the explicit command; reads only report it.
    const health = (await post(`/rules/${ruleId}/revalidate`, { reason: 'Record deletion' }, `"${created.json().revision}"`)).json<HealthReport>();
    const incident = health.incidents.find((value) => value.role === 'optionalFolder')!;
    expect(incident).toMatchObject({ code: 'bindingDeleted', severity: 'warning', blockingStages: [] });
    const dependencies = async () => {
      const response = await get(`/rules/${ruleId}/dependencies`);
      expect(response.statusCode, response.body).toBe(200);
      expect(validateAutomation('DependencyReport', response.json()).valid).toBe(true);
      return response.json<DependencyReport>().dependencies;
    };
    expect(await dependencies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'optionalFolder', resourceId: 'optional_live', status: 'blocked' }),
      expect.objectContaining({ role: 'academicRoot', resourceId: 'parent', status: 'valid' }),
    ]));
    expect((await post('/rules/validate', input)).json().valid).toBe(true);
    await post(`/incidents/${incident.id}/acknowledge`, { reason: 'Seen' });
    expect(await dependencies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'optionalFolder', resourceId: 'optional_live', status: 'blocked' }),
    ]));
    // When this role gains a consumer, the same dependency incident becomes blocking.
    const changed = await app.inject({ method: 'PUT', url: `${BASE}/rules/${ruleId}`,
      headers: { ...headers(), 'if-match': String(created.headers.etag) }, payload: {
        ...input, definition: { ...definition, intake: { ...definition.intake, folderRole: 'optionalFolder' } },
        pendingRuns: 'hold', counterPolicy: 'resetOnSemanticChange',
      } });
    expect(changed.statusCode, changed.body).toBe(200);
    const blocking = (await get(`/rules/${ruleId}/health`)).json<HealthReport>().incidents.find((value) => value.role === 'optionalFolder');
    expect(blocking).toMatchObject({ id: incident.id, severity: 'error', state: 'acknowledged', blockingStages: ['intake'] });
    expect((await f.db.selectFrom('automation_incidents').select('severity').where('id', '=', incident.id).executeTakeFirstOrThrow()).severity).toBe('error');
    await f.db.updateTable('nodes').set({ deleted_at: null }).where('id', '=', 'optional_live').execute();
    expect(await dependencies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'optionalFolder', resourceId: 'optional_live', status: 'valid' }),
    ]));
  });

});
