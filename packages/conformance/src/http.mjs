/**
 * Bounded HTTP client for black-box probing: every request counts against a
 * budget, has a deadline, and stops reading once the body exceeds a byte cap.
 */

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
 * @param {{ timeoutMs?: number, maxBytes?: number, maxRequests?: number, fetch?: typeof fetch }} [options]
 */
export function createHttpClient(options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxRequests = options.maxRequests ?? 200;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let used = 0;

  /**
   * @param {string | URL} url
   * @param {{ method?: string, accept?: string, headers?: Record<string, string> }} [init]
   */
  async function request(url, init = {}) {
    if (used >= maxRequests) throw new RequestBudgetError(`Request budget of ${maxRequests} exhausted.`);
    used += 1;
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (init.accept !== undefined) {
      headers.set('Accept', `${init.accept};version=${PROTOCOL_VERSION}, application/json;q=0.5`);
    }
    headers.set('Collection-Protocol-Version', PROTOCOL_VERSION);
    const response = await fetchImpl(url, {
      method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = await readBounded(response, maxBytes);
    return Object.freeze({
      method,
      url: String(url),
      finalUrl: response.url || String(url),
      status: response.status,
      headers: response.headers,
      bytes,
    });
  }

  return Object.freeze({
    request,
    get requestCount() {
      return used;
    },
  });
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
