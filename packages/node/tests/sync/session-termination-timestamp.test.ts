/**
 * Session termination timestamps follow the RFC 3339 contract used by
 * `expiresAt`: invalid values fail before any store call, valid values
 * persist through every termination path, and malformed stored records fail
 * closed on read.
 */
import { describe, expect, it } from 'vitest';

import {
  createSyncSession,
  terminateSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';

const expiresAt = '2026-07-18T03:00:00Z';

class RecordingStore implements SyncSessionStore {
  readonly state = new Map<string, SyncSessionRecord>();
  readonly calls: string[] = [];

  async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    this.calls.push('create');
    this.state.set(session.sessionId, structuredClone(session));
    return { state: 'created', session: structuredClone(session) };
  }

  async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    this.calls.push('load');
    return structuredClone(this.state.get(sessionId));
  }

  async terminate(termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined> {
    this.calls.push('terminate');
    const existing = this.state.get(termination.sessionId);
    if (existing === undefined) return undefined;
    if (existing.status === 'terminated') return structuredClone(existing);
    const terminated: SyncSessionRecord = {
      ...existing, status: 'terminated', terminationReason: termination.reason, terminatedAt: termination.terminatedAt,
    };
    this.state.set(termination.sessionId, terminated);
    return structuredClone(terminated);
  }
}

const input: CreateSyncSessionInput = {
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
  expiresAt,
};

function verification(
  now: string,
  authorization: VerifySyncSessionContextInput['authorization'] = {
    credentialActive: true, authorizationScopes: ['sync:pull', 'sync:push'],
  },
): VerifySyncSessionContextInput {
  const { sessionId, authorizationScopes: _scopes, expiresAt: _expires, ...binding } = input;
  return { sessionId, binding, authorization, terminatedAt: now };
}

async function seeded(): Promise<RecordingStore> {
  const store = new RecordingStore();
  await createSyncSession(store, input);
  store.calls.length = 0;
  return store;
}

const invalidTimestamps = [
  '', 'yesterday', '2026-07-18', '2026-07-18T02:00:00', '2026-07-18 02:00:00Z', '2026-13-01T00:00:00Z',
  '2026-02-30T00:00:00Z', '2026-07-18T24:00:00Z',
];

const revoked = { credentialActive: false, authorizationScopes: ['sync:pull', 'sync:push'] } as const;
const reduced = { credentialActive: true, authorizationScopes: ['sync:pull'] } as const;

describe('Session termination timestamp validation', () => {
  it.each(invalidTimestamps)('rejects direct termination at %j before any store call', async (terminatedAt) => {
    const store = await seeded();
    await expect(terminateSyncSession(store, { sessionId: 'session-1', reason: 'administrative', terminatedAt }))
      .rejects.toThrow(TypeError);
    expect(store.calls).toEqual([]);
  });

  it.each(invalidTimestamps)('rejects revocation/scope-loss verification at %j before any store call', async (now) => {
    const store = await seeded();
    for (const authorization of [revoked, reduced]) {
      await expect(verifySyncSessionContext(store, verification(now, authorization))).rejects.toThrow(TypeError);
    }
    expect(store.calls).toEqual([]);
    expect(store.state.get('session-1')?.status).toBe('active');
  });

  it.each([
    ['credential revocation', revoked, '2026-07-18T02:00:00Z', 'credential_revoked'],
    ['scope reduction', reduced, '2026-07-18T10:00:00+08:00', 'scope_reduced'],
    ['lease expiry', undefined, '2026-07-18T03:30:00.123Z', 'lease_expired'],
  ] as const)('persists a valid timestamp on %s', async (_label, authorization, now, reason) => {
    const store = await seeded();
    const result = await verifySyncSessionContext(store, verification(now, authorization));
    expect(result).toMatchObject({ state: 'terminated', session: { terminationReason: reason, terminatedAt: now } });
    expect(store.state.get('session-1')).toMatchObject({ status: 'terminated', terminatedAt: now });
  });

  it('keeps lease expiry inclusive at the exact expiry instant', async () => {
    const before = await seeded();
    expect(await verifySyncSessionContext(before, verification('2026-07-18T02:59:59.999Z')))
      .toMatchObject({ state: 'active' });
    const at = await seeded();
    expect(await verifySyncSessionContext(at, verification(expiresAt)))
      .toMatchObject({ state: 'terminated', session: { terminationReason: 'lease_expired' } });
    const offsetEquivalent = await seeded();
    expect(await verifySyncSessionContext(offsetEquivalent, verification('2026-07-18T11:00:00+08:00')))
      .toMatchObject({ state: 'terminated', session: { terminationReason: 'lease_expired' } });
  });

  it('fails closed on a stored terminated record with a malformed terminatedAt', async () => {
    const store = await seeded();
    store.state.set('session-1', {
      ...store.state.get('session-1')!, status: 'terminated', terminationReason: 'administrative', terminatedAt: 'later',
    } as SyncSessionRecord);
    await expect(verifySyncSessionContext(store, verification('2026-07-18T02:00:00Z')))
      .rejects.toThrow('Stored Sync Session terminatedAt must be an RFC 3339 date-time');
  });

  it('rejects an adapter that persists a different, malformed termination time', async () => {
    const store = await seeded();
    store.terminate = async (termination) => {
      const terminated = { ...store.state.get(termination.sessionId)!, status: 'terminated',
        terminationReason: termination.reason, terminatedAt: 'now' } as SyncSessionRecord;
      store.state.set(termination.sessionId, terminated);
      return structuredClone(terminated);
    };
    await expect(terminateSyncSession(store, {
      sessionId: 'session-1', reason: 'administrative', terminatedAt: '2026-07-18T02:00:00Z',
    })).rejects.toThrow('Stored Sync Session terminatedAt must be an RFC 3339 date-time');
  });
});
