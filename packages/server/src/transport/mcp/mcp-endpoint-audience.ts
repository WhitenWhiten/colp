/**
 * Signature/issuer/origin checks belong to the OAuth verifier. This final
 * admission check binds its selected resource to the actual registered route
 * and the trusted configured origin. A pathname-only check would let a token
 * minted for a foreign host replay against this endpoint.
 */
function isMcpPath(registeredPath: unknown): registeredPath is '/collections/-/mcp' | '/collections/-/mcp-compat' {
  return registeredPath === '/collections/-/mcp' || registeredPath === '/collections/-/mcp-compat';
}

function parseMcpAudience(audience: string, registeredPath: '/collections/-/mcp' | '/collections/-/mcp-compat'): URL | null {
  try {
    const url = new URL(audience);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || url.pathname !== registeredPath
    ) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Compare a verified audience with a mounted MCP endpoint. The origin is a
 * trusted configured value from MCP feature config, never a Host or forwarded
 * header. URL.origin normalization makes the comparison strict across scheme,
 * host, port (including default-port spelling), and path.
 */
export function isMcpAudienceForEndpoint(
  audience: string,
  registeredPath: unknown,
  registeredOrigin: string,
): boolean {
  if (!isMcpPath(registeredPath)) return false;
  const url = parseMcpAudience(audience, registeredPath);
  if (url === null) return false;
  try {
    const origin = new URL(registeredOrigin);
    if (
      (origin.protocol !== 'https:' && origin.protocol !== 'http:')
      || origin.username !== ''
      || origin.password !== ''
      || origin.pathname !== '/'
      || origin.search !== ''
      || origin.hash !== ''
    ) return false;
    return url.origin === origin.origin;
  } catch {
    return false;
  }
}

/** Quota identity only; never use this normalization for OAuth verification. */
export function mcpQuotaResource(audience: string): string {
  const strict = parseMcpAudience(audience, '/collections/-/mcp');
  const compat = parseMcpAudience(audience, '/collections/-/mcp-compat');
  const resource = strict ?? compat;
  if (resource === null) throw new TypeError('Invalid MCP quota resource');
  resource.pathname = '/collections/-/mcp';
  return resource.href;
}
