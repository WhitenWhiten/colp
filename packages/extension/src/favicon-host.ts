const RESERVED_SUFFIXES = [
  '.local', '.localhost', '.internal', '.corp', '.home', '.lan', '.intranet',
] as const;
const INTEGER_IPV4 = /^(?:0|[1-9]\d{0,9})$/;
const HEX_IPV4 = /^0x[0-9a-f]{1,8}$/i;
const IPV4_OCTET = /^(?:0|[1-9]\d*|0[0-7]+|0x[0-9a-f]+)$/i;

/** Fail-closed copy of the BF-05 web host predicate. Do not import the frontend package. */
export function isBookmarkHostAllowedForAutoUpload(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname;
    if (!hostname) return false;
    if (isLiteralIpHostname(hostname)) return false;
    if (isReservedHotlinkHost(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

function isLiteralIpHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname);
  if (host.includes(':')) return true;
  if (INTEGER_IPV4.test(host)) {
    const value = Number(host);
    if (Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff) return true;
  }
  if (HEX_IPV4.test(host)) return true;
  const parts = host.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((part) => IPV4_OCTET.test(part))) return true;
  return false;
}

function isReservedHotlinkHost(hostname: string): boolean {
  const folded = hostname.replace(/\.+$/u, '').toLowerCase();
  if (!folded || folded === 'localhost') return true;
  return RESERVED_SUFFIXES.some((suffix) => folded.endsWith(suffix));
}
