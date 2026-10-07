/**
 * Era-neutral MCP application request context (T-01).
 *
 * Token-free: principal, client, scopes, audience, abort, budgets, and
 * correlation id only. Interface files in this family must not import COLP
 * MCP codecs, Fastify, or `@modelcontextprotocol/*` wire types.
 */

export type McpApplicationAnonymousPrincipal = Readonly<{
  readonly kind: 'anonymous';
  readonly principalId: 'public';
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}>;

export type McpApplicationAuthenticatedPrincipal = Readonly<{
  readonly kind: 'authenticated';
  readonly principalId: string;
  readonly clientId: string;
  readonly credentialBindingId: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}>;

export type McpApplicationPrincipal =
  | McpApplicationAnonymousPrincipal
  | McpApplicationAuthenticatedPrincipal;

export interface McpApplicationBudgets {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
  readonly maxOperations: number;
  readonly maxListItems?: number;
  readonly maxReadContents?: number;
  readonly maxTextBytes?: number;
  readonly maxCursorLength?: number;
}

export interface McpApplicationContext {
  readonly principal: McpApplicationPrincipal;
  readonly clientId: string | undefined;
  readonly scopes: readonly string[];
  readonly resourceAudience: string;
  readonly abortSignal: AbortSignal;
  readonly budgets: McpApplicationBudgets;
  readonly correlationId: string;
  /** Opaque host residual; never a bearer token or raw credential. */
  readonly authorization: Readonly<Record<string, unknown>>;
}

export interface McpApplicationContextInput {
  readonly principal: McpApplicationPrincipal;
  readonly scopes: readonly string[];
  readonly abortSignal: AbortSignal;
  readonly budgets: McpApplicationBudgets;
  readonly correlationId: string;
  readonly authorization?: Readonly<Record<string, unknown>>;
}

export function createMcpApplicationContext(
  input: McpApplicationContextInput,
): McpApplicationContext {
  const principal = input.principal;
  const clientId = principal.kind === 'authenticated' ? principal.clientId : undefined;
  return Object.freeze({
    principal,
    clientId,
    scopes: Object.freeze([...input.scopes]),
    resourceAudience: principal.resourceAudience,
    abortSignal: input.abortSignal,
    budgets: Object.freeze({ ...input.budgets }),
    correlationId: input.correlationId,
    authorization: Object.freeze({ ...(input.authorization ?? {}) }),
  });
}
