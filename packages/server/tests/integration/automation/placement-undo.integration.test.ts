import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateAutomation } from '@know-n/colp/automation';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { placementInputDigest, placementResultDigest, getAutomationRun } from '../../../src/modules/automation/index.js';
import { moveCollectionNode } from '../../../src/modules/collections/index.js';
import { registerAutomationRoutes } from '../../../src/transport/product/automation-rule-routes.js';
import { automationRunRoutes } from '../../../src/transport/product/automation-run-routes.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
const ORIGIN = 'https://automation.example.test';
describeWithPostgres('M1 conservative single placement Undo', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>, app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    f = await automationDeviceFixture('aw51'); app = Fastify({ exposeHeadRoutes: false }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationRoutes(app, { identityUnitOfWork: f.identity, unitOfWork: f.uow, allowedOrigins: [ORIGIN], cursorKey: 'undo-cursor-secret' }, automationRunRoutes('undo-cursor-secret'));
  });
  afterEach(async () => { await app?.close(); await f?.isolated.close(); });
  async function placement(observed: boolean) {
    await f.syncCreate('undo-paper', 'undo-create', observed ? 'root' : 'academic');
    if (observed) await f.syncMove('undo-paper', 'undo-move');
    const pins = { committedNode: { serverUuid: 'server', collectionId: 'collection', nodeId: 'undo-paper' }, ruleRevision: '1', bindingRevision: '1' };
    await createAutomationDeviceUnitOfWork(f.db, 'server').execute({ credential: f.http.credential, sessionId: f.sessionId, origin: AUTOMATION_DEVICE_ORIGIN },
      p => p.accept({ ...pins, operationId: 'undo-create', beforeFolder: { ...f.folder, nodeId: 'root' }, ...(observed ? { placementOperationId: 'undo-move' } : {}),
        deviceId: f.replica.deviceId, replicaGeneration: Number(f.replica.leaseGeneration), localReceiptId: randomUUID(), ruleId: f.rule.id, bundleRevision: '1',
        inputDigest: placementInputDigest(pins, { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] }), resultDigests: [placementResultDigest(f.folder)], satisfiedTaskTypes: ['classify.root'] }));
    const id = (await sql<{ id: string }>`SELECT id FROM automation_runs WHERE explanation_json->>'nodeId'='undo-paper'`.execute(f.db)).rows[0]!.id;
    return f.uow.execute(f.owner, p => getAutomationRun(p.runs, id));
  }
  function undoRequest(run: Awaited<ReturnType<typeof placement>>) {
    return { method: 'POST' as const, url: `/api/v1/me/automations/runs/${run.id}/undo`,
      headers: { cookie: f.owner.cookie, origin: ORIGIN, 'x-csrf-token': f.owner.csrfToken, 'known-command-id': randomUUID(), 'if-match': `"${run.revision}"` },
      payload: { reason: 'Undo fixture', effectReceiptId: run.effects[0]!.id, expectedEffectDigest: run.effects[0]!.effectDigest } };
  }
  test('pre-save placement explains why original destination cannot be invented for Undo', async () => {
    const run = await placement(false); expect(validateAutomation('Run', run).valid).toBe(true);
    expect(run.effects[0]!.undoAvailable).toBe(false); expect(run.effects[0]!.undoReason).toContain('not observed');
    expect((await app.inject(undoRequest(run))).statusCode).toBe(409);
  });
  test('one compensating canonical move preserves the saved bookmark and retries replay its command', async () => {
    const run = await placement(true); expect(run.effects[0]!.undoAvailable).toBe(true);
    const request = undoRequest(run), response = await app.inject(request); expect(response.statusCode, response.body).toBe(200);
    expect(validateAutomation('OperationReceipt', response.json()).valid).toBe(true);
    expect((await app.inject(request)).body).toBe(response.body);
    const node = await f.db.selectFrom('nodes').selectAll().where('id', '=', 'undo-paper').executeTakeFirstOrThrow();
    expect(node.parent_id).toBe('root'); expect(node.url).toBe('https://arxiv.org/sync'); expect(node.deleted_at).toBeNull();
    const reread = await f.uow.execute(f.owner, p => getAutomationRun(p.runs, run.id));
    expect(reread.effects[0]).toMatchObject({ status: 'reverted', undoAvailable: false });
    expect((await sql<{ count: string }>`SELECT count(*) FROM automation_event_facts WHERE facts_json->>'stageId'='undo'`.execute(f.db)).rows[0]!.count).toBe('1');
  });
  test('a newer manual move blocks stale Undo without overwriting owner placement', async () => {
    const run = await placement(true);
    const node = await f.db.selectFrom('nodes').selectAll().where('id', '=', 'undo-paper').executeTakeFirstOrThrow();
    const source = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', 'academic').executeTakeFirstOrThrow();
    const target = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', 'parent').executeTakeFirstOrThrow();
    await f.canonical.execute(p => moveCollectionNode(p, { actor: f.actor, command: f.command(), collectionId: 'collection', nodeId: 'undo-paper',
      ifMatch: `"${node.resource_revision}"`, newParentId: 'parent', afterId: null, beforeId: null,
      baseSourceParentRevision: source.children_revision, baseTargetParentRevision: target.children_revision }));
    expect((await app.inject(undoRequest(run))).statusCode).toBe(409);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'undo-paper').executeTakeFirstOrThrow()).parent_id).toBe('parent');
  });
});
