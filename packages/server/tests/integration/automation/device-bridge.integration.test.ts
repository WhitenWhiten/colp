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
import { createAutomationToolPort, createMcpApplicationContext, withAutomationCatalog, type McpApplicationFacade } from '../../../src/modules/mcp/index.js';
import { createDeviceBridgeRunner } from '../../../../extension/src/automation/device-bridge.js';
import { replicaReportProofDigest } from '../../../src/infrastructure/sync/replica-report-authority.js';
import { createPostgresProductSyncCenterUnitOfWork, hasReplicaReportAuthority, isJoseSyncCredentialRevoked } from '../../../src/infrastructure/sync/index.js';

describeWithPostgres('explicit browser device bridge', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>, app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    f = await automationDeviceFixture('device_bridge'); app = Fastify({ exposeHeadRoutes: false }); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationDeviceRoutes(app, { unitOfWork: createAutomationDeviceUnitOfWork(f.db, 'server', {
      hasReplicaAuthority: hasReplicaReportAuthority,
      isCredentialRevoked: (tx, credential) => isJoseSyncCredentialRevoked(tx, { issuer: credential.issuer, subject: credential.subject,
        tokenId: credential.credentialId, tokenDigest: credential.credentialDigest,
        issuedAtSeconds: Math.floor(credential.credentialIssuedAt.getTime() / 1000), clockSkewSeconds: 0 }),
    }), credentialVerifier: f.http.verifier,
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
    // Use the selected MCP facade with the real durable bridge and a simulated device completion.
    const base: McpApplicationFacade = { listTools: async () => ({ tools: [] }),callTool: async () => { throw Error('unexpected standard call'); },
      listResources: async () => ({ resources: [] }),listResourceTemplates: async () => ({ resourceTemplates: [] }),readResource: async () => ({ contents: [] }) };
    const api = withAutomationCatalog(base,createAutomationToolPort({
      access: async () => ({ id: 'browser-profile',revision: '1',automationEnabled: true,catalogs: ['automationManager'],pairedTargets: [],taskToolsets: ['browser-rules'] }),
      configurations: { execute: async () => { throw Error('unexpected configuration call'); } },
      pairing: { pair: async () => { throw Error('unexpected pair'); },mine: async () => ({ items: [],nextCursor: null }) },
      cursorKey: 'browser-bridge-test-cursor-at-least-32-bytes',deviceBridge: port }));
    const context = createMcpApplicationContext({ principal: { kind: 'authenticated',principalId: f.owner.accountId,clientId: 'manager',credentialBindingId: 'binding',
      resourceAudience: 'https://example.test/collections/-/mcp',securityEpoch: '1' },scopes: ['automation:read','automation:manage','nodes:write'],
      abortSignal: new AbortController().signal,budgets: { maxDepth: 32,maxNodes: 10000,maxBytes: 1000000,maxOperations: 100 },
      correlationId: randomUUID(),authorization: { accountSubjectId: f.owner.subjectId } });
    const runId = randomUUID();
    const pending = await api.callTool(context,'automation.browser_rules.run_apply',{ replicaId: f.replica.replicaId,commandId: runId,previewId: 'reviewed-preview' });
    expect(pending).toMatchObject({ kind: 'complete',structuredContent: { requestId: runId,state: 'pending' } });
    expect(await api.callTool(context,'automation.device_requests.get',{ requestId: runId })).toMatchObject({ kind: 'complete',structuredContent: { state: 'pending' } });
    const work = await get();expect(work.json().items.map((item: { id: string }) => item.id)).toContain(runId);
    expect((await complete(runId)).statusCode).toBe(200);
    expect(await api.callTool(context,'automation.device_requests.get',{ requestId: runId })).toMatchObject({ kind: 'complete',structuredContent: { state: 'done',result: { attention: 1 } } });
  });

  test('selected Sync diagnostics use the real owner-scoped services without admitting repair writes', async () => {
    const base: McpApplicationFacade = { listTools: async () => ({ tools: [] }),callTool: async () => { throw Error('unexpected standard call'); },
      listResources: async () => ({ resources: [] }),listResourceTemplates: async () => ({ resourceTemplates: [] }),readResource: async () => ({ contents: [] }) };
    const api = withAutomationCatalog(base,createAutomationToolPort({
      access: async () => ({ id: 'profile',revision: '1',automationEnabled: true,catalogs: ['automationManager'],pairedTargets: [],taskToolsets: ['sync-diagnostics'] }),
      configurations: { execute: async () => { throw Error('unexpected configuration call'); } },
      pairing: { pair: async () => { throw Error('unexpected pair'); },mine: async () => ({ items: [],nextCursor: null }) },
      cursorKey: 'sync-diagnostics-cursor-at-least-32-bytes',accountTools: { sync: createPostgresProductSyncCenterUnitOfWork(f.db, {
        cursorSecret: 'sync-diagnostics-cursor-at-least-32-bytes',conflictPayloadKeyring: { active: { key: Buffer.alloc(32,71),keyVersion: 7 },retained: [] } }) } }));
    const context = createMcpApplicationContext({ principal: { kind: 'authenticated',principalId: f.owner.accountId,clientId: 'manager',credentialBindingId: 'binding',
      resourceAudience: 'https://example.test/collections/-/mcp',securityEpoch: '1' },scopes: ['automation:read','automation:manage','mcp:read:own','nodes:write'],
      abortSignal: new AbortController().signal,budgets: { maxDepth: 32,maxNodes: 10000,maxBytes: 1000000,maxOperations: 100 },
      correlationId: randomUUID(),authorization: { accountSubjectId: f.owner.subjectId } });
    for (const [name,args] of [['automation.sync.devices',{}],['automation.sync.status',{}],['automation.sync.issues',{ replicaId: f.replica.replicaId }]] as const) {
      expect(await api.callTool(context,name,args),name).toMatchObject({ kind: 'complete' });
    }
    expect(await api.callTool(context,'automation.sync.retry_issue',{})).toMatchObject({ kind: 'rejected',stableCode: 'unknown_tool' });
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

  test('installation proof authorizes bridge access without a live Sync session or lease renewal', async () => {
    const proof = 'bridge-installation-proof', replicaId = f.replica.replicaId;
    const replica = await f.db.selectFrom('sync_replicas').selectAll().where('replica_id', '=', replicaId).executeTakeFirstOrThrow();
    const account = await f.db.selectFrom('accounts').select('security_epoch').where('id', '=', f.owner.accountId).executeTakeFirstOrThrow();
    await f.db.insertInto('sync_replica_report_authorities').values({ proof_digest: replicaReportProofDigest(proof), replica_id: replicaId,
      account_id: f.owner.accountId, device_id: replica.device_id, browser_profile_id: replica.browser_profile_id,
      browser_generation: replica.browser_generation, credential_issuer: f.http.credential.issuer, oauth_client_id: f.http.credential.clientId,
      account_security_epoch: account.security_epoch, created_at: new Date() }).execute();
    const session = await f.db.selectFrom('sync_sessions').select('expires_at').where('session_id', '=', f.sessionId).executeTakeFirstOrThrow();
    await sql`UPDATE sync_sessions SET status='terminated',termination_reason='administrative',terminated_at=clock_timestamp()
      WHERE session_id=${f.sessionId}`.execute(f.db);
    const request = await createDeviceBridgeOwnerPort(f.db).request(actor(), 'adapters.status', { replicaId, commandId: randomUUID() });
    const read = (replicaProof: string, id = replicaId) => app.inject({ url: '/api/v1/automation-device/bridge-requests', headers: {
      authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-replica-id': id, 'known-sync-replica-proof': replicaProof } });
    expect((await read('wrong-proof')).statusCode).toBe(403);
    expect((await read(proof, 'foreign-replica')).statusCode).toBe(403);
    const response = await read(proof); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.map((r: { id: string }) => r.id)).toContain(request.requestId);
    const completion = await app.inject({ method: 'POST', url: '/api/v1/automation-device/bridge-results',
      payload: { requestId: request.requestId, state: 'done', result: { inspected: true } }, headers: {
        authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-replica-id': replicaId,
        'known-sync-replica-proof': proof, 'known-command-id': randomUUID() } });
    expect(completion.statusCode, completion.body).toBe(200);
    expect(completion.json()).toEqual({ recorded: true });
    expect((await f.db.selectFrom('sync_replicas').select('lease_expires_at').where('replica_id', '=', replicaId).executeTakeFirstOrThrow()).lease_expires_at)
      .toEqual(replica.lease_expires_at);
    expect(await f.db.selectFrom('sync_sessions').select(['status', 'expires_at']).where('session_id', '=', f.sessionId).executeTakeFirstOrThrow())
      .toEqual({ status: 'terminated', expires_at: session.expires_at });
  });
});
