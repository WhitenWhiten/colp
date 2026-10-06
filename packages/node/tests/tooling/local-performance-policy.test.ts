import { describe, expect, it } from 'vitest';

const { requireLocalPerformanceEnvironment, summarizeDurations, samePerformanceEnvironment } = await import(
  new URL('../../scripts/lib/local-performance.mjs', import.meta.url).href
) as {
  requireLocalPerformanceEnvironment(environment: Record<string, string>): void;
  summarizeDurations(values: number[]): Record<string, number>;
  samePerformanceEnvironment(left: Record<string, string>, right: Record<string, string>): boolean;
};

describe('Local performance tooling policy (without running any benchmark)', () => {
  it('rejects Actions and accepts a local environment', () => {
    expect(() => requireLocalPerformanceEnvironment({ GITHUB_ACTIONS: 'true' })).toThrow('local-only');
    expect(() => requireLocalPerformanceEnvironment({})).not.toThrow();
  });
  it('summarizes durations without changing samples', () => {
    const durations = [4, 1, 3, 2];
    expect(summarizeDurations(durations)).toEqual({ samples: 4, meanMs: 2.5, p50Ms: 2, p95Ms: 4, maxMs: 4 });
    expect(durations).toEqual([4, 1, 3, 2]);
    expect(() => summarizeDurations([])).toThrow();
  });
  it('refuses a cross-platform or cross-Node-major comparison', () => {
    const reference = { platform: 'win32', arch: 'x64', nodeMajor: '24', cpu: 'same-host-cpu' };
    expect(samePerformanceEnvironment(reference, { ...reference })).toBe(true);
    expect(samePerformanceEnvironment(reference, { ...reference, platform: 'linux' })).toBe(false);
    expect(samePerformanceEnvironment(reference, { ...reference, nodeMajor: '22' })).toBe(false);
  });
});
