import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';

import { afterEach, test, vi } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { SESSION_REPLICA_UNKNOWN, SessionRequestError } from '../src/session-client.js';
import type { StoredSession } from '../src/types.js';

/**
 * W2B-P1-3 (server half): the Session route answers "not found" for a replica id another account holds. A browser that
 * never registered the id takes a new one at once and loses nothing; a browser that did sync under it is stopped with a
 * named code (a Reset or a new sign-in is the exit), never silently given a new name.
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

const minted = (id: string): StoredSession => ({ sessionId: id, expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
  credentialAuthorityDigest: 'digest-1', acceptedProtocolVersion: '0.2', snapshotRequired: false,
  collection: { collectionId: 'lane-collection', serverCursor: 'cursor0', serverRevision: 'r0' },
  replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } });

async function laneFixture() {
  vi.resetModules();
  const local = new MemoryStorageArea(), session = new MemoryStorageArea();
  vi.stubGlobal('chrome', {
    storage: { local, session: Object.assign(session, { setAccessLevel: vi.fn(async () => undefined) }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      getURL: (path: string) => `chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen/${path}` },
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ session: { id: 's', userId: 'lane-account',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, user: { id: 'lane-account', email: null, name: null } })));
  const runtime = await import('../src/sw/runtime.js');
  const scope = await import('../src/sw/scope.js');
  cleanups.push(() => runtime.syncState.close());
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  runtime.sw.configPromise = Promise.resolve(config);
  const live = await runtime.store.fence.activate();
  const binding = await runtime.store.getOrCreateBinding(live.generation);
  await runtime.store.saveCredential({ accessToken: 'lane-test-credential', tokenType: 'Bearer', subject: 'lane-account',
    accountLabel: 'Lane test', expiresAt: Date.now() + 3_600_000, scope: config.scopes, serverOrigin: config.serverOrigin,
    issuer: config.issuer, audience: config.audience, clientId: config.clientId }, live.generation);
  await local.set({ [runtime.COLLECTION_BINDING]: 'lane-collection' });
  return { ...runtime, scope, binding };
}

const replicaOf = (call: unknown[]): string =>
  ((call[0] as { request: { replica: { replicaId: string } } }).request).replica.replicaId;

test('a replica id the browser never registered is replaced once and the Session is minted', async () => {
  const f = await laneFixture();
  mocks.session.mockRejectedValueOnce(new SessionRequestError(SESSION_REPLICA_UNKNOWN)).mockResolvedValueOnce(minted('minted-1'));
  const authority = await f.scope.pushSessionAuthority();
  assert.equal(authority.session.sessionId, 'minted-1');
  assert.equal(mocks.session.mock.calls.length, 2);
  assert.equal(replicaOf(mocks.session.mock.calls[0]!), f.binding.replicaId);
  const renamed = await f.store.loadBinding();
  assert.notEqual(renamed?.replicaId, f.binding.replicaId, 'the refused id is not used again');
  assert.equal(replicaOf(mocks.session.mock.calls[1]!), renamed?.replicaId);
  assert.equal(renamed?.browserProfileId, f.binding.browserProfileId);
});

test('a second refusal stops with the named code and does not rename again', async () => {
  const f = await laneFixture();
  mocks.session.mockRejectedValue(new SessionRequestError(SESSION_REPLICA_UNKNOWN));
  await assert.rejects(() => f.scope.pushSessionAuthority(), /session_replica_unknown/u);
  assert.equal(mocks.session.mock.calls.length, 2, 'one rename, one retry');
});

test('a replica that already synced is never silently renamed', async () => {
  const f = await laneFixture();
  mocks.session.mockResolvedValueOnce(minted('minted-1'));
  await f.scope.pushSessionAuthority();
  const registered = await f.store.loadBinding();
  mocks.session.mockRejectedValue(new SessionRequestError(SESSION_REPLICA_UNKNOWN));
  await assert.rejects(() => f.scope.pushSessionAuthority(true), /session_replica_unknown/u);
  assert.deepEqual(await f.store.loadBinding(), registered, 'the synced replica keeps its identity, its scope and its queue');
  assert.equal(mocks.session.mock.calls.length, 2, 'no retry under a new name');
});

test('other refusals do not rename the replica', async () => {
  const f = await laneFixture();
  mocks.session.mockRejectedValue(new SessionRequestError('server_unavailable'));
  await assert.rejects(() => f.scope.pushSessionAuthority(), /server_unavailable/u);
  assert.deepEqual(await f.store.loadBinding(), f.binding);
  assert.equal(mocks.session.mock.calls.length, 1);
});
