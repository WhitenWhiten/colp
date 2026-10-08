/**
 * Claude Code CIMD registers `http://localhost/callback` (no port) and binds
 * a new ephemeral port each session. Better Auth's RFC 8252 §7.3 matcher
 * ignores port only for IP literals (`127.0.0.0/8`, `[::1]`), so a
 * `localhost:<ephemeral>` request fails exact match.
 *
 * This module expands only the request-local resolved client with the current
 * `redirect_uri` when it is the same loopback host/path/query and differs only
 * by port. The fetched CIMD document and persisted/cacheable client remain
 * canonical, while the authorize redirect still uses the requested URI.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientDiscovery } from '@better-auth/oauth-provider';

const requestedRedirectUriStorage = new AsyncLocalStorage<string>();

export function runWithRequestedRedirectUri<T>(redirectUri: string, work: () => T): T {
  return requestedRedirectUriStorage.run(redirectUri, work);
}

export function requestedRedirectUri(): string | undefined {
  return requestedRedirectUriStorage.getStore();
}

export function redirectUriFromRequestUrl(url: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get('redirect_uri');
    if (value !== null && value.length > 0) return value;
  } catch {
    return undefined;
  }
  return undefined;
}

export function redirectUriFromRequestBody(
  body: Buffer,
  contentType: string,
  source: 'direct' | 'oauth-query',
): string | undefined {
  const value = requestBodyField(body, contentType, source === 'direct' ? 'redirect_uri' : 'oauth_query');
  if (value === undefined) return undefined;
  if (source === 'direct') return value;
  const redirectUri = new URLSearchParams(value).get('redirect_uri');
  return redirectUri !== null && redirectUri.length > 0 ? redirectUri : undefined;
}

export function dispatchBetterAuthWithLoopbackRedirectContext(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  bodyRedirectUri?: string,
): Promise<Response> {
  const redirectUri = redirectUriFromRequestUrl(request.url) ?? bodyRedirectUri;
  if (redirectUri === undefined) return handler(request);
  return runWithRequestedRedirectUri(redirectUri, () => handler(request));
}

export function isLoopbackRedirectHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return isIpv4Loopback(host);
}

export function isLoopbackRedirectPortVariant(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const registeredUrl = parseAbsoluteHttpUrl(registered);
  const requestedUrl = parseAbsoluteHttpUrl(requested);
  if (registeredUrl === undefined || requestedUrl === undefined) return false;
  if (registeredUrl.protocol !== requestedUrl.protocol) return false;
  if (registeredUrl.hostname.toLowerCase() !== requestedUrl.hostname.toLowerCase()) return false;
  if (registeredUrl.pathname !== requestedUrl.pathname) return false;
  if (registeredUrl.search !== requestedUrl.search) return false;
  return isLoopbackRedirectHostname(registeredUrl.hostname);
}

export function expandLoopbackRedirectUris(
  registered: readonly string[],
  requested: string | undefined,
): readonly string[] {
  if (requested === undefined || requested.length === 0) return registered;
  if (registered.includes(requested)) return registered;
  if (!registered.some((uri) => isLoopbackRedirectPortVariant(uri, requested))) return registered;
  return [...registered, requested];
}

/**
 * Decorate CIMD resolution, not its fetch transport. The upstream resolver
 * calls `resolve()` even on a metadata-cache hit when the DB client is owned by
 * CIMD, so every authorize request receives its own ephemeral port without
 * persisting that port or relying on a refetch.
 */
export function wrapCimdClientDiscoveryWithLoopbackRedirectVariance(
  discovery: ClientDiscovery,
): ClientDiscovery {
  return {
    ...discovery,
    async resolve(ctx, clientId, existingClient) {
      const resolved = await discovery.resolve(ctx, clientId, existingClient);
      if (resolved === null) return null;
      const registered = resolved.redirectUris ?? [];
      const expanded = expandLoopbackRedirectUris(registered, requestedRedirectUri());
      if (expanded === registered) return resolved;
      return { ...resolved, redirectUris: [...expanded] };
    },
  };
}

function parseAbsoluteHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function requestBodyField(body: Buffer, contentType: string, field: string): string | undefined {
  if (contentType === 'application/x-www-form-urlencoded') {
    const value = new URLSearchParams(body.toString('utf8')).get(field);
    return value !== null && value.length > 0 ? value : undefined;
  }
  if (contentType !== 'application/json') return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return false;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
    octets.push(octet);
  }
  return octets[0] === 127;
}
