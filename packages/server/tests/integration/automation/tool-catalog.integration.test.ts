import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationWorkPrincipal,createMcpApplicationContext,withAutomationCatalog,
  type McpApplicationFacade,type McpApplicationContext } from '../../../src/modules/mcp/index.js';
import { encodeStrictToolList } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';

// The sentinel exercises catalog delegation only. No business operation is represented as successful.
const standardTool = { name: 'nodes.get',description: 'Standard catalog sentinel',requiredScopes: ['mcp:read:own'],inputSchema: { type: 'object' },outputSchema: { type: 'object' } };
const base: McpApplicationFacade = {
  listTools: async () => ({ tools: [standardTool] }),
  callTool: async () => ({ kind: 'rejected',stableCode: 'sentinel',safeMessage: 'Catalog fixture only.',retryable: false }),
  listResources: async () => ({ resources: [{ uri: 'test:standard',name: 'standard' }] }),
  listResourceTemplates: async () => ({ resourceTemplates: [] }),
  readResource: async () => ({ contents: [] }),
};

describeWithPostgres('AW-30 current conditional Automation catalogs',() => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });
  async function context(token = f.token): Promise<McpApplicationContext> {
    const verified = await f.verifier.verify({ authorization: 'Bearer '+token });
    const b = verified.binding;
    if (b.kind !== 'authenticated') throw new Error('Expected real authenticated fixture');
    return createMcpApplicationContext({ principal: b,scopes: verified.scopes,abortSignal: new AbortController().signal,
      budgets: { maxDepth: 16,maxNodes: 1000,maxBytes: 100000,maxOperations: 100 },correlationId: randomUUID(),
      authorization: { accountSubjectId: verified.accountSubjectId,automationCredential: { credentialDigest: verified.credentialDigest,connectionId: verified.automationConnectionId,
        expiresAt: verified.expiresAt.toISOString(),issuedAtSeconds: verified.issuedAtSeconds,accountSecurityEpoch: verified.accountSecurityEpoch } } });
  }
  function facade() { return withAutomationCatalog(base,{
    access: c => c.principal.kind === 'anonymous' ? Promise.resolve(null) : f.worker.access(automationWorkPrincipal(c)),
    call: async () => ({ kind: 'rejected',stableCode: 'automation_unsupported_capability',safeMessage: 'Business dispatcher not installed in this catalog fixture.',retryable: false }),
  }); }
  test('ordinary catalog is unchanged; worker bootstrap, pairing and revoke change list/get/call together',async () => {
    f = await automationWorkerFixture('aw30_worker');const c = await context(),api = facade();
    expect(await api.listTools(c)).toEqual(await base.listTools(c));
    const s = await f.setup(),before = await api.listTools(c);
    expect(before.tools.map(t => t.name)).toEqual(['automation.targets.pair']);
    expect(await api.getTool!(c,'automation.jobs.list')).toBeUndefined();
    expect(await api.callTool(c,'automation.jobs.list',{})).toMatchObject({ stableCode: 'unknown_tool' });
    expect(await api.callTool(c,'nodes.get',{})).toMatchObject({ stableCode: 'unknown_tool' });
    expect(await api.listResources(c)).toEqual({ resources: [] });
    await expect(api.readResource(c,'test:standard')).rejects.toThrow('Invalid Resource URI.');
    expect((await f.pair(s.grant)).statusCode).toBe(200);
    const after = await api.listTools(c);
    expect(after.tools.map(t => t.name).sort()).toEqual(['automation.targets.pair','automation.jobs.list','automation.jobs.get','automation.jobs.inputs',
      'automation.jobs.claim','automation.jobs.heartbeat','automation.jobs.submit','automation.jobs.fail'].sort());
    expect(after.cacheKey).not.toBe(before.cacheKey);
    for (const tool of after.tools) expect((await api.getTool!(c,tool.name))?.inputSchema).toEqual(tool.inputSchema);
    expect(await api.callTool(c,'automation.jobs.list',{})).toMatchObject({ stableCode: 'automation_unsupported_capability' });
    expect(await api.callTool(c,'automation.jobs.list',{ foreign: true })).toMatchObject({ stableCode: 'invalid_arguments' });
    expect(await api.callTool(c,'automation.jobs.claim',{ jobId: 'job',commandId: 'not-uuid',request: {} })).toMatchObject({ stableCode: 'invalid_arguments' });
    await f.revocations.revokeClient(f.actor.clientId);
    expect((await api.listTools(c)).tools).toEqual([]);
    expect(await api.getTool!(c,'automation.jobs.list')).toBeUndefined();
    expect(await api.callTool(c,'automation.jobs.list',{})).toMatchObject({ stableCode: 'unknown_tool' });
  });
  test('explicit combined catalogs still require each scope and current binding; no global catalog cache',async () => {
    f = await automationWorkerFixture('aw30_combined',100,true);const s = await f.setup();
    const update = await f.app.inject({ method: 'PUT',url: `/api/v1/me/automations/connection-profiles/${s.profile.id}`,
      headers: f.ownerHeaders(randomUUID(),`"${s.profile.revision}"`),payload: { ...s.profile.configuration,catalogs: ['standard','automationWorker','automationManager'] } });
    expect(update.statusCode,update.body).toBe(200);
    const target = await f.app.inject({ url: `/api/v1/me/automations/targets/${s.target.id}`,headers: { cookie: f.owner.cookie } });
    const grant = await f.ownerPost(`/targets/${s.target.id}/pairings`,{ reason: 'Pair combined catalog' },String(target.headers.etag));
    expect(grant.statusCode,grant.body).toBe(201);expect((await f.pair(grant.json())).statusCode).toBe(200);
    const api = facade(),worker = await context(),all = await context(await f.mint({ scopes: ['automation:work','automation:read','automation:manage','mcp:read:own'] }));
    const listed = await api.listTools(all);expect(listed.tools).toHaveLength(16);
    expect((await api.listTools(worker)).tools.filter(t => t.name.startsWith('automation.rules.'))).toEqual([]);
    expect(await api.callTool(worker,'automation.rules.describe',{})).toMatchObject({ stableCode: 'unknown_tool' });
    expect(await api.getTool!(all,'automation.rules.describe')).toBeTruthy();
    expect(await api.callTool(all,'automation.rules.describe',{})).toMatchObject({ stableCode: 'automation_unsupported_capability' });
    expect(listed.cacheKey).not.toBe((await api.listTools(worker)).cacheKey);
    const manager = await context(await f.mint({ scopes: ['automation:read','automation:manage'] }));
    expect((await api.listTools(manager)).tools.filter(t => t.name.startsWith('automation.'))).toHaveLength(7);
    expect(await api.callTool(manager,'automation.jobs.list',{})).toMatchObject({ stableCode: 'unknown_tool' });
    await f.revokeWorker();
    expect((await api.listTools(all)).tools).toEqual([]);
  });
  test('dynamic strict catalogs have private zero TTL while ordinary catalogs retain their frozen cache contract',async () => {
    const dynamic = encodeStrictToolList([],false,true),ordinary = encodeStrictToolList([],false);
    expect(JSON.stringify(dynamic)).toContain('"ttlMs":0');
    expect(JSON.stringify(dynamic)).toContain('"cacheScope":"private"');
    expect(JSON.stringify(ordinary)).not.toContain('"ttlMs":0');
  });
});
