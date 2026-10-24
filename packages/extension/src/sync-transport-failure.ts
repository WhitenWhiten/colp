/**
 * One place where an HTTP status or a broken response body becomes a sync failure code (Rule A, S2).
 *
 * Before this module each throw site chose a code by itself, and the common choice was an integrity or
 * stop code: any non-OK effect-page status froze the replica, any stream error stopped Pull and Ack, any
 * 5xx on the conflicts endpoint was an integrity freeze. A transient fault became a permanent state.
 *
 * The rule is the same everywhere:
 * - HTTP >= 500, 408, and a body that stopped arriving are TRANSIENT (`server_unavailable`, `network_unavailable`).
 * - 429 is `rate_limited`, with the server's Retry-After.
 * - 401, 403, 404 and 410 are AUTHORITY (the Session, credential or cursor must be renewed). The caller names the
 *   authority code its endpoint understands; an endpoint that hides every denial as 404 says so by its choice.
 * - Anything else is a complete answer the client cannot use, so the caller's own code applies.
 * - An integrity code (`*_invalid`) is only for a COMPLETE, parseable 2xx body that fails its digest, shape or size checks.
 */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** The body of a response stopped arriving: a transport fault, not a verdict on what the server meant. */
export class ResponseStreamError extends Error {
  readonly code = 'network_unavailable';
  constructor(cause?: unknown) {
    super('network_unavailable', cause === undefined ? undefined : { cause });
    this.name = 'ResponseStreamError';
  }
}

export type HttpStatusClass = 'transient' | 'rate_limited' | 'authority' | 'other';

export function classifyHttpStatus(status: number): HttpStatusClass {
  if (status === 429) return 'rate_limited';
  if (status >= 500 || status === 408) return 'transient';
  if (status === 401 || status === 403 || status === 404 || status === 410) return 'authority';
  return 'other';
}

/** The authority code a status implies when the server named none. */
export function authorityCodeForStatus(status: number): string | undefined {
  switch (status) {
    case 401: return 'authentication_required';
    case 403: return 'insufficient_scope';
    case 404: return 'resource_not_found';
    case 410: return 'stale_replica';
    default: return undefined;
  }
}

/** Retry-After as milliseconds (delta-seconds or an HTTP date), clamped to what an engine backoff may honour. */
export function retryAfterMillisecondsOf(response: Response, now: number): number {
  const value = response.headers.get('Retry-After');
  let delay = 0;
  if (value && /^\d+$/u.test(value)) delay = Number(value) * 1_000;
  else if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) delay = Math.max(0, date - now);
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, delay));
}

type CodedError = Error & { retryAfterMilliseconds?: number };

function coded(code: string): CodedError { return new Error(code) as CodedError; }

/**
 * The failure for a non-2xx response whose body names no code of its own.
 * `authority` is the code to throw for 401/403/404/410 (default: the one the status implies);
 * `other` is the code for any other complete answer the client cannot use.
 */
export function statusFailure(response: Response, codes: { readonly authority?: string; readonly other: string },
  now: number): Error {
  switch (classifyHttpStatus(response.status)) {
    case 'transient': return coded('server_unavailable');
    case 'rate_limited': {
      const error = coded('rate_limited');
      error.retryAfterMilliseconds = retryAfterMillisecondsOf(response, now);
      return error;
    }
    case 'authority': return coded(codes.authority ?? authorityCodeForStatus(response.status) ?? codes.other);
    default: return coded(codes.other);
  }
}
