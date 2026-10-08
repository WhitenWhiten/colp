/**
 * Shared hardened egress port (FIX-M-019).
 *
 * Every hop of an outbound HTTPS fetch is validated before any connection is
 * made:
 *
 * - the target URL must pass the production OIDC endpoint policy (HTTPS, no
 *   userinfo, no loopback/private/link-local hosts, no cloud metadata hosts)
 *   via `bootstrap/oidc-endpoint-policy.ts`;
 * - the hostname is resolved to ALL A and AAAA records and every record is
 *   classified; a single reserved address fails the whole hop (fail closed),
 *   which also defeats DNS-rebinding record mixes;
 * - the connection is pinned to the validated address while TLS hostname
 *   verification still uses the URL hostname (SNI/certificate check intact);
 * - every redirect hop is re-validated and re-pinned with its own resolution;
 * - every redirect hop also follows fetch's credential rules: a cross-origin
 *   hop drops `authorization`/`cookie`-class headers, and 301/302/303 are
 *   rewritten to a bodyless GET, so a redirect can neither replay a Bearer
 *   token nor resend a POST payload to a host the caller never chose;
 * - environment proxy variables are never read: no proxy is ever configured,
 *   so HTTP_PROXY/HTTPS_PROXY/NO_PROXY cannot redirect traffic.
 *
 * Errors are stable and never echo resolved IPs, hostnames or DNS details.
 * Tests inject the resolver and the connector; no real network is required.
 */
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { OutgoingHttpHeaders } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import { assertOidcEndpointUrl } from '../../bootstrap/oidc-endpoint-policy.js';
import { settleBestEffort } from '../async/best-effort.js';

export type EgressAddressVerdict = 'public' | 'denied';

export interface HardenedEgressTarget {
  /** Target URL; the hostname is preserved for TLS hostname verification. */
  readonly url: URL;
  /** Validated address the connection must be pinned to. */
  readonly ip: string;
  readonly family: 4 | 6;
}

/** Resolves a hostname to every A/AAAA address; must never touch the network in tests. */
export interface HardenedEgressResolver {
  (hostname: string, signal?: AbortSignal): Promise<readonly string[]>;
}

/** Single-hop transport; production uses node:https pinned to the validated IP. */
export interface HardenedEgressConnector {
  (target: HardenedEgressTarget, init: RequestInit): Promise<Response>;
}

export interface HardenedEgressFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface HardenedEgressFetchOptions {
  /** DNS resolver; defaults to system A/AAAA resolution. */
  readonly resolve?: HardenedEgressResolver;
  /** Single-hop transport; defaults to node:https pinned to the validated IP. */
  readonly connect?: HardenedEgressConnector;
  /** Maximum redirect hops to follow. Default 5. Ignored when followRedirects is false. */
  readonly maxRedirects?: number;
  /**
   * Follow 3xx Location hops (re-validated each hop). CIMD must leave
   * redirects with the caller. Default true.
   */
  readonly followRedirects?: boolean;
  /** Stable label used in non-secret error messages. */
  readonly label?: string;
}

export type HardenedEgressErrorReason =
  | 'invalid_url'
  | 'denied'
  | 'denied_address'
  | 'dns_failure'
  | 'redirect_invalid'
  | 'too_many_redirects';

export class HardenedEgressError extends Error {
  readonly reason: HardenedEgressErrorReason;

  constructor(reason: HardenedEgressErrorReason, message: string) {
    super(message);
    this.name = 'HardenedEgressError';
    this.reason = reason;
  }
}

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Classify one resolved address. Anything that is not a public address is
 * denied, including loopback, RFC1918, link-local, CGNAT, multicast, reserved,
 * documentation and IPv4-mapped IPv6 forms.
 */
export function classifyEgressAddress(address: string): EgressAddressVerdict {
  // A DNS answer must not select an interface through an IPv6 zone identifier.
  if (address.includes('%')) return 'denied';
  const family = isIP(address);
  if (family === 4) return isDeniedIpv4(address) ? 'denied' : 'public';
  if (family === 6) return isDeniedIpv6(address) ? 'denied' : 'public';
  return 'denied';
}

function isDeniedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed -> fail closed
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, loopback
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  // IANA IPv4 Special-Purpose Registry: only these two /32 exceptions in
  // 192.0.0.0/24 are globally reachable. Deny unassigned members as well.
  if (a === 192 && b === 0 && c === 0) return d !== 9 && d !== 10;
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 documentation 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 documentation 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 documentation 203.0.113.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast 192.88.99.0/24
  if (a >= 224) return true; // multicast 224.0.0.0/4, reserved 240.0.0.0/4, broadcast
  return false;
}

function isDeniedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const first = firstIpv6Hextet(normalized);
  const second = secondIpv6Hextet(normalized);
  // Positive global-unicast boundary, then conservative special-use exclusions.
  // This also denies discard-only 100::/64, dummy 100:0:0:1::/64, SRv6 5f00::/16,
  // NAT64, mapped/compatible IPv4, local, multicast and unallocated address space.
  if (first === null || (first & 0xe000) !== 0x2000 || second === null) return true;
  if (first === 0x2001 && second === 0x0db8) return true; // documentation 2001:db8::/32
  if (first === 0x2001 && second <= 0x01ff) return true; // IETF protocol assignments 2001::/23
  if (first === 0x3fff && second <= 0x0fff) return true; // documentation 3fff::/20 (RFC 9637)
  if (first === 0x2002) return true; // 6to4 2002::/16
  return false;
}

function firstIpv6Hextet(address: string): number | null {
  if (address.startsWith('::')) return 0;
  const first = address.split(':', 1)[0];
  if (first === undefined || first === '') return null;
  const value = Number.parseInt(first, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
  return value;
}

function secondIpv6Hextet(address: string): number | null {
  const second = address.split(':')[1];
  // isIP already validated the address. An empty field starts :: compression
  // and represents zero, not an unknown hextet that can skip a deny rule.
  if (second === '') return 0;
  if (second === undefined) return null;
  const value = Number.parseInt(second, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
  return value;
}

/**
 * Validate one hop target: URL policy, full A/AAAA resolution and address
 * classification. The returned target pins the connection to a validated
 * address while keeping the original URL for TLS hostname verification.
 */
export async function planHardenedEgressTarget(
  label: string,
  input: string | URL,
  resolve: HardenedEgressResolver,
  signal?: AbortSignal,
): Promise<HardenedEgressTarget> {
  signal?.throwIfAborted();
  const value = typeof input === 'string' ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HardenedEgressError('invalid_url', `${label} must be a valid absolute URL`);
  }
  try {
    assertOidcEndpointUrl(label, value, 'strict');
  } catch {
    throw new HardenedEgressError('denied', `${label} is not an allowed egress target`);
  }

  const hostname = normalizeEgressHostname(parsed.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (classifyEgressAddress(hostname) === 'denied') {
      throw new HardenedEgressError('denied_address', `${label} resolves to a disallowed address`);
    }
    return { url: parsed, ip: hostname, family: literalFamily };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveEgressAddresses(resolve, hostname, signal);
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    throw new HardenedEgressError('dns_failure', `${label} could not be resolved`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new HardenedEgressError('dns_failure', `${label} could not be resolved`);
  }

  let anyDenied = false;
  let firstIpv4: { readonly ip: string; readonly family: 4 } | null = null;
  let firstIpv6: { readonly ip: string; readonly family: 6 } | null = null;
  for (const address of addresses) {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      anyDenied = true; // non-IP from the resolver -> fail closed
      continue;
    }
    if (classifyEgressAddress(address) === 'denied') {
      anyDenied = true;
      continue;
    }
    // Prefer IPv4: production api has no IPv6 route (Cloudflare AAAA → ENETUNREACH).
    if (family === 4 && firstIpv4 === null) firstIpv4 = { ip: address, family };
    if (family === 6 && firstIpv6 === null) firstIpv6 = { ip: address, family };
  }
  const pinned = firstIpv4 ?? firstIpv6;
  if (anyDenied || pinned === null) {
    throw new HardenedEgressError('denied_address', `${label} resolves to a disallowed address`);
  }
  return { url: parsed, ip: pinned.ip, family: pinned.family };
}

function normalizeEgressHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

/**
 * Socket lookup that always returns the validated address and never queries
 * DNS again. This is the DNS-rebinding defense: the connection goes to the
 * pinned IP while TLS still verifies the original URL hostname.
 */
export function createPinnedLookup(ip: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: ip, family }]);
      return;
    }
    callback(null, ip, family);
  };
}

/** Hardened fetch: validate -> pin -> connect, then revalidate every redirect hop. */
export function createHardenedEgressFetch(options: HardenedEgressFetchOptions = {}): HardenedEgressFetch {
  const resolve = options.resolve ?? systemEgressResolver;
  const connect = options.connect ?? createProductionEgressConnector();
  const followRedirects = options.followRedirects ?? true;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const label = options.label ?? 'egress target';

  return async (input, init = {}) => {
    let target = await planHardenedEgressTarget(label, input, resolve, init.signal ?? undefined);
    for (let hop = 0; ; hop += 1) {
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const response = await connect(target, { ...init, redirect: 'manual' });
      if (!followRedirects || !isRedirectStatus(response.status)) return response;
      const location = response.headers.get('location');
      if (response.body) {
        await settleBestEffort(response.body.cancel(),
          'the redirect decision is authoritative and body teardown is secondary');
      }
      if (location === null || location.trim() === '') {
        return response; // 3xx without a usable Location: leave for the caller
      }
      if (hop >= maxRedirects) {
        throw new HardenedEgressError('too_many_redirects', 'egress redirect limit exceeded');
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, target.url);
      } catch {
        throw new HardenedEgressError('redirect_invalid', 'egress redirect location is invalid');
      }
      init = redirectInit(init, response.status, target.url, nextUrl);
      target = await planHardenedEgressTarget(label, nextUrl, resolve, init.signal ?? undefined);
    }
  };
}

/**
 * Headers that carry a credential for one origin and must never be replayed to
 * another. `Authorization` and `Cookie` are the browser's own redirect rules;
 * the rest are credentials this backend actually sends (`authorization` on the
 * publication cache purge) or classic hop-by-hop credential carriers.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set([
  'authorization', 'cookie', 'proxy-authorization', 'proxy-authenticate', 'www-authenticate',
  // Sent by the publication-cache purge. The comment above claimed this was
  // stripped while it was not; the value is a deterministic digest correlator, so
  // it is not a credential, but a host the caller never chose has no business
  // receiving it either.
  'idempotency-key',
]);

function isSameOrigin(left: URL, right: URL): boolean {
  return left.origin === right.origin;
}

/**
 * Request options for the next redirect hop.
 *
 * Standard fetch semantics: with redirect handling, 301/302 are rewritten to
 * GET (and 303 always is), which drops the request body. 307/308 preserve the
 * method and body. A cross-origin hop additionally loses every credential
 * header — without this, a redirect to any other host replayed the original
 * `Authorization: Bearer` (publication cache purge), the IndexNow key body and
 * the idempotency key to a host the caller never chose has no business
 * receiving it either.
 *
 * When the method and body are preserved but the body cannot be read again
 * (a stream or a stream-bearing Request), the body is dropped rather than sent
 * empty or truncated: a hop that cannot be replayed faithfully fails loudly
 * instead of silently.
 */
function redirectInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const downgrade = status === 303 || status === 301 || status === 302;
  const sameOrigin = isSameOrigin(from, to);
  const headers = new Headers(init.headers ?? undefined);
  if (!sameOrigin) {
    for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
  }
  const next: RequestInit = { ...init, headers };
  if (downgrade) {
    next.method = 'GET';
    delete next.body;
    for (const name of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) {
      headers.delete(name);
    }
    return next;
  }
  if (!sameOrigin && init.body != null) {
    // A cross-origin hop NEVER carries the body, replayable or not.
    //
    // Dropping only un-replayable bodies left the far more dangerous case intact:
    // a 307/308 to a host the redirecting party chose re-sent the original form
    // body, which for the OIDC token exchange is the code_verifier AND, in
    // client_secret_post mode, the client secret. A body is caller-authored
    // content addressed to a specific host, so it is not resent elsewhere — that
    // is the same rule the credential headers already follow, and `isReplayableBody`
    // answers a different question (can it be re-sent at all) rather than this one
    // (should it be).
    delete next.body;
    for (const name of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) {
      headers.delete(name);
    }
    return next;
  }
  if (init.body != null && !isReplayableBody(init.body)) delete next.body;
  return next;
}

function isReplayableBody(body: RequestInit['body']): boolean {
  return typeof body === 'string' || body instanceof URLSearchParams || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Stop waiting for an injected resolver too; late results cannot start a connection. */
async function resolveEgressAddresses(
  resolve: HardenedEgressResolver, hostname: string, signal?: AbortSignal,
): Promise<readonly string[]> {
  if (!signal) return resolve(hostname);
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([resolve(hostname, signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Each request owns its resolver, so cancellation cannot cancel another request's DNS. */
async function systemEgressResolver(hostname: string, signal?: AbortSignal): Promise<readonly string[]> {
  signal?.throwIfAborted();
  const resolver = new Resolver();
  const onAbort = () => resolver.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal?.throwIfAborted();
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch forbids a body on 204/205/304. Passing a ReadableStream into
 * `new Response(stream, { status: 204 })` throws synchronously in undici
 * ("Invalid response status code 204") and is uncaught inside https.request.
 */
export function isFetchNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

export function createFetchResponseFromNodeHttp(input: {
  readonly statusCode: number | undefined;
  readonly statusText: string | undefined;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: ReadableStream<Uint8Array> | null;
}): Response {
  const raw = input.statusCode;
  const status = raw !== undefined && Number.isInteger(raw) && raw >= 200 && raw <= 599
    ? raw
    : 502;
  return new Response(isFetchNullBodyStatus(status) ? null : input.body, {
    status,
    statusText: input.statusText,
    headers: responseHeadersToWeb(input.headers),
  });
}

/** Production transport: node:https with the socket lookup pinned to the validated IP. */
export function createProductionEgressConnector(): HardenedEgressConnector {
  return (target, init) => new Promise<Response>((resolvePromise, rejectPromise) => {
    const agent = new https.Agent({
      lookup: createPinnedLookup(target.ip, target.family),
      keepAlive: false,
      // Node 22 Happy Eyeballs calls lookup with options.all; we handle that
      // in createPinnedLookup, and also turn the feature off so a string
      // callback cannot become `Invalid IP address: undefined`.
      autoSelectFamily: false,
    });
    const request = https.request(target.url, {
      method: init.method ?? 'GET',
      headers: normalizeOutgoingHeaders(init.headers),
      agent,
      signal: init.signal ?? undefined,
    }, (response) => {
      const status = response.statusCode;
      if (status !== undefined && isFetchNullBodyStatus(status)) {
        response.once('close', () => agent.destroy());
        response.resume();
        resolvePromise(createFetchResponseFromNodeHttp({
          statusCode: status,
          statusText: response.statusMessage,
          headers: response.headers,
          body: null,
        }));
        return;
      }
      // Byte-based high water mark: the standard bridge pauses IncomingMessage
      // when consumers stop reading and destroys it on cancellation.
      const stream = Readable.toWeb(response, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>;
      response.once('close', () => agent.destroy());
      resolvePromise(createFetchResponseFromNodeHttp({
        statusCode: status,
        statusText: response.statusMessage,
        headers: response.headers,
        body: stream,
      }));
    });
    request.on('error', (error) => {
      agent.destroy();
      rejectPromise(error);
    });
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string' || init.body instanceof URLSearchParams || Buffer.isBuffer(init.body)) {
        request.write(init.body instanceof URLSearchParams ? init.body.toString() : init.body);
      } else {
        request.destroy();
        agent.destroy();
        rejectPromise(new HardenedEgressError('invalid_url', 'egress connector does not support the request body type'));
        return;
      }
    }
    request.end();
  });
}

function normalizeOutgoingHeaders(headers: RequestInit['headers']): OutgoingHttpHeaders | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...headers };
}

function responseHeadersToWeb(headers: NodeJS.Dict<string | string[]>): Headers {
  const web = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) web.append(name, item);
    } else {
      web.append(name, value);
    }
  }
  return web;
}
