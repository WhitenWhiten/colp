import { assertCanonicalCommandId } from '../../commands/index.js';
import {
  catchUpOccurrences,
  deterministicRunIdentity,
  occurrences,
} from './schedule.js';
import type { DigestRun, DigestSchedule } from '../domain/types.js';

/**
 * The scheduler store is deliberately narrow.  Implementations must back all
 * methods with the durable run ledger; Redis or process memory is not a valid
 * implementation.  The optional generation arguments are lease fencing tokens
 * and are ignored only by legacy test doubles.
 */
export interface DigestSchedulerStore {
  listDue(now: Date, limit: number): Promise<readonly DigestSchedule[]>;
  /** Durable pending/retryable/expired-leased runs, independent of RRULE catch-up. */
  listDueRuns(now: Date, limit: number): Promise<readonly DigestRun[]>;
  /** Resolve ledger work independently of the schedule discovery page; null if inactive. */
  getSchedule(scheduleId: string): Promise<DigestSchedule | null>;
  upsertRun(run: Omit<DigestRun, 'id'> & { readonly scheduleRevision: string }): Promise<DigestRun>;
  claimRun(
    runId: string,
    owner: string,
    leaseMs: number,
    now: Date,
    expectedGeneration?: number,
  ): Promise<DigestRun | null>;
  completeRun(runId: string, owner: string, generation?: number): Promise<void | boolean>;
  retryRun(
    runId: string,
    owner: string,
    errorClass: string,
    nextAttemptAt: Date,
    generation?: number,
  ): Promise<void | boolean>;
  /** Terminal failure after the bounded attempt budget is exhausted. */
  failRun?: (runId: string, owner: string, errorClass: string, generation?: number) => Promise<void | boolean>;
  /** Move the schedule pointer without rewriting historical runs. */
  advanceSchedule?: (scheduleId: string, nextRunAt: Date | null, expectedRevision?: string) => Promise<void>;
}

export interface DigestScheduleConnector {
  /**
   * Submit only the opaque run identity and the already-authorized series id.
   * Implementations must honor AbortSignal promptly and make submission
   * idempotent by commandId: a deadline cannot retract an external request
   * that was already accepted by the connector.
   */
  readonly submit: (run: DigestRun, seriesId: string, signal?: AbortSignal) => Promise<{ issueKey: string; commandId: string }>;
}

export interface DigestSchedulerOptions {
  readonly store: DigestSchedulerStore;
  readonly connector?: DigestScheduleConnector;
  readonly ownerId: string;
  readonly leaseMs?: number;
  /** Connector deadline; always bounded below the lease duration. */
  readonly handlerTimeoutMs?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
  /** Process at most this many missed occurrences for a catch-up schedule. */
  readonly maxCatchUp?: number;
  readonly maxOccurrenceLimit?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OCCURRENCE_LIMIT = 100;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 20;
const MAX_POLL_INTERVAL_MS = 60_000;
/** Hard safety ceiling; deployment config may only lower this value. */
const MAX_CATCH_UP = 100;
const MAX_OCCURRENCE_LIMIT = 1_000;
const DAY_MS = 86_400_000;

type RunGeneration = DigestRun & { readonly leaseGeneration?: number | bigint };

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} is out of range`);
  return value;
}

function generationOf(run: DigestRun): number | undefined {
  const value = (run as RunGeneration).leaseGeneration;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeErrorClass(error: unknown): string {
  if (error instanceof Error && /identity mismatch/iu.test(error.message)) return 'identity_mismatch';
  if (error instanceof Error && /timeout|deadline|abort/iu.test(error.message)) return 'connector_timeout';
  return 'connector_error';
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`invalid ${label}`);
  return new Date(value.getTime());
}

function dueWindow(
  schedule: DigestSchedule,
  now: Date,
  limit: number,
  maxCatchUp: number,
): Date[] {
  const scheduleStart = validDate(new Date(schedule.dtstart), 'schedule dtstart');
  const pointer = schedule.nextRunAt === null ? null : validDate(new Date(schedule.nextRunAt), 'schedule nextRunAt');
  // A future pointer can only be useful for a future occurrence.  If the
  // store surfaced an unfinished retry while that pointer is ahead (for
  // example after a lease takeover), fall back to the bounded recent window
  // so the retry can be reclaimed instead of being hidden forever.
  const from = pointer && pointer.getTime() > scheduleStart.getTime()
    && pointer.getTime() <= now.getTime()
    ? pointer
    : new Date(Math.max(scheduleStart.getTime(), now.getTime() - DAY_MS));
  if (from.getTime() > now.getTime()) return [];
  if (schedule.catchUpPolicy === 'one') {
    // Apply the deployment-wide cap before expanding the RRULE.  This keeps a
    // permissive schedule row from bypassing REPORTS_MAX_CATCH_UP and also
    // makes a configured zero quota an explicit no-catch-up policy.
    const quota = Math.min(schedule.maxCatchUp, maxCatchUp, limit);
    if (quota < 1) return [];
    if (pointer) {
      return occurrences(schedule, from, now, quota);
    }
    const boundedSchedule = schedule.maxCatchUp === quota
      ? schedule
      : { ...schedule, maxCatchUp: quota };
    return catchUpOccurrences(boundedSchedule, now).slice(-quota);
  }
  return occurrences(schedule, from, now, Math.max(1, Math.min(limit, 1)));
}

function nextDiscoveryAt(schedule: DigestSchedule, now: Date): Date {
  // This is a durable discovery checkpoint, not necessarily an occurrence.
  // Empty finite rules and sparse rules both advance beyond the scanned window;
  // null is reserved for a schedule that has never been scanned.
  const horizon = new Date(now.getTime() + 366 * DAY_MS);
  return occurrences(schedule, new Date(now.getTime() + 1), horizon, 1)[0] ?? horizon;
}

function assertConnectorIdentity(
  submitted: { issueKey: string; commandId: string } | null | undefined,
  run: DigestRun,
): void {
  if (!submitted || submitted.issueKey !== run.issueKey || submitted.commandId !== run.commandId) {
    throw new Error('connector identity mismatch');
  }
  if (typeof submitted.issueKey !== 'string' || typeof submitted.commandId !== 'string') {
    throw new Error('connector identity mismatch');
  }
  try {
    assertCanonicalCommandId(submitted.commandId);
  } catch {
    throw new Error('connector identity mismatch');
  }
}

export interface DigestScheduler {
  readonly runOnce: () => Promise<number>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly isRunning: () => boolean;
}

/** Create a bounded, restart-safe scheduler loop. */
export function createDigestScheduler(options: DigestSchedulerOptions): DigestScheduler {
  if (typeof options.ownerId !== 'string' || options.ownerId.length < 1 || options.ownerId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(options.ownerId)) throw new RangeError('invalid scheduler owner id');
  const leaseMs = boundedInteger(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000, MAX_LEASE_MS, 'leaseMs');
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE, 'batchSize');
  const maxAttempts = boundedInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS, 'maxAttempts');
  const pollIntervalMs = boundedInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 100, MAX_POLL_INTERVAL_MS, 'pollIntervalMs');
  const maxCatchUp = boundedInteger(options.maxCatchUp ?? MAX_CATCH_UP, 0, MAX_CATCH_UP, 'maxCatchUp');
  const maxOccurrenceLimit = boundedInteger(options.maxOccurrenceLimit ?? DEFAULT_OCCURRENCE_LIMIT, 1, MAX_OCCURRENCE_LIMIT, 'maxOccurrenceLimit');
  const handlerTimeoutMs = boundedInteger(
    options.handlerTimeoutMs ?? Math.max(1_000, leaseMs - 1_000),
    100,
    leaseMs,
    'handlerTimeoutMs',
  );
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let running = false;
  let runInProgress: Promise<number> | undefined;
  let loopPromise: Promise<void> | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let resolvePoll: (() => void) | undefined;

  const reportError = (error: unknown): void => {
    options.onError?.(error);
  };

  async function processOccurrence(
    schedule: DigestSchedule,
    instant: Date,
    currentTime: Date,
  ): Promise<'processed' | 'retrying' | 'failed' | 'skipped' | 'deferred'> {
    const identity = deterministicRunIdentity(schedule.id, instant);
    const run = await options.store.upsertRun({
      scheduleId: schedule.id,
      scheduleRevision: schedule.resourceRevision,
      occurrenceKey: identity.occurrenceKey,
      scheduledFor: identity.occurrenceKey,
      state: 'pending',
      leaseOwner: null,
      leaseUntil: null,
      leaseGeneration: 0,
      attemptCount: 0,
      nextAttemptAt: null,
      lastErrorClass: null,
      issueKey: identity.issueKey,
      commandId: identity.commandId,
      editionId: null,
    });
    const claimed = await options.store.claimRun(
      run.id,
      options.ownerId,
      leaseMs,
      currentTime,
      generationOf(run),
    );
    if (!claimed) {
      return run.state === 'pending' || run.state === 'retryable' || run.state === 'leased'
        ? 'deferred' : 'skipped';
    }
    return executeClaimed(schedule, claimed, currentTime);
  }

  async function processLedgerRun(
    schedule: DigestSchedule,
    run: DigestRun,
    currentTime: Date,
  ): Promise<'processed' | 'retrying' | 'failed' | 'skipped' | 'deferred'> {
    const claimed = await options.store.claimRun(
      run.id,
      options.ownerId,
      leaseMs,
      currentTime,
      generationOf(run),
    );
    if (!claimed) {
      return run.state === 'pending' || run.state === 'retryable' || run.state === 'leased'
        ? 'deferred' : 'skipped';
    }
    return executeClaimed(schedule, claimed, currentTime);
  }

  async function executeClaimed(
    schedule: DigestSchedule,
    claimed: DigestRun,
    currentTime: Date,
  ): Promise<'processed' | 'retrying' | 'failed' | 'skipped' | 'deferred'> {
    const generation = generationOf(claimed);
    try {
      if (!options.connector) throw new Error('scheduler connector unavailable');
      const controller = new AbortController();
      let timeout: NodeJS.Timeout | undefined;
      const connector = options.connector.submit(claimed, schedule.seriesId, controller.signal);
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error('reports scheduler connector deadline exceeded'));
          reject(new Error('reports scheduler connector deadline exceeded'));
        }, handlerTimeoutMs);
        timeout.unref?.();
      });
      let submitted: { issueKey: string; commandId: string };
      try {
        submitted = await Promise.race([connector, deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      assertConnectorIdentity(submitted, claimed);
      await options.store.completeRun(claimed.id, options.ownerId, generation);
      return 'processed';
    } catch (error) {
      const attempt = Math.max(0, claimed.attemptCount);
      const errorClass = safeErrorClass(error);
      const delay = Math.min(3_600_000, 1_000 * (2 ** Math.min(attempt, 10)));
      if (attempt >= maxAttempts && options.store.failRun) {
        await options.store.failRun(claimed.id, options.ownerId, errorClass, generation);
      } else {
        await options.store.retryRun(
          claimed.id,
          options.ownerId,
          attempt >= maxAttempts ? 'max_attempts' : errorClass,
          new Date(currentTime.getTime() + delay),
          generation,
        );
      }
      reportError(error);
      return attempt >= maxAttempts ? 'failed' : 'retrying';
    }
  }

  async function runOnceInternal(): Promise<number> {
    if (stopped || !options.connector) return 0;
    const currentTime = validDate(now(), 'scheduler clock');
    let processed = 0;
    const schedules = await options.store.listDue(currentTime, batchSize);
    const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
    const parked = new Set<string>();
    for (const run of await options.store.listDueRuns(currentTime, batchSize)) {
      // The two bounded queries have different orderings; their pages need not overlap.
      const schedule = byId.get(run.scheduleId) ?? await options.store.getSchedule(run.scheduleId);
      if (!schedule?.enabled) continue;
      const outcome = await processLedgerRun(schedule, run, currentTime);
      if (outcome !== 'skipped' && outcome !== 'deferred') processed += 1;
      if (outcome === 'retrying' || outcome === 'deferred') parked.add(schedule.id);
    }
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      let due: Date[];
      try {
        due = dueWindow(schedule, currentTime, maxOccurrenceLimit, maxCatchUp);
      } catch (error) {
        reportError(error);
        continue;
      }
      let canAdvance = !parked.has(schedule.id);
      for (const instant of due) {
        const outcome = await processOccurrence(schedule, instant, currentTime);
        if (outcome !== 'skipped' && outcome !== 'deferred') processed += 1;
        if (outcome === 'retrying' || outcome === 'deferred') {
          canAdvance = false;
          break;
        }
      }
      if (canAdvance && options.store.advanceSchedule) {
        await options.store.advanceSchedule(schedule.id, nextDiscoveryAt(schedule, currentTime), schedule.resourceRevision);
      }
    }
    return processed;
  }

  async function runOnce(): Promise<number> {
    if (runInProgress) return runInProgress;
    runInProgress = runOnceInternal().finally(() => { runInProgress = undefined; });
    return runInProgress;
  }

  async function runLoop(): Promise<void> {
    while (running) {
      try {
        await runOnce();
      } catch (error) {
        reportError(error);
      }
      if (running) await waitForPoll();
    }
  }

  function waitForPoll(): Promise<void> {
    return new Promise<void>((resolve) => {
      resolvePoll = resolve;
      pollTimer = setTimeout(() => {
        resolvePoll = undefined;
        resolve();
      }, pollIntervalMs);
      pollTimer.unref?.();
    }).finally(() => {
      pollTimer = undefined;
      resolvePoll = undefined;
    });
  }

  function start(): void {
    if (running || stopped) return;
    running = true;
    loopPromise = runLoop();
  }

  async function stop(): Promise<void> {
    stopped = true;
    running = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    resolvePoll?.();
    resolvePoll = undefined;
    await loopPromise;
    await runInProgress;
    loopPromise = undefined;
  }

  return Object.freeze({
    runOnce,
    start,
    stop,
    isRunning: () => running,
  });
}
