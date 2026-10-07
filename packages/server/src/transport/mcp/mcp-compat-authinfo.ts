/**
 * Secret-safe SDK AuthInfo mapping for the MCP compatibility surface (T-03).
 *
 * `AuthInfo.token` is required by the official SDK. After upstream bearer
 * verification this mapper always writes the non-secret sentinel and never
 * copies Authorization or the raw credential.
 */
import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { McpAuthorizationBinding } from '@know-n/colp/mcp';
import { MCP_COMPAT_AUTH_TOKEN_SENTINEL } from '../../modules/mcp/index.js';

export const MCP_COMPAT_ANONYMOUS_AUTHINFO_CLIENT_ID = 'anonymous';

export type McpCompatKnownBinding = Readonly<{
  readonly kind: McpAuthorizationBinding['kind'];
  readonly principalId: string;
  readonly clientId?: string;
  readonly credentialBindingId?: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}>;

export interface McpCompatAuthInfoInput {
  readonly binding: McpAuthorizationBinding;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
  readonly resourceAudience: string;
}

type NodeRequestWithAuth = IncomingMessage & { auth?: AuthInfo };

export function mapMcpCompatAuthInfo(input: McpCompatAuthInfoInput): AuthInfo {
  const binding = input.binding;
  const knownBinding: McpCompatKnownBinding = binding.kind === 'authenticated'
    ? Object.freeze({
      kind: binding.kind,
      principalId: binding.principalId,
      clientId: binding.clientId,
      credentialBindingId: binding.credentialBindingId,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    })
    : Object.freeze({
      kind: binding.kind,
      principalId: binding.principalId,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    });
  const authInfo: AuthInfo = {
    token: MCP_COMPAT_AUTH_TOKEN_SENTINEL,
    clientId: binding.kind === 'authenticated'
      ? binding.clientId
      : MCP_COMPAT_ANONYMOUS_AUTHINFO_CLIENT_ID,
    scopes: Object.freeze([...input.scopes]) as string[],
    // Preserve the verified endpoint resource, not the shared strict config's default.
    resource: new URL(binding.kind === 'authenticated' ? binding.resourceAudience : input.resourceAudience),
    extra: Object.freeze({ knownBinding }),
  };
  if (input.expiresAt !== undefined) {
    authInfo.expiresAt = Math.floor(input.expiresAt.getTime() / 1_000);
  }
  return Object.freeze(authInfo);
}

export function attachMcpCompatAuthInfo(
  raw: IncomingMessage | object,
  authInfo: AuthInfo,
): void {
  (raw as NodeRequestWithAuth).auth = authInfo;
}
