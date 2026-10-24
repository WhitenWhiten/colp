import { stableError } from './errors.js';
import type { SyncStoreRuntime } from './runtime.js';
import { STORES } from './schema.js';

/**
 * W2A-01: whether the sync database can be used at all, and if not, why.
 *
 * Every other read goes through `open()`, so a database written by a newer extension, one missing a store,
 * or a backing store that fails made every status read throw and the popup answered "Sync is off". This
 * names the cause so the status can say it and offer the one exit that works: resetting local sync data.
 *
 * - `newer_version`: a newer extension wrote it (`future_schema`); an older build cannot read it.
 * - `read_only`: it opens but a store or index is missing (`diagnostic_read_only`); every write is refused.
 * - `upgrade_failed`: the upgrade to this version aborted.
 * - `unavailable`: the browser's storage failed (`storage_unavailable`, `quota_exceeded`, ...); it may pass.
 */
export type SyncStorageState = 'ok' | 'newer_version' | 'read_only' | 'upgrade_failed' | 'unavailable';
export interface SyncStorageHealth { readonly state: SyncStorageState; readonly code?: string }

const STATE_OF: Readonly<Record<string, SyncStorageState>> = Object.freeze({
  future_schema: 'newer_version', diagnostic_read_only: 'read_only', upgrade_failed: 'upgrade_failed',
});

export function createStorageStateRepository(ctx: SyncStoreRuntime) {
  return {
    /** Never throws; a real transaction proves the connection is alive, not only that one was opened. */
    async storageState(): Promise<SyncStorageHealth> {
      try {
        await ctx.open();
        if (ctx.isDiagnosticReadOnly()) return { state: 'read_only', code: 'diagnostic_read_only' };
        await ctx.readOne(STORES.metadata, 'schema');
        return { state: 'ok' };
      } catch (error) {
        const code = stableError(error).code;
        return { state: Object.hasOwn(STATE_OF, code) ? STATE_OF[code]! : 'unavailable', code };
      }
    },
    /** For the controlled local-data reset: close the connection and forget the flags of the deleted database. */
    forgetStorage() { ctx.reset(); },
  };
}
