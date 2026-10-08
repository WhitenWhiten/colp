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

/** CIMD is attacker-invoked metadata I/O; bound headers and body completion. */
export const CIMD_METADATA_TIMEOUT_MS = 10_000;

export interface ProductionCimdFetchOptions {
  readonly timeoutMs?: number;
}

export function createProductionCimdFetch(
  fetchImpl: HardenedEgressFetch = createHardenedEgressFetch({
    label: 'CIMD metadata',
    followRedirects: false,
  }),
  options: ProductionCimdFetchOptions = {},
): CimdClientMetadataFetch {
  const timeoutMs = options.timeoutMs ?? CIMD_METADATA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('CIMD metadata timeoutMs must be an integer between 1 and 120000.');
  }
  return async (input, init) => {
    const webRequest = new Request(input, init);
    const url = new URL(webRequest.url);
    if (url.protocol !== 'https:') {
      throw new TypeError('CIMD Node transport requires an HTTPS URL');
    }
    if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
      throw new TypeError('CIMD Node transport supports only GET and HEAD');
    }
    const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal);
    const controller = new AbortController();
    let rejectDeadline: ((reason: unknown) => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const abortRequest = () => {
      const reason = upstreamSignal?.reason
        ?? new DOMException('CIMD metadata request aborted', 'AbortError');
      controller.abort(reason);
      rejectDeadline?.(reason);
    };
    if (upstreamSignal?.aborted) abortRequest();
    else upstreamSignal?.addEventListener('abort', abortRequest, { once: true });
    // The deadline promise is independent of AbortSignal because a supplied
    // connector may ignore the signal and never settle its fetch promise.
    const timeout = setTimeout(() => {
      const reason = new DOMException('CIMD metadata response deadline exceeded', 'TimeoutError');
      controller.abort(reason);
      rejectDeadline?.(reason);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortRequest);
    };
    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: webRequest.method,
          headers: webRequest.headers,
          signal: controller.signal,
          redirect: 'manual',
        }),
        deadline,
      ]);
      // A connector may resolve despite ignoring AbortSignal; never hand its
      // late response to the OAuth parser after the request deadline.
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (response.body !== null) await response.body.cancel(reason).catch(() => undefined);
        throw reason instanceof Error
          ? reason
          : new DOMException('CIMD metadata request aborted', 'AbortError');
      }
      // Keep the deadline alive through response-body consumption. A server
      // that sends headers and then stalls must not retain the OAuth handler.
      if (response.body === null || webRequest.method === 'HEAD') {
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await Promise.race([reader.read(), deadline]);
            if (chunk.done) {
              cleanup();
              streamController.close();
            } else if (chunk.value !== undefined) {
              streamController.enqueue(chunk.value);
            }
          } catch (error) {
            cleanup();
            // Best-effort cancellation covers transports that ignore abort and
            // leave their original reader pending.
            void reader.cancel(error).catch(() => undefined);
            streamController.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      if (error instanceof HardenedEgressError) {
        throw new TypeError('CIMD Node transport refused the metadata hostname');
      }
      throw error;
    }
  };
}

export const fetchProductionClientMetadataResource = createProductionCimdFetch();
