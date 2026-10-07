/**
 * FIX-M-006 trusted-ingress allowlist parser (PUB-R03).
 *
 * Production must declare the reverse-proxy ingress EXPLICITLY as CIDRs or
 * exact addresses (`TRUSTED_INGRESS`) instead of a numeric hop count: only a
 * socket peer inside this allowlist can contribute `X-Forwarded-For` entries
 * to `request.ip` (Fastify trust function over the compiled subnet list), so
 * a client cannot spoof a forwarded address to an API that is directly
 * reachable, and multi-level proxy chains resolve when EVERY hop is inside
 * the allowlist. An explicit empty value is peer-only (`trustProxy: false`)
 * and never falls back to `TRUSTED_PROXY_HOPS`. Production refuses
 * `TRUSTED_PROXY_HOPS > 0` at config load; hop-count is non-production only.
 *
 * Coverage notes (audit requirements):
 *  - IPv4-mapped IPv6: Node reports IPv4 peers as `::ffff:a.b.c.d`; the
 *    normalizer converts mapped ENTRY addresses to plain IPv4 (and mapped
 *    CIDRs `::ffff:a.b.c.d/p` to `a.b.c.d/(p-96)`, p >= 96). The library
 *    trust matcher additionally converts mapped addresses on the request
 *    side, so `::ffff:10.0.0.2` matches entry `10.0.0.0/8`.
 *  - Multi-level proxies: the chain is trusted hop-by-hop — every address
 *    between the socket and the client must be inside the allowlist.
 *  - Fail closed: malformed entries are a configuration error (startup
 *    failure), never silently ignored.
 */
import { isIP } from 'node:net';

/** Hard ceiling on declared entries (bounded config). */
export const TRUSTED_INGRESS_MAX_ENTRIES = 64;
/** Hard ceiling on a single entry length. */
const TRUSTED_INGRESS_ENTRY_MAX_LENGTH = 128;

export interface TrustedIngressParseResult {
  /** True when the operator declared the variable (even an empty value). */
  readonly declared: boolean;
  /** Normalized CIDR/address entries (frozen); empty = no trusted peer. */
  readonly entries: readonly string[];
}

/**
 * Parses and normalizes `TRUSTED_INGRESS` (comma-separated IPv4/IPv6
 * addresses and CIDRs). Throws on any malformed entry. An empty value is a
 * valid explicit declaration meaning "no trusted proxy" (peer-only).
 */
export function parseTrustedIngress(raw: string | undefined): TrustedIngressParseResult {
  const declared = raw !== undefined;
  const entries: string[] = [];
  if (!declared) return Object.freeze({ declared, entries: Object.freeze(entries) });
  for (const chunk of raw.split(',')) {
    const entry = chunk.trim();
    if (entry === '') continue;
    if (entry.length > TRUSTED_INGRESS_ENTRY_MAX_LENGTH) {
      throw new Error('TRUSTED_INGRESS entry exceeds the maximum length');
    }
    entries.push(normalizeTrustedIngressEntry(entry));
    if (entries.length > TRUSTED_INGRESS_MAX_ENTRIES) {
      throw new Error(`TRUSTED_INGRESS supports at most ${TRUSTED_INGRESS_MAX_ENTRIES} entries`);
    }
  }
  return Object.freeze({ declared, entries: Object.freeze(entries) });
}

/**
 * Normalizes one entry: validates the address and CIDR prefix, converts
 * IPv4-mapped IPv6 forms to their IPv4 equivalents. Returns the canonical
 * `address` or `address/prefix` text (bare addresses keep their implicit
 * full prefix, mirroring the trust library's accepted grammar).
 */
export function normalizeTrustedIngressEntry(raw: string): string {
  const slash = raw.lastIndexOf('/');
  const addressPart = slash < 0 ? raw : raw.slice(0, slash);
  const prefixPart = slash < 0 ? undefined : raw.slice(slash + 1);
  if (prefixPart !== undefined && !/^\d{1,3}$/u.test(prefixPart)) {
    throw new Error(`TRUSTED_INGRESS entry has an invalid CIDR prefix: ${redactEntry(addressPart)}`);
  }

  let address = addressPart;
  let addressKind = isIP(address);
  let mappedPrefixAdjustment = 0;
  // Normalize an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to plain IPv4.
  const mapped = /^::ffff:([0-9.]+)$/iu.exec(address);
  if (mapped !== null && isIP(mapped[1]!) === 4) {
    address = mapped[1]!;
    addressKind = 4;
    mappedPrefixAdjustment = 96;
  }
  if (addressKind !== 4 && addressKind !== 6) {
    throw new Error(`TRUSTED_INGRESS entry is not a valid IP address or CIDR: ${redactEntry(addressPart)}`);
  }
  const maxPrefix = addressKind === 4 ? 32 : 128;
  if (prefixPart === undefined) {
    return address;
  }
  const prefix = Number(prefixPart);
  const effectivePrefix = prefix - mappedPrefixAdjustment;
  if (!Number.isSafeInteger(prefix) || effectivePrefix < 1 || effectivePrefix > maxPrefix) {
    throw new Error(
      `TRUSTED_INGRESS CIDR prefix must be 1-${maxPrefix} for ${redactEntry(address)}`,
    );
  }
  return `${address}/${effectivePrefix}`;
}

/**
 * Fixed low-sensitivity error text: never echoes the raw entry verbatim in a
 * way that could confuse operators about which value failed (the entry is a
 * non-secret network literal, but keep error text short and stable).
 */
function redactEntry(entry: string): string {
  return entry.length > 40 ? `${entry.slice(0, 40)}...` : entry;
}

/** One compiled allowlist entry (address bytes + prefix length). */
interface CompiledTrustedIngressEntry {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

/**
 * FIX-M-008: socket-peer membership test for the trusted-ingress allowlist.
 *
 * Transport guards (Sync TLS evidence) reuse the exact allowlist semantics
 * of the Fastify trust function: a peer is trusted only when its address
 * falls inside a declared CIDR/address entry. IPv4-mapped IPv6 peers (Node
 * reports IPv4 peers as `::ffff:a.b.c.d`) are normalized to plain IPv4 so
 * they match IPv4 entries; a multi-level proxy chain is trusted hop-by-hop
 * because every hop's socket peer must individually match.
 */
export type TrustedIngressPeerMatcher = (address: string | undefined) => boolean;

export function createTrustedIngressMatcher(entries: readonly string[]): TrustedIngressPeerMatcher {
  const compiled = entries.map(compileTrustedIngressEntry);
  return (address) => {
    if (address === undefined || address === '') return false;
    const normalized = normalizePeerAddress(address);
    const family = isIP(normalized);
    if (family !== 4 && family !== 6) return false;
    const bytes = parseAddressBytes(normalized, family);
    return compiled.some((entry) => entry.family === family
      && prefixMatches(entry.bytes, bytes, entry.prefix));
  };
}

/** Compiles one normalized entry; malformed entries fail closed. */
function compileTrustedIngressEntry(entry: string): CompiledTrustedIngressEntry {
  const slash = entry.lastIndexOf('/');
  const addressPart = slash < 0 ? entry : entry.slice(0, slash);
  const address = normalizePeerAddress(addressPart);
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new TypeError(`TRUSTED_INGRESS entry is not a valid IP address or CIDR: ${redactEntry(addressPart)}`);
  }
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = slash < 0 ? maxPrefix : Number(entry.slice(slash + 1));
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
    throw new TypeError(`TRUSTED_INGRESS CIDR prefix must be 1-${maxPrefix} for ${redactEntry(addressPart)}`);
  }
  return Object.freeze({ family, bytes: parseAddressBytes(address, family), prefix });
}

/** Normalizes an IPv4-mapped IPv6 peer to plain IPv4 (`::ffff:a.b.c.d`). */
function normalizePeerAddress(address: string): string {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:([0-9.]+)$/u.exec(lower);
  return mapped !== null && isIP(mapped[1]!) === 4 ? mapped[1]! : lower;
}

/** Parses a validated IPv4/IPv6 literal into 4/16 address bytes. */
function parseAddressBytes(address: string, family: 4 | 6): Uint8Array {
  if (family === 4) {
    const parts = address.split('.');
    if (parts.length !== 4) throw new TypeError(`invalid IPv4 address: ${redactEntry(address)}`);
    return Uint8Array.from(parts, (part) => {
      if (!/^\d{1,3}$/u.test(part)) throw new TypeError(`invalid IPv4 address: ${redactEntry(address)}`);
      const value = Number(part);
      if (value > 255) throw new TypeError(`invalid IPv4 address: ${redactEntry(address)}`);
      return value;
    });
  }
  const bytes = new Uint8Array(16);
  const sections = address.split('::');
  if (sections.length > 2) throw new TypeError(`invalid IPv6 address: ${redactEntry(address)}`);
  const head = sections[0] === '' ? [] : sections[0]!.split(':');
  const tail = sections.length === 2 && sections[1] !== '' ? sections[1]!.split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((sections.length === 2 && missing < 1) || (sections.length === 1 && missing !== 0)) {
    throw new TypeError(`invalid IPv6 address: ${redactEntry(address)}`);
  }
  const view = new DataView(bytes.buffer);
  [...head, ...Array.from({ length: missing }, () => '0'), ...tail].forEach((group, index) => {
    if (!/^[0-9a-f]{1,4}$/iu.test(group)) throw new TypeError(`invalid IPv6 address: ${redactEntry(address)}`);
    view.setUint16(index * 2, Number.parseInt(group, 16));
  });
  return bytes;
}

/** Bit-prefix match between two equal-family address byte strings. */
function prefixMatches(entryBytes: Uint8Array, candidateBytes: Uint8Array, prefix: number): boolean {
  const wholeBytes = Math.floor(prefix / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (entryBytes[index] !== candidateBytes[index]) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (entryBytes[wholeBytes]! & mask) === (candidateBytes[wholeBytes]! & mask);
}
