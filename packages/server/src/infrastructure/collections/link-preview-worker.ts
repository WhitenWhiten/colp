/**
 * LP-03 link preview worker loop (not an outbox handler).
 *
 * Each tick: sweep at most one public/unlisted collection into the target
 * cache, claim up to `concurrency` due targets, and fetch them with every
 * destination hop serialized by a per-host gap. Maintenance (prune + GC)
 * runs on its own interval inside the same loop.
 *
 * Per target: a source rule, else the page head (og/twitter/image_src), gives
 * up to three candidates; the first one that fully decodes and passes the
 * size/shape policy is stored. Ledger row before PUT; the lease-fenced
 * completion publishes it. Outcomes: ready, none (nothing usable), failed
 * (transport trouble; retried with backoff).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  createProductionEgressConnector,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../egress/index.js';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import {
  FaviconFetchError,
  LINK_PREVIEW_MAX_DECOMPRESSED_BYTES,
  LINK_PREVIEW_MAX_IMAGE_BYTES,
  linkPreviewImageRejection,
  linkPreviewTargetIdentity,
  type BookmarkFaviconObjectStore,
  type LinkPreviewCandidate,
  type LinkPreviewTargetIdentity,
  type ReadableReplicaFailureCode,
} from '../../modules/collections/index.js';
import { fetchFaviconImage } from './favicon-fetch.js';
import { previewSourceRuleImageUrl } from './link-preview-source-rules.js';
import { extractPreviewCandidates } from './link-preview-head.js';
import type { LinkPreviewClaim, LinkPreviewRepository } from './link-preview-postgres.js';
import { fetchReadableReplicaHtml } from './readable-replica-fetch.js';
import { createSerializedHostGate } from './serialized-host-gate.js';

export const LINK_PREVIEW_USER_AGENT = 'Mozilla/5.0 (compatible; Known-LinkPreview/1; +https://know-n.com/bot)';
export const LINK_PREVIEW_MAX_HTML_BYTES = 1_048_576;
export const LINK_PREVIEW_IMAGE_MAX_REDIRECTS = 5;
const DAY_MS = 86_400_000;
const NO_CARD_PAGE_FAILURES: ReadonlySet<ReadableReplicaFailureCode> = new Set([
  'not_html', 'too_large', 'denied', 'invalid_url',
]);

export interface LinkPreviewWorkerLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface LinkPreviewHostGate {
  run(host: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}

export interface LinkPreviewWorkerLoopOptions {
  readonly repository: LinkPreviewRepository;
  readonly store: BookmarkFaviconObjectStore;
  readonly logger: LinkPreviewWorkerLogger;
  readonly retentionSeconds: number;
  readonly metrics?: Metrics;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  /** Lease owner; a UUID (the lease columns are uuid). */
  readonly workerId?: string;
  readonly concurrency?: number;
  readonly perHostGapMs?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly pageTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly imageTimeoutMs?: number;
  readonly maintenanceIntervalMs?: number;
  /** Re-enqueue an unchanged published collection this often (keeps its URLs from being pruned). */
  readonly resweepAfterMs?: number;
  readonly sweepUrlLimit?: number;
  /** Targets nobody requested for this long are pruned. */
  readonly pruneAfterMs?: number;
  readonly hostGate?: LinkPreviewHostGate;
  readonly now?: () => number;
}

type Attempt =
  | { readonly kind: 'ready'; readonly body: Buffer; readonly mime: string; readonly width: number;
      readonly height: number; readonly candidate: LinkPreviewCandidate }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed' };

export class LinkPreviewWorkerLoop {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly pageTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly imageTimeoutMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly hostGate: LinkPreviewHostGate;
  private readonly now: () => number;
  private lastMaintenance = Number.NEGATIVE_INFINITY;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;
  private readonly controllers = new Set<AbortController>();
  /** Aborts in-flight sweep SQL when the loop is stopped. Separate from per-claim fetch controllers. */
  private readonly stopping = new AbortController();
  /** Hosts already gated on this claim's async stack. Concurrent claims do not share it. */
  private readonly heldHosts = new AsyncLocalStorage<ReadonlySet<string>>();
  /**
   * Runs once, inside the first connect's host gate and before that connect.
   * A false result means the lease is gone: the claim controller is already
   * aborted and the connect must not start.
   */
  private readonly prepareConnect = new AsyncLocalStorage<() => Promise<boolean>>();
  private readonly connect: HardenedEgressConnector;

  constructor(private readonly options: LinkPreviewWorkerLoopOptions) {
    this.workerId = options.workerId ?? randomUUID();
    this.concurrency = options.concurrency ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
    this.pageTimeoutMs = options.pageTimeoutMs ?? 15_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.imageTimeoutMs = options.imageTimeoutMs ?? 10_000;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.hostGate = options.hostGate ?? createSerializedHostGate({
      gapMs: options.perHostGapMs ?? 2_000,
      invalidGapMessage: 'link preview host gap must be a non-negative integer',
    });
    const innerConnect = options.connect ?? createProductionEgressConnector();
    this.connect = async (target, init) => {
      let response!: Response;
      // One gate per target connect. The lock ends when this hop's connect
      // returns (response headers), before the caller reads the body, so a
      // page claim cannot keep host A while it waits for host B.
      await this.withHost(target.url.hostname, async () => {
        const prepare = this.prepareConnect.getStore();
        if (prepare && !await prepare()) {
          throw new DOMException('link preview lease lost', 'AbortError');
        }
        response = await innerConnect(target, init);
      }, init?.signal ?? undefined);
      return response;
    };
    // Three candidates after the page, each within its own timeout, must fit the lease.
    const worstCase = this.pageTimeoutMs + 3 * this.imageTimeoutMs;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < worstCase) {
      throw new RangeError('invalid link preview worker timing configuration');
    }
    this.options.metrics?.gauge('collections.link_preview.worker_concurrency', this.concurrency);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** One tick. True when it found work, so a caller can drain without waiting. */
  async runOnce(): Promise<boolean> {
    const swept = await this.sweepOnce();
    const claims = await this.options.repository.claimDue({
      limit: this.concurrency,
      leaseOwner: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (claims.length > 0) {
      this.options.metrics?.increment('collections.link_preview.claims', claims.length);
      await Promise.all(claims.map((claim) => this.processClaim(claim)));
    }
    if (this.now() - this.lastMaintenance >= this.maintenanceIntervalMs) {
      this.lastMaintenance = this.now();
      await this.maintain();
    }
    return swept || claims.length > 0;
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
    this.stopping.abort(new Error('link preview worker stopping'));
    for (const controller of this.controllers) controller.abort(new Error('link preview worker stopping'));
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.runOnce();
      } catch (error) {
        this.options.metrics?.increment('collections.link_preview.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) }, 'link preview poll failed');
      }
      if (this.running && !busy) await this.waitForPoll();
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

  private async sweepOnce(): Promise<boolean> {
    const claim = await this.options.repository.claimSweep({
      leaseOwner: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      resweepAfterMs: this.options.resweepAfterMs ?? 30 * DAY_MS,
    });
    if (claim === null) return false;
    const limit = this.options.sweepUrlLimit ?? 5_000;
    let listed: { readonly urls: readonly string[]; readonly corrupted: boolean };
    try {
      listed = await this.options.repository.listSweepUrls(
        claim.collectionId, limit + 1, claim.afterUrl, { signal: this.stopping.signal },
      );
    } catch (error) {
      if (this.stopping.signal.aborted) {
        await this.options.repository.releaseSweep(claim);
        return false;
      }
      throw error;
    }
    if (listed.corrupted) {
      this.options.metrics?.increment('collections.link_preview.sweep_corrupt');
      this.options.logger.warn(
        { collectionId: claim.collectionId },
        'link preview sweep skipped a corrupt tree region',
      );
    }
    const urls = listed.urls.slice(0, limit);
    const identities = urls
      .map((url) => linkPreviewTargetIdentity(url))
      .filter((identity): identity is LinkPreviewTargetIdentity => identity !== null);
    await this.options.repository.enqueue(identities);
    await this.options.repository.completeSweep(claim, listed.urls.length > limit ? urls.at(-1)! : null);
    this.options.metrics?.increment('collections.link_preview.sweeps');
    return true;
  }

  private async maintain(): Promise<void> {
    const pruned = await this.options.repository.pruneStale({
      olderThanMs: this.options.pruneAfterMs ?? 180 * DAY_MS,
      limit: 100,
      retentionSeconds: this.options.retentionSeconds,
    });
    if (pruned > 0) this.options.metrics?.increment('collections.link_preview.pruned', pruned);
    for (const objectId of await this.options.repository.listCollectable(20)) {
      await this.options.store.delete(objectId);
      await this.options.repository.forgetObject(objectId);
      this.options.metrics?.increment('collections.link_preview.gc_deleted');
    }
  }

  private async processClaim(claim: LinkPreviewClaim): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: Promise<void> | undefined;
    const renew = async () => {
      const renewed = await this.options.repository.renewLease(claim, this.leaseDurationMs).catch(() => false);
      if (!renewed) controller.abort(new Error('link preview lease lost'));
      return renewed;
    };
    const schedule = () => {
      timer = setTimeout(() => {
        heartbeat = renew().then((renewed) => {
          if (renewed && !stopped && !controller.signal.aborted) schedule();
        });
      }, Math.max(1, Math.floor(this.leaseDurationMs / 3)));
      timer.unref();
    };
    // Queued same-host connects need renewal too, before they get a fetch slot.
    schedule();
    let prepared = false;
    const prepare = async (): Promise<boolean> => {
      if (prepared) return !controller.signal.aborted;
      prepared = true;
      if (controller.signal.aborted) return false;
      const renewed = await renew();
      if (!renewed) controller.abort(new Error('link preview lease lost'));
      return renewed;
    };
    try {
      // The page host is not held across the fetch. Each connect takes and
      // releases its own gate; the first one rechecks the lease.
      await this.prepareConnect.run(prepare, () => this.fetchAndComplete(claim, controller));
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await heartbeat;
      this.controllers.delete(controller);
    }
  }

  private async fetchAndComplete(claim: LinkPreviewClaim, controller: AbortController): Promise<void> {
    try {
      const attempt = await this.attempt(claim.normalizedUrl, controller.signal);
      if (controller.signal.aborted) return;
      const written = attempt.kind === 'ready'
        ? await this.publish(claim, attempt)
        : attempt.kind === 'none'
          ? await this.options.repository.completeNone(claim)
          : await this.options.repository.completeFailure(claim);
      if (!written) {
        this.options.metrics?.increment('collections.link_preview.lease_lost');
        this.options.logger.warn({ urlKey: claim.urlKey }, 'link preview lease lost');
        return;
      }
      this.options.metrics?.increment(`collections.link_preview.${attempt.kind}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.options.metrics?.increment('collections.link_preview.error');
      this.options.logger.error({ urlKey: claim.urlKey, error: redactSensitiveText(error) }, 'link preview failed');
      // Park the row on the failure schedule instead of re-claiming it every lease.
      await this.options.repository.completeFailure(claim).catch(() => false);
    }
  }

  private async attempt(pageUrl: string, signal: AbortSignal): Promise<Attempt> {
    const rule = previewSourceRuleImageUrl(pageUrl);
    let candidates: LinkPreviewCandidate[];
    if (rule !== null) {
      candidates = [{ url: rule, source: 'rule' }];
    } else {
      const page = await fetchReadableReplicaHtml({
        url: pageUrl,
        timeoutMs: this.pageTimeoutMs,
        connectTimeoutMs: this.connectTimeoutMs,
        maxBodyBytes: LINK_PREVIEW_MAX_HTML_BYTES,
        userAgent: LINK_PREVIEW_USER_AGENT,
        acceptEncoding: 'identity',
        truncateUnencodedBody: true,
        ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
        connect: this.connect,
        signal,
      });
      if (page.kind === 'failure') {
        // Not HTML (PDF, image, feed), refused by egress policy, or unusable:
        // retrying cannot help, so the page simply has no card.
        return NO_CARD_PAGE_FAILURES.has(page.failureCode) ? { kind: 'none' } : { kind: 'failed' };
      }
      candidates = extractPreviewCandidates(page.html, page.hopUrls.at(-1) ?? pageUrl);
    }
    let transportFailure = false;
    for (const candidate of candidates) {
      if (signal.aborted) return { kind: 'failed' };
      try {
        const image = await fetchFaviconImage({
          url: candidate.url,
          timeoutMs: this.imageTimeoutMs,
          maxBytes: LINK_PREVIEW_MAX_IMAGE_BYTES,
          maxDecompressedBytes: LINK_PREVIEW_MAX_DECOMPRESSED_BYTES,
          maxRedirects: LINK_PREVIEW_IMAGE_MAX_REDIRECTS,
          allowIco: false,
          userAgent: LINK_PREVIEW_USER_AGENT,
          ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
          connect: this.connect,
          signal,
        });
        const rejection = linkPreviewImageRejection(image);
        if (rejection !== null) {
          this.options.metrics?.increment(`collections.link_preview.${rejection}`);
          continue;
        }
        return { kind: 'ready', ...image, candidate };
      } catch (error) {
        if (error instanceof FaviconFetchError && error.reason === 'invalid_image') {
          this.options.metrics?.increment('collections.link_preview.rejected_type');
        } else if (error instanceof FaviconFetchError && error.reason === 'unsafe_source') {
          this.options.metrics?.increment('collections.link_preview.rejected_unsafe');
        } else {
          transportFailure = true;
        }
      }
    }
    return transportFailure ? { kind: 'failed' } : { kind: 'none' };
  }

  /** One start-to-start gap per destination connect. Re-entering the host already held by this claim is not a new hop. */
  private async withHost(host: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const held = this.heldHosts.getStore();
    if (held?.has(host)) {
      await work();
      return;
    }
    await this.hostGate.run(host, async () => {
      const next = new Set(held);
      next.add(host);
      await this.heldHosts.run(next, work);
    }, signal);
  }

  private async publish(claim: LinkPreviewClaim, attempt: Extract<Attempt, { kind: 'ready' }>): Promise<boolean> {
    const digest = createHash('sha256').update(attempt.body).digest('hex');
    let objectId = claim.objectId;
    if (objectId === null || claim.digest !== digest) {
      objectId = randomUUID();
      await this.options.repository.recordObject({
        objectId, urlKey: claim.urlKey, digest, retentionSeconds: this.options.retentionSeconds,
      });
      await this.options.store.put(objectId, attempt.body, attempt.mime);
    }
    const result = await this.options.repository.completeReady({
      claim,
      objectId,
      width: attempt.width,
      height: attempt.height,
      mime: attempt.mime,
      digest,
      source: attempt.candidate.source,
      retentionSeconds: this.options.retentionSeconds,
    });
    if (result.generic) this.options.metrics?.increment('collections.link_preview.generic');
    return result.written;
  }
}

export interface LinkPreviewWorkerRuntime {
  readonly loop: LinkPreviewWorkerLoop;
}

export function createLinkPreviewWorkerRuntime(options: LinkPreviewWorkerLoopOptions): LinkPreviewWorkerRuntime {
  return Object.freeze({ loop: new LinkPreviewWorkerLoop(options) });
}
