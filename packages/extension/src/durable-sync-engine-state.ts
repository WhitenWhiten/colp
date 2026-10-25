import type { EngineOptions } from './durable-sync-engine-types.js';
import type { DurableSyncEngineState } from './sync-state-store.js';

export type EngineTransitionPatch = Partial<DurableSyncEngineState>
  & { readonly expectedRevision?: number; readonly clearConnectivityConfirmation?: boolean };

/** The engine row (or a fresh `idle` one) and the compare-and-swap writer every phase change goes through. */
export function createEngineStateAccess(options: EngineOptions, now: () => number) {
  async function state() { return await options.store.getEngineState(options.scope) ?? {
    scopeKey: (await options.store.getScope(options.scope))!.scopeKey, phase: 'idle', revision: 0, updatedAt: now(),
    recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 } satisfies DurableSyncEngineState; }
  async function transition(phase: DurableSyncEngineState['phase'], patch: EngineTransitionPatch = {}) {
    const prior = await state(); return options.store.transitionEngine(options.scope, { phase, updatedAt: now(),
      recoveryFrozen: patch.recoveryFrozen ?? prior.recoveryFrozen, notBefore: patch.notBefore ?? prior.notBefore,
      authorityRefreshRequired: patch.authorityRefreshRequired ?? prior.authorityRefreshRequired,
      ...(('circuitBreaker' in patch ? patch.circuitBreaker : prior.circuitBreaker) === undefined ? {}
        : { circuitBreaker: 'circuitBreaker' in patch ? patch.circuitBreaker : prior.circuitBreaker }),
      ...(patch.recoveryFrozen === undefined && prior.localProjectionOwner !== undefined
        ? { localProjectionOwner: prior.localProjectionOwner } : {}),
      ...(!patch.clearConnectivityConfirmation && prior.connectivityConfirmationRevision !== undefined
        ? { connectivityConfirmationRevision: prior.connectivityConfirmationRevision } : {}),
      // Compare-and-swap every transition so a concurrent recovery/freeze write
      // cannot be overwritten by this stale read-modify-write.
      expectedRevision: patch.expectedRevision ?? prior.revision,
      ...(patch.lastPushServerCursor ?? prior.lastPushServerCursor ? { lastPushServerCursor:
        patch.lastPushServerCursor ?? prior.lastPushServerCursor } : {}),
      ...(patch.lastPushOutcomeHint ?? prior.lastPushOutcomeHint ? { lastPushOutcomeHint:
        patch.lastPushOutcomeHint ?? prior.lastPushOutcomeHint } : {}),
      ...(patch.networkBackoffCount !== undefined || prior.networkBackoffCount !== undefined
        ? { networkBackoffCount: patch.networkBackoffCount ?? prior.networkBackoffCount ?? 0 } : {}),
      ...(patch.sessionId ?? prior.sessionId ? { sessionId: patch.sessionId ?? prior.sessionId } : {}),
      ...(patch.lastPublishedCursor ?? prior.lastPublishedCursor ? { lastPublishedCursor:
        patch.lastPublishedCursor ?? prior.lastPublishedCursor } : {}),
      ...(patch.lastAckedCursor ?? prior.lastAckedCursor ? { lastAckedCursor: patch.lastAckedCursor
        ?? prior.lastAckedCursor } : {}), ...(patch.lastError ? { lastError: patch.lastError } : {}) }); }
  return { state, transition };
}

/** The cursor `pull()` would request from: the cursor row, else the scope checkpoint. */
export async function readDurableCursor(options: Pick<EngineOptions, 'store' | 'scope'>) {
  const [row, recorded] = await Promise.all([options.store.getCursor(options.scope), options.store.getScope(options.scope)]);
  if (row?.cursor) return { cursor: row.cursor, serverRevision: row.checkpoint };
  return recorded?.checkpoint ? { cursor: recorded.checkpoint.cursor, serverRevision: recorded.checkpoint.serverRevision } : undefined;
}
