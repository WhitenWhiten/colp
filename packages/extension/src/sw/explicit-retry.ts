/**
 * A user's "Retry sync" (the Status button, or the Sync center's Retry command) is the one trigger
 * that may re-run a stopped engine's failing step at once. Bookmark captures, worker boots and
 * follow-up passes also arrive as `manual` wakes; they must not count as a user's decision.
 *
 * The request is a flag the next manual pass consumes, so it survives coalescing: a Retry that
 * lands while a pass is already running is picked up by the follow-up pass.
 */
let requested = false;

export function requestExplicitSyncRetry(): void { requested = true; }

export function takeExplicitSyncRetry(): boolean {
  const value = requested; requested = false; return value;
}
