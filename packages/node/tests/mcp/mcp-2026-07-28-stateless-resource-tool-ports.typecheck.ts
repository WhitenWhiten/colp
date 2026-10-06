/**
 * COLP-MCP-07: compile-time rejection of the removed Session-oriented MCP
 * Resource Server API and compile-time absence of wire/session fields on the
 * new stateless shared ports.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves:
 * - `createMcpReadResourceServer` / `McpReadResourceServerSession` /
 *   `subscribeResource` / `unsubscribeResource` (and the gateway aliases)
 *   no longer exist on the public boundary;
 * - the new trusted read request context has no `sessionId`;
 * - the stateless shared ports carry no wire/transport types.
 */
import type {
  McpResourceProjectionPort,
  McpStatelessReadCore,
  McpTrustedReadRequestContext,
} from '../../src/mcp/shared/resources.js';
import type {
  McpStatelessToolCore,
  McpToolExecutionPort,
} from '../../src/mcp/shared/tools.js';
import type { McpAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import type { McpReadResource } from '../../src/mcp/resource-uri.js';

// --- Removed per-Session Resource Server factory and aliases -----------------
// @ts-expect-error createMcpReadResourceServer was removed in COLP-MCP-07
export const oldFactory = createMcpReadResourceServer;
// @ts-expect-error createMcpReadResourceGateway was removed in COLP-MCP-07
export const oldGatewayAlias = createMcpReadResourceGateway;
// @ts-expect-error createMcpResourceServer was removed in COLP-MCP-07
export const oldServerAlias = createMcpResourceServer;
// @ts-expect-error McpReadResourceServerSession was removed in COLP-MCP-07
export const oldSession: McpReadResourceServerSession = { sessionId: 'session-a' };
// @ts-expect-error McpReadResourceServer was removed in COLP-MCP-07
export const oldServer: McpReadResourceServer = null as never;
// @ts-expect-error McpReadResourceApplicationServicePort was removed in COLP-MCP-07
export const oldPort: McpReadResourceApplicationServicePort = null as never;
// @ts-expect-error McpResourceNotificationSink was removed in COLP-MCP-07
export const oldSink: McpResourceNotificationSink = null as never;
// @ts-expect-error McpResourceServerError was removed in COLP-MCP-07
export const oldError: McpResourceServerError = null as never;
// @ts-expect-error McpSubscriptionAuthorization was removed in COLP-MCP-07
export const oldSubscription: McpSubscriptionAuthorization = null as never;

// --- Removed subscription methods -------------------------------------------
export interface LegacyServerSurface {
  readonly subscribeResource: (input: unknown) => Promise<unknown>;
  readonly unsubscribeResource: (input: unknown) => Promise<unknown>;
}

// @ts-expect-error McpStatelessReadCore must not expose subscribeResource
export const subscribe: McpStatelessReadCore['subscribeResource'] = null as never;
// @ts-expect-error McpStatelessReadCore must not expose unsubscribeResource
export const unsubscribe: McpStatelessReadCore['unsubscribeResource'] = null as never;
// @ts-expect-error McpStatelessReadCore must not echo a sessionId
export const sessionEcho: McpStatelessReadCore['sessionId'] = null as never;

// --- Trusted read context carries no Session / wire fields -------------------
export const trustedContext: McpTrustedReadRequestContext = {
  binding: null as never,
  scope: Object.freeze(['collections:read']),
  budget: Object.freeze({}),
  abortSignal: new AbortController().signal,
  authorization: Object.freeze({}),
};

// @ts-expect-error the trusted read context has no sessionId
export const sessionOnContext = trustedContext.sessionId;
// @ts-expect-error the trusted read context has no headers
export const headersOnContext = trustedContext.headers;
// @ts-expect-error the trusted read context has no request/transport object
export const requestOnContext = trustedContext.request;

// --- Stateless shared ports expose only protocol-neutral members ------------
export const projectionPort: McpResourceProjectionPort = {
  listResources: () => ({ resources: Object.freeze([]) }),
  readResource: () => ({ contents: Object.freeze([]) }),
};
// @ts-expect-error the projection port must not expose a Session-shaped method
export const subscribeOnPort = projectionPort.subscribeResource;
// @ts-expect-error the projection port must not expose a wire method
export const jsonRpcOnPort = projectionPort.notificationsResourcesUpdated;

export const toolExecutionPort: McpToolExecutionPort = {
  invoke: () => ({ structuredContent: null }),
};
// @ts-expect-error the tool execution port must not expose a wire method
export const wireOnToolPort = toolExecutionPort.call;

export const readCore: McpStatelessReadCore = null as never;
// @ts-expect-error the stateless core is not a per-session factory
export const perSession = readCore.createForSession;

export const toolCore: McpStatelessToolCore = null as never;
// @ts-expect-error the stateless tool core must not accept a session binding
export const sessionToolCall = toolCore.callTool(null as never, 'collections.get', {}, { sessionId: 'x' });

export const resourceInput: McpReadResource = null as never;
// @ts-expect-error McpReadResource must not carry a sessionId
export const resourceSession = resourceInput.sessionId;

export const binding: McpAuthorizationBinding = null as never;
// @ts-expect-error authenticated-only fields are not visible on the union
export const untrustedClientId = binding.clientId;

// --- COLP Sync Session remains untouched (non-collateral) --------------------
import type { SyncSessionBinding } from '../../src/sync/session.js';

export const syncSessionBinding: SyncSessionBinding = {
  principal: { type: 'user', id: 'principal-1' },
  credential: { kind: 'token', id: 'token-id-1' },
  oauthClientId: null,
  origin: null,
  sessionScope: 'collection',
  protocolVersion: '0.1',
  collectionId: 'collection-1',
  purpose: null,
};

// The MCP trusted read context must never be assignable to a Sync Session binding.
// @ts-expect-error MCP trusted read context is not a Sync Session binding
export const syncFromRead: SyncSessionBinding = trustedContext;
