import { createMemorySearchRateLimiter } from '../../src/transport/http-security.js';

/** Generous in-memory limiter for tests that register Explore / Directory / Activity. */
export function memoryExploreDirectoryLimiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000,
    accountMaxRequests: 10_000,
    windowMs: 60_000,
  });
}

export function memoryPublicActivityLimiter() {
  return memoryExploreDirectoryLimiter();
}
