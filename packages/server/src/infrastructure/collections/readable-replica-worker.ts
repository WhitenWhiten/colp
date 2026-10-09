/**
 * Independent readable-replica worker loop (not an outbox handler).
 * Global concurrency ≤ 4. Same normalized host is serialized with per-host gap.
 */
import { randomUUID } from 'node:crypto';
import type { HardenedEgressConnector, HardenedEgressResolver } from '../egress/index.js';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import {
  hostnameFromBookmarkUrl,
  normalizeBookmarkUrl,
  type ReadableArticleExtractor,
  type ReadableReplicaFailureCode,
  type ReadableReplicaStoredStatus,
} from '../../modules/collections/index.js';
import { createMozillaReadableArticleExtractor } from './readable-replica-dom.js';
import { fetchReadableReplicaHtml } from './readable-replica-fetch.js';
import type {
  ReadableReplicaClaim,
  ReadableReplicaWorkerRepository,
} from './readable-replica-worker-postgres.js';
import { createSerializedHostGate } from './serialized-host-gate.js';

export interface ReadableReplicaWorkerLoopLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface ReadableReplicaHostGate {
  run(host: string, work: () => Promise<void>): Promise<void>;
}

export interface ReadableReplicaHostGateDiagnostics extends ReadableReplicaHostGate {
  /** Number of host queues with pending or active work. */
  pendingHostCount(): number;
  /** Number of hosts retaining a start time for gap enforcement. */
  trackedHostCount(): number;
}

export function createReadableReplicaHostGate(
  gapMs: number,
  now: () => number = Date.now,
  sleep?: (ms: number) => Promise<void>,
): ReadableReplicaHostGateDiagnostics {
  return createSerializedHostGate({
    gapMs,
    invalidGapMessage: 'readable-replica host gap must be a non-negative integer',
    now,
    ...(sleep === undefined ? {} : { sleep }),
  });
}

export interface ReadableReplicaWorkerLoopOptions {
  readonly repository: ReadableReplicaWorkerRepository;
  readonly logger: ReadableReplicaWorkerLoopLogger;
  readonly metrics?: Metrics;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  readonly extractor?: ReadableArticleExtractor;
  readonly workerId?: string;
  readonly probeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly concurrency?: number;
  readonly perHostGapMs?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
  readonly hostGate?: ReadableReplicaHostGate;
}

export class ReadableReplicaWorkerLoop {
  private readonly workerId: string;
  private readonly probeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly hostGate: ReadableReplicaHostGate;
  private readonly extractor: ReadableArticleExtractor;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: ReadableReplicaWorkerLoopOptions) {
    this.workerId = options.workerId ?? `readable-replica-${randomUUID()}`;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 2_097_152;
    this.concurrency = options.concurrency ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
    this.hostGate = options.hostGate ?? createReadableReplicaHostGate(options.perHostGapMs ?? 2_000);
    this.extractor = options.extractor ?? createMozillaReadableArticleExtractor();
    if (!Number.isInteger(this.probeTimeoutMs) || this.probeTimeoutMs < 1
      || !Number.isInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 1
      || !Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < this.probeTimeoutMs) {
      throw new RangeError('invalid readable-replica worker timing configuration');
    }
    this.options.metrics?.gauge('collections.readable_replica.worker_concurrency', this.concurrency);
    this.options.metrics?.gauge('collections.readable_replica.probe_timeout_ms', this.probeTimeoutMs);
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
    this.options.metrics?.increment('collections.readable_replica.claims', claims.length);
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
      controller.abort(new Error('readable-replica worker stopping'));
    }
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.metrics?.increment('collections.readable_replica.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) }, 'readable-replica poll failed');
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

  private async processClaim(claim: ReadableReplicaClaim): Promise<void> {
    const host = hostnameFromBookmarkUrl(claim.url) ?? '';
    await this.hostGate.run(host, () => this.fetchAndComplete(claim));
  }

  private async fetchAndComplete(claim: ReadableReplicaClaim): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const fetched = await fetchReadableReplicaHtml({
        url: claim.url,
        timeoutMs: this.probeTimeoutMs,
        connectTimeoutMs: this.connectTimeoutMs,
        maxBodyBytes: this.maxBodyBytes,
        ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
        ...(this.options.connect === undefined ? {} : { connect: this.options.connect }),
        signal: controller.signal,
        hostGate: this.hostGate,
        initialHost: hostnameFromBookmarkUrl(claim.url) ?? '',
      });
      if (controller.signal.aborted) return;
      if (fetched.kind === 'failure' && fetched.hopUrls.length > 0) {
        this.options.logger.info({
          nodeId: claim.nodeId,
          hopCount: fetched.hopUrls.length,
          failureCode: fetched.failureCode,
        }, 'readable-replica fetch failed');
      }
      const sourceUrl = normalizeBookmarkUrl(claim.url) ?? claim.url;
      const now = this.now();
      const terminal = fetched.kind === 'html'
        ? this.extractTerminal(fetched.html, claim, sourceUrl, now)
        : failureTerminal(fetched.failureCode, sourceUrl);
      const written = await this.options.repository.completeExtract({
        nodeId: claim.nodeId,
        leaseOwner: claim.leaseOwner,
        ...terminal,
        updatedAt: now,
      });
      if (!written) {
        this.options.metrics?.increment('collections.readable_replica.lease_lost');
        this.options.logger.warn({ nodeId: claim.nodeId }, 'readable-replica lease lost');
        return;
      }
      this.options.metrics?.increment(`collections.readable_replica.${terminal.status}`);
    } catch (error) {
      this.options.metrics?.increment('collections.readable_replica.error');
      this.options.logger.error({
        nodeId: claim.nodeId, error: redactSensitiveText(error),
      }, 'readable-replica extract failed');
    } finally {
      this.controllers.delete(controller);
    }
  }

  /**
   * An extractor exception (parser/Readability crash on hostile markup) must
   * still terminate the row: otherwise it stays `pending`, the lease expires,
   * and every poll re-claims and re-crashes it forever.
   */
  private extractTerminal(
    html: string,
    claim: ReadableReplicaClaim,
    sourceUrl: string,
    now: Date,
  ): ReadableReplicaTerminal {
    let extracted: ReturnType<ReadableArticleExtractor>;
    try {
      extracted = this.extractor({ html, url: claim.url });
    } catch (error) {
      this.options.metrics?.increment('collections.readable_replica.extract_error');
      this.options.logger.warn({
        nodeId: claim.nodeId, error: redactSensitiveText(error),
      }, 'readable-replica extractor threw; recording empty');
      return failureTerminal('empty', sourceUrl);
    }
    if (extracted.kind === 'empty') {
      return failureTerminal('empty', sourceUrl);
    }
    return {
      status: 'ready',
      sourceUrl,
      title: extracted.title,
      byline: extracted.byline,
      wordCount: extracted.wordCount,
      sections: extracted.sections,
      failureCode: null,
      extractedAt: now,
    };
  }
}

type ReadableReplicaTerminal = Omit<
  Parameters<ReadableReplicaWorkerRepository['completeExtract']>[0],
  'nodeId' | 'leaseOwner' | 'updatedAt'
>;

function failureTerminal(
  failureCode: ReadableReplicaFailureCode,
  sourceUrl: string,
): ReadableReplicaTerminal {
  const status: ReadableReplicaStoredStatus = failureCode === 'not_html' ? 'unsupported' : 'failed';
  return {
    status,
    sourceUrl,
    title: null,
    byline: null,
    wordCount: 0,
    sections: [],
    failureCode,
    extractedAt: null,
  };
}

export interface ReadableReplicaWorkerRuntime {
  readonly loop: ReadableReplicaWorkerLoop;
}

export function createReadableReplicaWorkerRuntime(
  options: ReadableReplicaWorkerLoopOptions,
): ReadableReplicaWorkerRuntime {
  return Object.freeze({
    loop: new ReadableReplicaWorkerLoop(options),
  });
}
