export function requireLocalPerformanceEnvironment(environment = process.env) {
  if (environment.GITHUB_ACTIONS === 'true') {
    throw new Error('Publication performance measurement is local-only; GitHub Actions must not run it.');
  }
}

export function summarizeDurations(durations) {
  if (!Array.isArray(durations) || durations.length === 0
    || durations.some(value => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('A non-empty array of finite nonnegative durations is required.');
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const at = quantile => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
  return { samples: sorted.length, meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) };
}

export function samePerformanceEnvironment(left, right) {
  return ['platform', 'arch', 'nodeMajor', 'cpu'].every(key =>
    typeof left?.[key] === 'string' && left[key] === right?.[key]);
}
