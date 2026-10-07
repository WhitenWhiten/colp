/**
 * Hostname/IP-literal classification for local/private destinations. Callers
 * that perform DNS resolution should also pass each resulting address through
 * {@link isPrivateOrLocalAddress}; the classifier is deliberately free of
 * network I/O so it remains usable in browser and custom-fetch builds.
 *
 * Pure hostname / IP-literal classification for localhost, RFC1918, CGNAT,
 * link-local, unspecified, and common IPv6 private/local forms. No DNS or
 * network I/O. Non-literal names other than localhost forms are not blocked.
 */

function tryParseIPv4Literal(host: string): readonly [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function isPrivateOrLocalIPv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  // 0.0.0.0/8 (unspecified / this network), 127.0.0.0/8 loopback
  if (a === 0 || a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 shared address space (CGNAT / carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 protocol assignments and TEST-NET-1 (192.0.2.0/24).
  if (a === 192 && b === 0) return true;
  // TEST-NET-1/2/3 and deprecated 6to4 relay anycast. These are not
  // globally reachable destinations and must not be used as an SSRF escape.
  if (a === 192 && b === 88 && octets[2] === 99) return true;
  if (a === 198 && b === 51 && octets[2] === 100) return true;
  if (a === 203 && b === 0 && octets[2] === 113) return true;
  // Benchmarking (RFC 2544) is reserved for test networks.
  if (a === 198 && (b === 18 || b === 19)) return true;
  // Multicast (224/4), reserved/future use (240/4), and limited broadcast.
  if (a >= 224) return true;
  return false;
}

/**
 * Single-number IPv4 host forms some stacks accept (decimal or 0x-hex).
 * Example: `2130706433` / `0x7f000001` → 127.0.0.1. No DNS.
 */
function tryParseIPv4SingleNumberLiteral(
  host: string,
): readonly [number, number, number, number] | null {
  let value: number | null = null;
  if (/^(?:0|[1-9]\d{0,9})$/u.test(host)) {
    value = Number(host);
  } else if (/^0x[0-9a-f]{1,8}$/iu.test(host)) {
    value = Number.parseInt(host, 16);
  }
  if (value === null || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    return null;
  }
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function expandIPv6Hextets(host: string): Uint16Array | null {
  let s = host.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  // Convert IPv4 tail (e.g. ::ffff:192.0.2.1) into two hextets.
  const v4Tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4Tail !== null) {
    const octets = tryParseIPv4Literal(v4Tail[2]!);
    if (octets === null) return null;
    s = `${v4Tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if (s.includes('.')) return null;

  const sides = s.split('::');
  if (sides.length > 2) return null;

  const parseSide = (side: string | undefined): string[] | null => {
    if (side === undefined || side === '') return [];
    const parts = side.split(':');
    return parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part)) ? parts : null;
  };

  const head = parseSide(sides[0]);
  if (head === null) return null;
  const tail = sides.length === 1 ? [] : parseSide(sides[1]);
  if (tail === null) return null;

  let parts: string[];
  if (sides.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    parts = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  }

  const out = new Uint16Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number.parseInt(parts[i]!, 16);
  }
  return out;
}

function isPrivateOrLocalIPv6(hextets: Uint16Array): boolean {
  const isZeroPrefix = (n: number): boolean => {
    for (let i = 0; i < n; i += 1) {
      if (hextets[i] !== 0) return false;
    }
    return true;
  };

  // :: (unspecified) and ::1 (loopback)
  if (isZeroPrefix(8)) return true;
  if (isZeroPrefix(7) && hextets[7] === 1) return true;

  // IPv4-mapped ::ffff:0:0/96 — re-check embedded IPv4 as private/local
  if (isZeroPrefix(5) && hextets[5] === 0xffff) {
    const a = hextets[6]! >> 8;
    const b = hextets[6]! & 0xff;
    const c = hextets[7]! >> 8;
    const d = hextets[7]! & 0xff;
    return isPrivateOrLocalIPv4([a, b, c, d]);
  }

  // fe80::/10 link-local
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique local (ULA)
  if ((hextets[0]! & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast and IPv6 special-use non-global ranges.
  if ((hextets[0]! & 0xff00) === 0xff00) return true;
  // IPv6 discard-only, benchmarking, documentation, and ORCHID ranges.
  if (hextets[0] === 0x0100 && hextets[1] === 0) return true; // 100::/64
  if (hextets[0] === 0x2001 && hextets[1] === 0x0002 && hextets[2] === 0) return true; // 2001:2::/48
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true; // 2001:db8::/32
  if (hextets[0] === 0x2001 && (hextets[1]! & 0xfff0) === 0x0010) return true; // 2001:10::/28

  return false;
}

/**
 * True for `localhost` / `*.localhost`, RFC1918, CGNAT `100.64.0.0/10`,
 * link-local (including `169.254.169.254`), unspecified, decimal/`0x`-hex
 * single-number IPv4 forms of those ranges, IPv6 loopback/ULA/link-local, and
 * IPv4-mapped equivalents. Non-literal hostnames are not classified here;
 * callers that resolve DNS answers should use {@link isPrivateOrLocalAddress}.
 */
export function isPrivateOrLocalLiteralHostname(hostname: string): boolean {
  // WHATWG hostnames are already ASCII-lowercased for domain names; normalize
  // trailing dots and compare without DNS resolution.
  const host = hostname.replace(/\.+$/u, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipv4 = tryParseIPv4Literal(host);
  if (ipv4 !== null) return isPrivateOrLocalIPv4(ipv4);

  const singleNumber = tryParseIPv4SingleNumberLiteral(host);
  if (singleNumber !== null) return isPrivateOrLocalIPv4(singleNumber);

  // WHATWG URL.hostname may keep brackets around IPv6 literals (Node); strip them.
  const ipv6Host = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (ipv6Host.includes(':')) {
    const hextets = expandIPv6Hextets(ipv6Host);
    if (hextets !== null) return isPrivateOrLocalIPv6(hextets);
  }

  return false;
}

/**
 * Classifies one address returned by a DNS resolver (or an address literal).
 * DNS answers are represented without URL brackets, while callers may also
 * pass a URL hostname with brackets, so use the same literal parser for both.
 */
export function isPrivateOrLocalAddress(address: string): boolean {
  return isPrivateOrLocalLiteralHostname(address);
}
