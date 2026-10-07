import type { ProductSurfaceRateLimiter, ProductSurfaceRateLimitOutcome, ProductSurfaceRateLimitReadiness } from '../infrastructure/rate-limit/index.js';
import { consumeProductAdmission, isProductSurfaceRateLimiter, type ProductAdmissionRateLimiter } from './http-security.js';

/**
 * Compose independent sustained and burst budgets while preserving the
 * shared adapter's fail-closed outcome. The wrapper is itself a product
 * limiter, so lifecycle and shared-purpose checks continue to treat the two
 * buckets as one credits-read admission family.
 */
export function createProductBurstRateLimiter(
  sustained: ProductAdmissionRateLimiter,
  burst: ProductAdmissionRateLimiter,
  purpose: ProductSurfaceRateLimiter['purpose'],
): ProductSurfaceRateLimiter {
  const close = async (limiter: ProductAdmissionRateLimiter): Promise<void> => {
    if (isProductSurfaceRateLimiter(limiter)) await limiter.close();
  };
  const readiness = (): ProductSurfaceRateLimitReadiness => {
    const states = [sustained, burst]
      .filter(isProductSurfaceRateLimiter)
      .map((limiter) => limiter.readiness());
    if (states.some((state) => state.status === 'degraded')) {
      const degraded = states.find((state) => state.status === 'degraded')!;
      return degraded;
    }
    return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: Date.now() };
  };
  return {
    purpose,
    readiness,
    async consume(key): Promise<ProductSurfaceRateLimitOutcome> {
      const sustainedResult = await consumeProductAdmission(sustained, key);
      if (sustainedResult.kind === 'failed') {
        return { kind: 'failed', failure: { class: 'internal', code: 'sustained_unavailable' } };
      }
      if (sustainedResult.kind === 'denied') {
        return { kind: 'denied', decision: { allowed: false, retryAfterSeconds: sustainedResult.retryAfterSeconds } };
      }
      const burstResult = await consumeProductAdmission(burst, JSON.stringify(['burst', key]));
      if (burstResult.kind === 'failed') {
        return { kind: 'failed', failure: { class: 'internal', code: 'burst_unavailable' } };
      }
      if (burstResult.kind === 'denied') {
        return { kind: 'denied', decision: { allowed: false, retryAfterSeconds: burstResult.retryAfterSeconds } };
      }
      return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
    },
    close: async () => { await Promise.all([close(sustained), close(burst)]); },
  };
}
