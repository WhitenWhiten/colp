import { readBoundedJson } from './json-response.js';

const MAX_BACKOFF_MS = 5 * 60_000;

// A Session proves server authority, never an unknown Chrome/Node identity.
export function holdsUnprovenIdentity(lastError: string | undefined) {
  return lastError === 'recovery_identity_unproven' || lastError === 'deletion_identity_unproven'
    || lastError === 'create_placement_parent_deleted' || lastError === 'create_placement_unproven';
}

/** Local projection damage cannot be cured by minting another active Session. */
export function needsReplicaRebuild(code: string | undefined): boolean {
  return code === 'pull_apply_target_missing' || code === 'pull_apply_evidence_missing'
    || code === 'anchor_mapping_missing' || code === 'legacy_resolution_sequence_collision'
    || code === 'metadata_sync_disabled' || code === 'mapping_identity_collision'
    || code === 'create_ambiguous' || code === 'create_evidence_missing';
}

export function persistentLocalSyncFailure(code: string | undefined): boolean {
  return code !== undefined && ['bounded_string_invalid', 'secret_field_forbidden', 'i_json_invalid',
    'record_too_large', 'snapshot_projection_incomplete', 'operation_schema_invalid'].includes(code);
}

export function pullApplyAckState(publishedCursor: string | undefined, nextCursor: string, parked: boolean):
  'ack' | 'parked' | 'not_durable' {
  if (publishedCursor === nextCursor) return 'ack';
  return parked ? 'parked' : 'not_durable';
}

export async function snapshotFailure(response: Response, timeoutMilliseconds?: number) {
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

export function holdsInboundPull(lastError: string | undefined) {
  return lastError !== undefined && lastError !== 'network_unavailable'
    && lastError !== 'position_context_stale' && lastError !== 'revision_conflict';
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

export function retryAfterMilliseconds(error: unknown) { const value = error && typeof error === 'object'
  ? (error as { readonly retryAfterMilliseconds?: unknown }).retryAfterMilliseconds : undefined;
  return Number.isSafeInteger(value) && Number(value) >= 1_000 && Number(value) <= MAX_BACKOFF_MS
    ? Number(value) : undefined; }

export function httpFailure(response: Response, fallback: string, now: number) {
  const error = new Error(response.status === 429 ? 'rate_limited' : fallback) as Error
    & { retryAfterMilliseconds?: number };
  if (response.status === 429) {
    const value = response.headers.get('Retry-After'); let delay = 0;
    if (value && /^\d+$/u.test(value)) delay = Number(value) * 1_000;
    else if (value) { const date = Date.parse(value); if (Number.isFinite(date)) delay = Math.max(0, date - now); }
    error.retryAfterMilliseconds = Math.min(MAX_BACKOFF_MS, Math.max(1_000, delay));
  }
  return error;
}
