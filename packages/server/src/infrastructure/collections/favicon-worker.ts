/**
 * FO-02 favicon worker loops (jobs + GC) — independent loops, not outbox
 * handlers. Both run under the real worker lifecycle in src/bootstrap/worker.ts
 * and reuse the existing lease pattern (claimDue + expiry re-claim).
 */
import { randomUUID } from 'node:crypto';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import {
  processFaviconGcClaim,
  type FaviconGcExecutionPorts,
  type FaviconGcOutcome,
  type FaviconGcWorkerRepository,
  processFaviconRefreshClaim,
  setFaviconRetentionSeconds,
  type FaviconExecutionOutcome,
  type FaviconFetcher,
  type FaviconJobClaim,
  type FaviconJobWorkerPort,
  type FaviconRefreshCasRunner,
  type FaviconRefreshExecutionPorts,
} from '../../modules/collections/index.js';
import {
  processFaviconBatchClaim,
  type FaviconBatchCasRunner,
  type FaviconBatchExecutionPorts,
} from '../../modules/collections/index.js';

export interface FaviconJobWorkerRepository {
  claimDue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<readonly FaviconJobClaim[]>;
  expireOverdue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<readonly FaviconJobClaim[]>;
  readonly worker: FaviconJobWorkerPort;
}

export interface FaviconGcRepository {
  claimDue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<readonly import('../../modules/collections/index.js').FaviconGcClaim[]>;
  readonly repository: FaviconGcWorkerRepository;
}

export interface FaviconWorkerLoopLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface FaviconWorkerLoopOptions {
  readonly maintainSharedCache?: () => Promise<boolean>;
  readonly repository: FaviconJobWorkerRepository;
  readonly gc: FaviconGcRepository;
  readonly verify: FaviconBatchCasRunner & FaviconRefreshCasRunner;
  readonly fetcher: FaviconFetcher;
  readonly store: {
    get(objectId: string): Promise<{ readonly contentType: string; readonly body: Buffer } | null>;
    put(objectId: string, body: Buffer, contentType: string): Promise<void>;
    delete(objectId: string): Promise<void>;
  };
  readonly logger: FaviconWorkerLoopLogger;
  readonly metrics?: Metrics;
  readonly workerId?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly gcPollIntervalMs?: number;
  readonly gcLeaseDurationMs?: number;
  readonly now?: () => Date;
  /** FO-03 per-cycle item cap for batch jobs (FAVICON_JOB_BATCH_SIZE). */
  readonly batchSize?: number;
  readonly options: {
    readonly maxAttempts: number;
    readonly backoffSeconds: readonly number[];
    readonly retentionSeconds: number;
    readonly maxBytes: number;
    readonly maxDecompressedBytes: number;
    readonly fetchTimeoutMs: number;
    readonly maxRedirects: number;
  };
}

export class FaviconJobWorkerLoop {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly executionPorts: FaviconRefreshExecutionPorts;
  private readonly batchExecutionPorts: FaviconBatchExecutionPorts;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;

  constructor(private readonly options: FaviconWorkerLoopOptions) {
    this.workerId = options.workerId ?? `favicon-jobs-${randomUUID()}`;
    this.concurrency = options.concurrency ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) {
      throw new RangeError('invalid favicon job worker timing configuration');
    }
    if (!Array.isArray(options.options.backoffSeconds) || options.options.backoffSeconds.length === 0) {
      throw new TypeError('favicon retry backoff must be a non-empty numeric schedule');
    }
    const batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError('FAVICON_JOB_BATCH_SIZE must be an integer between 1 and 1000');
    }
    setFaviconRetentionSeconds(options.options.retentionSeconds);
    this.executionPorts = {
      verify: options.verify,
      worker: options.repository.worker,
      fetcher: options.fetcher,
      store: options.store,
      clock: { now: async () => this.now() },
      now: this.now,
      options: {
        maxAttempts: options.options.maxAttempts,
        backoffSeconds: options.options.backoffSeconds,
        retentionSeconds: options.options.retentionSeconds,
        maxBytes: options.options.maxBytes,
        maxDecompressedBytes: options.options.maxDecompressedBytes,
        fetchTimeoutMs: options.options.fetchTimeoutMs,
        maxRedirects: options.options.maxRedirects,
      },
    };
    this.batchExecutionPorts = {
      verify: options.verify,
      worker: options.repository.worker,
      fetcher: options.fetcher,
      store: options.store,
      clock: { now: async () => this.now() },
      now: this.now,
      options: {
        ...this.executionPorts.options,
        batchSize,
        leaseDurationMs: this.leaseDurationMs,
      },
    };
    this.options.metrics?.gauge('collections.favicon_jobs.worker_concurrency', this.concurrency);
    this.options.metrics?.gauge('collections.favicon_jobs.batch_size', batchSize);
  }

  isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<boolean> {
    const overdue = await this.options.repository.expireOverdue({
      limit: this.concurrency,
      leaseOwner: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    // FO-08: the overdue sweep already took up to `concurrency` slots, so the
    // pending batch is capped at the remainder — total in-flight claims never
    // exceed the configured concurrency (before, two independent `limit:
    // concurrency` fetches processed up to 2x the bound at once).
    const pending = overdue.length >= this.concurrency
      ? []
      : await this.options.repository.claimDue({
        limit: this.concurrency - overdue.length,
        leaseOwner: this.workerId,
        leaseDurationMs: this.leaseDurationMs,
      });
    const claims = [...overdue, ...pending];
    if (claims.length === 0) return await this.options.maintainSharedCache?.() ?? false;
    this.options.metrics?.increment('collections.favicon_jobs.claims', claims.length);
    await Promise.all(claims.map((claim) => this.processClaim(claim)));
    await this.options.maintainSharedCache?.();
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.resolvePoll?.();
    this.resolvePoll = undefined;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.metrics?.increment('collections.favicon_jobs.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) }, 'favicon job poll failed');
      }
      await this.waitForPoll();
    }
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvePoll = resolve;
      this.pollTimer = setTimeout(() => {
        this.resolvePoll = undefined;
        resolve();
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    });
  }

  private async processClaim(claim: FaviconJobClaim): Promise<void> {
    const ran = await this.options.repository.worker.markRunning({
      jobId: claim.jobId,
      leaseOwner: claim.leaseOwner,
    });
    if (!ran) {
      this.options.metrics?.increment('collections.favicon_jobs.lease_lost');
      return;
    }
    try {
      // FO-03: refresh_one keeps the single-node path; batch operations
      // (fill/refresh_online/apply_force_online/restore_sources) run through
      // the bounded item-cycle executor. No new consumer is registered — the
      // same faviconJobs runtime claims both.
      const result = claim.operation === 'refresh_one'
        ? await processFaviconRefreshClaim(this.executionPorts, claim)
        : await processFaviconBatchClaim(this.batchExecutionPorts, claim);
      const outcome = result.outcome as FaviconExecutionOutcome;
      this.options.metrics?.increment(`collections.favicon_jobs.${outcome}`);
    } catch (error) {
      this.options.metrics?.increment('collections.favicon_jobs.error');
      this.options.logger.error({
        jobId: claim.jobId, error: redactSensitiveText(error),
      }, 'favicon job claim processing failed');
    }
  }
}

export class FaviconGcWorkerLoop {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly gcPorts: FaviconGcExecutionPorts;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;

  constructor(private readonly options: FaviconWorkerLoopOptions) {
    this.workerId = options.workerId !== undefined ? `${options.workerId}-gc` : `favicon-gc-${randomUUID()}`;
    this.concurrency = options.concurrency ?? 2;
    this.pollIntervalMs = options.gcPollIntervalMs ?? 60_000;
    this.leaseDurationMs = options.gcLeaseDurationMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) {
      throw new RangeError('invalid favicon gc worker timing configuration');
    }
    this.gcPorts = {
      store: options.store,
      repository: options.gc.repository,
      backoffSeconds: options.options.backoffSeconds,
      now: this.now,
    };
    this.options.metrics?.gauge('collections.favicon_gc.worker_concurrency', this.concurrency);
  }

  isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<boolean> {
    const claims = await this.options.gc.claimDue({
      limit: this.concurrency,
      leaseOwner: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (claims.length === 0) return false;
    this.options.metrics?.increment('collections.favicon_gc.claims', claims.length);
    await Promise.all(claims.map((claim) => this.processClaim(claim)));
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.resolvePoll?.();
    this.resolvePoll = undefined;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.metrics?.increment('collections.favicon_gc.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) }, 'favicon gc poll failed');
      }
      await this.waitForPoll();
    }
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvePoll = resolve;
      this.pollTimer = setTimeout(() => {
        this.resolvePoll = undefined;
        resolve();
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    });
  }

  private async processClaim(claim: import('../../modules/collections/index.js').FaviconGcClaim): Promise<void> {
    try {
      const result = await processFaviconGcClaim(this.gcPorts, claim);
      const outcome = result.outcome as FaviconGcOutcome;
      this.options.metrics?.increment(`collections.favicon_gc.${outcome}`);
    } catch (error) {
      this.options.metrics?.increment('collections.favicon_gc.error');
      this.options.logger.error({
        objectId: claim.objectId, error: redactSensitiveText(error),
      }, 'favicon gc claim failed');
    }
  }
}

export interface FaviconWorkerRuntime {
  readonly jobs: FaviconJobWorkerLoop;
  readonly gc: FaviconGcWorkerLoop;
}

export function createFaviconWorkerRuntime(
  options: FaviconWorkerLoopOptions,
): FaviconWorkerRuntime {
  return Object.freeze({
    jobs: new FaviconJobWorkerLoop(options),
    gc: new FaviconGcWorkerLoop(options),
  });
}