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
  /**
   * Admission identity. Caller-controlled `X-Forwarded-For` (surfaced as
   * `transportEvidence.forwardedFor`) is not a host-resolved peer identity:
   * a caller can cycle spoofed values to mint unlimited per-client buckets,
   * target another client's bucket, or omit the value to share one global
   * bucket. Authenticated requests therefore key on the host-verified
   * credential binding, which a caller cannot choose or forge; anonymous
   * requests have no credential identity and use their per-principal bucket.
   */
  const keys = (context: Mcp20260728RequestContext): { principal: string; client: string } => {
    const binding = context.binding;
    if (binding.kind === 'authenticated') {
      return {
        principal: `principal:${binding.principalId}`,
        client: `credential:${JSON.stringify([binding.principalId, binding.credentialBindingId])}`,
      };
    }
    return { principal: 'principal:anonymous', client: 'principal:anonymous' };
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
