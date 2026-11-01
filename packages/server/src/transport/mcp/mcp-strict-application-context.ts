/** Translate request identity, authorization and budgets across the strict MCP boundary. */
import {
  resolveMcpResourceReadBudget,
  type Mcp20260728RequestContext,
  type McpAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  createMcpApplicationContext,
  createPhase4bMcpRequestContext,
  type McpApplicationContext,
} from '../../modules/mcp/index.js';

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export function toMcpApplicationContextFromStrict(
  context: Mcp20260728RequestContext,
): McpApplicationContext {
  const binding = context.binding;
  const principal = binding.kind === 'anonymous'
    ? Object.freeze({
      kind: 'anonymous' as const,
      principalId: 'public' as const,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    })
    : Object.freeze({
      kind: 'authenticated' as const,
      principalId: binding.principalId,
      clientId: binding.clientId,
      credentialBindingId: binding.credentialBindingId,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    });
  const requestId = context.authorization.requestId;
  return createMcpApplicationContext({
    principal,
    scopes: context.scope,
    abortSignal: context.abortSignal,
    budgets: resolveMcpResourceReadBudget(context.budget),
    correlationId: typeof requestId === 'string' ? requestId : '',
    authorization: context.authorization,
  });
}

export function toStrictListContext(
  context: McpApplicationContext,
  method: 'tools/list' | 'tools/call',
): Mcp20260728RequestContext {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: method }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method,
      params: Object.freeze({
        _meta: Object.freeze({
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
        }),
      }),
    }),
    binding: bindingFromPrincipal(context.principal),
    scope: context.scopes,
    budget: context.budgets,
    abortSignal: context.abortSignal,
    authorization: context.authorization,
  });
}

export function toStrictCallContext(
  context: McpApplicationContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Mcp20260728RequestContext {
  const collectionId = args.collectionId;
  const headers: Array<{ readonly name: string; readonly value: string }> = [
    Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
    Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
    Object.freeze({ name: 'Mcp-Name', value: name }),
  ];
  if (typeof collectionId === 'string') {
    headers.push(Object.freeze({
      name: 'Mcp-Param-X-Collection-Id',
      value: collectionId,
    }));
  }
  return createPhase4bMcpRequestContext({
    headers: Object.freeze(headers),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
        }),
        name,
        arguments: args,
      }),
    }),
    binding: bindingFromPrincipal(context.principal),
    scope: context.scopes,
    budget: context.budgets,
    abortSignal: context.abortSignal,
    authorization: context.authorization,
  });
}

function bindingFromPrincipal(principal: McpApplicationContext['principal']): McpAuthorizationBinding {
  if (principal.kind === 'anonymous') {
    return Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: principal.resourceAudience,
      securityEpoch: principal.securityEpoch,
    });
  }
  return Object.freeze({
    kind: 'authenticated',
    principalId: principal.principalId,
    clientId: principal.clientId,
    credentialBindingId: principal.credentialBindingId,
    resourceAudience: principal.resourceAudience,
    securityEpoch: principal.securityEpoch,
  });
}
