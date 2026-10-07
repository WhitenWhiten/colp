/**
 * Production CIMD transport.
 *
 * `@better-auth/cimd/node` 1.7.1 pins DNS then supplies a 3-arg `lookup`
 * callback. Node 22 Happy Eyeballs calls that lookup with `options.all` and
 * treats the second argument as an address list, so a string IP becomes
 * `Invalid IP address: undefined`. The same pin also takes `addresses[0]`
 * in verbatim DNS order, which is often Cloudflare AAAA — the api container
 * has no IPv6 and gets ENETUNREACH.
 *
 * This wrapper keeps CIMD's contract (HTTPS GET/HEAD, resolve-once, refuse
 * RFC 6890, do not follow redirects) but uses the shared hardened egress
 * (`createPinnedLookup` already handles `options.all`; planning prefers IPv4).
 */
import {
  createHardenedEgressFetch,
  HardenedEgressError,
  type HardenedEgressFetch,
} from '../egress/index.js';

export type CimdClientMetadataFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

export function createProductionCimdFetch(
  fetchImpl: HardenedEgressFetch = createHardenedEgressFetch({
    label: 'CIMD metadata',
    followRedirects: false,
  }),
): CimdClientMetadataFetch {
  return async (input, init) => {
    const webRequest = new Request(input, init);
    const url = new URL(webRequest.url);
    if (url.protocol !== 'https:') {
      throw new TypeError('CIMD Node transport requires an HTTPS URL');
    }
    if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
      throw new TypeError('CIMD Node transport supports only GET and HEAD');
    }
    try {
      return await fetchImpl(url, {
        method: webRequest.method,
        headers: webRequest.headers,
        signal: init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal),
        redirect: 'manual',
      });
    } catch (error) {
      if (error instanceof HardenedEgressError) {
        throw new TypeError('CIMD Node transport refused the metadata hostname');
      }
      throw error;
    }
  };
}

export const fetchProductionClientMetadataResource = createProductionCimdFetch();
