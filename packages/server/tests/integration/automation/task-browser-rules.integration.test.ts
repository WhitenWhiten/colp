import { nativeBrowserRuleBridge } from '../../support/native-browser-rule-bridge.js';
import type { BrowserRequest } from '../../../../extension/src/automation/device-bridge.js';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createDeviceBridgeOwnerPort } from '../../../src/infrastructure/automation/device-bridge-store.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { registerAutomationDeviceRoutes } from '../../../src/transport/automation-device-routes.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { createAutomationToolPort, createMcpApplicationContext, withAutomationCatalog, type McpApplicationFacade } from '../../../src/modules/mcp/index.js';
import { hasReplicaReportAuthority, isJoseSyncCredentialRevoked } from '../../../src/infrastructure/sync/index.js';

describeWithPostgres('task-selected MCP browser chain with native Chromium', () => {
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
  const get = () => app.inject({ url: '/api/v1/automation-device/bridge-requests', headers: {
    authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-session': f.sessionId } });
  // This targeted E2E is run through xvfb-run; ordinary database-only suites do not launch a browser.
  test.skipIf(!process.env.DISPLAY)('MCP configure, preview, apply, replay and undo cross the durable bridge into real Chrome bookmarks', async () => {
    const browser = await nativeBrowserRuleBridge();
    try {
      const port = createDeviceBridgeOwnerPort(f.db);
      const base: McpApplicationFacade = { listTools: async () => ({ tools: [] }), callTool: async () => { throw Error('unexpected standard call'); },
        listResources: async () => ({ resources: [] }), listResourceTemplates: async () => ({ resourceTemplates: [] }), readResource: async () => ({ contents: [] }) };
      let selected = true;
      const api = withAutomationCatalog(base,createAutomationToolPort({
        access: async () => ({ id: 'browser-profile',revision: '1',automationEnabled: true,catalogs: ['automationManager'],pairedTargets: [],taskToolsets: selected ? ['browser-rules'] : [] }),
        configurations: { execute: async () => { throw Error('unexpected configuration call'); } },
        pairing: { pair: async () => { throw Error('unexpected pair'); },mine: async () => ({ items: [],nextCursor: null }) },
        cursorKey: 'native-browser-bridge-test-cursor-at-least-32',deviceBridge: port }));
      const context = createMcpApplicationContext({ principal: { kind: 'authenticated',principalId: f.owner.accountId,clientId: 'manager',credentialBindingId: 'binding',
        resourceAudience: 'https://example.test/collections/-/mcp',securityEpoch: '1' },scopes: ['automation:read','automation:manage','nodes:write'],
        abortSignal: new AbortController().signal,budgets: { maxDepth: 32,maxNodes: 10000,maxBytes: 1000000,maxOperations: 100 },
        correlationId: randomUUID(),authorization: { accountSubjectId: f.owner.subjectId } });
      const call = async <T>(name: string, args: Record<string,unknown>) => {
        const result = await api.callTool(context, name, args);
        expect(result.kind, JSON.stringify(result)).toBe('complete');
        return result.kind === 'complete' ? result.structuredContent as T : undefined as never;
      };
      const execute = async <T>(name: string, args: Record<string,unknown> = {}) => {
        const command = { replicaId: f.replica.replicaId, commandId: randomUUID(), ...args };
        const queued = await call<{ requestId: string; state: string }>(name, command);
        expect(queued.state).toBe('pending');
        expect(await call('automation.device_requests.get', { requestId: queued.requestId })).toMatchObject({ state: 'pending' });
        const response = await get();
        expect(response.statusCode, response.body).toBe(200);
        const requests = response.json().items as BrowserRequest[];
        expect(requests.map(request => request.id)).toContain(queued.requestId);
        const results = await browser.run(requests, f.replica.replicaId, 'collection');
        expect(results).toHaveLength(1);
        expect(results[0]!.state, JSON.stringify(results)).toBe('done');
        const completion = await app.inject({ method: 'POST', url: '/api/v1/automation-device/bridge-results', payload: results[0], headers: {
          authorization: f.http.authorization, origin: AUTOMATION_DEVICE_ORIGIN, 'known-sync-session': f.sessionId, 'known-command-id': randomUUID() } });
        expect(completion.json(),completion.body).toEqual({ recorded: true });
        const settled = await call<{ state: string; result: T }>('automation.device_requests.get', { requestId: queued.requestId });
        expect(settled.state).toBe('done');
        return { result: settled.result, command, queued, requests };
      };
      const list = await execute<{ revision: number }>('automation.browser_rules.list');
      const folders = await execute<{ items: { id: string; title: string }[] }>('automation.browser_rules.folders', { parentNativeId: browser.root });
      const destination = folders.result.items.find(folder => folder.title === 'Papers')!.id;
      expect(destination).toBe(browser.destination);
      const configured = await execute<{ ok: boolean }>('automation.browser_rules.configure', { baseRevision: list.result.revision, request: {
        operation: 'save', draft: { name: 'Research papers', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId: destination } } } });
      expect(configured.result.ok).toBe(true);
      const preview = await execute<{ ok: boolean; run: { previewId: string; moves: number } }>('automation.browser_rules.run_preview', { scopeNativeId: browser.inbox });
      expect(preview.result).toMatchObject({ ok: true, run: { moves: 1 } });
      expect(await browser.children(browser.inbox)).toEqual(['Paper','Blog']);
      const applied = await execute<{ ok: boolean; result: { runId: string; moved: number } }>('automation.browser_rules.run_apply', { previewId: preview.result.run.previewId });
      expect(applied.result).toMatchObject({ ok: true, result: { moved: 1 } });
      expect(await browser.children(destination)).toEqual(['Paper']);
      // Server command replay and the browser's durable result journal preserve the same run identity.
      expect(await call('automation.browser_rules.run_apply', applied.command)).toMatchObject({ state: 'done', result: applied.result });
      expect((await browser.run(applied.requests, f.replica.replicaId, 'collection'))[0]!.result).toEqual(applied.result);
      expect((await get()).json().items).toEqual([]);
      const undone = await execute<{ ok: boolean }>('automation.browser_rules.run_undo', { runId: applied.result.result.runId });
      expect(undone.result.ok).toBe(true);
      expect(await browser.children(browser.inbox)).toEqual(['Paper','Blog']);
      expect(await browser.children(destination)).toEqual([]);
      selected = false;
      expect(await api.callTool(context,'automation.browser_rules.run_apply',applied.command)).toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
    } finally { await browser.close(); }
  });
});
