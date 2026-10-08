import { isProductSurfaceRateLimiter, type ProductAdmissionRateLimiter } from './http-security.js';
import type { ProductSurfaceRateLimitPurpose } from '../infrastructure/rate-limit/index.js';

export function assertSharedProductRateLimiters(enabled: boolean, limiters: readonly {
  readonly purpose: ProductSurfaceRateLimitPurpose; readonly limiter: ProductAdmissionRateLimiter | undefined;
}[]): void {
  if (!enabled) return;
  const invalidPurposes = limiters.filter(({purpose, limiter}) => limiter === undefined
    || !isProductSurfaceRateLimiter(limiter) || limiter.purpose !== purpose).map(({purpose}) => purpose);
  if (invalidPurposes.length > 0) {
    throw new Error('buildApiApp requires purpose-matched shared product-route rate limiters when '
      + `PRODUCT_ROUTE_RATE_LIMIT_SHARED=true (missing or invalid: ${invalidPurposes.join(', ')})`);
  }
}
