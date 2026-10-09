/**
 * Independent link-health worker loop (not an outbox handler).
 * Global concurrency ≤ 4. Same normalized host is serialized with ≥ 1s gap.
 */
import { randomUUID } from 'node:crypto';
import type { HardenedEgressConnector, HardenedEgressResolver } from '../egress/index.js';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import {
  hostnameFromBookmarkUrl,
} from '../../modules/collections/index.js';
import {
  probeBookmarkUrl,
} from './link-health-probe.js';
import type { LinkHealthClaim, LinkHealthWorkerRepository } from './link-health-worker-postgres.js';
import { createSerializedHostGate } from './serialized-host-gate.js';

export interface LinkHealthWorkerLoopLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface LinkHealthHostGate {
  run(host: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}

export interface LinkHealthHostGateDiagnostics extends LinkHealthHostGate {
  /** Number of host queues with pending or active work. */
  pendingHostCount(): number;
  /** Number of hosts retaining a start time for gap enforcement. */
  trackedHostCount(): number;
}

export function createLinkHealthHostGate(
  gapMs: number,
  now: () => number = Date.now,
  sleep?: (ms: number) => Promise<void>,
): LinkHealthHostGateDiagnostics {
  return createSerializedHostGate({
    gapMs,
    invalidGapMessage: 'link-health host gap must be a non-negative integer',
    now,
    ...(sleep === undefined ? {} : { sleep }),
  });
}

export interface LinkHealthWorkerLoopOptions {
  readonly repository: LinkHealthWorkerRepository;
  readonly logger: LinkHealthWorkerLoopLogger;
  readonly metrics?: Metrics;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  readonly workerId?: string;
  readonly probeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly concurrency?: number;
  readonly perHostGapMs?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
  readonly hostGate?: LinkHealthHostGate;
}

export class LinkHealthWorkerLoop {
  private readonly workerId: string;
  private readonly probeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly hostGate: LinkHealthHostGate;
  private readonly connectionHostGate: LinkHealthHostGate;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: LinkHealthWorkerLoopOptions) {
    this.workerId = options.workerId ?? `link-health-${randomUUID()}`;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 8_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
    this.concurrency = options.concurrency ?? 4;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.hostGate = options.hostGate ?? createLinkHealthHostGate(options.perHostGapMs ?? 1_000);
    // Connection gates are never nested in another connection gate. A claim
    // may hold its origin gate across redirects without creating A/B deadlocks.
    this.connectionHostGate = createLinkHealthHostGate(options.perHostGapMs ?? 1_000);
    if (!Number.isInteger(this.probeTimeoutMs) || this.probeTimeoutMs < 1
      || !Number.isInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 1
      || !Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < this.probeTimeoutMs) {
      throw new RangeError('invalid link-health worker timing configuration');
    }
    this.options.metrics?.gauge('collections.link_health.worker_concurrency', this.concurrency);
    this.options.metrics?.gauge('collections.link_health.probe_timeout_ms', this.probeTimeoutMs);
  }

  isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<boolean> {
    const claims = await this.options.repository.claimDue({
      limit: this.concurrency,
      leaseOwner: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (claims.length === 0) return false;
    this.options.metrics?.increment('collections.link_health.claims', claims.length);
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
    for (const controller of this.controllers) {
      controller.abort(new Error('link-health worker stopping'));
    }
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.metrics?.increment('collections.link_health.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) }, 'link-health poll failed');
      }
      if (this.running) await this.waitForPoll();
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

  private async processClaim(claim: LinkHealthClaim): Promise<void> {
    const host = hostnameFromBookmarkUrl(claim.url) ?? '';
    await this.hostGate.run(host, () => this.probeAndComplete(claim));
  }

  private async probeAndComplete(claim: LinkHealthClaim): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const probed = await probeBookmarkUrl({
        url: claim.url,
        timeoutMs: this.probeTimeoutMs,
        connectTimeoutMs: this.connectTimeoutMs,
        ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
        ...(this.options.connect === undefined ? {} : { connect: this.options.connect }),
        signal: controller.signal,
        hostGate: this.connectionHostGate,
      });
      if (controller.signal.aborted) return;
      const written = await this.options.repository.completeProbe({
        nodeId: claim.nodeId,
        leaseOwner: claim.leaseOwner,
        fact: probed.fact,
        checkedAt: this.now(),
      });
      if (!written) {
        this.options.metrics?.increment('collections.link_health.lease_lost');
        this.options.logger.warn({ nodeId: claim.nodeId }, 'link-health lease lost');
        return;
      }
      this.options.metrics?.increment(`collections.link_health.${probed.fact.status}`);
    } catch (error) {
      this.options.metrics?.increment('collections.link_health.error');
      this.options.logger.error({
        nodeId: claim.nodeId, error: redactSensitiveText(error),
      }, 'link-health probe failed');
    } finally {
      this.controllers.delete(controller);
    }
  }
}

export interface LinkHealthWorkerRuntime {
  readonly loop: LinkHealthWorkerLoop;
}

export function createLinkHealthWorkerRuntime(
  options: LinkHealthWorkerLoopOptions,
): LinkHealthWorkerRuntime {
  return Object.freeze({
    loop: new LinkHealthWorkerLoop(options),
  });
}
