import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SYNC_RESOLUTION_LANE_RECEIPT_BINDING,
  canonicalSyncConflictResolutionDigest,
  SyncConflictResolutionError,
  validateSyncConflictResolutionCommand,
  validateSyncResolutionLaneClaim,
} from '../../../src/modules/sync/sync-conflict-resolution.js';
import {
  allowedSyncConflictResolutions,
  isSyncConflictPayloadKeyring,
  selectSyncConflictPayloadKey,
} from '../../../src/infrastructure/sync/sync-conflict-postgres.js';

function command(overrides: Record<string, unknown> = {}):
Parameters<typeof validateSyncConflictResolutionCommand>[0] {
  return {
    conflictId: 'conflict-1',
    idempotencyKey: 'resolution-command-1',
    ifMatch: ['"conflict-r1"'],
    request: { resolution: 'incoming', baseConflictRevision: 'conflict-r1' },
    ...overrides,
  } as Parameters<typeof validateSyncConflictResolutionCommand>[0];
}

function expectCode(input: unknown, code: SyncConflictResolutionError['code']): void {
  assert.throws(
    () => validateSyncConflictResolutionCommand(input as never),
    (error: unknown) => error instanceof SyncConflictResolutionError && error.code === code,
  );
}

describe('P3-18 Conflict resolution command boundary', () => {
  test('accepts each protocol resolution and requires custom value only for custom', () => {
    for (const resolution of ['server', 'incoming', 'both'] as const) {
      const parsed = validateSyncConflictResolutionCommand(command({
        request: { resolution, baseConflictRevision: 'conflict-r1' },
      }));
      assert.equal(parsed.resolution, resolution);
      assert.equal(parsed.conflictRevision, 'conflict-r1');
    }
    assert.deepEqual(validateSyncConflictResolutionCommand(command({
      request: { resolution: 'custom', value: 'Merged title', baseConflictRevision: 'conflict-r1' },
    })).value, 'Merged title');
    expectCode(command({ request: { resolution: 'custom', baseConflictRevision: 'conflict-r1' } }), 'invalid_document');
    expectCode(command({ request: {
      resolution: 'server', value: 'forbidden', baseConflictRevision: 'conflict-r1',
    } }), 'invalid_document');
  });

  test('rejects missing, weak, wildcard, list, stale-body and duplicate If-Match evidence', () => {
    expectCode(command({ ifMatch: [] }), 'precondition_required');
    for (const ifMatch of [['W/"conflict-r1"'], ['*'], ['"one", "two"'], ['conflict-r1']]) {
      expectCode(command({ ifMatch }), 'invalid_document');
    }
    expectCode(command({ ifMatch: ['"conflict-r1"', '"conflict-r1"'] }), 'invalid_document');
    expectCode(command({ request: {
      resolution: 'incoming', baseConflictRevision: 'conflict-r2',
    } }), 'precondition_failed');
  });

  test('canonical digest binds Conflict identity, strong revision and complete request', () => {
    const base = validateSyncConflictResolutionCommand(command());
    assert.equal(canonicalSyncConflictResolutionDigest(base), canonicalSyncConflictResolutionDigest(base));
    for (const changed of [
      command({ conflictId: 'conflict-2' }),
      command({ ifMatch: ['"conflict-r2"'], request: {
        resolution: 'incoming', baseConflictRevision: 'conflict-r2',
      } }),
      command({ request: { resolution: 'server', baseConflictRevision: 'conflict-r1' } }),
    ]) {
      assert.notEqual(
        canonicalSyncConflictResolutionDigest(base),
        canonicalSyncConflictResolutionDigest(validateSyncConflictResolutionCommand(changed)),
      );
    }
  });
});

describe('FIX-M-011 conflict payload keyring selection and validation', () => {
  const key = (fill: number) => Buffer.alloc(32, fill);
  const keyring = {
    active: { key: key(11), keyVersion: 2 },
    retained: [{ key: key(22), keyVersion: 1 }],
  };

  test('selects the active key for the active version and retained keys by persisted version', () => {
    assert.equal(selectSyncConflictPayloadKey(keyring, 2), keyring.active);
    assert.equal(selectSyncConflictPayloadKey(keyring, 1), keyring.retained[0]);
    assert.equal(selectSyncConflictPayloadKey(keyring, 3), undefined);
  });

  test('accepts a well-formed active plus retained keyring', () => {
    assert.equal(isSyncConflictPayloadKeyring(keyring), true);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: key(33), keyVersion: 1 }, retained: [] }), true);
  });

  test('rejects malformed keys, version collisions and reused key material without exposing bytes', () => {
    assert.equal(isSyncConflictPayloadKeyring(undefined), false);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: key(44), keyVersion: 1 }, retained: {} }), false);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: Buffer.alloc(16), keyVersion: 1 }, retained: [] }), false);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: key(55), keyVersion: 0 }, retained: [] }), false);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: key(66), keyVersion: 1 },
      retained: [{ key: key(77), keyVersion: 1 }] }), false);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: key(88), keyVersion: 1 },
      retained: [{ key: key(88), keyVersion: 2 }] }), false);
    assert.equal(isSyncConflictPayloadKeyring({ active: { key: key(99), keyVersion: 1 },
      retained: Array.from({ length: 9 }, (_, index) => ({ key: key(100 + index), keyVersion: 2 + index })) }), false);
  });
});

describe('FIX-M-015 per-type Conflict resolution menus', () => {
  test('delete_update advertises only the executable dismiss choice for every node kind', () => {
    for (const kind of ['folder', 'bookmark', 'separator'] as const) {
      assert.deepEqual(allowedSyncConflictResolutions('delete_update', kind), ['server']);
    }
  });

  test('non-delete_update Conflicts keep the historical menu and both stays bookmark-only', () => {
    for (const type of ['concurrent_field_update', 'unprovable_base', 'untrusted_base'] as const) {
      assert.deepEqual(allowedSyncConflictResolutions(type, 'bookmark'),
        ['server', 'incoming', 'custom', 'both']);
      for (const kind of ['folder', 'separator'] as const) {
        assert.deepEqual(allowedSyncConflictResolutions(type, kind), ['server', 'incoming', 'custom']);
      }
    }
  });

  test('the returned menu is frozen and never empty so wire advertising stays stable', () => {
    for (const type of ['concurrent_field_update', 'unprovable_base', 'untrusted_base', 'delete_update'] as const) {
      for (const kind of ['folder', 'bookmark', 'separator'] as const) {
        const menu = allowedSyncConflictResolutions(type, kind);
        assert.ok(Object.isFrozen(menu));
        assert.ok(menu.length >= 1);
      }
    }
  });
});

describe('SYNC-R01 conflict resolution server lane claim', () => {
  const claim = (overrides: Record<string, unknown> = {}) => ({
    replicaId: 'replica-b',
    collectionId: 'collection-a',
    sessionId: 'session-b',
    operationId: 'resolution-op-1',
    canonicalDigest: 'a'.repeat(64),
    result: { conflictId: 'conflict-1', resolution: 'incoming', operationId: 'resolution-op-1' },
    ...overrides,
  });

  test('accepts a server-authored lane claim that never accepts a client Sequence input', () => {
    const parsed = validateSyncResolutionLaneClaim(claim());
    assert.deepEqual(parsed, claim());
    assert.equal(Object.hasOwn(parsed, 'sequence'), false);
    assert.throws(
      () => validateSyncResolutionLaneClaim(claim({ sequence: 3 })),
      (error: unknown) => error instanceof TypeError,
    );
    assert.throws(
      () => validateSyncResolutionLaneClaim(claim({ originSequence: 3 })),
      (error: unknown) => error instanceof TypeError,
    );
  });

  test('rejects incomplete claims, malformed identities and non-canonical digests', () => {
    for (const key of ['replicaId', 'collectionId', 'sessionId', 'operationId',
      'canonicalDigest', 'result'] as const) {
      const incomplete = { ...claim() };
      delete (incomplete as Record<string, unknown>)[key];
      assert.throws(() => validateSyncResolutionLaneClaim(incomplete), TypeError);
    }
    for (const invalid of [
      claim({ replicaId: '' }),
      claim({ collectionId: 7 }),
      claim({ sessionId: null }),
      claim({ operationId: 'x'.repeat(513) }),
      claim({ canonicalDigest: 'A'.repeat(64) }),
      claim({ canonicalDigest: 'a'.repeat(63) }),
      claim({ result: [] }),
      claim({ result: null }),
    ]) assert.throws(() => validateSyncResolutionLaneClaim(invalid), TypeError);
  });

  test('freezes the server-resolution receipt binding identity', () => {
    assert.deepEqual(SYNC_RESOLUTION_LANE_RECEIPT_BINDING, {
      serverBatchSuffix: 'conflict-resolution',
      mediaType: 'application/colp+json',
      endpointIdentity: 'known.sync.conflict-resolution',
      status: 'applied',
    });
  });
});
