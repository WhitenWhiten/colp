import Fastify from 'fastify';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { loadConfig } from '../../support/test-config.js';
import { createAutomationUnitOfWork, createAutomationRuntime, createAutomationSourceInspector } from '../../../src/infrastructure/automation/index.js';
import { deleteCollectionNode } from '../../../src/modules/collections/index.js';
import { createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { PostgresOutboxRepository, VersionedOutboxWorker, OutboxRouter, EventEnvelopeRegistry,
  createAutomationIngestRoute, automationIngestRegistration, automationResumeRegistration, AUTOMATION_RESUME_EVENT,
  type OutboxClaim } from '../../../src/infrastructure/outbox/index.js';
import { registerAutomationRoutes } from '../../../src/transport/product/automation-rule-routes.js';
import { automationRunRoutes } from '../../../src/transport/product/automation-run-routes.js';
import { automationHealthRoutes } from '../../../src/transport/product/automation-health-routes.js';
import { registerNodeRoutes } from '../../../src/transport/product/node-routes.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
const ORIGIN = 'https://automation.example.test', BASE = '/api/v1/me/automations';

describeWithPostgres('AW-66 M1 backend gate through API and durable worker', () => {
  let f: Awaited<ReturnType<typeof automationFixture>>, app: ReturnType<typeof Fastify>;
  const workers: VersionedOutboxWorker[] = [];
  beforeAll(async () => {
    f = await automationFixture('aw66'); app = Fastify({ exposeHeadRoutes: false }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationRoutes(app, { identityUnitOfWork: f.identity, unitOfWork: createAutomationUnitOfWork(f.db, 'server', { runtimeEnabled: true }),
      allowedOrigins: [ORIGIN], cursorKey: 'm1-gate-cursor-key' }, [...automationRunRoutes('m1-gate-cursor-key'), ...automationHealthRoutes('m1-gate-cursor-key')]);
    registerNodeRoutes(app, { config: loadConfig({ DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN,
      OIDC_JWKS_URI: 'https://issuer.example/certs', LOG_LEVEL: 'silent' }), identityUnitOfWork: f.identity,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(f.db), productCollectionMutationUnitOfWork: f.canonical, collectionMetadataMutationsEnabled: true });
  });
  afterAll(async () => { for (const worker of workers) await worker.stop(); await app?.close(); await f?.isolated.close(); });
  const headers = () => ({ cookie: f.owner.cookie, origin: ORIGIN, 'x-csrf-token': f.owner.csrfToken, 'known-command-id': randomUUID() });
  const post = (path: string, payload: unknown, etag?: string) => app.inject({ method: 'POST', url: path, payload,
    headers: { ...headers(), ...(etag ? { 'if-match': etag } : {}) } });
  const get = (path: string) => app.inject({ method: 'GET', url: path, headers: { cookie: f.owner.cookie } });
  function worker(repository: PostgresOutboxRepository, faultBeforeCommit = false) {
    const runtime = createAutomationRuntime('server');
    const inspect = createAutomationSourceInspector(f.db, async (tx, actor, collectionId, sources) => {
      const more = await runtime(tx, actor, collectionId, sources);
      if (faultBeforeCommit) throw new Error('fault: before transaction commit');
      return more;
    });
    const value = new VersionedOutboxWorker({ repository,
      router: new OutboxRouter([createAutomationIngestRoute(inspect), createAutomationIngestRoute(inspect, AUTOMATION_RESUME_EVENT)]),
      envelopes: new EventEnvelopeRegistry([automationIngestRegistration, automationResumeRegistration]),
      logger: { info() {}, warn() {}, error() {} }, leaseDurationMs: 30000, heartbeatIntervalMs: 5000, handlerTimeoutMs: 20000,
      retryPolicy: { maxAttempts: 3, retryDelayMs: () => 1 } });
    workers.push(value); return value;
  }
  async function drain(value: VersionedOutboxWorker) {
    for (let i = 0; i < 30; i++) {
      // Isolate this feature's worker from unrelated projection routes, and advance the test queue clock.
      await f.db.updateTable('outbox_events').set({ state: 'completed', completed_at: new Date() }).where('handler_name', '!=', 'automation_ingest').execute();
      await f.db.updateTable('outbox_events').set({ available_at: sql<Date>`clock_timestamp()-interval '1 second'` })
        .where('handler_name', '=', 'automation_ingest').where('state', 'in', ['pending','retryable']).execute();
      if (!await value.runOnce()) return;
    }
    throw new Error('M1 worker did not converge within 30 bounded passes');
  }
  test('authorized configuration → root create → commit-before-ack crash → restart → explanation → one-effect Undo', async () => {
    const binding = await post(BASE + '/binding-sets', { name: 'M1 folders', values: f.values }); expect(binding.statusCode, binding.body).toBe(201);
    const input = { definition: f.rule, bindingSetId: binding.json().id };
    const draft = await post(BASE + '/rules', input); expect(draft.statusCode, draft.body).toBe(201);
    const preview = await post(BASE + '/rules/preview', { rule: input, mode: 'currentState' }); expect(preview.statusCode, preview.body).toBe(200);
    const rule = await post(`${BASE}/rules/${draft.json().id}/lifecycle`, { state: 'enabled', pendingRuns: 'hold', reason: 'M1 gate',
      activationPreviewId: preview.json().previewId }, `"${draft.json().revision}"`);
    expect(rule.statusCode, rule.body).toBe(200); expect(rule.json().effectiveState).toBe('active');
    expect((await get(`${BASE}/rules/${draft.json().id}/health`)).json().incidents).toEqual([]);
    expect((await get(BASE + '/capabilities')).json()).toMatchObject({ triggerModes: ['each'], taskTypes: [], eventsEnabled: false });
    const created = await post('/api/v1/collections/collection/nodes', { parentId: 'root', afterId: null, beforeId: null,
      intakeDisposition: 'userDefault', node: { kind: 'bookmark', title: 'Gate paper', url: 'https://arxiv.org/gate', description: null, tags: [], visibility: 'inherit' } });
    expect(created.statusCode, created.body).toBe(201); const nodeId = created.json().node.id;
    const pending = await f.db.selectFrom('outbox_events').selectAll().where('handler_name', '=', 'automation_ingest').orderBy('commit_ordinal', 'desc').executeTakeFirstOrThrow();
    expect(pending.available_at.getTime()-pending.occurred_at.getTime()).toBeGreaterThanOrEqual(9990);
    expect((await get(BASE + '/runs')).json().items).toEqual([]);
    const rollbackWorker = worker(new PostgresOutboxRepository(f.isolated.runtime.pool), true);
    await f.db.updateTable('outbox_events').set({ state: 'completed' }).where('handler_name', '!=', 'automation_ingest').execute();
    // Only the newest source is claimable in this injected rollback window.
    await f.db.updateTable('outbox_events').set({ available_at: new Date(Date.now()+60000) }).where('handler_name', '=', 'automation_ingest').execute();
    await f.db.updateTable('outbox_events').set({ available_at: new Date(0) }).where('outbox_id', '=', pending.outbox_id).execute();
    await rollbackWorker.runOnce(); await rollbackWorker.stop();
    expect((await get(BASE + '/runs')).json().items).toEqual([]);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', nodeId).executeTakeFirstOrThrow()).parent_id).toBe('root');
    let crashed = false;
    class CommitThenCrashRepository extends PostgresOutboxRepository {
      override async complete(claim: OutboxClaim): Promise<boolean> {
        const effects = (await sql<{ count: string }>`SELECT count(*) FROM automation_effect_receipts`.execute(f.db)).rows[0]!.count;
        if (!crashed && Number(effects) > 0) { crashed = true; throw new Error('fault: commit succeeded, acknowledgment lost'); }
        return super.complete(claim);
      }
    }
    const firstWorker = worker(new CommitThenCrashRepository(f.isolated.runtime.pool));
    for (let i=0; i<10 && !crashed; i++) {
      await f.db.updateTable('outbox_events').set({ state: 'completed' }).where('handler_name', '!=', 'automation_ingest').execute();
      await f.db.updateTable('outbox_events').set({ available_at: new Date(0) }).where('handler_name', '=', 'automation_ingest').execute();
      await firstWorker.runOnce();
    }
    expect(crashed).toBe(true); await firstWorker.stop();
    await drain(worker(new PostgresOutboxRepository(f.isolated.runtime.pool)));
    const runs = (await get(BASE + '/runs')).json().items; expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', executionPolicyRevision: null, jobIds: [], kind: 'intake' });
    expect(runs[0].effects).toHaveLength(1); expect(runs[0].effects[0].undoAvailable).toBe(true);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', nodeId).executeTakeFirstOrThrow()).parent_id).toBe('academic');
    const undone = await post(`${BASE}/runs/${runs[0].id}/undo`, { reason: 'M1 gate Undo', effectReceiptId: runs[0].effects[0].id,
      expectedEffectDigest: runs[0].effects[0].effectDigest }, `"${runs[0].revision}"`);
    expect(undone.statusCode, undone.body).toBe(200);
    await drain(worker(new PostgresOutboxRepository(f.isolated.runtime.pool)));
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', nodeId).executeTakeFirstOrThrow()).parent_id).toBe('root');
    const counts = (await sql<{ effects: string; jobs: string; moves: string }>`SELECT
      (SELECT count(*) FROM automation_effect_receipts) AS effects, (SELECT count(*) FROM automation_jobs) AS jobs,
      (SELECT count(*) FROM automation_event_facts WHERE facts_json->>'action'='move') AS moves`.execute(f.db)).rows[0];
    expect(counts).toEqual({ effects: '1', jobs: '0', moves: '2' });
    expect((await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()
      AND table_name IN ('automation_execution_policies','automation_targets','automation_subscriptions','automation_usage_counters')`.execute(f.db)).rows).toEqual([]);
  });
  test('unknown or explicitly selected root never becomes default consent at grace expiry', async () => {
    const ids: string[] = [];
    for (const intent of [undefined, 'userSelected']) {
      const response = await post('/api/v1/collections/collection/nodes', { parentId: 'root', afterId: null, beforeId: null,
        ...(intent ? { intakeDisposition: intent } : {}), node: { kind: 'bookmark', title: 'Manual root', url: 'https://arxiv.org/manual', description: null, tags: [], visibility: 'inherit' } });
      expect(response.statusCode, response.body).toBe(201); ids.push(response.json().node.id);
    }
    await drain(worker(new PostgresOutboxRepository(f.isolated.runtime.pool)));
    const nodes = await f.db.selectFrom('nodes').select('parent_id').where('id', 'in', ids).execute();
    expect(nodes.map(node => node.parent_id)).toEqual(['root','root']);
    expect((await get(BASE + '/runs')).json().items).toHaveLength(1);
  });
  test('a deleted destination and same-name replacement never redirect the pinned rule', async () => {
    const destination = await f.db.selectFrom('nodes').select('resource_revision').where('id', '=', 'academic').executeTakeFirstOrThrow();
    await f.canonical.execute(p => deleteCollectionNode(p, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'academic', ifMatch: destination.resource_revision, recursive: false }));
    await f.createNode('same-name-replacement', 'parent', 'Academic');
    const response = await post('/api/v1/collections/collection/nodes', { parentId: 'root', afterId: null, beforeId: null,
      intakeDisposition: 'userDefault', node: { kind: 'bookmark', title: 'Missing destination', url: 'https://arxiv.org/missing', description: null, tags: [], visibility: 'inherit' } });
    expect(response.statusCode, response.body).toBe(201);
    await drain(worker(new PostgresOutboxRepository(f.isolated.runtime.pool)));
    const runs = (await get(`${BASE}/runs?collectionId=collection&nodeId=${response.json().node.id}`)).json().items;
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: 'review', effects: [] });
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', response.json().node.id).executeTakeFirstOrThrow()).parent_id).toBe('root');
  });
  test('a real schema backup/restore restarts with all automation paused before any pending effect', async () => {
    const before = (await get(BASE + '/runs')).json().items.length;
    const scratch = mkdtempSync(join(tmpdir(), 'automation-m1-gate-'));
    try {
      const backup = join(scratch, 'm1.dump'), url = new URL(f.isolated.databaseUrl); url.searchParams.delete('options');
      execFileSync('pg_dump', ['--dbname', url.toString(), '--schema', f.isolated.schema, '--format=custom', '--file', backup]);
      execFileSync('pg_restore', ['--dbname', url.toString(), '--schema', f.isolated.schema, '--clean', '--if-exists', '--exit-on-error', '--single-transaction', backup]);
      const pause = readFileSync('../../deploy/restore.sh', 'utf8').split("<<'SQL'\n")[1]!.split('\nSQL')[0]!;
      await sql.raw(pause).execute(f.db);
      expect((await get(BASE + '/pause')).json()).toMatchObject({ paused: true, pausedBy: 'restore' });
      const created = await post('/api/v1/collections/collection/nodes', { parentId: 'root', afterId: null, beforeId: null,
        intakeDisposition: 'userDefault', node: { kind: 'bookmark', title: 'After restore', url: 'https://arxiv.org/restored', description: null, tags: [], visibility: 'inherit' } });
      expect(created.statusCode, created.body).toBe(201);
      await drain(worker(new PostgresOutboxRepository(f.isolated.runtime.pool)));
      expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', created.json().node.id).executeTakeFirstOrThrow()).parent_id).toBe('root');
      expect((await get(BASE + '/runs')).json().items).toHaveLength(before);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

});
