import { AuthorityFencedError } from '../authority-fence.js';
import type { StorageArea } from '../credential-store.js';
import type { createSyncStateStore, SyncScope } from '../sync-state-store.js';

/**
 * Rule E: a step of an engine wake that throws must not vanish. Before this, a failing pre-step
 * (`replicaRebuilder().resume()`, the missing-removal scan, plan activation) either returned
 * silently or died in an unhandled rejection, and Status showed an engine that was fine.
 *
 * The record lives in `chrome.storage.local` because the failing step is often the IndexedDB one;
 * a scope diagnostic row is written too when the store works, for the diagnostics export. Status
 * and the health report read it through `readVisibleWakeFailures`.
 */
export const WAKE_FAILURE_KEY = 'known.sync.wake-failures.v1';
/** Consecutive failing wakes before a step is reported; a step that fails once and recovers is not news. */
export const WAKE_FAILURE_VISIBLE_AFTER = 3;
/** Waits and fences that Status already shows by other means; never recorded as a failing step. */
const WAITS: ReadonlySet<string> = new Set(['not_connected', 'collection_required', 'permission_required', 'offline',
  'network_unavailable', 'authority_fenced', 'session_expired', 'engine_revision_stale']);
/** A code that means "wait", not "broken": the caller stops quietly and tries again on a later wake. */
export const isWakeWait = (code: string) => WAITS.has(code);
const CODE = /^[a-z][a-z0-9_:-]{0,63}$/u;
const STAGE = /^[a-z][a-z0-9_]{0,47}$/u;
const MAX_STAGES = 16;

export interface WakeFailure {
  readonly stage: string;
  /** The stable code of the error that stopped the step. */
  readonly code: string;
  /** Consecutive failing wakes. */
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  /** The replica the record belongs to; absent while no scope could be located. */
  readonly replicaId?: string;
}
type Stored = Record<string, WakeFailure>;
type Storage = Pick<StorageArea, 'get' | 'set' | 'remove'>;

/** The code a thrown value stands for; same rule as `safeError` in sw/runtime.ts, without its imports. */
export function wakeFailureCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
  if (typeof code === 'string' && CODE.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  if (CODE.test(message)) return message;
  if (/fetch|network|abort/iu.test(message)) return 'offline';
  return error instanceof Error && /^[A-Za-z]+Error$/u.test(error.name) ? `operation_${error.name.toLowerCase()}` : 'operation_failed';
}

export function createWakeFailureLog(storage: Storage, now: () => number = Date.now) {
  async function read(): Promise<Stored> {
    try {
      const value = (await storage.get(WAKE_FAILURE_KEY))[WAKE_FAILURE_KEY];
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Stored : {};
    } catch { return {}; }
  }
  /** Records one failing wake of `stage`; returns undefined for a wait or when nothing could be stored. */
  async function record(stage: string, error: unknown, replicaId?: string): Promise<WakeFailure | undefined> {
    if (error instanceof AuthorityFencedError || !STAGE.test(stage)) return undefined;
    const code = wakeFailureCode(error);
    if (WAITS.has(code)) return undefined;
    try {
      const all = await read(); const prior = all[stage]; const at = now();
      const sameRun = prior !== undefined && prior.replicaId === replicaId;
      const failure: WakeFailure = { stage, code, count: sameRun ? Math.min(prior.count + 1, 1_000_000) : 1,
        firstAt: sameRun ? prior.firstAt : at, lastAt: at, ...(replicaId === undefined ? {} : { replicaId }) };
      const next: Stored = { ...all, [stage]: failure };
      // A bounded record: the oldest stages go first if a bug ever invents many.
      for (const name of Object.keys(next).sort((a, b) => next[a]!.lastAt - next[b]!.lastAt)
        .slice(0, Math.max(0, Object.keys(next).length - MAX_STAGES))) delete next[name];
      await storage.set({ [WAKE_FAILURE_KEY]: next });
      return failure;
    } catch { return undefined; }
  }
  async function clear(stage: string): Promise<void> {
    try {
      const all = await read(); if (all[stage] === undefined) return;
      const { [stage]: _gone, ...rest } = all;
      if (Object.keys(rest).length === 0) await storage.remove(WAKE_FAILURE_KEY); else await storage.set({ [WAKE_FAILURE_KEY]: rest });
    } catch { /* a marker that cannot be cleared is cleared by the next successful wake */ }
  }
  /** The failures Status shows: repeated, and belonging to this replica (or to no scope yet). */
  async function visible(replicaId?: string): Promise<WakeFailure[]> {
    return Object.values(await read()).filter((failure) => failure.count >= WAKE_FAILURE_VISIBLE_AFTER
      && (failure.replicaId === undefined || replicaId === undefined || failure.replicaId === replicaId))
      .sort((left, right) => left.firstAt - right.firstAt);
  }
  return { record, clear, visible };
}
export type WakeFailureLog = ReturnType<typeof createWakeFailureLog>;

const NO_STORAGE: Storage = { get: async () => ({}), set: async () => undefined, remove: async () => undefined };
/** The worker's own log; outside an extension (a unit test without `chrome`) records go nowhere. */
export function workerWakeFailureLog(): WakeFailureLog {
  return createWakeFailureLog(typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : NO_STORAGE);
}

export type GuardedStep<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/**
 * The guard one wake pass uses. A failure is mirrored into the scope diagnostics (the diagnostics
 * export) as soon as the scope is known; steps that fail before it is located are mirrored then.
 */
export function createWakeSteps(log: WakeFailureLog, store: Pick<ReturnType<typeof createSyncStateStore>, 'putScopeDiagnostic'>) {
  let located: SyncScope | undefined; const deferred: WakeFailure[] = [];
  const mirror = (scope: SyncScope, failure: WakeFailure) => store.putScopeDiagnostic(scope, { kind: 'wake_failure',
    code: failure.stage, details: { code: failure.code, count: failure.count, firstAt: failure.firstAt, lastAt: failure.lastAt } });
  const diagnose = async (failure: WakeFailure) => { if (located) await mirror(located, failure); else deferred.push(failure); };
  const step = <T>(stage: string, run: () => Promise<T>) => guardWakeStep(log, stage, run,
    { ...(located ? { replicaId: located.replicaId } : {}), diagnose });
  /** Like `step`, for a step the wake does not need: its value, or undefined when it failed. */
  const attempt = async <T>(stage: string, run: () => Promise<T>): Promise<T | undefined> => {
    const outcome = await step(stage, run); return outcome.ok ? outcome.value : undefined;
  };
  const locate = async (scope: SyncScope) => {
    located = scope;
    for (const failure of deferred.splice(0)) await mirror(scope, failure).catch(() => undefined);
  };
  return { step, attempt, locate };
}

/**
 * Runs one wake step. A throw is recorded (and mirrored into the scope diagnostics) and returned as a
 * failure so the caller decides whether the wake can go on; a fence still unwinds the wake.
 */
export async function guardWakeStep<T>(log: WakeFailureLog, stage: string, step: () => Promise<T>,
  options: { readonly replicaId?: string;
    readonly diagnose?: (failure: WakeFailure) => Promise<unknown> } = {}): Promise<GuardedStep<T>> {
  try {
    const value = await step();
    await log.clear(stage);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof AuthorityFencedError) throw error;
    const failure = await log.record(stage, error, options.replicaId);
    if (failure && options.diagnose) await options.diagnose(failure).catch(() => undefined);
    return { ok: false, code: failure?.code ?? wakeFailureCode(error) };
  }
}
