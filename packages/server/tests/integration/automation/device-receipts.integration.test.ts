import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateAutomation, type LocalReceiptInput } from '@know-n/colp/automation';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';
import { registerAutomationDeviceRoutes } from '../../../src/transport/automation-device-routes.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
describeWithPostgres('canonical device receipt transport', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>, app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    f = await automationDeviceFixture('aw17'); app = Fastify({ exposeHeadRoutes: false }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationDeviceRoutes(app, { unitOfWork: createAutomationDeviceUnitOfWork(f.db, 'server'), credentialVerifier: f.http.verifier,
      allowedOrigins: [AUTOMATION_DEVICE_ORIGIN], allowInsecureLoopback: true });
  });
  afterAll(async () => { await app?.close(); await f?.isolated.close(); });
  const post = (body: unknown, override: Record<string,string> = {}) => app.inject({ method: 'POST', url: '/api/v1/automation-device/intake-receipts', payload: body,
    headers: { authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-session': f.sessionId, 'known-command-id': randomUUID(), ...override } });
  const receipt = (nodeId: string, operationId: string): LocalReceiptInput => {
    const input = { deviceId: f.replica.deviceId, replicaGeneration: Number(f.replica.leaseGeneration), localReceiptId: randomUUID(),
      operationId, ruleId: f.rule.id, ruleRevision: '1', bindingRevision: '1', bundleRevision: '1',
      committedNode: { serverUuid: 'server', collectionId: 'collection', nodeId }, satisfiedTaskTypes: ['classify.root' as const], resultDigests: [placementResultDigest(f.folder)] };
    return { ...input, inputDigest: placementInputDigest(input, { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] }) };
  };
  test('receipt before Sync waits, canonical arrival reconciles once; Sync before receipt converges too', async () => {
    const first = receipt('device-first', 'device-create-first');
    const waiting = await post(first); expect(waiting.statusCode, waiting.body).toBe(202); expect(waiting.json().state).toBe('waitingForSync');
    await f.syncCreate(first.committedNode.nodeId, first.operationId); await f.inspect();
    const accepted = await post(first); expect(accepted.statusCode, accepted.body).toBe(202); expect(accepted.json().state).toBe('accepted');
    expect(validateAutomation('ReceiptIngestResult', accepted.json()).valid).toBe(true);
    const second = receipt('device-second', 'device-create-second'); await f.syncCreate(second.committedNode.nodeId, second.operationId);
    expect((await post(second)).json().state).toBe('accepted'); await f.inspect(); await post(second);
    expect((await sql<{ count: string }>`SELECT count(*) FROM automation_runs WHERE explanation_json->>'nodeId' IN ('device-first','device-second')`.execute(f.db)).rows[0]!.count).toBe('2');
  });
  test('observed create-then-move joins both operations and completes the existing admission once', async () => {
    const input = { ...receipt('observed-paper', 'observed-create'), placementOperationId: 'observed-move',
      beforeFolder: { ...f.folder, nodeId: 'root' } };
    expect((await post(input)).json().state).toBe('waitingForSync');
    await f.syncCreate('observed-paper', 'observed-create', 'root'); await f.inspect();
    expect((await post(input)).json().state).toBe('waitingForSync');
    const moved = await f.syncMove('observed-paper', 'observed-move'); expect(moved.results[0]!.status).toBe('applied');
    await f.inspect(); expect((await post(input)).json().state).toBe('accepted');
    const runs = (await sql<{ state: string }>`SELECT state FROM automation_runs WHERE explanation_json->>'nodeId'='observed-paper'`.execute(f.db)).rows;
    expect(runs).toEqual([{ state: 'completed' }]);
  });
  test('rejects enrichment/native IDs, mismatched canonical identity, stale generations and unauthorized bearer', async () => {
    await f.syncCreate('negative-reference', 'negative-create');
    const input = receipt('negative-reference', 'negative-create');
    expect((await post({ ...input, satisfiedTaskTypes: ['summary.generate'] })).statusCode).toBe(400);
    expect((await post({ ...input, nativeBookmarkId: '123' })).statusCode).toBe(400);
    expect((await post({ ...input, committedNode: { ...input.committedNode, nodeId: 'paper' } })).json().state).toBe('rejected');
    expect((await post({ ...input, localReceiptId: randomUUID(), replicaGeneration: input.replicaGeneration + 1 })).json().state).toBe('rejected');
    expect((await post(input, { authorization: 'Bearer invalid' })).statusCode).toBe(401);
    expect((await post(input, { origin: 'https://foreign.example' })).statusCode).toBe(403);
  });
});
