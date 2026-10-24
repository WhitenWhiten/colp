import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { stableError } from './durable-sync-engine-errors.js';
import { classifySyncFailure } from './sync-failure-class.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Local issues one pass records before it only counts the rest, so a systematic fault cannot flood the list. */
export const ISOLATED_ISSUES_PER_PASS = 5;

type IsolationStore = Pick<ReturnType<typeof createSyncStateStore>, 'recordLocalIssue' | 'putScopeDiagnostic'>;

/**
 * A-F11: the lost-event safety nets (tree reconcile, missing-removal scan) walk every bookmark in
 * one pass. One bookmark that throws used to end the pass, so a single poison node switched the
 * net off for the whole library and, in a frozen state, the engine wake that calls it.
 *
 * `run` isolates a failure that belongs to one bookmark: an unregistered code or an `item` code.
 * A pause, an authority problem, a replica-wide fault (the store is unreadable) or the browser
 * refusing the extension's access still ends the pass at once, so the caller sees that the net
 * did not complete and schedules it again. `finish` makes the isolated failures visible:
 * the first few become local issues (they carry the bookmark's id) and the count goes to a scope
 * diagnostic. If no bookmark of the pass worked, the problem is not one bookmark's and the first
 * failure is rethrown as before.
 */
export function createNodeIsolation(input: { readonly store: IsolationStore; readonly scope: SyncScope; readonly now?: () => number }) {
  let attempted = 0; const failed: { readonly nativeId: string; readonly code: string; readonly error: unknown }[] = [];
  async function run(nativeId: string, work: () => Promise<void>): Promise<void> {
    attempted += 1;
    try { await work(); } catch (error) {
      const code = stableError(error);
      const policy = classifySyncFailure(code, { nativeId });
      if (policy && policy.class !== 'item') throw error;
      // The browser refusing the whole extension is not one bookmark's problem either.
      if (classifyBookmarkApiFailure(error) === 'permission_denied') throw error;
      failed.push({ nativeId, code, error });
    }
  }
  async function finish(): Promise<void> {
    if (failed.length === 0) return;
    if (failed.length === attempted) throw failed[0]!.error;
    const at = (input.now ?? Date.now)();
    for (const row of failed.slice(0, ISOLATED_ISSUES_PER_PASS)) {
      try { await input.store.recordLocalIssue(input.scope, { code: row.code, nativeId: row.nativeId, now: at }); }
      catch { /* the diagnostic below still counts it */ }
    }
    try { await input.store.putScopeDiagnostic(input.scope, { kind: 'capture_net_node_failures', code: failed[0]!.code,
      details: { failed: failed.length, attempted } }); } catch { /* best effort */ }
  }
  return { run, finish };
}
