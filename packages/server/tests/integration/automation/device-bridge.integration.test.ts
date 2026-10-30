import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createDeviceBridgeOwnerPort } from '../../../src/infrastructure/automation/device-bridge-store.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { registerAutomationDeviceRoutes } from '../../../src/transport/automation-device-routes.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import type { WorkPrincipal } from '../../../src/modules/automation/index.js';
import { createDeviceBridgeRunner } from '../../../../extension/src/automation/device-bridge.js';

describeWithPostgres('explicit browser device bridge', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>, app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    f = await automationDeviceFixture('device_bridge'); app = Fastify({ exposeHeadRoutes: false }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationDeviceRoutes(app, { unitOfWork: createAutomationDeviceUnitOfWork(f.db, 'server'), credentialVerifier: f.http.verifier,
      allowedOrigins: [AUTOMATION_DEVICE_ORIGIN], allowInsecureLoopback: true });
  });
  afterAll(async () => { await app?.close(); await f?.isolated.close(); });
  const actor = (): WorkPrincipal => ({ accountId: f.owner.accountId, subjectId: f.owner.subjectId, clientId: 'manager', credentialBindingId: 'binding', scopes: ['automation:read','automation:manage'] });
  const get = () => app.inject({ url: '/api/v1/automation-device/bridge-requests', headers: {
    authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-session': f.sessionId } });
  const complete = (requestId: string) => app.inject({ method: 'POST', url: '/api/v1/automation-device/bridge-results', payload: { requestId, state: 'done', result: { attention: 1 } }, headers: {
    authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-session': f.sessionId, 'known-command-id': randomUUID() } });
  test('device bridge queues explicit replica requests, fences generations and returns durable results under owner authority', async () => {
    const port = createDeviceBridgeOwnerPort(f.db), commandId = randomUUID(), args = { replicaId: f.replica.replicaId, commandId };
    const queued = await port.request(actor(), 'adapters.status', args);
    expect(queued).toMatchObject({ requestId: commandId, state: 'pending', result: null });
    expect(await port.request(actor(), 'adapters.status', args)).toEqual(queued);
    await expect(port.request(actor(), 'classification.diagnostics', args)).rejects.toMatchObject({ code: 'automation_command_conflict' });
    await expect(port.request(actor(), 'adapters.status', { ...args, replicaId: 'foreign', commandId: randomUUID() })).rejects.toMatchObject({ code: 'resource_not_found' });
    const other = await f.issue('foreign');
    await expect(port.get({ ...actor(), accountId: other.accountId, subjectId: other.subjectId }, commandId)).rejects.toMatchObject({ code: 'resource_not_found' });
    const fetched = await get(); expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json()).toMatchObject({ items: [{ id: commandId, replicaId: f.replica.replicaId, operation: 'adapters.status' }] });
    expect((await port.get(actor(), commandId)).state).toBe('running');
    const posted = await complete(commandId); expect(posted.statusCode, posted.body).toBe(200);
    expect(await port.get(actor(),commandId)).toMatchObject({ state: 'done', result: { attention: 1 } });
    expect((await get()).json().items).toEqual([]);
    const stale = await port.request(actor(), 'classification.diagnostics', { ...args, commandId: randomUUID() });
    await sql`UPDATE automation_device_requests SET replica_generation=replica_generation+1 WHERE id=${stale.requestId}`.execute(f.db);
    expect((await get()).json().items).toEqual([]);
    expect((await complete(stale.requestId)).json()).toEqual({ recorded: false });
    await sql`UPDATE automation_device_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${stale.requestId}`.execute(f.db);
    expect((await port.get(actor(), stale.requestId)).state).toBe('expired');
  });

  test('eight oversized cached browser results settle and let the ninth request progress', async () => {
    const port = createDeviceBridgeOwnerPort(f.db), ids: string[] = [], values = new Map<string, unknown>();
    const result = { classificationEnabled: true, counts: { attention: 20, pending: 0, history: 0 }, nextCursor: null,
      items: Array.from({ length: 20 }, () => ({ id: randomUUID(), title: '中'.repeat(512), state: 'attention',
        reason: 'local_key_required', connections: [randomUUID(), randomUUID()], retryable: true })) };
    for (let i = 0; i < 9; i++) {
      const request = await port.request(actor(), 'adapters.jobs', { replicaId: f.replica.replicaId, commandId: randomUUID() });
      ids.push(request.requestId);
      if (i < 8) values.set(`known.automation.device-bridge.v1.request.${request.requestId}`, { requestId: request.requestId, state: 'done', result });
    }
    let executions = 0;
    const run = createDeviceBridgeRunner({ get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } }, {
      authorize: async () => {}, execute: async () => { executions++; return { attention: 0 }; },
      complete: async payload => {
        const response = await app.inject({ method: 'POST', url: '/api/v1/automation-device/bridge-results', payload, headers: {
          authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-session': f.sessionId, 'known-command-id': randomUUID() } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ recorded: true });
        return 'accepted';
      },
    });
    const first = await get(); expect(first.json().items).toHaveLength(8);
    await run(first.json().items); expect(executions).toBe(0);
    for (const id of ids.slice(0, 8)) expect(await port.get(actor(), id)).toMatchObject({ state: 'failed', result: { code: 'device_result_too_large' } });
    const next = await get(); expect(next.json().items.map((r: { id: string }) => r.id)).toEqual([ids[8]]);
    await run(next.json().items); expect(executions).toBe(1);
    expect((await get()).json().items).toEqual([]);
  });
});
