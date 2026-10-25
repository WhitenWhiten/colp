import { CLOCK_SKEW_WARNING_MILLISECONDS, clientClockSkew, clockSkewIsSignificant } from './session-clock.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { StoredSession } from './types.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'putScopeDiagnostic'>;
/** Whether this worker last wrote an exceeded row, so the all-clear is written once (and only then). */
const recorded = { exceeded: false };

/**
 * K4: leave a durable trace of this computer's clock being off, so the card and the health report can say
 * so. Sync keeps working (expiry is judged in server time); the code only names the cause.
 *
 * One row per scope (`clock_skew`), rewritten at every mint where the clock is off, and once more with
 * `exceeded: false` when it is back within bounds so a reader never sees a stale warning as current. The
 * Session's own `clientClockSkewMilliseconds` stays the live value.
 */
export async function recordClockSkew(store: Store, scope: SyncScope, session: StoredSession,
  measuredAt: number = Date.now()): Promise<void> {
  const skewMilliseconds = clientClockSkew(session);
  const exceeded = clockSkewIsSignificant(skewMilliseconds);
  if (!exceeded && !recorded.exceeded) return;
  try {
    await store.putScopeDiagnostic(scope, { kind: 'clock_skew', code: 'clock_skew', details: {
      skewMilliseconds, thresholdMilliseconds: CLOCK_SKEW_WARNING_MILLISECONDS, exceeded, measuredAt } });
    recorded.exceeded = exceeded;
  } catch { /* best-effort: the Session carries the live value */ }
}
