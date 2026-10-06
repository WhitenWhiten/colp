/**
 * Bounded HTTP client for black-box probing: every request counts against a
 * budget, has a deadline, and stops reading once the body exceeds a byte cap.
 * Navigation is transport-controlled here, rather than delegated to fetch,
 * so every redirect receives the same SSRF decision as its initial target.
 */

import { lookup } from 'node:dns/promises';

import {
  isPrivateOrLocalAddress,
  isPrivateOrLocalLiteralHostname,
} from '@collection-protocol/node/client';

export const PROTOCOL_VERSION = '0.1';

/** Versioned media types a COLP client asks for, per endpoint. */
export const MEDIA_TYPES = Object.freeze({
  manifest: 'application/vnd.collection-protocol.manifest+json',
  directory: 'application/vnd.collection-protocol.catalog+json',
  collection: 'application/vnd.collection-protocol.collection+json',
  snapshot: 'application/vnd.collection-protocol.snapshot+json',
});

/** The run used up its request budget; the runner stops probing. */
export class RequestBudgetError extends Error {}

/** One response body was larger than the byte cap. */
export class ResponseTooLargeError extends Error {}

/**
 * @param {{ timeoutMs?: number, maxBytes?: number, maxRequests?: number,
 *   maxRedirects?: number, fetch?: typeof fetch, initialOrigin?: string,
 *   resolveHost?: (hostname: string) => Promise<readonly string[]> }} [options]
 */
export function createHttpClient(options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxRequests = options.maxRequests ?? 200;
  const maxRedirects = options.maxRedirects ?? 5;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const initialOrigin = options.initialOrigin === undefined ? undefined : new URL(options.initialOrigin).origin;
  const initialPrivateLiteral = options.initialOrigin === undefined
    ? false
    : isPrivateOrLocalLiteralHostname(new URL(options.initialOrigin).hostname);
  // Resolve independently of the fetch implementation so wrappers cannot
  // bypass the runner's egress boundary. Tests and host integrations may
  // inject a deterministic resolver for an intentionally simulated transport.
  const resolveHost = options.resolveHost
    ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
  let used = 0;

  /**
   * @param {string | URL} url
   * @param {{ method?: string, accept?: string, headers?: Record<string, string> }} [init]
   */
  async function request(url, init = {}) {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (init.accept !== undefined) {
      headers.set('Accept', `${init.accept};version=${PROTOCOL_VERSION}, application/json;q=0.5`);
    }
    headers.set('Collection-Protocol-Version', PROTOCOL_VERSION);
    let currentUrl = new URL(url);
    let redirects = 0;
    while (true) {
      await assertEgressTarget(currentUrl, {
        initialOrigin,
        initialPrivateLiteral,
        resolveHost,
      });
      if (used >= maxRequests) throw new RequestBudgetError(`Request budget of ${maxRequests} exhausted.`);
      used += 1;
      const response = await fetchImpl(currentUrl, {
        method,
        headers,
        // Redirects are followed explicitly so Location is checked before the
        // next network request. A transport that ignores manual mode fails
        // closed rather than hiding an uninspected hop.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.redirected || (response.url !== '' && new URL(response.url).href !== currentUrl.href)) {
        await cancelResponse(response);
        throw new TypeError('Fetch implementation followed a redirect despite redirect: manual.');
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const bytes = await readBounded(response, maxBytes);
        return Object.freeze({
          method,
          url: currentUrl.href,
          finalUrl: currentUrl.href,
          status: response.status,
          headers: response.headers,
          bytes,
        });
      }

      const location = response.headers.get('location');
      await cancelResponse(response);
      if (location === null) throw new TypeError(`HTTP ${response.status} redirect is missing Location.`);
      if (redirects >= maxRedirects) {
        throw new RequestBudgetError(`Request exceeds the redirect limit of ${maxRedirects}.`);
      }
      const nextUrl = new URL(location, currentUrl);
      nextUrl.hash = '';
      currentUrl = nextUrl;
      redirects += 1;
    }
  }

  return Object.freeze({
    request,
    get requestCount() {
      return used;
    },
  });
}

/** Checks one target immediately before its fetch call. */
async function assertEgressTarget(url, policy) {
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Conformance request URLs must not contain user information.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`Conformance request URLs must use HTTP(S), got ${url.protocol}.`);
  }
  const privateLiteral = isPrivateOrLocalLiteralHostname(url.hostname);
  const initialLocalTarget = policy.initialOrigin !== undefined
    && url.origin === policy.initialOrigin
    && policy.initialPrivateLiteral;
  if (privateLiteral && !initialLocalTarget) {
    throw new TypeError('Conformance egress policy denied a private or local target.');
  }
  if (!privateLiteral && policy.resolveHost !== undefined) {
    let addresses;
    try {
      addresses = await policy.resolveHost(url.hostname);
    } catch (error) {
      throw new TypeError('Conformance egress policy could not resolve the target host.', { cause: error });
    }
    if (addresses.length === 0 || addresses.some((address) => isPrivateOrLocalAddress(address))) {
      throw new TypeError('Conformance egress policy denied a DNS-resolved private or local target.');
    }
  }
}

async function cancelResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect body is discarded; a cancellation failure must not permit
    // the uninspected target to be requested.
  }
}

async function readBounded(response, maxBytes) {
  if (response.body === null) return new Uint8Array(0);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw new ResponseTooLargeError(`Response body of ${declared} bytes exceeds the ${maxBytes}-byte limit.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ResponseTooLargeError(`Response body exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parses an RFC 8288 Link header into `{ href, rel }` pairs (relations split on whitespace). */
export function parseLinkHeader(value) {
  if (value === null || value === '') return [];
  const links = [];
  for (const match of value.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/gu)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/iu.exec(match[2]);
    const relations = (rel?.[1] ?? rel?.[2] ?? '').split(/\s+/u).filter(Boolean);
    for (const relation of relations) links.push({ href: match[1], rel: relation });
  }
  return links;
}

/** Splits a list-valued header such as Vary or Cache-Control into lowercase tokens. */
export function headerTokens(value) {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}
