import type { DurableSyncEngineState } from './sync-state-store.js';
import { classifySyncFailure, normalizeSyncFailureCode, persistentLocalSyncFailure, refreshesReplicaIntegrity } from './sync-failure-class.js';

export const CIRCUIT_WINDOW_MS = 30 * 60_000;
export const CIRCUIT_THRESHOLD = 5;
const INITIAL_COOLDOWN_MS = 60_000;
/**
 * A stopped engine is never forgotten: it is probed again after 5 minutes, then 15 minutes,
 * 1 hour and every 6 hours, so one stop code (a corrupt record, a version skew) that later heals
 * does not need a bookmark edit or a browser restart to be noticed. Probes are the engine's own
 * alarm; a user's Retry is not a probe and does not move this schedule.
 */
export const STOP_PROBE_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;
export const STOP_BUCKET_PREFIX = 'stop:';
/** Consecutive failed wakes of the transient class after which a waiting (non-network) code stops polling. */
export const TRANSIENT_STALL_ATTEMPTS = 20;
export const STALLED_BUCKET_PREFIX = 'stalled:';

export function stopProbeDelay(trips: number): number {
  return STOP_PROBE_DELAYS_MS[Math.min(Math.max(0, trips), STOP_PROBE_DELAYS_MS.length - 1)]!;
}

/**
 * Transient codes that end because the network or the server came back. A code outside this set
 * names a fact the engine waits for (a native outcome, a hand-over, a page it cannot yet place);
 * repeating it for ever without progress is a stall, not an outage.
 */
const SELF_RESOLVING_TRANSIENT: ReadonlySet<string> = new Set([
  'server_unavailable', 'network_unavailable', 'rate_limited', 'push_network_failed', 'push_batch_timeout',
  'push_batch_response_unknown', 'pull_failed', 'pull_transport_unavailable', 'transaction_aborted',
  'request_failed', 'indexeddb_unavailable', 'quota_exceeded', 'commit_outcome_unknown',
  // The server's own words for the same outage (Problem codes on Session, Pull, Ack and Snapshot answers).
  'service_unavailable', 'internal_error',
]);

export function stalledTransientWait(code: string | undefined, consecutiveFailures: number): boolean {
  // A Snapshot answer wraps the server's code (`snapshot_503_service_unavailable`); the wrapper names the endpoint only.
  return code !== undefined && classifySyncFailure(code)?.class === 'transient'
    && !SELF_RESOLVING_TRANSIENT.has(normalizeSyncFailureCode(code)) && consecutiveFailures >= TRANSIENT_STALL_ATTEMPTS;
}
export interface SyncCircuitBreaker {
  readonly progress: string;
  readonly failures: readonly { readonly code: string; readonly attempts: readonly number[] }[];
  readonly trips: number;
  readonly retryAt?: number;
}

/**
 * What this replica has committed: the Pull page, Snapshot or push receipt the
 * cursor row names, and the head of the push lane. A renewed Session rotates the
 * cursor and rebases the checkpoint onto the collection head, which every other
 * device moves by editing; neither is work this browser finished, so neither
 * appears here.
 */
export function syncProgress(input: { readonly cursorEvidence: unknown; readonly headOpId: string | null }): string {
  const evidence = input.cursorEvidence && typeof input.cursorEvidence === 'object'
    ? input.cursorEvidence as Record<string, unknown> : {};
  const work = [evidence.pullPageId, evidence.snapshotId, evidence.receiptId].find((value) => typeof value === 'string');
  return JSON.stringify([typeof work === 'string' ? work : null, input.headOpId]);
}

/** A Session rebase drops the cursor's work evidence without doing work, so a rebased cursor matches what came before it. */
export function sameSyncProgress(prior: string, current: string): boolean {
  if (prior === current) return true;
  const previous = parseProgress(prior); const next = parseProgress(current);
  return previous !== undefined && next !== undefined && next.work === null && previous.head === next.head;
}

function parseProgress(value: string): { readonly work: string | null; readonly head: string | null } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [work, head] = parsed as unknown[];
    if ((work !== null && typeof work !== 'string') || (head !== null && typeof head !== 'string')) return undefined;
    return { work, head };
  } catch { return undefined; }
}

export interface CircuitContext {
  /** The failing wake was an automatic probe or trigger, not a user's Retry. */
  readonly probe?: boolean;
  /** Consecutive failed wakes of any non-stop kind (`networkBackoffCount`). */
  readonly consecutiveFailures?: number;
}

/**
 * A failure that stops the engine without damaging the user's data: schedule the next probe in
 * its own bucket. Only an automatic probe that fails again moves the schedule on; a user's Retry
 * re-arms the delay already reached.
 */
function advanceProbeSchedule(prior: SyncCircuitBreaker | undefined, bucket: string, progress: string, now: number,
  probe: boolean): SyncCircuitBreaker {
  const base = prior !== undefined && sameSyncProgress(prior.progress, progress) ? prior : undefined;
  const others = (base?.failures ?? []).filter(row => row.code !== bucket);
  const previous = base?.failures.find(row => row.code === bucket);
  const attempts = [...(previous?.attempts.map(at => Math.min(at, now)) ?? []), now].slice(-CIRCUIT_THRESHOLD);
  const trips = base === undefined ? 0 : probe ? Math.min(base.trips + 1, 32) : base.trips;
  return { progress: base?.progress ?? progress, failures: [...others, { code: bucket, attempts }], trips,
    retryAt: now + stopProbeDelay(trips) };
}

/** A clock that reads this much before the time a row was written has been corrected since; less is jitter. */
export const CLOCK_STEP_TOLERANCE_MS = 60_000;

/**
 * Whether a stored deadline still holds. `notBefore` is an absolute time written under whatever clock the computer had
 * then, and a clock that ran ahead and was corrected leaves a deadline hours away (W2B-P3-2). A clock that now reads
 * earlier than the row's own write time cannot measure that wait, so the wait is over instead of stretched by the
 * excursion: one early wake costs a request, a stretched wait stops sync for hours.
 */
export function deadlineHolds(state: Pick<DurableSyncEngineState, 'notBefore' | 'updatedAt'>, now: number): boolean {
  return state.notBefore > now && state.updatedAt - now <= CLOCK_STEP_TOLERANCE_MS;
}

/** Whether a stopped engine's next probe is due. A deadline beyond every schedule also means the clock stepped back. */
export function stopProbeDue(state: DurableSyncEngineState, now: number): boolean {
  return !deadlineHolds(state, now) || state.notBefore - now > STOP_PROBE_DELAYS_MS[STOP_PROBE_DELAYS_MS.length - 1]!;
}

/** An `error` state written before probes existed: a stop code, no breaker row, nothing scheduled. */
export function unprobedStop(state: DurableSyncEngineState | null | undefined): boolean {
  return state?.phase === 'error' && state.circuitBreaker === undefined
    && persistentLocalSyncFailure(state.lastError) && !refreshesReplicaIntegrity(state.lastError);
}

/** Count failures across worker restarts, independently for each denial code. */
export function advanceSyncCircuit(prior: SyncCircuitBreaker | undefined, code: string | undefined,
  progress: string, now: number, context: CircuitContext = {}): SyncCircuitBreaker | undefined {
  const policy = classifySyncFailure(code);
  const integrity = refreshesReplicaIntegrity(code);
  if (code && persistentLocalSyncFailure(code) && !integrity) {
    return advanceProbeSchedule(prior, `${STOP_BUCKET_PREFIX}${code}`, progress, now, context.probe === true);
  }
  if (code && stalledTransientWait(code, context.consecutiveFailures ?? 0)) {
    return advanceProbeSchedule(prior, `${STALLED_BUCKET_PREFIX}${code}`, progress, now, context.probe === true);
  }
  if (policy?.class === 'replica' && !integrity || policy?.class === 'item') return undefined;
  // The window keeps the progress it was opened on; a rebase that only dropped evidence does not rename it.
  const base = prior !== undefined && sameSyncProgress(prior.progress, progress) ? prior : undefined;
  if (!code || policy && policy.class !== 'authority' && !integrity) return base;
  const counterCode = integrity ? 'replica_integrity_refresh' : policy ? code : 'unknown_external_failure';
  const failures = (base?.failures ?? []).map(row => ({ ...row,
    attempts: row.attempts.map(at => Math.min(at, now)).filter(at => integrity || now - at < CIRCUIT_WINDOW_MS) })).filter(row => row.attempts.length > 0);
  const previous = failures.find(row => row.code === counterCode);
  const attempts = [...(previous?.attempts ?? []), now].slice(-CIRCUIT_THRESHOLD);
  const trips = base?.trips ?? 0;
  const tripped = attempts.length >= CIRCUIT_THRESHOLD || base?.retryAt !== undefined;
  return { progress: base?.progress ?? progress, failures: [...failures.filter(row => row.code !== counterCode),
    { code: counterCode, attempts }],
  trips: tripped ? Math.min(trips + 1, 32) : trips,
  ...(tripped ? { retryAt: now + Math.min(CIRCUIT_WINDOW_MS, INITIAL_COOLDOWN_MS * 2 ** Math.min(trips, 5)) } : {}) };
}

export function circuitIsStopped(state: DurableSyncEngineState | null | undefined): boolean {
  return state?.phase === 'error' && state.circuitBreaker?.retryAt !== undefined;
}
