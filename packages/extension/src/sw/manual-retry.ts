import type { SyncRetryResponse } from '../types.js';

/** How long Retry waits for the pass it started before it answers "still running". */
export const MANUAL_RETRY_WAIT_MS = 20_000;

/**
 * Answers a Retry after the pass has run, not before it has been asked for.
 *
 * The wake used to be fired and forgotten, so "Sync retry requested." appeared
 * even when the pass returned at once or failed. Now the page hears whether
 * the pass finished (`settled`), or that it is still going, or what it failed
 * with, and can read the status again to say whether anything changed.
 */
export async function settleManualRetry(wake: Promise<unknown>, describeError: (error: unknown) => string,
  waitMilliseconds = MANUAL_RETRY_WAIT_MS): Promise<SyncRetryResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'running'>((resolve) => { timer = setTimeout(() => resolve('running'), waitMilliseconds); });
  try {
    const outcome = await Promise.race([wake.then(() => 'settled' as const), timeout]);
    return { ok: true, settled: outcome === 'settled' };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
