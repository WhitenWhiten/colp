/**
 * Bounded HTTP client for black-box probing: every request counts against a
 * budget, has a deadline, and stops reading once the body exceeds a byte cap.
 * Navigation is transport-controlled here, rather than delegated to fetch,
 * so every redirect receives the same SSRF decision as its initial target.
 */

import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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
  const maxBytes = positiveSafeInteger(options.maxBytes ?? 16 * 1024 * 1024, 'maxBytes');
  const maxRequests = options.maxRequests ?? 200;
  const maxRedirects = options.maxRedirects ?? 5;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pinnedFetch = options.fetch === undefined ? createPinnedFetch() : undefined;
  const initialOrigin = options.initialOrigin === undefined ? undefined : new URL(options.initialOrigin).origin;
  const initialPrivateLiteral = options.initialOrigin === undefined
    ? false
    : isPrivateOrLocalLiteralHostname(new URL(options.initialOrigin).hostname);
  // Resolve independently of the fetch implementation so wrappers cannot
  // bypass the runner's egress boundary. Tests and host integrations may
  // inject a deterministic resolver for an intentionally simulated transport.
  const resolveHost = options.resolveHost
    ?? (async (hostname) => {
      const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
      return (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);
    });
  let used = 0;

  /**
   * @param {string | URL} url
   * `maxBytes` is an optional per-response ceiling. The conformance runner
   * supplies the remaining Snapshot budget here while following pagination;
   * keeping the cap at the stream reader means a later page cannot allocate a
   * fresh full-size response after earlier pages have consumed the run's
   * cumulative allowance.
   *
   * @param {{ method?: string, accept?: string, headers?: Record<string, string>, maxBytes?: number }} [init]
   */
  async function request(url, init = {}) {
    const method = init.method ?? 'GET';
    const requestMaxBytes = init.maxBytes === undefined
      ? maxBytes
      : Math.min(maxBytes, positiveSafeInteger(init.maxBytes, 'request maxBytes'));
    const headers = new Headers(init.headers);
    if (init.accept !== undefined) {
      headers.set('Accept', `${init.accept};version=${PROTOCOL_VERSION}, application/json;q=0.5`);
    }
    headers.set('Collection-Protocol-Version', PROTOCOL_VERSION);
    let currentUrl = new URL(url);
    let redirects = 0;
    while (true) {
      const approvedAddress = await assertEgressTarget(currentUrl, {
        initialOrigin,
        initialPrivateLiteral,
        resolveHost,
      });
      if (used >= maxRequests) throw new RequestBudgetError(`Request budget of ${maxRequests} exhausted.`);
      used += 1;
      const requestInit = {
        method,
        headers,
        // Redirects are followed explicitly so Location is checked before the
        // next network request. A transport that ignores manual mode fails
        // closed rather than hiding an uninspected hop.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      };
      const response = pinnedFetch !== undefined && approvedAddress !== undefined
        ? await pinnedFetch(currentUrl, requestInit, approvedAddress)
        : await fetchImpl(currentUrl, requestInit);
      if (response.redirected || (response.url !== '' && new URL(response.url).href !== currentUrl.href)) {
        await cancelResponse(response);
        throw new TypeError('Fetch implementation followed a redirect despite redirect: manual.');
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const bytes = await readBounded(response, requestMaxBytes);
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
    return addresses[0];
  }
  return undefined;
}

/** Internal transport hook exported for the pinned-address regression test. */
export function createPinnedFetch() {
  return (url, init, approvedAddress) => new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const request = (secure ? httpsRequest : httpRequest)({
      hostname: approvedAddress ?? url.hostname,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: (() => {
        const headers = new Headers(init.headers);
        if (!headers.has('host')) headers.set('Host', url.host);
        return Object.fromEntries(headers.entries());
      })(),
      ...(secure ? { servername: url.hostname.replace(/^\[|\]$/gu, '') } : {}),
    }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const body = new ReadableStream({
        start(controller) {
          response.on('data', chunk => controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)));
          response.on('end', () => controller.close());
          response.on('error', error => controller.error(error));
        },
        cancel() { response.destroy(); },
      });
      resolve(new Response(body, { status: response.statusCode ?? 500, statusText: response.statusMessage, headers }));
    });
    request.once('error', reject);
    if (init.signal?.aborted) {
      request.destroy(init.signal.reason);
      reject(init.signal.reason);
      return;
    }
    init.signal?.addEventListener('abort', () => request.destroy(init.signal.reason), { once: true });
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) request.write(init.body);
    request.end();
  });
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
      try {
        await response.body.cancel();
      } catch {
        // Iteration may have locked the stream; the byte-limit error remains
        // the useful failure even when cancellation cannot acquire that lock.
      }
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

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
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
