/**
 * Delay before the engine retries a failed wake. The first failures are retried within half a
 * minute, which is also the platform's alarm floor; a failure that keeps repeating (the server is
 * down, the network is gone for a long while) is retried less and less often so a long outage is
 * not polled at its first cadence for hours. A connectivity event or a user's Retry never waits
 * for this delay.
 */
const BACKOFF_STAGES = [
  { upToFailures: 6, capMs: 30_000 },
  { upToFailures: 12, capMs: 2 * 60_000 },
  { upToFailures: 20, capMs: 5 * 60_000 },
] as const;
const LONG_OUTAGE_CAP_MS = 15 * 60_000;

export function engineBackoffCap(failures: number): number {
  return BACKOFF_STAGES.find((stage) => failures <= stage.upToFailures)?.capMs ?? LONG_OUTAGE_CAP_MS;
}

export function engineBackoffDelay(failures: number, retryAfterMilliseconds: number | undefined,
  random: () => number): number {
  if (retryAfterMilliseconds !== undefined) return retryAfterMilliseconds;
  const cap = engineBackoffCap(failures);
  const ceiling = Math.min(cap, 1_000 * 2 ** Math.min(14, failures));
  return Math.min(cap, Math.max(1_000, Math.floor(ceiling * Math.max(0.1, Math.min(1, random())))));
}
