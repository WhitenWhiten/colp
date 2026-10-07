import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createSyncRecoveryCapabilityKeyring,
  type SyncRecoveryCapabilityClaims,
} from '../../../src/modules/sync/index.js';

const claims: SyncRecoveryCapabilityClaims = Object.freeze({
  purpose: 'sync-recovery-bootstrap-ack',
  version: 1,
  sessionId: 'session-1',
  accountId: 'account-1',
  replicaId: 'replica-1',
  collectionId: 'collection-1',
  oldLeaseGeneration: '4',
  purgeBoundary: { commitOrdinal: '41', streamKind: 'conflict', stableId: 'conflict-41' },
  snapshotId: 'snap_0123456789abcdefghijklmnopqrstuv',
  snapshotRevision: 'revision-9',
  snapshotPageCount: 3,
  snapshotNodeCount: 401,
  snapshotCursor: 'snapshot-safe-cursor',
});

test('recovery capability is independently keyed, scoped, expiring and rotation aware', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const old = { id: 'recovery-2026-06', secret: Buffer.alloc(32, 81).toString('base64') };
  const current = { id: 'recovery-2026-07', secret: Buffer.alloc(32, 82).toString('base64') };
  const issuing = createSyncRecoveryCapabilityKeyring({ active: current, retained: [old], ttlMs: 60_000,
    now: () => now });
  const capability = issuing.sign(claims);
  assert.deepEqual(issuing.verify(capability, claims), { valid: true, claims, keyId: current.id,
    expiresAt: now + 60_000 });

  const rotated = createSyncRecoveryCapabilityKeyring({ active: {
    id: 'recovery-2026-08', secret: Buffer.alloc(32, 83).toString('base64'),
  }, retained: [current], ttlMs: 60_000, now: () => now + 1_000 });
  assert.equal(rotated.verify(capability, claims).valid, true);
  assert.equal(createSyncRecoveryCapabilityKeyring({ active: old, retained: [], ttlMs: 60_000,
    now: () => now }).verify(capability, claims).valid, false);
  assert.equal(issuing.verify(`${capability.slice(0, -1)}x`, claims).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, sessionId: 'session-2' }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, accountId: 'account-2' }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, replicaId: 'replica-2' }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, collectionId: 'collection-2' }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, oldLeaseGeneration: '5' }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims,
    purgeBoundary: { ...claims.purgeBoundary, streamKind: 'operation' } }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims,
    purgeBoundary: { ...claims.purgeBoundary, stableId: 'conflict-42' } }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, snapshotId: `${claims.snapshotId}-other` }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, snapshotRevision: 'revision-10' }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, snapshotPageCount: 2 }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, snapshotNodeCount: 400 }).valid, false);
  assert.equal(issuing.verify(capability, { ...claims, snapshotCursor: 'other-cursor' }).valid, false);
  assert.equal(createSyncRecoveryCapabilityKeyring({ active: current, retained: [], ttlMs: 60_000,
    now: () => now + 60_001 }).verify(capability, claims).valid, false);
});

test('recovery capability accepts the canonical initial purge boundary', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const keyring = createSyncRecoveryCapabilityKeyring({ active: {
    id: 'recovery-initial', secret: Buffer.alloc(32, 84).toString('base64'),
  }, retained: [], ttlMs: 60_000, now: () => now });
  const initial = { ...claims,
    purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' } };
  const capability = keyring.sign(initial);
  assert.deepEqual(keyring.verify(capability, initial), {
    valid: true, claims: initial, keyId: 'recovery-initial', expiresAt: now + 60_000,
  });
});

test('recovery capability keyring rejects weak, duplicate and Pull-purpose keys', () => {
  assert.throws(() => createSyncRecoveryCapabilityKeyring({ active: { id: 'weak', secret: 'c2hvcnQ=' },
    retained: [], ttlMs: 60_000 }));
  assert.throws(() => createSyncRecoveryCapabilityKeyring({ active: {
    id: 'same', secret: Buffer.alloc(32, 1).toString('base64'),
  }, retained: [{ id: 'same', secret: Buffer.alloc(32, 2).toString('base64') }], ttlMs: 60_000 }));
  assert.throws(() => createSyncRecoveryCapabilityKeyring({ active: {
    id: 'sync-pull-v1', secret: Buffer.alloc(32, 3).toString('base64'),
  }, retained: [], ttlMs: 60_000 }));
});
