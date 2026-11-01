import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { BindingSet, PreviewResult, Rule } from '@know-n/colp/automation';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresMcpOwnedCollectionReadPort, createPostgresOwnedCollectionsReadPort } from '../../../src/infrastructure/collections/index.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { createProductOwnedCollectionsCursorSigner } from '../../../src/modules/collections/index.js';
import { createAutomationToolPort, createPhase4bMcpReadToolAdapter, createPhase4bMcpResourceIdentity,
  withAutomationCatalog, type AutomationProfileAccess, type McpOauthVerifier } from '../../../src/modules/mcp/index.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import { emptyResourceProjection, emptySnapshotResourceProjection, emptyNodeResourceProjection,
  mcpEnv, modernBody, SERVER_UUID } from '../../support/phase4b-mcp-transport-scaffold.js';
import { compatJsonRpc, injectCompatLegacyPost, injectStrictPost, startCompatApp } from '../../support/phase4b-mcp-compat-admission.js';
import { mcpCompatToolsCallBody, mcpCompatToolsListBody } from '../../support/phase4b-mcp-compat-spike.js';
import { loadConfig } from '../../support/test-config.js';

describeWithPostgres('task-selected rule authoring from discovered folder identities', () => {
  test.each(['strict', 'compat'] as const)('%s discovers paged folders, creates bindings, and enables only a matching preview', async transport => {
    const f = await automationFixture(`task_author_${transport}`);
    const cursors = createProductOwnedCollectionsCursorSigner({ current: { id: 'test', key: 'task-authoring-collection-cursor-secret' } });
    let app: ReturnType<typeof startCompatApp>['app'] | undefined;
    try {
      // There are no bindings or rules. The destination is deliberately after the first snapshot page.
      expect(await f.db.selectFrom('automation_binding_sets').select('id').execute()).toEqual([]);
      await f.createNode('a-paging', 'root', 'Earlier folder');
      for (let i = 0; i < 201; i++) await f.createNode(`filler-${i}`, 'a-paging', `Earlier ${i}`, `https://example.test/${i}`);
      const config = loadConfig(mcpEnv()).mcp!;
      const collectionProjection = emptyResourceProjection(), snapshotProjection = emptySnapshotResourceProjection(), nodeProjection = emptyNodeResourceProjection();
      const read = createPhase4bMcpReadToolAdapter({ collectionProjection, snapshotProjection, nodeProjection, serverUuid: SERVER_UUID,
        ownedRead: createPostgresMcpOwnedCollectionReadPort({ db: f.db, accessPolicy: createPostgresAccessPolicyFactsPort(f.db) }) });
      const base = createPhase4bMcpApplicationFacadeFromColpAdapters({ resourceIdentity: createPhase4bMcpResourceIdentity(config),
        collectionProjection, snapshotProjection, nodeProjection, readToolAdapter: read.adapter,
        ownedCollectionsQuery: { reads: createPostgresOwnedCollectionsReadPort(f.db), cursors, clock: { now: async () => new Date() } } });
      let selection: AutomationProfileAccess['taskToolsets'];
      const facade = withAutomationCatalog(base, createAutomationToolPort({
        access: async () => ({ id: 'profile', revision: '1', automationEnabled: true, catalogs: ['standard','automationManager'], pairedTargets: [], ...(selection === undefined ? {} : { taskToolsets: selection }) }),
        configurations: createAutomationUnitOfWork(f.db, SERVER_UUID, { runtimeEnabled: true }),
        pairing: { pair: async () => { throw Error('unexpected pairing'); }, mine: async () => ({ items: [], nextCursor: null }) },
        cursorKey: 'task-authoring-cursor-secret-at-least-32' }));
      const scopes = ['mcp:read:own','automation:read','automation:manage','nodes:write'];
      const audience = `https://collections.example.test/collections/-/mcp${transport === 'compat' ? '-compat' : ''}`;
      const verifier: McpOauthVerifier = { verify: async () => ({ binding: { kind: 'authenticated', principalId: f.owner.accountId,
        clientId: 'task-agent', credentialBindingId: 'binding', resourceAudience: audience, securityEpoch: '1' },
        accountSubjectId: f.owner.subjectId, scopes, expiresAt: new Date(Date.now()+60_000) } as never) };
      app = startCompatApp({ env: { MCP_OAUTH_SCOPES: scopes.join(',') }, mcpReadTransport: {
        oauthVerifier: verifier, applicationFacade: facade, readToolAdapter: read.adapter, readToolParamDeclarations: read.paramDeclarations } }).app;
      let id = 0;
      const rpc = async (name?: string, args: Record<string,unknown> = {}) => {
        const method = name ? 'tools/call' : 'tools/list';
        const response = transport === 'strict'
          ? await injectStrictPost(app!, method, ++id, { authorization: 'Bearer fixture', ...(name ? { 'mcp-name': name } : {}),
            ...(name?.startsWith('collections.') && typeof args.collectionId === 'string' ? { 'mcp-param-x-collection-id': args.collectionId } : {}) },
          modernBody(method, id, name ? { name, arguments: args } : undefined))
          : await injectCompatLegacyPost(app!, name ? mcpCompatToolsCallBody(name, ++id, args) : mcpCompatToolsListBody(++id), '2025-11-25', { authorization: 'Bearer fixture' });
        expect(response.statusCode, response.payload).toBe(200);
        return transport === 'strict' ? JSON.parse(response.payload) : compatJsonRpc(response);
      };
      const value = async <T>(name: string, args: Record<string,unknown> = {}): Promise<T> => {
        const body = await rpc(name, args);
        expect(body.error, JSON.stringify(body)).toBeUndefined();
        expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
        return body.result.structuredContent as T;
      };
      // Measure the complete mounted read catalog, including collections.list, at identical scopes.
      const sizes: Record<string, { count: number; inputBytes: number }> = {};
      for (const task of [undefined, 'recovery', 'rule-authoring', 'sync-diagnostics', 'browser-rules'] as const) {
        selection = task === undefined ? undefined : [task];
        const tools = (await rpc()).result.tools as { name: string; description: string; inputSchema: unknown }[];
        sizes[task ?? 'unrestricted'] = { count: tools.length, inputBytes: Buffer.byteLength(JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))) };
      }
      console.log('TASK_AUTHORIZED_WIRE_CATALOG', transport, JSON.stringify(sizes));
      expect(sizes.recovery!.inputBytes).toBeLessThan(sizes.unrestricted!.inputBytes * 0.3);
      expect(sizes['sync-diagnostics']!.inputBytes).toBeLessThan(sizes.unrestricted!.inputBytes * 0.3);
      selection = ['rule-authoring'];
      const collections = await value<{ collections: { id: string; title: string }[] }>('collections.list');
      const collectionId = collections.collections.find(item => item.title === 'Automation')!.id;
      let cursor: string | undefined, destination: { id: string; kind: string; title: string } | undefined, pages = 0;
      do {
        const snapshot = await value<{ nodes: { id: string; kind: string; title: string }[]; page: { nextCursor: string | null } }>(
          'collections.get_snapshot', { collectionId, ...(cursor ? { cursor } : {}) });
        destination ??= snapshot.nodes.find(node => node.kind === 'folder' && node.title === 'Academic');
        cursor = snapshot.page.nextCursor ?? undefined;
        pages++;
        expect(pages).toBeLessThan(5);
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(destination).toBeDefined();
      const binding = await value<BindingSet>('automation.bindings.save', { mode: 'create', commandId: randomUUID(), binding: {
        name: 'Discovered destination', values: { academicRoot: { kind: 'folder', folder: { serverUuid: SERVER_UUID, collectionId, nodeId: destination!.id },
          followIdentity: true, onUnavailable: 'block', notifyOn: ['rename','move','delete','permission','syncScope'] } } } });
      const input = { definition: { ...f.rule, scope: { collectionId } }, bindingSetId: binding.id };
      await value('automation.rules.validate', input);
      const saved = await value<Rule>('automation.rules.save', { mode: 'create', rule: input, commandId: randomUUID() });
      const enable = (activationPreviewId?: string) => ({ ruleId: saved.id, baseRevision: saved.revision, commandId: randomUUID(),
        change: { state: 'enabled', pendingRuns: 'hold', reason: 'Enable reviewed configuration', ...(activationPreviewId ? { activationPreviewId } : {}) } });
      expect(JSON.stringify(await rpc('automation.rules.set_state', enable()))).toContain('exact unexpired preview');
      const stale = await value<PreviewResult>('automation.rules.preview', { ruleId: saved.id, rule: input, mode: 'currentState' });
      await value('automation.bindings.save', { mode: 'update', bindingSetId: binding.id, baseRevision: binding.revision,
        commandId: randomUUID(), binding: { name: 'Reviewed binding revision', values: binding.values } });
      expect(JSON.stringify(await rpc('automation.rules.set_state', enable(stale.previewId)))).toContain('Preview again');
      const preview = await value<PreviewResult>('automation.rules.preview', { ruleId: saved.id, rule: input, mode: 'currentState' });
      const command = enable(preview.previewId);
      const enabled = await value<Rule>('automation.rules.set_state', command);
      expect(enabled.desiredState).toBe('enabled');
      expect(await value('automation.rules.set_state', command)).toEqual(enabled);
      selection = [];
      expect(JSON.stringify(await rpc('collections.get_snapshot', { collectionId }))).toMatch(/Unknown tool/i);
    } finally { await app?.close(); cursors.destroy(); await f.isolated.close(); }
  });
});
