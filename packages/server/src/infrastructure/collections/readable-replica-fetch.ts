/**
 * Bookmark HTML fetch through the shared hardened egress facade.
 * Direct GET, bounded body (total > maxBytes → too_large), hop URLs from
 * wrapConnectRecordingHops. Production Response.url is empty; do not read it.
 * The facade follows 301/302/303/307/308 itself (re-validating every hop);
 * the raw bytes are inflated (content-encoding) and charset-decoded by
 * readable-replica-decode.ts under the same byte cap.
 */
import {
  createHardenedEgressFetch,
  HardenedEgressError,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../egress/index.js';
import {
  normalizeBookmarkUrl,
  type ReadableReplicaFailureCode,
} from '../../modules/collections/index.js';
import { settleBestEffort } from '../async/best-effort.js';
import { wrapConnectRecordingHops, type ProbeHostGate } from './link-health-probe.js';
import {
  decodeReadableReplicaBody,
  ReadableReplicaBodyEncodingError,
  ReadableReplicaBodyTooLargeError,
} from './readable-replica-decode.js';

/**
 * Browser-like but honest: JS-heavy sites (Mintlify, Next.js docs) serve a
 * no-JS fallback shell to unknown bot tokens, so the Mozilla/5.0 prefix with
 * a self-identifying product token is what unlocks the real article HTML.
 */
export const READABLE_REPLICA_USER_AGENT = 'Mozilla/5.0 (compatible; Known-ReadableReplica/1)';
export const READABLE_REPLICA_ACCEPT = 'text/html,application/xhtml+xml;q=0.9';
export const READABLE_REPLICA_ACCEPT_LANGUAGE = 'en,zh;q=0.8,*;q=0.5';
export const READABLE_REPLICA_ACCEPT_ENCODING = 'gzip, deflate, br';
export const READABLE_REPLICA_MAX_REDIRECTS = 5;

export interface FetchReadableReplicaHtmlOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  readonly signal?: AbortSignal;
  /** Defaults to READABLE_REPLICA_USER_AGENT. */
  readonly userAgent?: string;
  /** Defaults to READABLE_REPLICA_ACCEPT_ENCODING. */
  readonly acceptEncoding?: string;
  /**
   * Keep the first `maxBodyBytes` of an unencoded body instead of failing
   * with too_large (callers that only need the document head). Encoded
   * bodies cannot be cut safely and keep the too_large failure.
   */
  readonly truncateUnencodedBody?: boolean;
  /** Gate every redirect destination; the initial host is gated by the worker. */
  readonly hostGate?: ProbeHostGate;
  readonly initialHost?: string;
}

export type FetchReadableReplicaHtmlResult =
  | { readonly kind: 'html'; readonly html: string; readonly hopUrls: readonly string[] }
  | {
      readonly kind: 'failure';
      readonly failureCode: ReadableReplicaFailureCode;
      readonly hopUrls: readonly string[];
    };

export async function fetchReadableReplicaHtml(
  options: FetchReadableReplicaHtmlOptions,
): Promise<FetchReadableReplicaHtmlResult> {
  if (normalizeBookmarkUrl(options.url) === null) {
    return { kind: 'failure', failureCode: 'invalid_url', hopUrls: [] };
  }

  const hopUrls: string[] = [];
  const outer = new AbortController();
  const timer = setTimeout(() => outer.abort(), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([outer.signal, options.signal]) : outer.signal;
  try {
    const connect = wrapConnectRecordingHops(
      options.connect, hopUrls, options.connectTimeoutMs, signal,
      options.hostGate, options.initialHost,
    );
    const fetchImpl = createHardenedEgressFetch({
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      connect,
      maxRedirects: READABLE_REPLICA_MAX_REDIRECTS,
      label: 'readable-replica',
    });
    const response = await fetchImpl(options.url, {
      method: 'GET',
      headers: {
        'user-agent': options.userAgent ?? READABLE_REPLICA_USER_AGENT,
        accept: READABLE_REPLICA_ACCEPT,
        'accept-language': READABLE_REPLICA_ACCEPT_LANGUAGE,
        'accept-encoding': options.acceptEncoding ?? READABLE_REPLICA_ACCEPT_ENCODING,
      },
      signal,
      redirect: 'manual',
    });
    if (response.status < 200 || response.status >= 300) {
      if (response.body) {
        await settleBestEffort(response.body.cancel(),
          'the non-success HTTP result is authoritative and body teardown is secondary');
      }
      return { kind: 'failure', failureCode: 'http', hopUrls: freezeHops(hopUrls) };
    }
    if (!isHtmlContentType(response.headers.get('content-type'))) {
      if (response.body) {
        await settleBestEffort(response.body.cancel(),
          'the non-HTML result is authoritative and body teardown is secondary');
      }
      return { kind: 'failure', failureCode: 'not_html', hopUrls: freezeHops(hopUrls) };
    }
    const contentEncoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
    const truncate = options.truncateUnencodedBody === true
      && (contentEncoding === '' || contentEncoding === 'identity');
    const bytes = await readBoundedResponseBytes(response, options.maxBodyBytes, truncate);
    const html = decodeReadableReplicaBody({
      bytes,
      contentType: response.headers.get('content-type'),
      contentEncoding: response.headers.get('content-encoding'),
      maxBytes: options.maxBodyBytes,
    });
    return { kind: 'html', html, hopUrls: freezeHops(hopUrls) };
  } catch (error: unknown) {
    return { kind: 'failure', failureCode: mapFetchError(error), hopUrls: freezeHops(hopUrls) };
  } finally {
    clearTimeout(timer);
  }
}

function freezeHops(hopUrls: readonly string[]): readonly string[] {
  return Object.freeze([...hopUrls]);
}

function isHtmlContentType(value: string | null): boolean {
  const media = (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return media === 'text/html' || media === 'application/xhtml+xml';
}

function mapFetchError(error: unknown): ReadableReplicaFailureCode {
  if (error instanceof ReadableReplicaBodyTooLargeError) return 'too_large';
  if (error instanceof ReadableReplicaBodyEncodingError) return 'http';
  if (isAbortError(error)) return 'timeout';
  if (error instanceof HardenedEgressError) {
    if (error.reason === 'denied' || error.reason === 'denied_address') return 'denied';
    if (error.reason === 'dns_failure') return 'dns';
    if ((error.reason as string) === 'invalid_url') return 'invalid_url';
    return 'http';
  }
  return 'http';
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return false;
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  truncate = false,
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ReadableReplicaBodyTooLargeError();
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      if (truncate) return bytes.slice(0, maxBytes);
      throw new ReadableReplicaBodyTooLargeError();
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (total + next.value.byteLength > maxBytes) {
        await reader.cancel();
        if (!truncate) throw new ReadableReplicaBodyTooLargeError();
        chunks.push(next.value.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
