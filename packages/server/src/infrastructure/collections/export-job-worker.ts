/**
 * Independent export-job worker loop (not an outbox handler).
 * Generates the library JSON outside any outbox lease.
 */
import { randomUUID } from 'node:crypto';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import {
  processExportJobClaim,
  type ExportLibraryProjectionPort,
  type ExportObjectStore,
} from '../../modules/collections/index.js';
import type { ExportJobWorkerRepository } from './export-job-postgres.js';

export interface ExportJobWorkerLoopLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface ExportJobWorkerLoopOptions {
  readonly repository: ExportJobWorkerRepository;
  readonly projection: ExportLibraryProjectionPort;
  readonly store: ExportObjectStore;
  readonly logger: ExportJobWorkerLoopLogger;
  readonly metrics?: Metrics;
  readonly workerId?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export class ExportJobWorkerLoop {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;

  constructor(private readonly options: ExportJobWorkerLoopOptions) {
    this.workerId = options.workerId ?? `export-job-${randomUUID()}`;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) {
      throw new RangeError('invalid export-job worker timing configuration');
    }
    this.options.metrics?.gauge('collections.export_jobs.worker_concurrency', this.concurrency);
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
    const pending = await this.options.repository.claimDue({
      limit: this.concurrency,
      leaseOwner: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    const claims = [...overdue, ...pending];
    if (claims.length === 0) return false;
    this.options.metrics?.increment('collections.export_jobs.claims', claims.length);
    await Promise.all(claims.map(async (claim) => {
      let renewal: Promise<void> | undefined;
      const renewLease = this.options.repository.worker.renewLease;
      const heartbeat = renewLease ? setInterval(() => {
        if (renewal) return; // Slow control SQL must not create a tick-sized backlog.
        renewal = Promise.resolve().then(async () => {
          const renewed = await renewLease({ ...claim, leaseDurationMs: this.leaseDurationMs });
          if (!renewed) clearInterval(heartbeat);
        }).catch(error => {
          clearInterval(heartbeat);
          this.options.logger.warn({ error: redactSensitiveText(error) }, 'export-job renewal failed');
        }).finally(() => { renewal = undefined; });
      }, Math.max(100, Math.floor(this.leaseDurationMs / 3))) : undefined;
      heartbeat?.unref();
      try {
        await processExportJobClaim({
          worker: this.options.repository.worker,
          projection: this.options.projection,
          store: this.options.store,
          clock: { now: this.now },
          ...(this.options.maxBytes === undefined ? {} : { maxBytes: this.options.maxBytes }),
        }, claim);
      } catch (error) {
        this.options.metrics?.increment('collections.export_jobs.error');
        this.options.logger.error({
          jobId: claim.jobId,
          error: redactSensitiveText(error),
        }, 'export-job claim failed');
      } finally {
        clearInterval(heartbeat);
        await renewal;
      }
    }));
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
        this.options.metrics?.increment('collections.export_jobs.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) }, 'export-job poll failed');
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
}

export interface ExportJobWorkerRuntime {
  readonly loop: ExportJobWorkerLoop;
}

export function createExportJobWorkerRuntime(
  options: ExportJobWorkerLoopOptions,
): ExportJobWorkerRuntime {
  return Object.freeze({
    loop: new ExportJobWorkerLoop(options),
  });
}
