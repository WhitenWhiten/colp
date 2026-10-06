import { describe, expect, expectTypeOf, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import {
  SYNC_HOST_COMPOSITION_NOTES,
  createSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type SyncUnitOfWork,
  type SequenceCoordinatorUnitOfWork,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';

/**
 * SYNC-V-011 — Session durable model may carry optional `expiresAt`.
 * Missing field remains compatible with existing Session records.
 *
 * SYNC-V-013 — light composition contract: exclusive opId reservation owners
 * remain documented type-level boundaries (not a runtime cross-coordinator lock).
 */

const futureExpiry = '2026-07-18T04:00:00Z';
const pastExpiry = '2026-07-18T01:00:00Z';
const now = '2026-07-18T02:00:00Z';
const later = '2026-07-18T03:00:00Z';

type DurableState = Map<string, SyncSessionRecord>;

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

class DurableMemorySessionStore implements SyncSessionStore {
  public constructor(private readonly state: DurableState = new Map()) {}

  public async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    await Promise.resolve();
    const existing = this.state.get(session.sessionId);
    if (existing !== undefined) return copy({ state: 'conflict', session: existing });
    const stored = copy(session);
    this.state.set(session.sessionId, stored);
    return copy({ state: 'created', session: stored });
  }

  public async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : copy(session);
  }

  public async terminate(
    termination: SyncSessionTermination,
  ): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    const existing = this.state.get(termination.sessionId);
    if (existing === undefined) return undefined;
    if (existing.status === 'terminated') return copy(existing);
    const terminated: SyncSessionRecord = {
      ...copy(existing),
      status: 'terminated',
      terminationReason: termination.reason,
      terminatedAt: termination.terminatedAt,
    };
    this.state.set(termination.sessionId, terminated);
    return copy(terminated);
  }
}

function collectionInput(
  overrides: Partial<CreateSyncSessionInput> = {},
): CreateSyncSessionInput {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'https://client.example/app',
    origin: 'https://client.example',
    sessionScope: 'collection',
    protocolVersion: '0.1',
    collectionId: 'collection-1',
    purpose: null,
    authorizationScopes: ['sync:pull', 'sync:push'],
    ...overrides,
  };
}

function binding(input: CreateSyncSessionInput): SyncSessionBinding {
  return {
    principal: copy(input.principal),
    credential: copy(input.credential),
    oauthClientId: input.oauthClientId,
    origin: input.origin,
    sessionScope: input.sessionScope,
    protocolVersion: input.protocolVersion,
    collectionId: input.collectionId,
    purpose: input.purpose,
  };
}

function verification(
  input: CreateSyncSessionInput,
  overrides: Partial<VerifySyncSessionContextInput> = {},
): VerifySyncSessionContextInput {
  return {
    sessionId: input.sessionId,
    binding: binding(input),
    authorization: {
      credentialActive: true,
      authorizationScopes: [...input.authorizationScopes],
    },
    terminatedAt: now,
    ...overrides,
  };
}

describe('SYNC-V-011 Session expiresAt hardening', () => {
  it('verifies an active Session with a future expiresAt', async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ expiresAt: futureExpiry });

    const created = await createSyncSession(store, input);
    const checked = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: now }),
    );

    expect(created.status).toBe('active');
    expect((created as ActiveSyncSessionRecord).expiresAt).toBe(futureExpiry);
    expect(checked).toEqual({ state: 'active', session: created });
  });

  it('fails closed when expiresAt is at or before the verification clock', async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ expiresAt: pastExpiry });
    await createSyncSession(store, input);

    const checked = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: now }),
    );

    expect(checked.state).not.toBe('active');
    expect(checked.state).toBe('terminated');
    if (checked.state === 'terminated') {
      expect(checked.session.terminationReason).toBe('lease_expired');
      expect(checked.session.terminatedAt).toBe(now);
      expect(checked.session.status).toBe('terminated');
      expect(checked.session.expiresAt).toBe(pastExpiry);
    }
    await expect(store.load(input.sessionId)).resolves.toMatchObject({
      status: 'terminated',
      terminatedAt: now,
    });
  });

  it('treats expiresAt equal to the verification clock as expired (fail closed)', async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ expiresAt: now });
    await createSyncSession(store, input);

    const checked = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: now }),
    );

    expect(checked.state).toBe('terminated');
    if (checked.state === 'terminated') {
      // Durable reason is lease_expired (not a bare "expired" alias).
      expect(checked.session.terminationReason).toBe('lease_expired');
      expect(checked.session.terminatedAt).toBe(now);
    }
  });

  it('keeps Sessions without expiresAt compatible (legacy records still verify)', async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    // Explicitly ensure the field is absent rather than undefined-on-override.
    expect(Object.hasOwn(input, 'expiresAt')).toBe(false);

    const created = await createSyncSession(store, input);
    const checked = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: later }),
    );

    expect(created.status).toBe('active');
    expect(Object.hasOwn(created, 'expiresAt')).toBe(false);
    expect(checked).toEqual({ state: 'active', session: created });
  });

  it('does not revive an expired Session on a later verification after termination', async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ expiresAt: pastExpiry });
    await createSyncSession(store, input);

    const first = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: now }),
    );
    const second = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: later }),
    );

    expect(first.state).toBe('terminated');
    if (first.state === 'terminated') {
      expect(first.session.terminationReason).toBe('lease_expired');
    }
    expect(second).toEqual(first);
  });

  it('rejects create when expiresAt is not an RFC3339 instant', async () => {
    const store = new DurableMemorySessionStore();
    await expect(createSyncSession(store, collectionInput({
      expiresAt: 'not-a-date',
    }))).rejects.toThrow(/expiresAt|instant|RFC|date/iu);
  });

  it('rejects verify when terminatedAt is not a representable instant for lease checks', async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ expiresAt: futureExpiry });
    await createSyncSession(store, input);

    // RFC 3339 admits a leap second that Date cannot represent.
    await expect(verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: '2016-12-31T23:59:60Z' }),
    )).rejects.toThrow(/terminatedAt must be a representable instant/u);
    await expect(verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: 'not-a-date' }),
    )).rejects.toThrow(/terminatedAt must be an RFC 3339 date-time/u);
  });
});

describe('SYNC-V-013 operationId reservation owner contract (light)', () => {
  it('documents exclusive write owners and keeps distinct reservation owner brands', () => {
    expect(publicSyncApi.SYNC_HOST_COMPOSITION_NOTES).toBe(SYNC_HOST_COMPOSITION_NOTES);
    expect(SYNC_HOST_COMPOSITION_NOTES.exclusiveOpIdOwner).toMatch(/exactly one/i);
    expect(SYNC_HOST_COMPOSITION_NOTES.exclusiveOpIdOwner).toMatch(/createSyncHost/i);
    expect(SYNC_HOST_COMPOSITION_NOTES.migration).toMatch(/sync\/unsafe/i);

    // Type-level ownership brands (runtime enforcement remains host discipline).
    expectTypeOf<SyncUnitOfWork<never, never, never, never, never>['operationIdReservationOwner']>()
      .toEqualTypeOf<'push'>();
    expectTypeOf<SequenceCoordinatorUnitOfWork<unknown>['operationIdReservationOwner']>()
      .toEqualTypeOf<'sequence'>();

    // No dual-owner sequenced-push facade (composition honesty).
    expect('coordinateSequencedPush' in publicSyncApi).toBe(false);
  });
});
