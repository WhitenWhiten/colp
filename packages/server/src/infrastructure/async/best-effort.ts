/**
 * Explicit boundary for a secondary Promise whose failure cannot change the
 * authoritative outcome (for example, observing a late query rejection after
 * an AbortSignal already won). Do not use this for durable cleanup, rollback,
 * or state transitions: those failures must be propagated or reported.
 */
export function observeBestEffort(
  promise: PromiseLike<unknown>,
  rationale: string,
): void {
  assertRationale(rationale);
  void settle(promise);
}

/** Await a best-effort secondary action while deliberately discarding failure. */
export function settleBestEffort(
  promise: PromiseLike<unknown>,
  rationale: string,
): Promise<void> {
  assertRationale(rationale);
  return settle(promise);
}

async function settle(promise: PromiseLike<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // The required call-site rationale owns why this rejection is secondary.
  }
}

function assertRationale(rationale: string): void {
  if (rationale.trim().length < 12) {
    throw new TypeError('Best-effort Promise suppression requires a specific rationale');
  }
}
