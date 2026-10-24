import { readBoundedJson } from './json-response.js';
import { authorityCodeForStatus, classifyHttpStatus, statusFailure } from './sync-transport-failure.js';

const MAX_BACKOFF_MS = 5 * 60_000;
/** Placeholders callers pass when the response named no code; a status that implies an authority denial replaces them. */
const GENERIC_FAILURE = new Set(['pull_failed', 'ack_failed', 'snapshot_failed', 'session_failed']);

export function pullApplyAckState(publishedCursor: string | undefined, nextCursor: string, parked: boolean):
  'ack' | 'parked' | 'not_durable' {
  if (publishedCursor === nextCursor) return 'ack';
  return parked ? 'parked' : 'not_durable';
}

export async function snapshotFailure(response: Response, timeoutMilliseconds?: number) {
  if (classifyHttpStatus(response.status) === 'transient') return 'server_unavailable';
  const type = response.headers.get('Content-Type') ?? '';
  if (!/^application\/problem\+json(?:\s*;|$)/iu.test(type)) return `snapshot_http_${response.status}`;
  return `snapshot_${response.status}_${await responseProblemCode(response, 'invalid_problem', timeoutMilliseconds)}`;
}

export async function responseProblemCode(response: Response, fallback: string, timeoutMilliseconds?: number) {
  if (!/^application\/problem\+json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '')) return fallback;
  try {
    const problem = await readBoundedJson(response, 128 * 1024, 'sync_problem_invalid', { timeoutMilliseconds });
    const code = problem && typeof problem === 'object' && !Array.isArray(problem)
      ? (problem as { readonly code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : fallback;
  } catch { return fallback; }
}

export function stableError(error: unknown) { const code = error && typeof error === 'object' && 'code' in error
    ? (error as { readonly code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code)) return code;
  if (!(error instanceof Error)) return 'sync_failed';
  if (error.name === 'AbortError') {
    return typeof DOMException !== 'undefined' && error instanceof DOMException
      && !/transaction/i.test(error.message) ? 'network_unavailable' : 'transaction_aborted';
  }
  if (/transaction/i.test(error.message) && /abort/i.test(error.message)) return 'transaction_aborted';
  // F036: only a transport-signature message makes a TypeError a network
  // failure ('Failed to fetch', 'fetch failed', 'NetworkError...',
  // 'Load failed'). A bare TypeError is a local defect and falls through to
  // the name-based classification instead of masking as connectivity.
  if (/network|offline|fetch|abort|load failed/iu.test(error.message)) return 'network_unavailable';
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(error.message)) return error.message;
  const prefix = /^([a-z][a-z0-9_]{0,63}):/u.exec(error.message)?.[1];
  if (prefix) return prefix;
  const named = error.name !== 'Error' && /^([A-Z][A-Za-z0-9]{0,55})Error$/u.exec(error.name)?.[1]
    ?.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
  return named && /^[a-z][a-z0-9_]{0,55}$/u.test(named) ? `${named}_error` : 'sync_failed'; }

/** The wait a server asked for, at most five minutes: a longer Retry-After is honoured as five, not dropped (W2B-P3-7). */
export function retryAfterMilliseconds(error: unknown) { const value = error && typeof error === 'object'
  ? (error as { readonly retryAfterMilliseconds?: unknown }).retryAfterMilliseconds : undefined;
  return Number.isSafeInteger(value) && Number(value) >= 1_000 ? Math.min(MAX_BACKOFF_MS, Number(value)) : undefined; }

export function httpFailure(response: Response, fallback: string, now: number) {
  // Rule A: the status decides transient / rate limited / authority; a body that named a code keeps it.
  const authority = classifyHttpStatus(response.status) === 'authority' && GENERIC_FAILURE.has(fallback)
    ? authorityCodeForStatus(response.status) : undefined;
  return statusFailure(response, { other: fallback, ...(authority ? { authority } : { authority: fallback }) }, now);
}

export function recoveryCapability(cursor: string | undefined) { return cursor?.startsWith('src1.') === true; }
export function recoveryCapabilityOf(cursor: { readonly evidence?: unknown } | null | undefined) {
  const evidence = cursor?.evidence && typeof cursor.evidence === 'object'
    ? cursor.evidence as { readonly capability?: unknown } : {};
  return typeof evidence.capability === 'string' && evidence.capability.length > 0
    ? evidence.capability : undefined;
}
