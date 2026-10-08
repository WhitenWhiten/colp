import { observeBestEffort } from '../async/best-effort.js';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import type { EventEnvelopeRegistry, VersionedEventEnvelope } from './envelope.js';
import type { OutboxClaim, OutboxRepository } from './repository.js';
import {
  OutboxContinuationRequested,
  OutboxDeliveryError,
  TransientSideEffectCompletionError,
  type OutboxRouter,
  type OutboxRoute,
  type PublicationCachePurgeReadiness,
} from './router.js';

export interface OutboxWorkerLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface OutboxRetryPolicy {
  readonly maxAttempts: number;
  retryDelayMs(attemptCount: number): number;
}

export interface VersionedOutboxWorkerOptions {
  readonly repository: OutboxRepository;
  readonly router: OutboxRouter;
  readonly envelopes: EventEnvelopeRegistry;
  readonly logger: OutboxWorkerLogger;
  readonly metrics?: Metrics;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly maxConcurrentHandlers?: number;
  /** Max claims launched per poll cycle; always capped by maxConcurrentHandlers. */
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  /** Independent backlog telemetry cadence; never runs in the claim path. */
  readonly backlogSampleIntervalMs?: number;
  readonly retryPolicy?: OutboxRetryPolicy;
  /**
   * Hard ceiling for stop() drain. Abort-ignoring handlers remain tracked, but
   * shutdown must still return so SIGTERM / rolling deploys cannot hang forever.
   * Defaults to handlerTimeoutMs.
   */
  readonly shutdownDeadlineMs?: number;
  /**
   * Unit-harness opt-in: allow permanent completion after a transient side-effect route.
   * Production must leave this false/undefined so transient projections never complete events.
   */
  readonly acknowledgeTransientSideEffects?: boolean;
  /**
   * Honest publication cache purge provider readiness state at composition time. Overlaid
   * onto projectionReadiness() so a test-mode no-op purge provider ('stubbed') is never
   * reported as durable. Omitted for direct constructions, where the route-declared default
   * (configured ? 'durable' : 'missing') is used.
   */
  readonly publicationCachePurgeState?: 'durable' | 'stubbed' | 'missing';
}

/** Credential-free worker capacity/readiness snapshot. */
export interface OutboxWorkerConcurrencyReadiness {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly handlerTimeoutMs: number;
  readonly maxConcurrentHandlers: number;
  readonly activeHandlers: number;
  readonly running: boolean;
}

export interface OutboxWorker {
  runOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
  /** Actionable readiness for projection durability (metrics-friendly, no secrets). */
  projectionReadiness(): {
    readonly routeCount: number;
    readonly durableCount: number;
    readonly transientCount: number;
    readonly allDurable: boolean;
    readonly acknowledgesTransientSideEffects: boolean;
    readonly publicationCachePurge: PublicationCachePurgeReadiness;
  };
  /** Bounded concurrency capacity and live in-flight count (no secrets). */
  concurrencyReadiness(): OutboxWorkerConcurrencyReadiness;
}

export interface ExponentialRetryPolicyOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

export function createExponentialRetryPolicy(
  options: ExponentialRetryPolicyOptions = {},
): OutboxRetryPolicy {
  const base = options.baseDelayMs ?? 1_000;
  const cap = options.maxDelayMs ?? 300_000;
  const maxAttempts = options.maxAttempts ?? 10;
  const jitter = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  if (base < 1 || cap < base || maxAttempts < 1 || jitter < 0 || jitter > 1) {
    throw new RangeError('invalid exponential retry policy');
  }
  return Object.freeze({
    maxAttempts,
    retryDelayMs(attemptCount: number): number {
      const exponential = Math.min(cap, base * (2 ** Math.max(0, attemptCount - 1)));
      const factor = 1 - jitter + (2 * jitter * random());
      return Math.max(1, Math.round(exponential * factor));
    },
  });
}

function envelopeFromClaim(claim: OutboxClaim): unknown {
  return {
    event_id: claim.eventId,
    event_type: claim.eventType,
    event_version: claim.eventVersion,
    aggregate_identity: {
      aggregate_type: claim.aggregateType,
      aggregate_id: claim.aggregateId,
      aggregate_scope: claim.aggregateScope,
    },
    aggregate_revision: claim.aggregateRevision,
    commit_ordinal: claim.commitOrdinal,
    occurred_at: claim.occurredAt.toISOString(),
    payload: claim.payload,
  };
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error : `UnknownError: ${String(error)}`);
}

/** Resolves true when `work` is still pending after `deadlineMs`. */
function raceDeadline(work: Promise<void>, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), deadlineMs);
    timer.unref?.();
    work.then(
      () => { clearTimeout(timer); resolve(false); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

export class VersionedOutboxWorker implements OutboxWorker {
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly backlogSampleIntervalMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly shutdownDeadlineMs: number;
  private readonly maxConcurrentHandlers: number;
  private readonly batchSize: number;
  private readonly retryPolicy: OutboxRetryPolicy;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private backlogLoopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;
  private backlogTimer: NodeJS.Timeout | undefined;
  private resolveBacklogWait: (() => void) | undefined;
  private readonly activeHandlers = new Set<AbortController>();
  private readonly lingeringHandlers = new Set<Promise<void>>();
  private activeHandlerCount = 0;
  private lingeringHandlerCount = 0;

  constructor(private readonly options: VersionedOutboxWorkerOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.backlogSampleIntervalMs = options.backlogSampleIntervalMs ?? 30_000;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? this.leaseDurationMs;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? this.handlerTimeoutMs;
    this.maxConcurrentHandlers = options.maxConcurrentHandlers ?? 1;
    this.batchSize = options.batchSize ?? 1;
    this.retryPolicy = options.retryPolicy ?? createExponentialRetryPolicy();
    if (this.leaseDurationMs < 1 || this.heartbeatIntervalMs < 1
      || this.heartbeatIntervalMs >= this.leaseDurationMs || this.pollIntervalMs < 1
      || !Number.isInteger(this.backlogSampleIntervalMs) || this.backlogSampleIntervalMs < 1
      || !Number.isInteger(this.handlerTimeoutMs) || this.handlerTimeoutMs < 1
      || !Number.isInteger(this.shutdownDeadlineMs) || this.shutdownDeadlineMs < 1
      || !Number.isInteger(this.maxConcurrentHandlers) || this.maxConcurrentHandlers < 1
      || !Number.isInteger(this.batchSize) || this.batchSize < 1
      || this.batchSize > this.maxConcurrentHandlers
      || this.handlerTimeoutMs > this.leaseDurationMs) {
      throw new RangeError('invalid outbox worker timing configuration');
    }
    this.publishDurabilityTelemetry();
    this.options.metrics?.gauge('outbox.worker_concurrency', this.maxConcurrentHandlers);
    this.options.metrics?.gauge('outbox.worker_batch_size', this.batchSize);
    this.options.metrics?.gauge('outbox.worker_poll_interval_ms', this.pollIntervalMs);
    this.options.metrics?.gauge('outbox.worker_lease_duration_ms', this.leaseDurationMs);
  }

  /** Actionable readiness snapshot for projection durability (no secrets). */
  projectionReadiness(): {
    readonly routeCount: number;
    readonly durableCount: number;
    readonly transientCount: number;
    readonly allDurable: boolean;
    readonly acknowledgesTransientSideEffects: boolean;
    readonly publicationCachePurge: PublicationCachePurgeReadiness;
  } {
    const inspection = this.options.router.durabilityInspection();
    return Object.freeze({
      ...inspection,
      acknowledgesTransientSideEffects: this.options.acknowledgeTransientSideEffects === true,
      publicationCachePurge: this.publicationCachePurgeReadiness(),
    });
  }

  /** Honest publication cache purge readiness: overlays the actual provider state. */
  private publicationCachePurgeReadiness(): PublicationCachePurgeReadiness {
    const routeLevel = this.options.router.durabilityInspection().publicationCachePurge;
    const state = this.options.publicationCachePurgeState
      ?? (routeLevel.configured ? 'durable' : 'missing');
    return Object.freeze({
      configured: routeLevel.configured,
      routeCount: routeLevel.routeCount,
      durableCount: routeLevel.durableCount,
      allDurable: routeLevel.configured && state === 'durable',
      state,
    });
  }

  /** Bounded concurrency capacity and live in-flight count (no secrets). */
  concurrencyReadiness(): OutboxWorkerConcurrencyReadiness {
    return Object.freeze({
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      leaseDurationMs: this.leaseDurationMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      handlerTimeoutMs: this.handlerTimeoutMs,
      maxConcurrentHandlers: this.maxConcurrentHandlers,
      activeHandlers: this.capacityUsed,
      running: this.running,
    });
  }

  async runOnce(): Promise<boolean> {
    // A worker without a configured contract must stay passive. Claiming first would turn
    // valid events into retries or dead letters merely because deployment wiring is empty.
    if (this.options.router.isEmpty || this.options.envelopes.isEmpty) return false;
    if (this.capacityUsed >= this.maxConcurrentHandlers) return false;
    this.activeHandlerCount += 1;

    try {
      const claimStarted = performance.now();
      const claim = await this.options.repository.claim(this.leaseDurationMs);
      this.options.metrics?.observe('outbox.claim_latency_ms', performance.now() - claimStarted);
      if (!claim) return false;
      this.options.metrics?.increment('outbox.claimed');

      try {
        const envelope = this.options.envelopes.validate(envelopeFromClaim(claim));
        const route = this.options.router.resolve(claim);
        if (route.routeClass === 'publication_cache_purge') {
          this.options.metrics?.observe(
            'publication.cache_purge.queue_age_ms',
            Math.max(0, Date.now() - claim.occurredAt.getTime()),
          );
          this.options.metrics?.observe('publication.cache_purge.attempt', claim.attemptCount);
        }
        if (claim.handlerMode === 'projection_latest_only'
          && (claim.aggregateScope === null || claim.commitOrdinal === null)) {
          throw new Error('projection_latest_only requires aggregate scope and commit ordinal');
        }
        if (await this.canSkip(claim)) {
          const completed = await this.options.repository.complete(claim);
          this.options.metrics?.increment(completed ? 'outbox.obsolete_skipped' : 'outbox.lease_lost');
          return true;
        }
        // Refuse a misconfigured transient route BEFORE it can perform a side
        // effect that this worker would reject and replay on the next attempt.
        this.assertDurableRoute(route, claim);
        await this.invokeHandler(claim, envelope, route.handle.bind(route));
        const completed = await this.options.repository.complete(claim);
        this.options.metrics?.increment(completed ? 'outbox.completed' : 'outbox.lease_lost');
      } catch (error: unknown) {
        if (error instanceof OutboxContinuationRequested) {
          await this.continueClaim(claim);
        } else {
          await this.failClaim(claim, error);
        }
      }
      return true;
    } finally {
      this.activeHandlerCount -= 1;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.options.metrics) this.backlogLoopPromise = this.runBacklogLoop();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.resolvePoll?.();
    this.resolvePoll = undefined;
    if (this.backlogTimer) clearTimeout(this.backlogTimer);
    this.backlogTimer = undefined;
    this.resolveBacklogWait?.();
    this.resolveBacklogWait = undefined;
    for (const controller of this.activeHandlers) {
      controller.abort(new Error('outbox worker stopping'));
    }
    const drain = Promise.all([
      Promise.resolve(this.loopPromise),
      Promise.resolve(this.backlogLoopPromise),
    ])
      .then(() => Promise.allSettled([...this.lingeringHandlers]))
      .then(() => undefined);
    const timedOut = await raceDeadline(drain, this.shutdownDeadlineMs);
    if (timedOut) {
      this.options.metrics?.increment('outbox.shutdown_deadline_exceeded');
      this.options.logger.warn({
        shutdownDeadlineMs: this.shutdownDeadlineMs,
        lingeringHandlers: this.lingeringHandlerCount,
        actionable: 'stop proceeded without waiting for abort-ignoring handlers',
      }, 'outbox worker stop exceeded shutdown deadline');
      observeBestEffort(drain,
        'the shutdown deadline result is authoritative over a late drain rejection');
    }
    this.loopPromise = undefined;
    this.backlogLoopPromise = undefined;
  }

  private async canSkip(claim: OutboxClaim): Promise<boolean> {
    return claim.handlerMode === 'projection_latest_only'
      ? this.options.repository.isObsoleteProjection(claim)
      : this.options.repository.hasDeliveryReceipt(claim);
  }

  /** Normal continuation: release the lease back to pending without fail()/last_error. */
  private async continueClaim(claim: OutboxClaim): Promise<void> {
    const continued = await this.options.repository.continue(claim);
    this.options.metrics?.increment(continued ? 'outbox.continued' : 'outbox.lease_lost');
  }

  private async failClaim(claim: OutboxClaim, error: unknown): Promise<void> {
    const delay = this.retryPolicy.retryDelayMs(claim.attemptCount);
    const sanitizedError = errorMessage(error);
    const maxAttempts = error instanceof OutboxDeliveryError && error.failureKind === 'permanent'
      ? claim.attemptCount
      : this.retryPolicy.maxAttempts;
    const disposition = await this.options.repository.fail(
      claim,
      sanitizedError,
      delay,
      maxAttempts,
    );
    this.options.metrics?.increment(`outbox.${disposition}`);
    if (claim.handlerName === 'publication_cache_purge' && disposition === 'dead_letter') {
      this.options.metrics?.increment('publication.cache_purge.dead_letter');
    }
    const log = disposition === 'dead_letter' ? this.options.logger.error.bind(this.options.logger)
      : this.options.logger.warn.bind(this.options.logger);
    log({
      outboxId: claim.outboxId,
      eventId: claim.eventId,
      handlerName: claim.handlerName,
      attemptCount: claim.attemptCount,
      leaseGeneration: claim.leaseGeneration,
      disposition,
      error: sanitizedError,
    }, 'outbox delivery failed');
  }

  private assertDurableRoute(route: OutboxRoute, claim: OutboxClaim): void {
    if (route.sideEffectDurability === 'durable') return;
    if (this.options.acknowledgeTransientSideEffects === true) return;
    this.options.metrics?.increment('outbox.transient_completion_refused');
    this.options.logger.error({
      outboxId: claim.outboxId,
      eventId: claim.eventId,
      handlerName: claim.handlerName,
      sideEffectDurability: route.sideEffectDurability,
      actionable: 'wire a durable projection sink or remove the route; do not complete through memory/no-op sinks',
    }, 'refusing to complete outbox event through a transient projection side effect');
    throw new TransientSideEffectCompletionError(
      `refusing to complete outbox event ${claim.outboxId} through a transient projection side effect `
      + `(handler=${claim.handlerName}); wire a durable sink (sideEffectDurability: "durable")`,
    );
  }

  private publishDurabilityTelemetry(): void {
    const inspection = this.options.router.durabilityInspection();
    this.options.metrics?.gauge('outbox.projection_routes', inspection.routeCount);
    this.options.metrics?.gauge('outbox.projection_durable_routes', inspection.durableCount);
    this.options.metrics?.gauge('outbox.projection_transient_routes', inspection.transientCount);
    this.options.metrics?.gauge('outbox.projection_all_durable', inspection.allDurable ? 1 : 0);
    this.options.metrics?.gauge(
      'publication.cache_purge.route_configured',
      inspection.publicationCachePurge.configured ? 1 : 0,
    );
    // 1 only when the purge provider is actually durable; 0 for the test-mode no-op stub
    // and for an absent provider, matching the honest readiness state.
    this.options.metrics?.gauge(
      'publication.cache_purge.route_durable',
      this.publicationCachePurgeReadiness().allDurable ? 1 : 0,
    );
    if (inspection.transientCount > 0 && this.options.acknowledgeTransientSideEffects !== true) {
      this.options.logger.warn({
        routeCount: inspection.routeCount,
        durableCount: inspection.durableCount,
        transientCount: inspection.transientCount,
        actionable: 'transient routes will not permanently complete events; wire durable projection sinks for production',
      }, 'outbox worker configured with transient projection side effects');
    }
  }

  private async recordBacklog(): Promise<void> {
    if (!this.options.metrics) return;
    try {
      const backlog = await this.options.repository.inspectBacklog();
      this.options.metrics.gauge('outbox.backlog', backlog.count);
      this.options.metrics.gauge('outbox.oldest_age_ms', backlog.oldestAgeMs);
    } catch (error: unknown) {
      this.options.metrics.increment('outbox.metrics_error');
      this.options.logger.warn({ error: errorMessage(error) }, 'outbox backlog metrics failed');
    }
  }

  /**
   * Backlog count/min are intentionally detached from runOnce(): a drain of N
   * events must not execute N whole-backlog aggregates (near O(N²) during the
   * incident where claim throughput matters most).
   */
  private async runBacklogLoop(): Promise<void> {
    while (this.running) {
      await this.recordBacklog();
      if (!this.running) break;
      await this.waitForBacklogSample();
    }
  }

  private waitForBacklogSample(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveBacklogWait = resolve;
      this.backlogTimer = setTimeout(resolve, this.backlogSampleIntervalMs);
      this.backlogTimer.unref();
    }).finally(() => {
      this.backlogTimer = undefined;
      this.resolveBacklogWait = undefined;
    });
  }

  private async invokeHandler(
    claim: OutboxClaim,
    envelope: VersionedEventEnvelope,
    handle: (context: {
      envelope: VersionedEventEnvelope;
      idempotencyKey: string;
      signal: AbortSignal;
      attempt?: { readonly outboxId: string; readonly leaseGeneration: string };
    }) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeHandlers.add(controller);
    let heartbeatPromise: Promise<void> | undefined;
    let leaseLost = false;
    let deadlineExpired = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPromise || leaseLost) return;
      const heartbeatStarted = performance.now();
      heartbeatPromise = this.options.repository.heartbeat(claim, this.leaseDurationMs)
        .then((renewed) => {
          this.options.metrics?.observe('outbox.heartbeat_duration_ms', performance.now() - heartbeatStarted);
          this.options.metrics?.increment(renewed ? 'outbox.heartbeat' : 'outbox.heartbeat_lost');
          if (!renewed) {
            leaseLost = true;
            controller.abort(new Error('outbox lease lost'));
          }
        })
        .catch((error: unknown) => {
          this.options.metrics?.observe('outbox.heartbeat_duration_ms', performance.now() - heartbeatStarted);
          this.options.metrics?.increment('outbox.heartbeat_error');
          leaseLost = true;
          controller.abort(error);
        })
        .finally(() => { heartbeatPromise = undefined; });
    }, this.heartbeatIntervalMs);
    heartbeat.unref();
    let rejectDeadline: ((error: Error) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      const error = new Error(`outbox handler exceeded ${this.handlerTimeoutMs}ms deadline`);
      controller.abort(error);
      rejectDeadline?.(error);
    }, this.handlerTimeoutMs);
    deadlineTimer.unref();
    const handlerStarted = performance.now();
    let handlerSettled = false;
    let trackedAsLingering = false;
    const handler = Promise.resolve().then(() => handle({
      envelope,
      idempotencyKey: claim.eventId,
      signal: controller.signal,
      attempt: Object.freeze({
        outboxId: claim.outboxId,
        leaseGeneration: claim.leaseGeneration,
      }),
    })).finally(() => {
      handlerSettled = true;
      this.activeHandlers.delete(controller);
      if (trackedAsLingering) {
        this.lingeringHandlerCount -= 1;
        this.options.metrics?.gauge('outbox.worker_active_handlers', this.capacityUsed);
        this.options.metrics?.observe(
          'outbox.handler_lingering_duration_ms',
          performance.now() - handlerStarted,
        );
      }
    });
    observeBestEffort(handler,
      'the worker race owns the handler outcome and must observe it before racing');
    try {
      // Claim transaction has committed before this method is entered. Handlers may perform network I/O.
      await Promise.race([handler, deadline]);
      if (leaseLost) throw new Error('outbox lease lost during handler execution');
      if (deadlineExpired) throw new Error('outbox handler deadline expired');
    } finally {
      this.options.metrics?.observe('outbox.handler_duration_ms', performance.now() - handlerStarted);
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      if (!handlerSettled) {
        trackedAsLingering = true;
        this.lingeringHandlerCount += 1;
        this.lingeringHandlers.add(handler);
        observeBestEffort(
          handler.finally(() => { this.lingeringHandlers.delete(handler); }),
          'the handler outcome is already recorded and this Promise only tracks set cleanup',
        );
        this.options.metrics?.increment('outbox.handler_ignored_abort');
        this.options.metrics?.gauge('outbox.worker_active_handlers', this.capacityUsed);
        this.options.logger.warn({
          outboxId: claim.outboxId,
          eventId: claim.eventId,
          handlerName: claim.handlerName,
          actionable: 'handler remains capacity-accounted until it settles; make the sink honor AbortSignal',
        }, 'outbox handler remained active after cancellation');
      } else {
        this.activeHandlers.delete(controller);
      }
      await heartbeatPromise;
    }
  }

  private async runLoop(): Promise<void> {
    // Drain in-flight batch work after stop() so graceful shutdown never drops mid-handler.
    while (this.running) {
      try {
        const budget = Math.min(
          this.batchSize,
          Math.max(0, this.maxConcurrentHandlers - this.capacityUsed),
        );
        if (budget < 1) {
          // At capacity: wait a short poll slice rather than spinning.
          await this.waitForPoll();
          continue;
        }

        // Bounded batch only — never Promise.all over the full backlog.
        const batch: Array<Promise<boolean>> = [];
        for (let i = 0; i < budget; i += 1) {
          if (!this.running) break;
          if (this.capacityUsed >= this.maxConcurrentHandlers) break;
          // Isolate failures so the batch always drains (shutdown/backpressure safe).
          batch.push(this.runOnce().catch((error: unknown) => {
            this.options.metrics?.increment('outbox.loop_error');
            this.options.logger.error({ error: errorMessage(error) }, 'outbox worker loop failed');
            return false;
          }));
        }

        if (batch.length === 0) {
          await this.waitForPoll();
          continue;
        }

        const results = await Promise.all(batch);
        this.options.metrics?.gauge('outbox.worker_active_handlers', this.capacityUsed);
        if (results.some(Boolean)) continue;
      } catch (error: unknown) {
        this.options.metrics?.increment('outbox.loop_error');
        this.options.logger.error({ error: errorMessage(error) }, 'outbox worker loop failed');
      }
      await this.waitForPoll();
    }
  }

  private waitForPoll(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolvePoll = resolve;
      this.pollTimer = setTimeout(resolve, this.pollIntervalMs);
      this.pollTimer.unref();
    }).finally(() => {
      this.pollTimer = undefined;
      this.resolvePoll = undefined;
    });
  }

  private get capacityUsed(): number {
    return this.activeHandlerCount + this.lingeringHandlerCount;
  }
}
