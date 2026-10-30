import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, expect, test } from 'vitest';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createCollectionNode, updateCollectionNode, moveCollectionNode, deleteCollectionNode } from '../../../src/modules/collections/index.js';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createActivityAgentRoute, createActivityStore, setAgentActivityEnabled } from '../../../src/infrastructure/activity/index.js';
import { setAutomationCaptureEnabled } from '../../../src/infrastructure/automation/index.js';
import { registerActivityRoutes } from '../../../src/transport/product/activity-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import type { OutboxHandlerContext } from '../../../src/infrastructure/outbox/router.js';

describeWithPostgres('durable owner agent activity', () => {
  let f: Awaited<ReturnType<typeof automationFixture>>, app: ReturnType<typeof Fastify>, store: ReturnType<typeof createActivityStore>;
  afterEach(async () => { await app?.close(); await f?.isolated.close(); setAgentActivityEnabled(false); setAutomationCaptureEnabled(false); });
  async function setup() {
    f = await automationFixture('agent_activity'); setAgentActivityEnabled(true);
    store = createActivityStore(f.db, 'activity-test-cursor-key-at-least-32-bytes');
    app = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerActivityRoutes(app, { identityUnitOfWork: f.identity, allowedOrigins: ['https://activity.example.test'], activity: store }); await app.ready();
  }
  async function create(id: string, agent: string | null = 'client-a', origin: 'mcp' | 'web' | 'automation' = 'mcp', parentId = 'parent') {
    return f.canonical.execute(ports => createCollectionNode({ ...ports, canonical: { ...ports.canonical,
      execute: input => ports.canonical.execute({ ...input, automationContext: { origin,
        ...(agent ? { agent: { clientId: agent, credentialBindingId: 'cred-1' } } : {}) } }) } }, {
      actor: f.actor, command: f.command(), collectionId: 'collection', parentId, nodeId: id, afterId: null, beforeId: null,
      node: { kind: 'bookmark', title: `Paper ${id}`, url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit' },
    }));
  }
  async function context(id: string, occurredAt?: Date): Promise<OutboxHandlerContext> {
    const row = await f.db.selectFrom('outbox_events').selectAll().where('handler_name', '=', 'activity_agent')
      .where(sql<string>`payload_json->>'nodeId'`, '=', id).executeTakeFirstOrThrow();
    const payload = occurredAt ? { ...row.payload_json, occurredAt: occurredAt.toISOString() } : row.payload_json;
    await f.db.updateTable('outbox_events').set({ state: 'leased', lease_generation: 1n, payload_json: payload,
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
      locked_until: sql<Date>`clock_timestamp()+interval '60 seconds'` }).where('outbox_id', '=', row.outbox_id).execute();
    return { signal: new AbortController().signal, idempotencyKey: row.domain_event_id,
      attempt: { outboxId: row.outbox_id, leaseGeneration: '1' }, envelope: { event_id: row.domain_event_id,
        event_type: row.event_type, event_version: 1, aggregate_identity: { aggregate_type: 'collection', aggregate_id: 'collection', aggregate_scope: 'collection' },
        aggregate_revision: null, commit_ordinal: String(row.commit_ordinal), occurred_at: (occurredAt ?? row.occurred_at).toISOString(),
        payload: payload as OutboxHandlerContext['envelope']['payload'] } };
  }
  const get = (suffix = '', cookie?: string) => app.inject({ url: `/api/v1/me/activity${suffix}`, headers: { cookie: cookie ?? f.owner.cookie } });
  const read = (payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v1/me/activity/read', payload,
    headers: { cookie: f.owner.cookie, origin: 'https://activity.example.test', 'x-csrf-token': f.owner.csrfToken, 'known-command-id': randomUUID(), ...extra } });
  test('capture-independent enqueue, retry idempotency and concurrent aggregation', async () => {
    await setup(); setAutomationCaptureEnabled(false); await create('first');
    const delivery = await context('first'), route = createActivityAgentRoute(f.db);
    expect(delivery.envelope.payload).toMatchObject({ agentClientId: 'client-a', credentialBindingId: 'cred-1', nodeId: 'first' });
    expect(Object.keys(delivery.envelope.payload).sort()).toEqual(['agentClientId','collectionId','credentialBindingId','nodeId','occurredAt','operationId']);
    await route.handle(delivery); await route.handle(delivery);
    expect(await f.db.selectFrom('activity_members').selectAll().execute()).toHaveLength(1);
    expect(await f.db.selectFrom('activity_items').selectAll().execute()).toMatchObject([{ count: 1 }]);
    await create('second'); await create('third');
    await Promise.all([context('second').then(c => route.handle(c)), context('third').then(c => route.handle(c))]);
    expect(await f.db.selectFrom('activity_items').selectAll().execute()).toMatchObject([{ count: 3 }]);
    expect((await get('/summary')).json()).toMatchObject({ unreadCount: 1, latest: { count: 3,
      agent: { clientId: 'client-a', name: null, kind: 'unknown' }, folders: [{ nodeId: 'parent', title: 'Research', count: 3 }] } });
    for (let i = 0; i < 6; i++) {
      await f.createNode(`folder-${i}`, 'root', `Folder ${i}`); await create(`sample-${i}`, 'client-a', 'mcp', `folder-${i}`);
      await route.handle(await context(`sample-${i}`));
    }
    const bounded = (await get('/summary')).json().latest;
    expect(bounded.items).toHaveLength(5); expect(bounded.folders).toHaveLength(5);
    expect(bounded.count).toBe(9); expect(bounded.folders[0]).toMatchObject({ nodeId: 'parent', count: 3 });
    await create('web', null, 'web'); await create('automation', null, 'automation'); setAgentActivityEnabled(false); await create('disabled');
    expect(await f.db.selectFrom('outbox_events').select('outbox_id').where('handler_name', '=', 'activity_agent').execute()).toHaveLength(9);
    await f.db.updateTable('outbox_events').set({ lease_generation: 2n }).where('outbox_id', '=', delivery.attempt!.outboxId).execute();
    await expect(route.handle(delivery)).rejects.toThrow('lease lost');
  });
  test('MCP update, move and delete produce separate durable activity and retries do not duplicate it', async () => {
    await setup(); await create('changed');
    const route = createActivityAgentRoute(f.db);
    await route.handle(await context('changed'));
    const canonical = <T>(work: (ports: Parameters<Parameters<typeof f.canonical.execute>[0]>[0]) => Promise<T>) => f.canonical.execute(ports => work({ ...ports,
      canonical: { ...ports.canonical, execute: input => ports.canonical.execute({ ...input,
        automationContext: { origin: 'mcp', agent: { clientId: 'client-a', credentialBindingId: 'cred-1' } } }) } }));
    const node = () => f.db.selectFrom('nodes').select('resource_revision').where('id', '=', 'changed').executeTakeFirstOrThrow();
    await canonical(async ports => updateCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'changed', ifMatch: `"${(await node()).resource_revision}"`, patch: { title: 'Updated title' } }));
    const parents = await f.db.selectFrom('nodes').select(['id', 'children_revision']).where('id', 'in', ['parent', 'academic']).execute();
    await canonical(async ports => moveCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'changed', ifMatch: `"${(await node()).resource_revision}"`, newParentId: 'academic', afterId: null, beforeId: null,
      baseSourceParentRevision: parents.find(p => p.id === 'parent')!.children_revision, baseTargetParentRevision: parents.find(p => p.id === 'academic')!.children_revision }));
    await canonical(async ports => deleteCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'changed', ifMatch: `"${(await node()).resource_revision}"`, recursive: false }));
    const rows = await f.db.selectFrom('outbox_events').selectAll().where('handler_name', '=', 'activity_agent').execute();
    expect(rows).toHaveLength(4);
    for (const row of rows.filter(row => (row.payload_json as { action?: string }).action)) {
      await f.db.updateTable('outbox_events').set({ state: 'leased', lease_generation: 1n,
        locked_until: sql<Date>`clock_timestamp()+interval '60 seconds'` }).where('outbox_id', '=', row.outbox_id).execute();
      const delivery: OutboxHandlerContext = { signal: new AbortController().signal, idempotencyKey: row.domain_event_id,
        attempt: { outboxId: row.outbox_id, leaseGeneration: '1' }, envelope: { event_id: row.domain_event_id,
          event_type: row.event_type, event_version: 1, aggregate_identity: { aggregate_type: 'collection', aggregate_id: 'collection', aggregate_scope: 'collection' },
          aggregate_revision: null, commit_ordinal: String(row.commit_ordinal), occurred_at: row.occurred_at.toISOString(), payload: row.payload_json } };
      await route.handle(delivery); await route.handle(delivery);
    }
    const activity = (await store.list(f.owner.accountId, {})).items;
    expect(activity.find(i => i.kind === 'agent_nodes_deleted')?.items).toMatchObject([
      { nodeId: 'changed', title: 'Updated title', host: 'example.test' },
    ]);
    const kinds = activity.map(i => i.kind).sort();
    expect(kinds).toEqual([
      'agent_bookmarks_added', 'agent_nodes_deleted', 'agent_nodes_moved', 'agent_nodes_updated']);
    for (const name of ['product-v1.yaml', 'colp-server-v1.yaml']) {
      const contract = parse(readFileSync(new URL(`../../../openapi/${name}`, import.meta.url), 'utf8'));
      for (const kind of kinds) expect(contract.components.schemas.ActivityItem.properties.kind.enum).toContain(kind);
    }
    expect(await f.db.selectFrom('activity_members').selectAll().execute()).toHaveLength(4);
  });
  test('private list, summary, id and through reads; deleted samples; signed pagination', async () => {
    await setup(); const route = createActivityAgentRoute(f.db);
    await create('one'); await route.handle(await context('one')); await create('two', 'client-b'); await route.handle(await context('two'));
    const all = await get(); expect(all.statusCode, all.body).toBe(200); expect(all.headers['cache-control']).toBe('private, no-store');
    expect(all.json()).toMatchObject({ unreadCount: 2, items: [{ count: 1 }, { count: 1 }] }); const [newest, oldest] = all.json().items;
    expect((await read({ ids: [oldest.id, 'unknown'] })).json()).toEqual({ readCount: 1, unreadCount: 1 });
    expect((await read({ ids: [oldest.id] })).json()).toEqual({ readCount: 0, unreadCount: 1 });
    expect((await get('?state=unread')).json().items.map((i: { id: string }) => i.id)).toEqual([newest.id]);
    expect((await get('/summary')).headers['known-activity-account-id']).toBe(f.owner.accountId);
    const foreign = await f.issue('activity_foreign');
    expect((await get('/summary', foreign.cookie)).headers['known-activity-account-id']).toBe(foreign.accountId); expect((await get('', foreign.cookie)).json()).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
    expect(await store.markRead(foreign.accountId, { through: newest.id, throughRevision: newest.revision }, randomUUID())).toEqual({ readCount: 0, unreadCount: 0 });
    expect((await read({ through: 'unknown', throughRevision: '1' })).json()).toEqual({ readCount: 0, unreadCount: 1 });
    expect((await read({ through: newest.id, throughRevision: newest.revision })).json()).toEqual({ readCount: 1, unreadCount: 0 });
    await create('three', null); await route.handle(await context('three')); expect((await get('/summary')).json().latest.agent).toBeNull();
    await f.db.updateTable('nodes').set({ deleted_at: new Date() }).where('id', '=', 'three').execute();
    expect((await get('/summary')).json().latest).toMatchObject({ count: 1, items: [], folders: [] });
    const first = await get('?limit=1'); expect(first.json().nextCursor).toBeTruthy();
    expect((await get(`?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`)).json().items[0].id).not.toBe(first.json().items[0].id);
    expect((await get('?state=bad')).statusCode).toBe(400); expect((await get('?limit=0')).statusCode).toBe(400);
    expect((await read({ ids: [newest.id, newest.id] })).statusCode).toBe(400);
  });
  test('lost first lease rolls back all writes; read and expired aggregates start fresh items', async () => {
    await setup(); const route = createActivityAgentRoute(f.db); await create('one'); const delivery = await context('one');
    await f.db.updateTable('outbox_events').set({ lease_generation: 2n }).where('outbox_id', '=', delivery.attempt!.outboxId).execute();
    await expect(route.handle(delivery)).rejects.toThrow('lease lost'); expect(await f.db.selectFrom('activity_items').selectAll().execute()).toHaveLength(0);
    await route.handle(await context('one')); const item = (await store.list(f.owner.accountId, {})).items[0]!;
    await store.markRead(f.owner.accountId, { ids: [item.id] }, randomUUID()); await create('two'); await route.handle(await context('two'));
    await sql`UPDATE activity_items SET created_at=clock_timestamp()-interval '24 hours' WHERE read_at IS NULL`.execute(f.db);
    await create('three'); await route.handle(await context('three')); expect(await f.db.selectFrom('activity_items').selectAll().execute()).toHaveLength(3);
    await create('inactive'); const inactive = await context('inactive');
    await f.db.updateTable('accounts').set({ status: 'disabled' }).where('id', '=', f.owner.accountId).execute();
    await route.handle(inactive); expect(await f.db.selectFrom('activity_items').selectAll().execute()).toHaveLength(3);
  });
  test('read-through cannot advance past the rendered revision after concurrent aggregation', async () => {
    await setup(); const route = createActivityAgentRoute(f.db);
    await create('seen', 'agent-a'); await route.handle(await context('seen'));
    const seen = (await store.list(f.owner.accountId, {})).items[0]!;
    await create('new-other', 'agent-b'); await route.handle(await context('new-other'));
    await create('new-same', 'agent-a'); await route.handle(await context('new-same'));
    expect((await read({ through: seen.id, throughRevision: seen.revision })).json()).toEqual({ readCount: 0, unreadCount: 2 });
    for (const throughRevision of ['0', '1 OR 1=1', '9'.repeat(20), 1]) {
      expect((await read({ through: seen.id, throughRevision })).statusCode).toBe(400);
    }
    const latest = (await store.summary(f.owner.accountId)).latest!;
    expect((await read({ through: latest.id, throughRevision: latest.revision })).json()).toEqual({ readCount: 2, unreadCount: 0 });
  });
  test('delayed and out-of-order events share a fixed delivery window without rewriting source time', async () => {
    await setup(); const route = createActivityAgentRoute(f.db);
    const firstTime = new Date(Date.now() - 25 * 3_600_000), olderTime = new Date(firstTime.getTime() - 3_600_000);
    await create('delayed-first'); await route.handle(await context('delayed-first', firstTime));
    const opened = await f.db.selectFrom('activity_items').select(['id', 'created_at']).executeTakeFirstOrThrow();
    await create('delayed-earlier'); const earlier = await context('delayed-earlier', olderTime);
    await route.handle(earlier); await route.handle(earlier);
    const page = await store.list(f.owner.accountId, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: opened.id, count: 2, occurredAt: firstTime.toISOString() });
    expect(page.items[0]!.items.map(item => item.occurredAt)).toEqual([firstTime.toISOString(), olderTime.toISOString()]);
    expect((await f.db.selectFrom('activity_items').select('created_at').where('id', '=', opened.id).executeTakeFirstOrThrow()).created_at)
      .toEqual(opened.created_at);
    await sql`UPDATE activity_items SET created_at=clock_timestamp()-interval '24 hours' WHERE id=${opened.id}`.execute(f.db);
    await create('delayed-next-window'); await route.handle(await context('delayed-next-window', firstTime));
    expect((await store.list(f.owner.accountId, {})).items).toHaveLength(2);
  });
  test('browser session, Origin, CSRF and command id admission', async () => {
    await setup(); expect((await app.inject({ url: '/api/v1/me/activity/summary' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/me/activity', headers: { authorization: 'Bearer sync-token' } })).statusCode).toBe(401);
    expect((await read({ through: 'unknown', throughRevision: '1' }, { origin: 'https://foreign.test' })).statusCode).toBe(403);
    expect((await read({ through: 'unknown', throughRevision: '1' }, { 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await read({ through: 'unknown', throughRevision: '1' }, { 'known-command-id': '' })).statusCode).toBe(400);
  });
});
