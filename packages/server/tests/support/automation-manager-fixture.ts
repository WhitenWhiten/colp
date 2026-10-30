import { randomUUID } from 'node:crypto';
import { automationRuntimeFixture } from './automation-runtime-fixture.js';
import { createAutomationUnitOfWork } from '../../src/infrastructure/automation/index.js';
import { createAutomationToolPort, createMcpApplicationContext, withAutomationCatalog, type McpApplicationFacade } from '../../src/modules/mcp/index.js';

/** The fixture supplies an admitted manager principal; business operations and
 * command receipts use the real owner-scoped PostgreSQL services. */
export async function automationManagerFixture(prefix: string) {
  const f = await automationRuntimeFixture(prefix, true);
  const context = createMcpApplicationContext({ principal: { kind: 'authenticated', principalId: f.owner.accountId,
    clientId: 'manager', credentialBindingId: 'binding', resourceAudience: 'https://manager.test/collections/-/mcp', securityEpoch: '1' },
    scopes: ['automation:read', 'automation:manage'], abortSignal: new AbortController().signal,
    budgets: { maxDepth: 32, maxNodes: 10000, maxBytes: 1_000_000, maxOperations: 100 }, correlationId: randomUUID(),
    authorization: { accountSubjectId: f.owner.subjectId } });
  const base: McpApplicationFacade = { listTools: async () => ({ tools: [] }),
    callTool: async () => ({ kind: 'rejected', stableCode: 'unknown_tool', safeMessage: 'Unknown tool.', retryable: false }),
    listResources: async () => ({ resources: [] }), listResourceTemplates: async () => ({ resourceTemplates: [] }), readResource: async () => ({ contents: [] }) };
  const api = withAutomationCatalog(base, createAutomationToolPort({ access: async c => c.principal.principalId === f.owner.accountId
    ? { id: 'manager-profile', revision: '1', automationEnabled: true, catalogs: ['automationManager'], pairedTargets: [] } : null,
    configurations: createAutomationUnitOfWork(f.db, 'server', { runtimeEnabled: true, workerEnabled: true }),
    pairing: { pair: async () => { throw Error('Worker pairing is not installed in this manager fixture.'); }, mine: async () => ({ items: [], nextCursor: null }) },
    cursorKey: 'automation-manager-test-cursor-key-at-least-32' }));
  const call = (name: string, args: Readonly<Record<string, unknown>> = {}) => api.callTool(context, name, args);
  const value = async <T>(name: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> => {
    const result = await call(name, args);
    if (result.kind !== 'complete') throw Error(`${name}: ${result.kind === 'rejected' ? result.stableCode : result.kind}`);
    return result.structuredContent as T;
  };
  return { ...f, api, context, call, value };
}
