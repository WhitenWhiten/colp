/**
 * P4B-R05 stateless MCP `2026-07-28` request context composition.
 *
 * This module is the host boundary for COLP-MCP-08's `mcp-request-candidate`.
 * It delegates wire/header/envelope validation to
 * `createMcp20260728RequestContext`, rejects legacy JSON-RPC methods before
 * they can be treated as Modern, and optionally pins the trusted binding to
 * the current resource audience/security epoch. Every successful call returns
 * a fresh frozen context; no request state is retained in this process.
 */
import {
  MCP_PROTOCOL_VERSION,
  Mcp20260728RequestError,
  assertBindingMatchesResourceAudience,
  assertBindingMatchesSecurityEpoch,
  createMcp20260728RequestContext,
  mayEmitMcp20260728LogNotification,
  parseMcp20260728RequestHeaders,
  requireMcp20260728ClientCapability,
  scanMcp20260728XMcpHeaderDeclarations,
  supportedMcpProtocolVersions,
  validateMcp20260728ParamHeaders,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
} from '@know-n/colp/mcp';

export { Mcp20260728RequestError };
export { parseMcp20260728RequestHeaders as parsePhase4bMcpRequestHeaders };
export { mayEmitMcp20260728LogNotification as mayEmitPhase4bMcpLogNotification };
export { requireMcp20260728ClientCapability as requirePhase4bMcpClientCapability };
export { scanMcp20260728XMcpHeaderDeclarations as scanPhase4bMcpParamHeaders };
export type {
  Mcp20260728HeaderField,
  Mcp20260728RequestContext,
  Mcp20260728RequestContextInput,
  Mcp20260728WireErrorKind,
  Mcp20260728XMcpHeaderDeclaration,
  Mcp20260728XMcpHeaderScanResult,
} from '@know-n/colp/mcp';

/**
 * Legacy MCP JSON-RPC methods that must never reach a Modern handler
 * (migration decision §6.2, §6.5 and §6.9).
 */
export const PHASE4B_MCP_LEGACY_BODY_METHODS: readonly string[] = Object.freeze([
  'initialize',
  'notifications/initialized',
  'resources/subscribe',
  'resources/unsubscribe',
  'logging/setLevel',
  'ping',
  'notifications/roots/list_changed',
  'tasks/cancel',
  'tasks/get',
  'tasks/list',
  'tasks/update',
  'notifications/tasks/list_changed',
]);

/** True for any body method that belongs to the rejected legacy surface. */
export function isPhase4bMcpLegacyBodyMethod(method: string): boolean {
  return PHASE4B_MCP_LEGACY_BODY_METHODS.includes(method);
}

export interface Phase4bMcpRequestContextOptions {
  /** When set, reject a binding whose resource audience differs. */
  readonly expectedResourceAudience?: string;
  /** When set, reject a binding whose current security epoch differs. */
  readonly expectedSecurityEpoch?: string;
}

function readLegacyMethod(input: Mcp20260728RequestContextInput): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const body = (input as { readonly body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return undefined;
  const method = (body as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

/**
 * Builds one frozen per-request context from real host inputs. Legacy method
 * rejection happens before delegation so a Modern envelope cannot smuggle an
 * old lifecycle/subscription/logging/tasks call through COLP.
 */
export function createPhase4bMcpRequestContext(
  input: Mcp20260728RequestContextInput,
  options: Phase4bMcpRequestContextOptions = {},
): Mcp20260728RequestContext {
  const method = readLegacyMethod(input);
  if (method !== undefined && isPhase4bMcpLegacyBodyMethod(method)) {
    throw new Mcp20260728RequestError(
      'unsupported_protocol_version',
      `Legacy MCP method '${method}' is not supported by protocol version ${MCP_PROTOCOL_VERSION}.`,
      { supported: supportedMcpProtocolVersions, method },
    );
  }

  const context = createMcp20260728RequestContext(input);
  if (input.paramDeclarations !== undefined) {
    // COLP's context adapter validates declared Mcp-Param-* headers against
    // body.params, while tool declarations are paths inside body.params
    // .arguments. Reuse its exported validator for that final body comparison.
    validateMcp20260728ParamHeaders(
      input.paramDeclarations,
      input.body.params?.arguments,
      parseMcp20260728RequestHeaders(input.headers).params,
    );
  }
  if (options.expectedResourceAudience !== undefined) {
    assertBindingMatchesResourceAudience(context.binding, options.expectedResourceAudience);
  }
  if (options.expectedSecurityEpoch !== undefined) {
    assertBindingMatchesSecurityEpoch(context.binding, options.expectedSecurityEpoch);
  }
  return context;
}
