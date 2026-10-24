import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';

import { afterEach, describe, test, vi } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { ResponseStreamError } from '../src/sync-transport-failure.js';
import { SessionRequestError, credentialAuthorityDigest, retainSessionAfterTransientRenewalFailure } from '../src/session-client.js';
import type { StoredSession } from '../src/types.js';

/**
 * W2B-P2-5: a renewal that fails because the server or the network could not be asked (a 5xx, a cut-off body, a deadline,
 * missing site access) must not discard a Session that is still valid. Only the named Session faults do.
 */
const cleanups: Array<() => void> = [];
const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('../src/session-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/session-client.js')>(),
  createSyncSession: mocks.session,
}));
vi.mock('../src/manifest-client.js', () => ({
  fetchSyncEndpoints: async () => ({
    syncSessions: 'https://known.example/v1/session', syncSnapshot: 'https://known.example/v1/snapshot',
    syncPush: 'https://known.example/v1/push', syncPull: 'https://known.example/v1/pull',
    syncAck: 'https://known.example/v1/ack', syncConflict: 'https://known.example/v1/conflicts/{conflictId}',
    syncEffectPages: 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', syncRetire: 'https://known.example/v1/retire',
  }),
}));

afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

const validSession = (overrides: Partial<StoredSession> = {}): StoredSession => ({ sessionId: 'session-held',
  expiresAt: new Date(Date.now() + 30_000).toISOString(), scope: 'collection', credentialAuthorityDigest: 'a'.repeat(64),
  acceptedProtocolVersion: '0.2', snapshotRequired: false,
  collection: { collectionId: 'lane-collection', serverCursor: 'cursor0', serverRevision: 'r0' },
  replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: new Date(Date.now() + 600_000).toISOString() },
  ...overrides });

describe('the retention predicate', () => {
  const retained = (error: unknown) => retainSessionAfterTransientRenewalFailure(validSession(), error);

  test('keeps a still-valid Session for every transient fault', () => {
    for (const error of [new TypeError('Failed to fetch'), Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      Object.assign(new Error('aborted'), { name: 'AbortError' }), new SessionRequestError('server_unavailable'),
      new SessionRequestError('service_unavailable'), new SessionRequestError('internal_error'), new ResponseStreamError(),
      new Error('server_configuration_failed'), new Error('network_unavailable')]) {
      assert.equal(retained(error), true, error.message);
    }
  });

  test('discards it for a Session fault, a refusal or an unknown fault', () => {
    for (const error of [new SessionRequestError('credential_revoked'), new SessionRequestError('session_replica_unknown'),
      new SessionRequestError('session_failed'), new Error('session_invalid'), new Error('something_else'), 'text']) {
      assert.equal(retained(error), false, String(error));
    }
  });

  test('never keeps a Session that expires before the retry', () => {
    const expired = validSession({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    assert.equal(retainSessionAfterTransientRenewalFailure(expired, new SessionRequestError('server_unavailable')), false);
    assert.equal(retainSessionAfterTransientRenewalFailure(validSession(), new SessionRequestError('rate_limited', 120_000)), false,
      'a rate limit longer than the Session lives is not waited out on it');
  });
});

async function laneFixture() {
  vi.resetModules();
  const local = new MemoryStorageArea(), session = new MemoryStorageArea();
  vi.stubGlobal('chrome', {
    storage: { local, session: Object.assign(session, { setAccessLevel: vi.fn(async () => undefined) }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      getURL: (path: string) => `chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen/${path}` },
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  const runtime = await import('../src/sw/runtime.js');
  const scope = await import('../src/sw/scope.js');
  cleanups.push(() => runtime.syncState.close());
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  runtime.sw.configPromise = Promise.resolve(config);
  const live = await runtime.store.fence.activate();
  await runtime.store.getOrCreateBinding(live.generation);
  const credential = { accessToken: 'lane-test-credential', tokenType: 'Bearer' as const, subject: 'lane-account',
    accountLabel: 'Lane test', expiresAt: Date.now() + 3_600_000, scope: config.scopes, serverOrigin: config.serverOrigin,
    issuer: config.issuer, audience: config.audience, clientId: config.clientId };
  await runtime.store.saveCredential(credential, live.generation);
  await local.set({ [runtime.COLLECTION_BINDING]: 'lane-collection' });
  // A Session near its renewal margin but still valid, minted for this credential.
  await runtime.store.saveSession(validSession({ credentialAuthorityDigest: await credentialAuthorityDigest(credential.accessToken) }),
    live.generation);
  return { ...runtime, scope };
}

describe('the Session lane', () => {
  for (const error of [new SessionRequestError('server_unavailable'), new ResponseStreamError(), new Error('server_configuration_failed')]) {
    test(`a renewal that fails with ${error.message} keeps the Session it was renewing`, async () => {
      const f = await laneFixture();
      mocks.session.mockRejectedValue(error);
      await assert.rejects(() => f.scope.pushSessionAuthority(), new RegExp(error.message, 'u'));
      assert.equal((await f.store.loadSession())?.sessionId, 'session-held');
    });
  }

  test('a renewal refused by the Session route still discards it', async () => {
    const f = await laneFixture();
    mocks.session.mockRejectedValue(new SessionRequestError('insufficient_scope'));
    await assert.rejects(() => f.scope.pushSessionAuthority(), /insufficient_scope/u);
    assert.equal(await f.store.loadSession(), null);
  });
});
