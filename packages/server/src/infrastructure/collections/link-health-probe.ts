/**
 * Bookmark URL probe through the shared hardened egress facade.
 * Tests inject `connect` and `resolve`. Production Response.url is empty;
 * hop URLs come from wrapping `connect` and recording `target.url.href`.
 */
import {
  createHardenedEgressFetch,
  createProductionEgressConnector,
  HardenedEgressError,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../egress/index.js';
import {
  hostnameFromBookmarkUrl,
  mapLinkHealthProbeObservation,
  normalizeBookmarkUrl,
  type LinkHealthProbeFact,
} from '../../modules/collections/index.js';
import { settleBestEffort } from '../async/best-effort.js';

export const LINK_HEALTH_USER_AGENT = 'Known-LinkHealth/1';
export const LINK_HEALTH_MAX_BODY_BYTES = 8192;
export const LINK_HEALTH_MAX_REDIRECTS = 5;

export interface ProbeBookmarkUrlOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  readonly signal?: AbortSignal;
  /** Gate each redirect destination in addition to the initial bookmark host. */
  readonly hostGate?: ProbeHostGate;
  readonly initialHost?: string;
}

export interface ProbeHostGate {
  run(host: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}

export interface ProbeBookmarkUrlResult {
  readonly fact: LinkHealthProbeFact;
  readonly hopUrls: readonly string[];
}

export async function probeBookmarkUrl(
  options: ProbeBookmarkUrlOptions,
): Promise<ProbeBookmarkUrlResult> {
  const startUrl = options.url;
  if (normalizeBookmarkUrl(startUrl) === null) {
    return { fact: mapLinkHealthProbeObservation({ kind: 'invalid_url' }), hopUrls: [] };
  }

  const hopUrls: string[] = [];
  const outer = new AbortController();
  const timer = setTimeout(() => outer.abort(), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([outer.signal, options.signal]) : outer.signal;
  try {
    const connect = wrapConnect(
      options.connect, hopUrls, options.connectTimeoutMs, signal,
      options.hostGate, options.initialHost,
    );
    const fetchImpl = createHardenedEgressFetch({
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      connect,
      maxRedirects: LINK_HEALTH_MAX_REDIRECTS,
      label: 'link-health',
    });
    const init: RequestInit = {
      headers: {
        'user-agent': LINK_HEALTH_USER_AGENT,
        accept: '*/*',
      },
      signal,
      redirect: 'manual',
    };
    let response = await fetchImpl(startUrl, { ...init, method: 'HEAD' });
    if (response.status === 405 || response.status === 501) {
      await drainBounded(response, LINK_HEALTH_MAX_BODY_BYTES);
      response = await fetchImpl(startUrl, { ...init, method: 'GET' });
    }
    await drainBounded(response, LINK_HEALTH_MAX_BODY_BYTES);
    const finalUrl = hopUrls[hopUrls.length - 1] ?? startUrl;
    return {
      fact: mapLinkHealthProbeObservation({
        kind: 'completed',
        httpStatus: response.status,
        startUrl,
        finalUrl,
      }),
      hopUrls: [...hopUrls],
    };
  } catch (error: unknown) {
    return { fact: mapProbeError(error), hopUrls: [...hopUrls] };
  } finally {
    clearTimeout(timer);
  }
}

export function wrapConnectRecordingHops(
  connect: HardenedEgressConnector | undefined,
  hopUrls: string[],
  connectTimeoutMs: number,
  parentSignal?: AbortSignal,
  hostGate?: ProbeHostGate,
  initialHost?: string,
): HardenedEgressConnector {
  return wrapConnect(connect, hopUrls, connectTimeoutMs, parentSignal, hostGate, initialHost);
}

function wrapConnect(
  connect: HardenedEgressConnector | undefined,
  hopUrls: string[],
  connectTimeoutMs: number,
  parentSignal?: AbortSignal,
  hostGate?: ProbeHostGate,
  initialHost?: string,
): HardenedEgressConnector {
  const inner: HardenedEgressConnector = connect ?? createProductionEgressConnector();
  return async (target, init) => {
    hopUrls.push(target.url.href);
    const hop = new AbortController();
    const timer = setTimeout(() => hop.abort(), connectTimeoutMs);
    const signal = init.signal ?? parentSignal;
    // The connect timer ends at headers; total timeout/stop still owns the body.
    const requestSignal = signal ? AbortSignal.any([signal, hop.signal]) : hop.signal;
    const connectOnce = async (): Promise<Response> => {
      try {
        return await inner(target, { ...init, signal: requestSignal });
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const targetHost = hostnameFromBookmarkUrl(target.url.href) ?? '';
      if (hostGate !== undefined && targetHost !== '' && targetHost !== initialHost) {
        let response: Response | undefined;
        await hostGate.run(targetHost, async () => { response = await connectOnce(); }, requestSignal);
        return response!;
      }
      return await connectOnce();
    } finally {
      clearTimeout(timer);
    }
  };
}

function mapProbeError(error: unknown): LinkHealthProbeFact {
  if (isAbortError(error)) return mapLinkHealthProbeObservation({ kind: 'timeout' });
  if (isTlsError(error)) return mapLinkHealthProbeObservation({ kind: 'http' });
  if (error instanceof HardenedEgressError) {
    if (error.reason === 'denied' || error.reason === 'denied_address') {
      return mapLinkHealthProbeObservation({ kind: 'denied' });
    }
    if (error.reason === 'dns_failure') return mapLinkHealthProbeObservation({ kind: 'dns' });
    if (error.reason === 'invalid_url') return mapLinkHealthProbeObservation({ kind: 'invalid_url' });
    return mapLinkHealthProbeObservation({ kind: 'http' });
  }
  return mapLinkHealthProbeObservation({ kind: 'http' });
}

function isTlsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  return /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/u.test(code)
    || code === 'EPROTO'
    || /(?:\bssl\b|\btls\b|certificate)/iu.test(message);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return false;
}

async function drainBounded(response: Response, maxBytes: number): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total >= maxBytes) {
        await settleBestEffort(reader.cancel(),
          'the oversized probe result is authoritative and stream teardown is secondary');
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function normalizedHostForProbe(url: string): string {
  return hostnameFromBookmarkUrl(url) ?? '';
}
