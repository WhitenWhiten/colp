/**
 * COLP-MCP-08: compile-time contract for the Modern request/discovery/result
 * adapter layer.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves:
 *
 * - `Mcp20260728RequestContext` satisfies `McpTrustedReadRequestContext`, so
 *   the adapter context can be handed directly to the protocol-neutral
 *   stateless cores without leaking wire/SDK types into application ports.
 * - `resultType` is the closed `'complete' | 'input_required'` union and
 *   `cacheScope` is `'public' | 'private'`.
 * - The adapter inputs are structural and never reference SDK request,
 *   transport or JSON-RPC types.
 */
import type { McpTrustedReadRequestContext } from '../../src/mcp/shared/resources.js';
import { createAnonymousPublicBinding } from '../../src/mcp/shared/authorization.js';
import type { Mcp20260728RequestContext } from '../../src/mcp/2026-07-28/request-context.js';
import type { Mcp20260728ResultType, Mcp20260728CacheScope } from '../../src/mcp/2026-07-28/results.js';

declare const requestContext: Mcp20260728RequestContext;

// The adapter context IS a trusted shared read context: application cores
// accept it without any Header/JSON-RPC/SDK request/transport type.
export const sharedContext: McpTrustedReadRequestContext = requestContext;

export const protocolFact: '2026-07-28' = requestContext.protocolVersion;

// resultType / cacheScope are closed unions, not arbitrary strings.
declare const resultType: Mcp20260728ResultType;

export function describeResultType(type: Mcp20260728ResultType): string {
  if (type === 'complete') return 'complete';
  return type;
}

// @ts-expect-error 'complete' | 'input_required' is not assignable to 'definitive'
export const badResultType: 'definitive' = resultType;

declare const cacheScope: Mcp20260728CacheScope;
export const publicScope: 'public' | 'private' = cacheScope;

// @ts-expect-error cacheScope is closed to 'public' | 'private'
export const badCacheScope: 'shared' = cacheScope;

// Anonymous public binding remains the only anonymous branch; the adapter
// accepts the generic discriminated union and never the SDK request types.
export const anonBinding = createAnonymousPublicBinding({
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
});

// @ts-expect-error SDK JSON-RPC request objects never cross the adapter boundary
export const sdkRequestInContext: Mcp20260728RequestContext = { method: 'server/discover' };
