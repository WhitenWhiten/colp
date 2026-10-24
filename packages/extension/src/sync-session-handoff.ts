import { pendingNativeOrPullFacts } from './native-repair.js';
import { cursorIsConfirmed } from './sync-state/cursor-confirmation.js';
import type { EngineOptions } from './durable-sync-engine-types.js';
import { serverNow } from './session-clock.js';
import type { StoredSession } from './types.js';

/** True when the Session's server-time expiry is within `marginMilliseconds` of now on this computer's clock. */
export function sessionExpiresWithin(session: Pick<StoredSession, 'expiresAt' | 'clientClockSkewMilliseconds'>,
  localNow: number, marginMilliseconds = 0): boolean {
  return Date.parse(session.expiresAt) <= serverNow(session, localNow) + marginMilliseconds;
}

/** Adopt a renewed token only at a fully acknowledged local boundary. Pending
 * Acks and browser effects retain their original authority and exact bytes. */
export async function readEngineSessionAuthority(options: Pick<EngineOptions, 'sessions' | 'store' | 'scope'>, now: () => number,
  forceRefresh = false) {
  const authority = await options.sessions.get(forceRefresh); const session = authority.session;
  if (session.acceptedProtocolVersion !== '0.2' || session.collection.collectionId !== options.scope.collectionId
      || sessionExpiresWithin(session, now())) throw new Error('session_invalid');
  const prior = await options.store.getEngineState(options.scope);
  if (!prior?.sessionId || prior.sessionId === session.sessionId || session.snapshotRequired
      || prior.recoveryFrozen || prior.authorityRefreshRequired) return authority;
  const cursor = await options.store.getCursor(options.scope);
  if (!cursor || await options.store.getPendingAckIntent(options.scope)) return authority;
  const facts = await pendingNativeOrPullFacts(options.store, options.scope);
  if (facts.pendingIncompletePull || facts.nativeResultUnknown) return authority;
  const acks = await options.store.listAckIntents(options.scope);
  if (!cursorIsConfirmed(cursor, prior.lastAckedCursor, acks)) return authority;
  const frozen = await options.store.transitionEngine(options.scope, { ...prior, phase: 'session',
    recoveryFrozen: true, authorityRefreshRequired: true, updatedAt: now(), expectedRevision: prior.revision });
  try {
    await options.store.rebaseActiveSessionAuthority(options.scope, {
      cursor: session.collection.serverCursor, serverRevision: session.collection.serverRevision,
      expectedEngineRevision: frozen.revision, requireConfirmedCursor: cursor.cursor,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'session_handoff_pending') {
      await options.store.transitionEngine(options.scope, { ...prior, expectedRevision: frozen.revision });
    }
    throw error;
  }
  await options.store.transitionEngine(options.scope, { ...frozen, phase: 'session',
    sessionId: session.sessionId, recoveryFrozen: false, authorityRefreshRequired: false,
    notBefore: 0, updatedAt: now(), expectedRevision: frozen.revision,
    lastPublishedCursor: session.collection.serverCursor, lastAckedCursor: session.collection.serverCursor });
  return authority;
}
