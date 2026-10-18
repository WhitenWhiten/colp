import { enforceSyncIssueCeiling, SYNC_ISSUE_CEILING_CODE } from './sync-issue-ceiling.js';
import { stableError } from './durable-sync-engine-errors.js';
import type { EngineOptions } from './durable-sync-engine-types.js';

/** Finish only already-started native work while admission is stopped. */
export async function recoverAtSyncIssueCeiling(options: EngineOptions, authority: () => Promise<unknown>, now: () => number): Promise<boolean> {
  const { store, scope } = options;
  if (await enforceSyncIssueCeiling(store, scope, now())) {
    try {
      const pending = await store.listPullEvents(scope, ['browser_call_started', 'native_event_observed', 'authority_committed']);
      if (pending.length) { await options.endpoints(); await authority(); await options.pullApplier.resume({ recoveryOnly: true }); }
      if ((await store.listProjectionIntents(scope)).some(row => row.state === 'executing' || row.state === 'recovery')) {
        const exported = await store.exportScope(scope);
        const mappings = exported.recovery ? exported.recoveryNodes.map(row => row.mapping)
          : (await store.listMappings(scope)).map(({ scopeKey: _key, ...row }) => row);
        await options.snapshotProjector(mappings, { recoveryOnly: true });
      }
    } catch (error) {
      await store.putScopeDiagnostic(scope, { kind: 'issue_ceiling_native_recovery', code: stableError(error) });
      options.schedule?.(30_000);
    }
    return true;
  }
  const current = await store.getEngineState(scope);
  if (current?.lastError === SYNC_ISSUE_CEILING_CODE) {
    const staging = await store.hasRecoveryStaging(scope);
    const { lastError: _error, ...prior } = current;
    await store.transitionEngine(scope, { ...prior, phase: staging ? 'recovery' : 'sleeping',
      recoveryFrozen: staging || current.localProjectionOwner !== undefined,
      expectedRevision: current.revision, updatedAt: now(), notBefore: 0 });
  }
  return false;
}
