import type {
  LedgerArchiveExportClaim,
  LedgerArchiveExportJobRepository,
} from '../database/ledger-archive-export-job-repository.js';

export interface LedgerArchiveExportWorkerLogger {
  info(bindings: Readonly<{ code: string }>, message: string): void;
  warn(bindings: Readonly<{ code: string }>, message: string): void;
}

export interface LedgerArchiveExportWorkerOptions {
  readonly jobs: LedgerArchiveExportJobRepository;
  readonly leaseOwner: string;
  readonly exportSegment: (segmentId: string, signal: AbortSignal) => Promise<void>;
  readonly classifyFailure?: (error: unknown) => Readonly<{ errorClass: string; retryable: boolean }>;
  readonly logger?: LedgerArchiveExportWorkerLogger;
  readonly leaseDurationMs?: number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
}

export interface LedgerArchiveExportWorkerRuntime {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly tick: () => Promise<boolean>;
  /** Compatibility alias for one explicitly driven tick. */
  readonly runOnce: () => Promise<boolean>;
  readonly isRunning: () => boolean;
}

/** Construction is passive; callers explicitly start a loop or drive bounded ticks. */
export function createLedgerArchiveExportWorker(
  options: LedgerArchiveExportWorkerOptions,
): LedgerArchiveExportWorkerRuntime {
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const concurrency = options.concurrency ?? 1;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  assertRuntimeOptions({ leaseDurationMs, retryDelayMs, maxAttempts, concurrency, pollIntervalMs });

  let running = false;
  let stopController: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let tickPromise: Promise<boolean> | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let resolvePoll: (() => void) | undefined;

  const tick = (): Promise<boolean> => {
    stopController ??= new AbortController();
    tickPromise ??= tickInternal(options, {
      leaseDurationMs, retryDelayMs, maxAttempts, concurrency,
      ...(stopController === undefined ? {} : { signal: stopController.signal }),
    }).finally(() => { tickPromise = undefined; });
    return tickPromise;
  };

  const waitForPoll = (): Promise<void> => new Promise((resolve) => {
    resolvePoll = resolve;
    pollTimer = setTimeout(() => {
      resolvePoll = undefined;
      pollTimer = undefined;
      resolve();
    }, pollIntervalMs);
    pollTimer.unref();
  });

  const runLoop = async (): Promise<void> => {
    while (running) {
      try {
        await tick();
      } catch {
        options.logger?.warn({ code: 'ledger_archive_poll_failed' }, 'ledger archive worker poll failed');
      }
      if (running) await waitForPoll();
    }
  };

  const runtime: LedgerArchiveExportWorkerRuntime = {
    start() {
      if (running) return;
      running = true;
      stopController = new AbortController();
      options.logger?.info({ code: 'ledger_archive_worker_started' }, 'ledger archive worker started');
      loopPromise = runLoop();
    },
    async stop() {
      if (!running && loopPromise === undefined && tickPromise === undefined) return;
      running = false;
      stopController?.abort('worker_stop');
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      resolvePoll?.();
      resolvePoll = undefined;
      const pending: Promise<unknown>[] = [];
      if (loopPromise) pending.push(loopPromise);
      if (tickPromise) pending.push(tickPromise);
      await Promise.all(pending);
      loopPromise = undefined;
      stopController = undefined;
      options.logger?.info({ code: 'ledger_archive_worker_stopped' }, 'ledger archive worker stopped');
    },
    tick,
    runOnce: tick,
    isRunning: () => running,
  };
  return Object.freeze(runtime);
}

async function tickInternal(
  options: LedgerArchiveExportWorkerOptions,
  runtime: Readonly<{
    leaseDurationMs: number;
    retryDelayMs: number;
    maxAttempts: number;
    concurrency: number;
    signal?: AbortSignal;
  }>,
): Promise<boolean> {
  if (runtime.signal?.aborted) return false;
  const claims = await options.jobs.claimDue({
    leaseOwner: options.leaseOwner,
    leaseDurationMs: runtime.leaseDurationMs,
    limit: runtime.concurrency,
  });
  if (claims.length === 0) return false;
  await Promise.all(claims.map((claim) => processClaim(options, claim, runtime)));
  return true;
}

async function processClaim(
  options: LedgerArchiveExportWorkerOptions,
  claim: LedgerArchiveExportClaim,
  runtime: Readonly<{
    leaseDurationMs: number;
    retryDelayMs: number;
    maxAttempts: number;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  const controller = new AbortController();
  let leaseTimedOut = false;
  const abortFromStop = (): void => controller.abort('worker_stop');
  runtime.signal?.addEventListener('abort', abortFromStop, { once: true });
  if (runtime.signal?.aborted) abortFromStop();
  const leaseTimer = setTimeout(() => {
    leaseTimedOut = true;
    controller.abort('lease_timeout');
  }, runtime.leaseDurationMs);
  leaseTimer.unref();
  try {
    controller.signal.throwIfAborted();
    await options.exportSegment(claim.segmentId, controller.signal);
    controller.signal.throwIfAborted();
    await options.jobs.succeed(claim);
  } catch (error) {
    const classified = leaseTimedOut
      ? { errorClass: 'archive_lease_timeout', retryable: true }
      : runtime.signal?.aborted
        ? { errorClass: 'archive_worker_stopped', retryable: true }
        : options.classifyFailure?.(error) ?? {
            errorClass: 'archive_export_failed', retryable: true,
          };
    options.logger?.warn(
      { code: classified.errorClass },
      'ledger archive export claim failed',
    );
    if (classified.retryable && (runtime.signal?.aborted || claim.attemptCount < runtime.maxAttempts)) {
      await options.jobs.retry(claim, classified.errorClass, runtime.retryDelayMs);
    } else {
      await options.jobs.fail(claim, classified.errorClass);
    }
  } finally {
    clearTimeout(leaseTimer);
    runtime.signal?.removeEventListener('abort', abortFromStop);
  }
}

function assertRuntimeOptions(input: Readonly<{
  leaseDurationMs: number;
  retryDelayMs: number;
  maxAttempts: number;
  concurrency: number;
  pollIntervalMs: number;
}>): void {
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000
      || input.leaseDurationMs > 3_600_000
      || !Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0
      || input.retryDelayMs > 86_400_000
      || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100
      || !Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 100
      || !Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 10
      || input.pollIntervalMs > 3_600_000) {
    throw new RangeError('ledger_archive_worker_options_invalid');
  }
}
