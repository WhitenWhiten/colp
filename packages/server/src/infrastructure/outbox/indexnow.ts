import { observeBestEffort } from '../async/best-effort.js';
import { createHardenedEgressFetch } from '../egress/index.js';
import type { Metrics } from '../telemetry/index.js';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const INDEXNOW_KEY_LOCATION = 'https://know-n.com/indexnow.txt';
export const INDEXNOW_SUCCESS_METRIC = 'publication.indexnow.succeeded';
export const INDEXNOW_FAILURE_METRIC = 'publication.indexnow.failure';

const SITE_HOST = 'know-n.com';
const SITE_ORIGIN = 'https://know-n.com';
const INDEXNOW_KEY_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_INDEXNOW_TIMEOUT_MS = 5_000;

export interface IndexNowPayload {
  readonly host: 'know-n.com';
  readonly key: string;
  readonly keyLocation: 'https://know-n.com/indexnow.txt';
  readonly urlList: readonly string[];
}

export type IndexNowFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Structural logger with no URL, slug, key, payload, or raw error fields. */
export interface IndexNowLogger {
  warn(bindings: object, message: string): void;
}

/** Best-effort side effect appended to the existing publication purge route. */
export interface IndexNowPublisher {
  notifyPublicationSlug(publicationSlug: string): void;
  /** Drain already-scheduled submissions during worker shutdown. */
  close(): Promise<void>;
}

export function buildIndexNowPayload(key: string, publicationSlug: string): IndexNowPayload {
  return Object.freeze({
    host: SITE_HOST,
    key,
    keyLocation: INDEXNOW_KEY_LOCATION,
    urlList: Object.freeze([
      `${SITE_ORIGIN}/c/${encodeURIComponent(publicationSlug)}`,
    ]),
  });
}

export interface BestEffortIndexNowPublisherOptions {
  readonly key: string;
  readonly timeoutMs: number;
  readonly fetch?: IndexNowFetch;
  readonly metrics?: Metrics;
  readonly logger?: IndexNowLogger;
}

/**
 * Schedules one no-retry IndexNow request and consumes every asynchronous
 * failure. The authoritative purge route never awaits this work; close() is a
 * worker-lifecycle/test observation seam bounded by the request deadline.
 */
export class BestEffortIndexNowPublisher implements IndexNowPublisher {
  private readonly fetchImplementation: IndexNowFetch;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: BestEffortIndexNowPublisherOptions) {
    if (!INDEXNOW_KEY_PATTERN.test(options.key)) {
      throw new TypeError('IndexNow key must be exactly 32 lowercase hexadecimal characters');
    }
    if (!Number.isInteger(options.timeoutMs)
      || options.timeoutMs < 1
      || options.timeoutMs > MAX_INDEXNOW_TIMEOUT_MS) {
      throw new RangeError('IndexNow timeoutMs must be an integer from 1 through 5000');
    }
    this.fetchImplementation = options.fetch ?? createHardenedEgressFetch({
      label: 'IndexNow submission',
    });
  }

  notifyPublicationSlug(publicationSlug: string): void {
    const submission = this.submit(publicationSlug);
    this.pending.add(submission);
    observeBestEffort(
      submission.then(
        () => { this.pending.delete(submission); },
        () => { this.pending.delete(submission); },
      ),
      'IndexNow is secondary to the completed publication cache purge',
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async submit(publicationSlug: string): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const fetchOutcome = Promise.resolve().then(() => this.fetchImplementation(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildIndexNowPayload(this.options.key, publicationSlug)),
      signal: controller.signal,
    })).then(
      (response) => {
        if (timedOut && response.body !== null) {
          observeBestEffort(
            response.body.cancel(),
            'A late IndexNow response is irrelevant after the request deadline won',
          );
        }
        return { kind: 'response' as const, response };
      },
      () => ({ kind: 'network' as const }),
    );
    let resolveTimeout: ((value: { readonly kind: 'timeout' }) => void) | undefined;
    const timeoutOutcome = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      resolveTimeout = resolve;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      resolveTimeout?.({ kind: 'timeout' });
      controller.abort();
    }, this.options.timeoutMs);
    timeout.unref();
    const outcome = await Promise.race([fetchOutcome, timeoutOutcome]);
    clearTimeout(timeout);
    if (outcome.kind === 'timeout') {
      this.recordFailure('timeout');
      return;
    }
    if (outcome.kind === 'network') {
      this.recordFailure('network');
      return;
    }
    if (!outcome.response.ok) {
      this.recordFailure('http', outcome.response.status);
    } else {
      this.options.metrics?.increment(INDEXNOW_SUCCESS_METRIC);
    }
    if (outcome.response.body !== null) {
      observeBestEffort(
        outcome.response.body.cancel(),
        'IndexNow response bodies are irrelevant after the HTTP status is observed',
      );
    }
  }

  private recordFailure(
    failureKind: 'network' | 'http' | 'timeout',
    statusCode?: number,
  ): void {
    this.options.metrics?.increment(INDEXNOW_FAILURE_METRIC);
    this.options.metrics?.increment(`publication.indexnow.${failureKind}_failure`);
    this.options.logger?.warn({
      outcome: 'failed',
      failureKind,
      ...(statusCode === undefined ? {} : { statusCode }),
    }, 'IndexNow submission failed');
  }
}
