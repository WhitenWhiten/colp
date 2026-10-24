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

export interface ManualRetryDeps {
  /** Marks the next manual pass as the person's own Retry (`explicit-retry.ts`); bookmark captures and worker boots are not. */
  readonly request: () => void;
  /** Asks for the manual pass. It is asked for after the request is recorded, never before. */
  readonly wake: () => Promise<unknown>;
  readonly describeError: (error: unknown) => string;
  /** Where a failed pass is logged; the answer carries the code either way. */
  readonly onError?: (error: unknown) => void;
  readonly waitMilliseconds?: number;
}

/**
 * The one path of the Status tab's "Retry sync": record that the person asked, run the manual
 * pass, and answer once it has settled (or after the bounded wait). The Sync center's Retry
 * command records the same request and runs the same pass inside its own command lane.
 */
export function runManualRetry(deps: ManualRetryDeps): Promise<SyncRetryResponse> {
  deps.request();
  let wake: Promise<unknown>;
  try { wake = Promise.resolve(deps.wake()); } catch (error) { wake = Promise.reject(error); }
  if (deps.onError) wake.catch(deps.onError);
  return settleManualRetry(wake, deps.describeError, deps.waitMilliseconds);
}
