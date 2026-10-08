/**
 * Startup policy for OIDC issuer / authorization / token / JWKS endpoint URLs.
 *
 * Production (strict): HTTPS only, no userinfo, no private/loopback/link-local
 * hosts, no cloud metadata endpoints.
 *
 * Test-provider mode (relaxed): allows http and private/loopback hosts for
 * local doubles; still rejects userinfo and cloud metadata endpoints.
 *
 * Runtime discovery is verified against config-backed endpoints; discovery can
 * never redirect the application to an unapproved origin.
 */

export type OidcEndpointPolicyMode = 'strict' | 'relaxed';

/** Well-known cloud metadata hostnames that must never be OIDC targets. */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * Validate an OIDC-related absolute URL under the given policy mode.
 * @throws Error with a stable, non-secret message on rejection
 */
export function assertOidcEndpointUrl(
  label: string,
  value: string,
  mode: OidcEndpointPolicyMode,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label} must not contain userinfo`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`${label} must use http or https`);
  }

  if (mode === 'strict' && protocol !== 'https:') {
    throw new Error(`${label} must use https in production policy`);
  }

  const host = normalizeHostname(parsed.hostname);
  if (host === '') {
    throw new Error(`${label} must include a hostname`);
  }

  if (isMetadataHost(host)) {
    throw new Error(`${label} must not target cloud metadata endpoints`);
  }

  if (mode === 'strict' && isPrivateOrLocalHost(host)) {
    throw new Error(`${label} must not target private, loopback, or link-local hosts under production policy`);
  }

  return parsed;
}

export function oidcEndpointPolicyMode(options: {
  readonly nodeEnv: string;
  readonly allowTestProvider: boolean;
}): OidcEndpointPolicyMode {
  // Production always strict. Non-production with test provider may relax for local doubles.
  if (options.nodeEnv === 'production') return 'strict';
  if (options.allowTestProvider) return 'relaxed';
  // Real provider outside production still requires HTTPS / non-private (same as prod).
  return 'strict';
}

/** Parse comma-separated exact origins approved in addition to the issuer origin. */
export function parseOidcAllowedEndpointOrigins(
  value: string | undefined,
  mode: OidcEndpointPolicyMode,
): ReadonlySet<string> {
  const origins = new Set<string>();
  if (!value?.trim()) return origins;

  for (const raw of value.split(',')) {
    const origin = raw.trim();
    if (!origin) continue;
    const parsed = assertOidcEndpointUrl('OIDC_ENDPOINT_ALLOWED_ORIGINS', origin, mode);
    if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('OIDC_ENDPOINT_ALLOWED_ORIGINS entries must be exact origins');
    }
    origins.add(parsed.origin);
  }
  return origins;
}

/** Require every configured provider endpoint to use an explicitly approved origin. */
export function assertOidcEndpointOrigins(input: {
  readonly issuer: URL;
  readonly endpoints: ReadonlyArray<readonly [label: string, url: URL]>;
  readonly additionalAllowedOrigins?: ReadonlySet<string>;
}): void {
  const allowed = new Set<string>([
    input.issuer.origin,
    ...(input.additionalAllowedOrigins ?? []),
  ]);
  for (const [label, endpoint] of input.endpoints) {
    if (!allowed.has(endpoint.origin)) {
      throw new Error(
        `${label} origin must match OIDC_ISSUER or be listed in OIDC_ENDPOINT_ALLOWED_ORIGINS`,
      );
    }
  }
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }

  if (isIpv4Literal(host)) {
    return isPrivateOrLocalIpv4(host);
  }

  if (isIpv6Literal(host)) {
    return isPrivateOrLocalIpv6(host);
  }

  return false;
}

export function isMetadataHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (METADATA_HOSTS.has(host)) return true;
  if (host.endsWith('.metadata.google.internal')) return true;
  // IPv4 link-local metadata well-known address
  if (host === '169.254.169.254') return true;
  // IPv6 metadata common on some clouds
  if (host === 'fd00:ec2::254') return true;
  return false;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // Strip zone id (fe80::1%eth0)
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

function isIpv4Literal(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isIpv6Literal(host: string): boolean {
  return host.includes(':');
}

function isPrivateOrLocalIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // treat malformed as disallowed under strict policy
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateOrLocalIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  // IPv4-mapped IPv6: dotted-quad forms delegate to the IPv4 classifier.
  // Serialized hex forms (e.g. ::ffff:7f00:1 from a URL hostname) must fail
  // closed instead of falling through to the reserved-:: checks below.
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIpv4Literal(mapped)) return isPrivateOrLocalIpv4(mapped);
    return true;
  }
  // Reserved ::/8 beyond :: and ::1 (also catches ::2, compressed forms).
  if (normalized.startsWith('::')) return true;
  // Unique local fc00::/7 and link-local fe80::/10
  const first = expandIpv6FirstHextet(normalized);
  if (first === null || first === 0) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

function expandIpv6FirstHextet(host: string): number | null {
  // Minimal parse: take the first hextet before ':' when not compressed at start.
  if (host.startsWith('::')) {
    // ::1 etc. already handled; other :: forms treated as non-public for safety only
    // when first hextet is empty → 0
    return 0;
  }
  const first = host.split(':', 1)[0];
  if (first === undefined || first === '') return null;
  const value = Number.parseInt(first, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
  return value;
}
