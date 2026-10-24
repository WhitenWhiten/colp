import type { PersonalSyncMode } from '../personal-sync-policy.js';
import { titleOf } from '../sync-issue-snapshot.js';
import type { DurableSyncEngineState, QueueOperation, SyncScope } from '../sync-state-store.js';
import { evaluateWatchdog, watchdogMarkerChanged, type WatchdogMarker, type WatchdogResult } from '../sync-watchdog.js';

/** Where the watchdog remembers what it has seen, so a worker restart does not forget how long something has not moved. */
export const WATCHDOG_MARKER_KEY = 'known.sync.watchdog.v1';
/** In session storage, which a browser restart clears: its presence says the browser has not been restarted since. */
const SESSION_KEY = 'known.sync.watchdog.session';

interface Area {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
interface Stored { readonly replicaId: string; readonly marker: WatchdogMarker }

export interface SyncWatchdogDeps {
  readonly local: Area;
  /** Without session storage every browser start looks like a fresh session, which only makes the watchdog quieter. */
  readonly session?: Area;
  readonly now?: () => number;
  /** The change at the head of the push lane. */
  readonly head: (scope: SyncScope) => Promise<Pick<QueueOperation, 'opId' | 'payload'> | null>;
  readonly mode?: (scope: SyncScope) => Promise<PersonalSyncMode | undefined>;
}

export interface SyncWatchdog {
  /** Never throws: a watchdog that fails says nothing. */
  sample(input: { readonly scope: SyncScope; readonly engine: DurableSyncEngineState | null | undefined;
    readonly explained: boolean }): Promise<WatchdogResult | undefined>;
}

export function createSyncWatchdog(deps: SyncWatchdogDeps): SyncWatchdog {
  const clock = deps.now ?? Date.now;
  async function sessionStart(now: number): Promise<number> {
    try {
      const stored = (await deps.session?.get(SESSION_KEY))?.[SESSION_KEY];
      if (typeof stored === 'number' && Number.isFinite(stored) && stored <= now) return stored;
      await deps.session?.set({ [SESSION_KEY]: now });
    } catch { /* No session storage: this moment is the start, and the watchdog stays quiet. */ }
    return now;
  }
  return { async sample({ scope, engine, explained }) {
    try {
      if (!engine) return undefined;
      const now = clock();
      const mode = await deps.mode?.(scope).catch(() => undefined);
      const row = await deps.head(scope).catch(() => null);
      const title = row ? titleOf(row.payload) : undefined;
      const stored = (await deps.local.get(WATCHDOG_MARKER_KEY))[WATCHDOG_MARKER_KEY] as Stored | undefined;
      const marker = stored?.replicaId === scope.replicaId && stored.marker?.version === 1 ? stored.marker : undefined;
      const result = evaluateWatchdog(marker, { now, sessionStart: await sessionStart(now),
        explained: explained || (mode !== undefined && mode !== 'enabled'),
        ...(row ? { head: { opId: row.opId, ...(title ? { title } : {}) } } : {}),
        engineUpdatedAt: engine.updatedAt, passEnded: engine.phase === 'sleeping' && engine.lastError === undefined });
      if (watchdogMarkerChanged(marker, result.marker)) {
        await deps.local.set({ [WATCHDOG_MARKER_KEY]: { replicaId: scope.replicaId, marker: result.marker } satisfies Stored });
      }
      return result;
    } catch { return undefined; }
  } };
}
