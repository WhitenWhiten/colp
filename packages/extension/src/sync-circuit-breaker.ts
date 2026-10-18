import type { DurableSyncEngineState } from './sync-state-store.js';
import { classifySyncFailure, refreshesReplicaIntegrity } from './sync-failure-class.js';

export const CIRCUIT_WINDOW_MS = 30 * 60_000;
export const CIRCUIT_THRESHOLD = 5;
const INITIAL_COOLDOWN_MS = 60_000;
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

/** Count failures across worker restarts, independently for each denial code. */
export function advanceSyncCircuit(prior: SyncCircuitBreaker | undefined, code: string | undefined,
  progress: string, now: number): SyncCircuitBreaker | undefined {
  const policy = classifySyncFailure(code);
  const integrity = refreshesReplicaIntegrity(code);
  if (policy?.class === 'replica' && !integrity || policy?.class === 'item') return undefined;
  // The window keeps the progress it was opened on; a rebase that only dropped evidence does not rename it.
  const base = prior !== undefined && sameSyncProgress(prior.progress, progress) ? prior : undefined;
  if (!code || policy && policy.class !== 'authority' && !integrity) return base;
  const counterCode = integrity ? 'replica_integrity_refresh' : policy ? code : 'unknown_external_failure';
  const failures = (base?.failures ?? []).map(row => ({ ...row,
    attempts: row.attempts.filter(at => now >= at && (integrity || now - at < CIRCUIT_WINDOW_MS)) })).filter(row => row.attempts.length > 0);
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
