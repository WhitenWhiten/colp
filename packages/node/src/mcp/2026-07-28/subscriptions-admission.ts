import type { Mcp20260728RequestContext } from './request-context.js';

export type McpListenAdmissionFailure = 'aggregate' | 'principal' | 'client';
export type McpListenAdmissionResult = (() => void) | McpListenAdmissionFailure;

/** Process-wide admission buckets shared by every stream from one adapter. */
export function createMcpListenAdmission(
  maxSessions: number,
  maxSessionsPerPrincipal: number,
  maxSessionsPerClient: number,
): { readonly acquire: (context: Mcp20260728RequestContext) => McpListenAdmissionResult } {
  let active = 0;
  const principals = new Map<string, number>();
  const clients = new Map<string, number>();
  const keys = (context: Mcp20260728RequestContext): { principal: string; client: string } => {
    const binding = context.binding;
    const principal = binding.kind === 'authenticated'
      ? `${binding.principalId}\u0000${binding.clientId}\u0000${binding.credentialBindingId}`
      : 'anonymous';
    const forwarded = context.transportEvidence.forwardedFor;
    return { principal, client: forwarded !== undefined && forwarded.length > 0 ? forwarded[0]! : 'unknown' };
  };
  const adjust = (map: Map<string, number>, key: string, delta: 1 | -1): void => {
    const count = (map.get(key) ?? 0) + delta;
    if (count <= 0) map.delete(key);
    else map.set(key, count);
  };
  return Object.freeze({
    acquire(context) {
      const key = keys(context);
      if (active >= maxSessions) return 'aggregate';
      if ((principals.get(key.principal) ?? 0) >= maxSessionsPerPrincipal) return 'principal';
      if ((clients.get(key.client) ?? 0) >= maxSessionsPerClient) return 'client';
      active += 1;
      adjust(principals, key.principal, 1);
      adjust(clients, key.client, 1);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        active -= 1;
        adjust(principals, key.principal, -1);
        adjust(clients, key.client, -1);
      };
    },
  });
}
