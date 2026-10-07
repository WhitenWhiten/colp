/**
 * Registrable-domain ("eTLD+1") comparison for the isolated delivery origin.
 *
 * The isolated delivery origin is session-free (no Known browser session
 * credential is ever accepted there) and must never be same-site
 * with the Known application origin, otherwise browser cookies (including the
 * `__Host-known_session` cookie) could travel to it. The check is intentionally
 * conservative: the same registrable domain is treated as same-site regardless
 * of scheme or port.
 *
 * The registrable domain is computed with `tldts` (pinned to 7.4.10), which
 * ships the full Public Suffix List including private suffixes (github.io,
 * appspot.com, ...) so deployments on any suffix are classified exactly like
 * browsers would. IP addresses and single-label hosts are their own
 * registrable domain. The production startup guard fails closed: when either
 * origin is an IP address or its registrable domain cannot be determined, the
 * origins cannot be proven to be different sites and the guard throws.
 */
import { getDomain } from 'tldts';

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/u, '');
}

/** IPv4 (dotted quad), IPv6 (bracketed or bare) and IP:port forms. */
function isIpLike(host: string): boolean {
  return IPV4_PATTERN.test(host) || host.includes(':');
}

/**
 * Returns the registrable domain (eTLD+1) for a hostname using the full
 * Public Suffix List (private suffixes included), or the host itself for IPs,
 * single-label hosts and unresolvable inputs. Lowercases and strips a
 * trailing dot.
 */
export function registrableDomain(hostname: string): string {
  const host = normalizeHostname(hostname);
  if (host === '') return host;
  if (isIpLike(host)) return host;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/**
 * Fail-closed guard: the isolated delivery origin must not share a registrable
 * domain with the Known application origin (same-site cookie risk). In
 * production, IP addresses and hostnames whose registrable domain cannot be
 * determined cannot be proven to be different sites and therefore fail closed.
 */
export function assertDeliveryOriginNotSameSite(
  appOrigin: string,
  deliveryOrigin: string,
  label: string,
  production = false,
): void {
  const appHost = new URL(appOrigin).hostname;
  const deliveryHost = new URL(deliveryOrigin).hostname;
  if (production) {
    const appRegistrable = registrableDomainOrFailClosed(appHost, label);
    if (appRegistrable === registrableDomainOrFailClosed(deliveryHost, label)) {
      throw new Error(
        `${label} must not be same-site with the Known application origin (registrable domain ${appRegistrable})`,
      );
    }
    return;
  }
  const appRegistrable = registrableDomain(appHost);
  if (appRegistrable === registrableDomain(deliveryHost)) {
    throw new Error(
      `${label} must not be same-site with the Known application origin (registrable domain ${appRegistrable})`,
    );
  }
}

function registrableDomainOrFailClosed(host: string, label: string): string {
  const normalized = normalizeHostname(host);
  if (isIpLike(normalized)) {
    throw new Error(
      `${label} must not use an IP address in production (host ${normalized}): `
      + 'the delivery origin and app origin cannot be proven to be different sites',
    );
  }
  const domain = getDomain(normalized, { allowPrivateDomains: true });
  if (domain === null) {
    throw new Error(
      `${label} must use a resolvable DNS hostname in production: `
      + `cannot determine the registrable domain of ${normalized}`,
    );
  }
  return domain;
}
