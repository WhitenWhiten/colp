import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { assertPushSession } from '../src/push-authority.js';
import { parseSyncSessionResult, retainSessionAfterTransientRenewalFailure, retryStaleReplicaSession,
  SessionRequestError, syncSessionNeedsRenewal } from '../src/session-client.js';
import { CLOCK_SKEW_WARNING_MILLISECONDS, clientClockSkew, clockSkewIsSignificant, localTimeOf,
  measureClientClockSkew, serverNow } from '../src/session-clock.js';
import { recordClockSkew } from '../src/session-clock-record.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { readEngineSessionAuthority, sessionExpiresWithin } from '../src/sync-session-handoff.js';
import type { SyncScope } from '../src/sync-state-store.js';
import type { StoredSession } from '../src/types.js';

// W2B-P0-1 (sync resilience audit): the Session and its replica lease expire in SERVER time, but the engine
// judged them against this computer's clock. A clock 15 minutes ahead rejected every fresh Session; a clock
// behind kept using an expired one. The offset measured at the mint is now kept and used for every judgment.
const SERVER_NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const MINUTE = 60_000;
const SESSION_TTL = 15 * MINUTE; // server default SYNC_SESSION_DURATION_SECONDS = 900
const LEASE_TTL = 24 * 60 * MINUTE;
const scope = { collectionId: 'c' } as SyncScope;

/** A Session as the server answers it at `serverMint` to a request built by a client whose clock reads `clientSkew` later. */
function mint(clientSkew: number, serverMint = SERVER_NOW, roundTrip = 200): StoredSession {
  const clientSent = serverMint + clientSkew - roundTrip / 2;
  const body = { sessionId: 's', expiresAt: new Date(serverMint + SESSION_TTL).toISOString(),
    serverTime: new Date(serverMint).toISOString(), clockSkewMilliseconds: serverMint - clientSent,
    acceptedProtocolVersion: '0.2', scope: 'collection', maxBatchOperations: 1, tombstoneRetentionSeconds: 1,
    replicaLease: { leaseId: 'l', generation: '1', state: 'active', lastSeenAt: new Date(serverMint).toISOString(),
      expiresAt: new Date(serverMint + LEASE_TTL).toISOString(), acknowledgedCursor: null },
    collection: { collectionId: 'c', snapshotRequired: false, serverCursor: 'x', serverRevision: 'r' },
    conversionPolicy: { alias: 'duplicate', separator: 'preserve_remote', unknownExtensions: 'sidecar' } };
  const request = { protocolVersion: '0.2', replica: { capabilities: { maxBatchOperations: 1 } },
    collection: { collectionId: 'c' }, clientTime: new Date(clientSent).toISOString() };
  return parseSyncSessionResult(body, request, 'a'.repeat(64), undefined, clientSent + roundTrip);
}

async function engineAccepts(session: StoredSession, clientNow: number): Promise<string> {
  const options: any = { scope, sessions: { get: async () => ({ credential: {}, session }) },
    store: { getEngineState: async () => null } };
  try { await readEngineSessionAuthority(options, () => clientNow); return 'accepted'; }
  catch (error) { return `rejected:${(error as Error).message}`; }
}

describe('Session expiry is judged in server time (W2B-P0-1)', () => {
  test('the Session keeps the clock offset the response measured', () => {
    assert.equal(clientClockSkew(mint(0)), 0);
    assert.equal(clientClockSkew(mint(20 * MINUTE)), 20 * MINUTE);
    assert.equal(clientClockSkew(mint(-20 * MINUTE)), -20 * MINUTE);
    // Half the round trip is not charged to the clock: the estimate sits at the middle of the exchange.
    assert.equal(clientClockSkew(mint(5 * MINUTE, SERVER_NOW, 4_000)), 5 * MINUTE);
    assert.equal(measureClientClockSkew({ clientTime: undefined, serverTime: new Date(SERVER_NOW).toISOString(),
      receivedAt: SERVER_NOW + 1_000 }), 1_000);
  });

  for (const skew of [-20 * MINUTE, -MINUTE, 0, MINUTE, 14.5 * MINUTE, 16 * MINUTE, 20 * MINUTE, 3 * 60 * MINUTE]) {
    test(`a fresh Session is accepted with the clock ${skew / MINUTE} min off, and not renewed on every call`, async () => {
      const session = mint(skew);
      const clientNow = SERVER_NOW + skew + 2_000; // two seconds after the mint
      assert.equal(await engineAccepts(session, clientNow), 'accepted');
      assert.equal(syncSessionNeedsRenewal(session, clientNow), false);
      assert.equal(sessionExpiresWithin(session, clientNow, 60_000), false);
      assert.doesNotThrow(() => assertPushSession(session, scope, clientNow));
    });

    test(`the same Session expires after 15 server minutes with the clock ${skew / MINUTE} min off`, async () => {
      const session = mint(skew);
      const later = SERVER_NOW + skew + SESSION_TTL + 1_000;
      assert.equal(await engineAccepts(session, later), 'rejected:session_invalid');
      assert.equal(syncSessionNeedsRenewal(session, later), true);
      assert.throws(() => assertPushSession(session, scope, later), /sync_session_invalid/);
      // The renewal window opens a minute before expiry, in server time.
      const renewalDue = SERVER_NOW + skew + SESSION_TTL - 30_000;
      assert.equal(syncSessionNeedsRenewal(session, renewalDue), true);
      assert.equal(syncSessionNeedsRenewal(session, SERVER_NOW + skew + SESSION_TTL - 90_000), false);
    });
  }

  test('a Session the server already expired is not used while the clock runs behind', async () => {
    // Client 10 minutes behind, 16 server minutes after the mint: the local clock still reads inside the TTL.
    const session = mint(-10 * MINUTE);
    const clientNow = SERVER_NOW - 10 * MINUTE + 16 * MINUTE;
    assert.equal(await engineAccepts(session, clientNow), 'rejected:session_invalid');
    assert.equal(syncSessionNeedsRenewal(session, clientNow), true);
  });

  test('a Session stored before the offset was measured is judged exactly as before', async () => {
    const legacy = { ...mint(20 * MINUTE) } as Record<string, unknown>;
    delete legacy.clientClockSkewMilliseconds;
    const session = legacy as unknown as StoredSession;
    assert.equal(clientClockSkew(session), 0);
    assert.equal(serverNow(session, 5_000), 5_000);
    assert.equal(await engineAccepts(session, SERVER_NOW + 1_000), 'accepted');
    assert.equal(await engineAccepts(session, SERVER_NOW + SESSION_TTL + 1_000), 'rejected:session_invalid');
  });

  test('transient renewal failures retain a Session by its server-time expiry', () => {
    const session = mint(20 * MINUTE);
    const clientNow = SERVER_NOW + 20 * MINUTE + 5 * MINUTE; // five server minutes in, ten left
    const offline = new TypeError('Failed to fetch');
    assert.equal(retainSessionAfterTransientRenewalFailure(session, offline, clientNow), true);
    const nearlyOver = SERVER_NOW + 20 * MINUTE + SESSION_TTL + 1_000;
    assert.equal(retainSessionAfterTransientRenewalFailure(session, offline, nearlyOver), false);
    const limited = new SessionRequestError('rate_limited', 5 * MINUTE);
    assert.equal(retainSessionAfterTransientRenewalFailure(session, limited, clientNow), true);
    assert.equal(retainSessionAfterTransientRenewalFailure(session, new SessionRequestError('rate_limited', 11 * MINUTE),
      clientNow), false);
    assert.equal(localTimeOf(session, session.expiresAt), SERVER_NOW + 20 * MINUTE + SESSION_TTL);
  });

  test('a stale-replica retry still renews a Session that is live in server time', async () => {
    const session = mint(20 * MINUTE);
    const live = SERVER_NOW + 20 * MINUTE + MINUTE;
    let renewed = 0;
    await retryStaleReplicaSession(session, new Error('stale_replica'), async () => { renewed += 1; return session; }, live);
    assert.equal(renewed, 1);
    await assert.rejects(retryStaleReplicaSession(session, new Error('stale_replica'),
      async () => session, SERVER_NOW + 20 * MINUTE + SESSION_TTL + 1), /stale_replica/);
  });
});

describe('clock skew is named, not blocking (K4)', () => {
  test('session_invalid and clock_skew are registered', () => {
    assert.deepEqual([classifySyncFailure('session_invalid')?.class, classifySyncFailure('session_invalid')?.exit],
      ['authority', 'refresh']);
    const skew = classifySyncFailure('clock_skew');
    assert.deepEqual([skew?.class, skew?.exit, skew?.pullsOnWake], ['transient', 'retry', true]);
  });

  test('the warning threshold is two minutes either way', () => {
    assert.equal(CLOCK_SKEW_WARNING_MILLISECONDS, 2 * MINUTE);
    assert.equal(clockSkewIsSignificant(2 * MINUTE), false);
    assert.equal(clockSkewIsSignificant(2 * MINUTE + 1), true);
    assert.equal(clockSkewIsSignificant(-2 * MINUTE - 1), true);
  });

  test('a diagnostics row carries the signed skew, and one all-clear row follows when it is back in bounds', async () => {
    const rows: Array<{ kind: string; code: string; details?: Record<string, unknown> }> = [];
    const store = { putScopeDiagnostic: async (_scope: SyncScope, row: (typeof rows)[number]) => { rows.push(row); } };
    await recordClockSkew(store, scope, mint(0), 1);
    assert.equal(rows.length, 0, 'a healthy clock leaves no trace');
    await recordClockSkew(store, scope, mint(20 * MINUTE), 2);
    await recordClockSkew(store, scope, mint(-20 * MINUTE), 3);
    await recordClockSkew(store, scope, mint(MINUTE), 4);
    await recordClockSkew(store, scope, mint(MINUTE), 5);
    assert.deepEqual(rows.map((row) => [row.kind, row.code, row.details?.skewMilliseconds, row.details?.exceeded]), [
      ['clock_skew', 'clock_skew', 20 * MINUTE, true],
      ['clock_skew', 'clock_skew', -20 * MINUTE, true],
      ['clock_skew', 'clock_skew', MINUTE, false],
    ]);
  });
});
