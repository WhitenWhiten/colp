import { buildCacheEpochKey, CacheKeyError, type CacheKeyOptions } from '../cache/cache-key-codec.js';
import type { CacheStore } from '../cache/cache-store.js';
import { OutboxDeliveryError } from './router.js';

export const REPORT_CACHE_EPOCH_TTL_MS = 120_000;
export const REPORT_CACHE_SOURCE_BATCH_LIMIT = 1_000;

export class RedisReportCacheInvalidator {
  constructor(private readonly options: { readonly store: CacheStore; readonly key: CacheKeyOptions; readonly epochTtlMs?: number }) {}

  async rotateSeries(slug: string, signal: AbortSignal): Promise<void> {
    await this.rotate({ kind: 'report', slug }, signal);
    await this.rotate({ kind: 'report-directory' }, signal);
  }

  async rotateDirectory(signal: AbortSignal): Promise<void> {
    await this.rotate({ kind: 'report-directory' }, signal);
  }

  async rotateSource(signal: AbortSignal, slugs: readonly string[] = []): Promise<void> {
    const unique = [...new Set(slugs)];
    if (unique.length > REPORT_CACHE_SOURCE_BATCH_LIMIT) {
      throw new OutboxDeliveryError('retryable', 'report source invalidation batch exceeds bounded limit');
    }
    for (const slug of unique) {
      signal.throwIfAborted();
      await this.rotate({ kind: 'report', slug }, signal);
    }
    await this.rotateDirectory(signal);
  }

  private async rotate(domain: { readonly kind: 'report'; readonly slug: string } | { readonly kind: 'report-directory' }, signal: AbortSignal): Promise<void> {
    try {
      const key = buildCacheEpochKey({ ...this.options.key, domain });
      await this.options.store.rotateEpoch(key, this.options.epochTtlMs ?? REPORT_CACHE_EPOCH_TTL_MS, signal);
    } catch (error) {
      if (error instanceof CacheKeyError) throw new OutboxDeliveryError('permanent', 'report cache invalidation scope is not keyable');
      throw new OutboxDeliveryError('retryable', 'report cache invalidation failed');
    }
  }
}
