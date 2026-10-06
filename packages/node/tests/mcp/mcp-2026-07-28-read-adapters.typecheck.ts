/**
 * COLP-MCP-09: compile-time contract for the Modern Read adapter layer.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves:
 *
 * - `Mcp20260728RequestContext` is accepted directly by the Modern Resource
 *   and Read Tool adapters without leaking wire/SDK/JSON-RPC types.
 * - The adapter results are `Mcp20260728Result` (`resultType` closed to
 *   `'complete' | 'input_required'`, cacheScope closed to `'public' |
 *   'private'`), so hosts only ever receive the Modern result contract.
 * - The schema budget is a closed set of safe-integer limits and the adapter
 *   never exposes SDK schema instances through its public inputs.
 */
import type { Mcp20260728RequestContext } from '../../src/mcp/2026-07-28/request-context.js';
import type {
  Mcp20260728ResourceAdapter,
  Mcp20260728ResourceAdapterOptions,
} from '../../src/mcp/2026-07-28/resources.js';
import type {
  Mcp20260728ReadToolAdapter,
  Mcp20260728ReadToolAdapterOptions,
} from '../../src/mcp/2026-07-28/tools.js';
import type {
  Mcp20260728CacheScope,
  Mcp20260728Result,
  Mcp20260728ResultType,
  Mcp20260728ServerInfo,
} from '../../src/mcp/2026-07-28/results.js';
import type { McpSchemaBudget } from '../../src/mcp/2026-07-28/schema-budget.js';
import type { McpStatelessReadCore } from '../../src/mcp/shared/resources.js';
import type { McpStatelessToolCore } from '../../src/mcp/shared/tools.js';

declare const requestContext: Mcp20260728RequestContext;
declare const serverInfo: Mcp20260728ServerInfo;
declare const resourceAdapter: Mcp20260728ResourceAdapter;
declare const toolAdapter: Mcp20260728ReadToolAdapter;
declare const readCore: McpStatelessReadCore;
declare const toolCore: McpStatelessToolCore;

// Adapter methods accept the Modern per-request context directly and return
// the Modern result contract.
export const resourceList: Promise<Mcp20260728Result> = resourceAdapter.listResources(requestContext, {});
export const resourceRead: Promise<Mcp20260728Result> = resourceAdapter.readResource(requestContext, { uri: 'x' });
export const resourceTemplates: Promise<Mcp20260728Result> = resourceAdapter.listResourceTemplates(requestContext);
export const toolList: Promise<Mcp20260728Result> = toolAdapter.listTools(requestContext);
export const toolCall: Promise<Mcp20260728Result> = toolAdapter.callTool(requestContext, { name: 'a.b', arguments: {} });

// Adapter options accept the stateless shared cores (never SDK instances).
export const resourceOptions: Mcp20260728ResourceAdapterOptions = { readCore, serverInfo };
export const toolOptions: Mcp20260728ReadToolAdapterOptions = { toolCore, serverInfo };

// resultType / cacheScope stay closed unions on the adapter results.
declare const result: Mcp20260728Result;
export function describeType(type: Mcp20260728ResultType): string {
  if (type === 'complete') return 'complete';
  return type;
}
// @ts-expect-error 'complete' | 'input_required' is not assignable to 'definitive'
export const badResultType: 'definitive' = result.resultType;

declare const scope: Mcp20260728CacheScope;
export const scopes: 'public' | 'private' = scope;
// @ts-expect-error cacheScope is closed to 'public' | 'private'
export const badScope: 'shared' = scope;

// Schema budget is a closed set of optional safe-integer limits.
declare const budget: McpSchemaBudget;
export const depth: number | undefined = budget.maxDepth;
// @ts-expect-error schema budget has no maxFrobnication field
export const badBudgetField: unknown = budget.maxFrobnication;

// @ts-expect-error SDK JSON-RPC request objects never cross the adapter boundary
resourceAdapter.listResources({ method: 'resources/list' }, {});
// @ts-expect-error SDK JSON-RPC request objects never cross the adapter boundary
toolAdapter.callTool({ method: 'tools/call' }, { name: 'a.b' });
