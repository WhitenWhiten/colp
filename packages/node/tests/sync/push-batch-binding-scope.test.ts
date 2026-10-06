/**
 * P1-11: a sessionId prefix is not a unique batch binding when opaqueId contains dots.
 * New ids use binding version 1. Legacy retries stay inside one receipt scope.
 */
import { describe, expect, it } from 'vitest';

import { collectionProtocolSchema, createValidatorRegistry } from '../../src/schema/index.js';
import * as compositionApi from '../../src/sync/composition.js';
import {
  SYNC_PUSH_BATCH_BINDING_VERSION,
  SyncSessionGateDeniedError,
  assertSyncPushBatchBoundToSession,
  bindSyncPushBatchId,
  legacySyncPushBatchInReceiptScope,
  readSyncPushBatchBinding,
  type SyncPushBatchReceiptScope,
} from '../../src/sync/index.js';
import * as syncApi from '../../src/sync/index.js';

const evidence = '[review:sync.push-batch-binding-scope]';
const validators = createValidatorRegistry();
const opaqueId = collectionProtocolSchema.$defs.opaqueId as {
  readonly maxLength: number;
  readonly minLength: number;
  readonly pattern: string;
};

function scope(
  sessionId: string,
  patch: {
    readonly principal?: SyncPushBatchReceiptScope['principal'];
    readonly endpoint?: string;
    readonly digest?: string;
  } = {},
): SyncPushBatchReceiptScope {
  return {
    sessionId,
    principal: patch.principal ?? { type: 'user', id: 'alice' },
    endpoint: patch.endpoint ?? '/sync/collection/push',
    digest: patch.digest ?? 'digest-1',
  };
}

describe(`versioned Push batch binding ${evidence}`, () => {
  it(`exports the versioned binding helpers ${evidence}`, () => {
    expect(SYNC_PUSH_BATCH_BINDING_VERSION).toBe(1);
    expect(syncApi.SYNC_PUSH_BATCH_BINDING_VERSION).toBe(compositionApi.SYNC_PUSH_BATCH_BINDING_VERSION);
    expect(syncApi.bindSyncPushBatchId).toBe(compositionApi.bindSyncPushBatchId);
    expect(syncApi.readSyncPushBatchBinding).toBe(compositionApi.readSyncPushBatchBinding);
    expect(syncApi.legacySyncPushBatchInReceiptScope).toBe(
      compositionApi.legacySyncPushBatchInReceiptScope,
    );
    expect(syncApi.assertSyncPushBatchBoundToSession).toBe(
      compositionApi.assertSyncPushBatchBoundToSession,
    );
  });

  it(`does not let session a and session a.b accept each other's batch ids ${evidence}`, () => {
    // The old prefix form made both of these the same string: "a.b.c".
    const fromA = bindSyncPushBatchId('a', 'b.c');
    const fromAb = bindSyncPushBatchId('a.b', 'c');
    expect(fromA).toBe('b1.1.a.b.c');
    expect(fromAb).toBe('b1.3.a.b.c');
    expect(fromA).not.toBe(fromAb);

    expect(readSyncPushBatchBinding(fromA)).toEqual({ version: 1, sessionId: 'a', suffix: 'b.c' });
    expect(readSyncPushBatchBinding(fromAb)).toEqual({ version: 1, sessionId: 'a.b', suffix: 'c' });

    expect(() => assertSyncPushBatchBoundToSession(fromA, { sessionId: 'a' })).not.toThrow();
    expect(() => assertSyncPushBatchBoundToSession(fromAb, { sessionId: 'a.b' })).not.toThrow();
    expect(() => assertSyncPushBatchBoundToSession(fromA, { sessionId: 'a.b' })).toThrow(
      SyncSessionGateDeniedError,
    );
    expect(() => assertSyncPushBatchBoundToSession(fromAb, { sessionId: 'a' })).toThrow(
      SyncSessionGateDeniedError,
    );
    expect(() => assertSyncPushBatchBoundToSession('a.b.c', { sessionId: 'a' })).toThrow(
      SyncSessionGateDeniedError,
    );
    expect(() => assertSyncPushBatchBoundToSession('a.b.c', { sessionId: 'a.b' })).toThrow(
      SyncSessionGateDeniedError,
    );
  });

  it(`requires a non-empty suffix and a canonical opaque encoding ${evidence}`, () => {
    expect(opaqueId).toMatchObject({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._~-]+$',
    });
    expect(() => bindSyncPushBatchId('a', '')).toThrow(TypeError);
    expect(() => bindSyncPushBatchId('', 'x')).toThrow(TypeError);
    expect(() => bindSyncPushBatchId('a/b', 'c')).toThrow(TypeError);
    expect(() => bindSyncPushBatchId('a', 'b:c')).toThrow(TypeError);
    expect(readSyncPushBatchBinding('b1.1.a.')).toBeUndefined();
    expect(readSyncPushBatchBinding('b1.01.a.x')).toBeUndefined();
    expect(() => assertSyncPushBatchBoundToSession('b1.01.a.x', { sessionId: 'a' })).toThrow(
      SyncSessionGateDeniedError,
    );

    const dotted = bindSyncPushBatchId('a.b~c_d-e', 'suf.fix~1');
    expect(validators.validate('opaqueId', dotted)).toEqual({ valid: true, errors: [] });
    expect(readSyncPushBatchBinding(dotted)).toEqual({
      version: 1,
      sessionId: 'a.b~c_d-e',
      suffix: 'suf.fix~1',
    });
    expect(dotted.startsWith('b1.')).toBe(true);
  });

  it(`keeps a fitted batch id inside the opaqueId maximum ${evidence}`, () => {
    const sessionId = 'a'.repeat(119);
    const suffix = 'z';
    const fitted = bindSyncPushBatchId(sessionId, suffix);
    expect(fitted).toHaveLength(opaqueId.maxLength);
    expect(validators.validate('opaqueId', fitted)).toEqual({ valid: true, errors: [] });
    expect(readSyncPushBatchBinding(fitted)).toEqual({ version: 1, sessionId, suffix });
    expect(validators.validate('opaqueId', 'a'.repeat(opaqueId.maxLength + 1)).valid).toBe(false);
    expect(bindSyncPushBatchId(sessionId, `${suffix}z`)).toMatch(/^b2\./u);
    expect(bindSyncPushBatchId(`${sessionId}a`, suffix)).toMatch(/^b2\./u);

    const short = 'a';
    const framing = `b1.${short.length}.${short}.`;
    const maxSuffix = 'x'.repeat(opaqueId.maxLength - framing.length);
    const full = bindSyncPushBatchId(short, maxSuffix);
    expect(full).toHaveLength(opaqueId.maxLength);
    expect(readSyncPushBatchBinding(full)?.suffix).toBe(maxSuffix);
    expect(bindSyncPushBatchId(short, `${maxSuffix}y`)).toMatch(/^b2\./u);
  });

  it('binds every legal long Session and local ID while preserving old b1 retries', () => {
    for (const length of [119, 120, 127, 128]) {
      const sessionId = 'a'.repeat(length);
      for (const suffix of ['x', 'x'.repeat(128)]) {
        const batch = bindSyncPushBatchId(sessionId, suffix);
        expect(validators.validate('opaqueId', batch).valid).toBe(true);
        expect(() => assertSyncPushBatchBoundToSession(batch, { sessionId })).not.toThrow();
        expect(() => assertSyncPushBatchBoundToSession(batch, { sessionId: `${sessionId.slice(0, -1)}b` }))
          .toThrow(SyncSessionGateDeniedError);
        expect(bindSyncPushBatchId(sessionId, suffix)).toBe(batch);
      }
    }
    const sessionId = 'a'.repeat(128);
    const compact = bindSyncPushBatchId(sessionId, 'x'.repeat(128));
    expect(compact).toHaveLength(90);
    expect(readSyncPushBatchBinding(compact)).toMatchObject({ version: 2 });
    expect(compact).not.toBe(bindSyncPushBatchId(sessionId, 'y'.repeat(128)));
    expect(() => assertSyncPushBatchBoundToSession('b1.3.a.b.retry', { sessionId: 'a.b' })).not.toThrow();
    expect(legacySyncPushBatchInReceiptScope(compact, scope('b2'), scope('b2'))).toBe(false);
    expect(() => bindSyncPushBatchId('a'.repeat(129), 'x')).toThrow(TypeError);
    expect(() => bindSyncPushBatchId('a', 'x'.repeat(129))).toThrow(TypeError);
    expect(readSyncPushBatchBinding(`${compact}.extra`)).toBeUndefined();
    expect(readSyncPushBatchBinding(compact.replace(/^b2\./u, 'b02.'))).toBeUndefined();
    expect(readSyncPushBatchBinding(`${compact.slice(0, -1)}B`)).toBeUndefined();
  });

  it(`does not let an old-session retry cross receipt scope ${evidence}`, () => {
    // "a.b.c" is the legacy shape for both session "a" and session "a.b".
    // That string is not a unique session binding. A retry matches only the
    // stored receipt whose full session, principal, endpoint, and digest agree.
    const legacyBatch = 'a.b.c';
    expect(legacySyncPushBatchInReceiptScope(legacyBatch, scope('a'), scope('a'))).toBe(true);
    expect(legacySyncPushBatchInReceiptScope(legacyBatch, scope('a.b'), scope('a.b'))).toBe(true);
    expect(legacySyncPushBatchInReceiptScope(legacyBatch, scope('a'), scope('a.b'))).toBe(false);
    expect(legacySyncPushBatchInReceiptScope(legacyBatch, scope('a.b'), scope('a'))).toBe(false);

    expect(legacySyncPushBatchInReceiptScope('a', scope('a'), scope('a'))).toBe(true);
    expect(legacySyncPushBatchInReceiptScope('a', scope('a'), scope('a.b'))).toBe(false);
    expect(legacySyncPushBatchInReceiptScope('a.b', scope('a.b'), scope('a'))).toBe(false);
    expect(legacySyncPushBatchInReceiptScope('a.', scope('a'), scope('a'))).toBe(false);
    expect(legacySyncPushBatchInReceiptScope('a:b', scope('a'), scope('a'))).toBe(false);

    expect(legacySyncPushBatchInReceiptScope(
      legacyBatch,
      scope('a.b', { digest: 'digest-2' }),
      scope('a.b'),
    )).toBe(false);
    expect(legacySyncPushBatchInReceiptScope(
      legacyBatch,
      scope('a.b', { endpoint: '/sync/other' }),
      scope('a.b'),
    )).toBe(false);
    expect(legacySyncPushBatchInReceiptScope(
      legacyBatch,
      scope('a.b', { principal: { type: 'user', id: 'a.b' } }),
      scope('a.b'),
    )).toBe(false);
    expect(legacySyncPushBatchInReceiptScope(
      legacyBatch,
      scope('a.b', { principal: { type: 'service', id: 'alice' } }),
      scope('a.b'),
    )).toBe(false);

    const versioned = bindSyncPushBatchId('a', 'b.c');
    expect(legacySyncPushBatchInReceiptScope(versioned, scope('a'), scope('a'))).toBe(false);
    expect(legacySyncPushBatchInReceiptScope(versioned, scope('b1'), scope('b1'))).toBe(false);
  });
});
