import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';

import { afterEach, test, vi } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { SessionRequestError } from '../src/session-client.js';

/**
 * W2B-P1-2: a 401 from the Session route says the server no longer accepts the credential, although its stored
 * expiry still looks fine (a web sign-out, a password change). The lane asks the identity server once; when it
 * agrees, the extension signs out and keeps the replica, so the person sees the sign-in card instead of "Signed in"
 * over a dead sync, and signing in again resumes the same replica.
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

async function laneFixture(identityServer: (url: string) => Response) {
  vi.resetModules();
  const local = new MemoryStorageArea(), session = new MemoryStorageArea();
  vi.stubGlobal('chrome', {
    storage: { local, session: Object.assign(session, { setAccessLevel: vi.fn(async () => undefined) }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      getURL: (path: string) => `chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen/${path}` },
  });
  const identityCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    identityCalls.push(String(input));
    return identityServer(String(input));
  }));
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
  return { ...runtime, scope, binding, identityCalls };
}

const alive = () => Response.json({ session: { id: 's', userId: 'lane-account',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, user: { id: 'lane-account', email: 'lane@example.test', name: null } });

test('a 401 on the Session route that the identity server confirms signs out and keeps the replica', async () => {
  const f = await laneFixture(() => new Response(null, { status: 401 }));
  mocks.session.mockRejectedValue(new SessionRequestError('credential_revoked'));
  await assert.rejects(() => f.scope.pushSessionAuthority(), /authentication_required/u);
  assert.equal(await f.store.loadCredential(), null, 'the dead credential is gone');
  assert.equal(await f.store.loadSignOutReason(), 'authentication_required');
  assert.deepEqual(await f.store.loadBinding(), f.binding, 'the replica survives');
  assert.ok(f.identityCalls.some((url) => url.endsWith('/get-session')), 'the identity server was asked');
  assert.equal(mocks.session.mock.calls.length, 1);
});

test('a 401 the identity server does not confirm stays a Session refusal and keeps the credential', async () => {
  const f = await laneFixture(alive);
  mocks.session.mockRejectedValue(new SessionRequestError('credential_revoked'));
  await assert.rejects(() => f.scope.pushSessionAuthority(), /credential_revoked/u);
  assert.equal((await f.store.loadCredential())?.subject, 'lane-account');
  assert.deepEqual(await f.store.loadBinding(), f.binding);
});

test('an unreachable identity server leaves the original refusal and the credential alone', async () => {
  const f = await laneFixture(() => { throw new TypeError('Failed to fetch'); });
  mocks.session.mockRejectedValue(new SessionRequestError('credential_revoked'));
  await assert.rejects(() => f.scope.pushSessionAuthority(), /credential_revoked/u);
  assert.equal((await f.store.loadCredential())?.subject, 'lane-account');
});

test('other Session failures do not trigger a credential check', async () => {
  const f = await laneFixture(alive);
  mocks.session.mockRejectedValue(new SessionRequestError('server_unavailable'));
  await assert.rejects(() => f.scope.pushSessionAuthority(), /server_unavailable/u);
  assert.deepEqual(f.identityCalls.filter((url) => url.includes('/api/v1/auth/')), []);
});
