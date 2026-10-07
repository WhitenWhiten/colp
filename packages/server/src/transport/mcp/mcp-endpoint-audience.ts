/**
 * Signature/issuer/origin checks belong to the OAuth verifier. This final
 * admission check binds its selected resource to the actual registered route,
 * not a Host, forwarded header, client hint or protocol negotiation value.
 */
export function isMcpAudienceForEndpoint(audience: string, registeredPath: unknown): boolean {
  if (registeredPath !== '/collections/-/mcp' && registeredPath !== '/collections/-/mcp-compat') return false;
  try {
    const url = new URL(audience);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === registeredPath;
  } catch { return false; }
}

/** Quota identity only; never use this normalization for OAuth verification. */
export function mcpQuotaResource(audience: string): string {
  if (!isMcpAudienceForEndpoint(audience, '/collections/-/mcp')
    && !isMcpAudienceForEndpoint(audience, '/collections/-/mcp-compat')) {
    throw new TypeError('Invalid MCP quota resource');
  }
  const resource = new URL(audience);
  resource.pathname = '/collections/-/mcp';
  return resource.href;
}
