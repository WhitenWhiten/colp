import assert from 'node:assert/strict';
import { test } from 'vitest';
import { productReplicaActivity, REPLICA_ACTIVITY_STALE_MS } from '../../../src/modules/sync/index.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds);

test('replica activity separates ordinary lag from a stuck or silent replica', () => {
  const active = { status: 'active' as const, now };
  assert.equal(productReplicaActivity({ ...active, behindSince: null, lastSeenAt: ago(5 * REPLICA_ACTIVITY_STALE_MS) }), 'current');
  assert.equal(productReplicaActivity({ ...active, behindSince: ago(REPLICA_ACTIVITY_STALE_MS - 1), lastSeenAt: ago(0) }), 'behind');
  assert.equal(productReplicaActivity({ ...active, behindSince: ago(REPLICA_ACTIVITY_STALE_MS), lastSeenAt: ago(60_000) }), 'stalled');
  assert.equal(productReplicaActivity({ ...active, behindSince: ago(REPLICA_ACTIVITY_STALE_MS),
    lastSeenAt: ago(REPLICA_ACTIVITY_STALE_MS) }), 'silent');
  // Catching up and expired replicas are judged by the same facts.
  assert.equal(productReplicaActivity({ status: 'recovery_required', now, behindSince: ago(2 * REPLICA_ACTIVITY_STALE_MS),
    lastSeenAt: ago(0) }), 'stalled');
  assert.equal(productReplicaActivity({ status: 'retired', now, behindSince: ago(2 * REPLICA_ACTIVITY_STALE_MS),
    lastSeenAt: ago(2 * REPLICA_ACTIVITY_STALE_MS) }), null);
});
