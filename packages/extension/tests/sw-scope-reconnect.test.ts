import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { credentialAuthorityDigest } from '../src/session-client.js';
import type { SyncScope } from '../src/sync-state-store.js';

/** Server requests only: e2e-fixture builds also read the packaged e2e-origin.json (D6). */
function serverCalls(network: { mock: { calls: readonly (readonly unknown[])[] } }): number {
  return network.mock.calls.filter(([input]) => !String((input as { url?: unknown } | undefined)?.url ?? input).startsWith('chrome-extension://')).length;
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.unstubAllGlobals(); vi.resetModules(); });

async function disconnectedSession(seedScope = true) {
  vi.resetModules();
  const local = new MemoryStorageArea();
  vi.stubGlobal('indexedDB', new IDBFactory());
  // `runtime.store` pins the credential area to trusted contexts before any
  // read, so the stub has to expose `session` and `setAccessLevel`.
  const session = new MemoryStorageArea();
  const setAccessLevel = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', {
    storage: { local, session: Object.assign(session, { setAccessLevel }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      getURL: (path: string) => `chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen/${path}` },
  });
  const network = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  vi.stubGlobal('fetch', network);
  const runtime = await import('../src/sw/runtime.js');
  const api = await import('../src/sw/scope.js');
  cleanups.push(() => runtime.syncState.close());
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  runtime.sw.configPromise = Promise.resolve(config);
  const binding = await runtime.store.getOrCreateBinding(0);
  const credential = { accessToken: 'reconnect-test-credential', tokenType: 'Bearer' as const,
    subject: 'reconnect-account', accountLabel: 'Reconnect test', expiresAt: Date.now() + 3_600_000,
    scope: config.scopes, serverOrigin: config.serverOrigin, issuer: config.issuer,
    audience: config.audience, clientId: config.clientId };
  await runtime.store.saveCredential(credential);
  await local.set({ [runtime.COLLECTION_BINDING]: 'reconnect-collection' });
  const scope: SyncScope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: credential.subject, browserProfileId: binding.browserProfileId, collectionId: 'reconnect-collection',
    replicaId: binding.replicaId, generation: Number(binding.generation) };
  if (seedScope) await runtime.syncState.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'expired-lease', expiresAt: 1 }, checkpoint: { serverRevision: 'r0', cursor: 'cursor0' },
    selectedRoots: [], rootStatus: 'ready' });
  return { ...runtime, api, local, session, scope, binding, credential, network };
}

test('expired offline renewal can clear Session without losing the existing recovery scope', async () => {
  const f = await disconnectedSession();
  await f.store.saveSession({ sessionId: 'expired-session', expiresAt: '2000-01-01T00:00:00Z', scope: 'collection',
    credentialAuthorityDigest: await credentialAuthorityDigest(f.credential.accessToken),
    acceptedProtocolVersion: '0.2', snapshotRequired: false,
    collection: { collectionId: f.scope.collectionId, serverCursor: 'cursor0', serverRevision: 'r0' },
    replicaLease: { leaseId: 'expired-lease', generation: '1', state: 'active', expiresAt: '2000-01-01T00:00:00Z' } });
  await assert.rejects(f.api.pushSessionAuthority(), /Failed to fetch/);
  assert.equal(await f.store.loadSession(), null);
  assert.deepEqual(await f.api.currentSyncScope(), f.scope);
  assert.equal(serverCalls(f.network), 1);
  // Locating durable recovery work does not manufacture current authority.
  await assert.rejects(f.api.currentSyncStatusAuthority(), /not_connected/);
});

test('a restart that emptied the session area restores the credential instead of reporting no connection', async () => {
  const f = await disconnectedSession();
  assert.deepEqual(await f.api.restoredSyncScope(), f.scope, 'a live credential needs no restore');
  assert.equal(serverCalls(f.network), 0);
  await f.store.clearCredential();
  await assert.rejects(f.api.currentSyncScope(), /not_connected/);
  // No browser cookie here, so the Session lane's restore is what fails, not the scope read.
  await assert.rejects(f.api.restoredSyncScope(), /authentication_required/);
});

/** The manifest the e2e-fixture config points at, as the server serves it. */
function fixtureManifest() {
  const origin = 'https://known.example';
  return { protocol: 'https://know-n.com/colp/spec/0.2', protocolVersions: ['0.1', '0.2'],
    syncEffectPages: `${origin}/v1/effects/{effectId}/pages/{pageNumber}`,
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/sync/`, profiles: ['core'], endpoints: {
      syncSessions: `${origin}/v1/session`, syncSnapshot: `${origin}/v1/snapshot`,
      syncPush: `${origin}/v1/push`, syncPull: `${origin}/v1/pull`, syncAck: `${origin}/v1/ack`,
      syncConflict: `${origin}/v1/conflicts/{conflictId}` },
    features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] },
      sync: { multiCollectionSessions: false } },
    auth: { anonymousRead: false, apiKeys: false, oauth: true,
      protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
    limits: { maxPageSize: 100, maxSnapshotNodes: 10000, minPollIntervalSeconds: 10,
      recommendedPollIntervalSeconds: 30, maxSyncBatchOperations: 1,
      idempotencyRetentionSeconds: 86400, syncCursorRetentionSeconds: 2592000 },
    'https://known.example/extensions/sync-retire': { href: `${origin}/extensions/sync-retire`,
      method: 'DELETE', requestBody: false, successStatus: 204,
      requiredHeaders: ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'] } }] };
}

/**
 * Serve the manifest, and hold every Session mint open so two flows can be
 * observed while the first mint is still in flight.
 */
function holdingNetwork(config: { readonly manifestUrl: string }, holdSessions = true) {
  const held = { release: () => {}, sessionPosts: 0 };
  const gate = new Promise<void>((resolve) => { held.release = resolve; });
  const network = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === config.manifestUrl) {
      return new Response(JSON.stringify(fixtureManifest()), { status: 200,
        headers: { 'content-type': 'application/vnd.collection-protocol.manifest+json;version=0.2' } });
    }
    if (url.endsWith('/v1/session')) { held.sessionPosts += 1; if (holdSessions) await gate; }
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', network);
  return held;
}

function fixtureConfig() {
  return readFile('config/e2e-fixture.json', 'utf8').then((source) => parseBuildConfig(JSON.parse(source)));
}

test('a stored Session bound to another Collection is not reused', async () => {
  const f = await disconnectedSession();
  const config = await fixtureConfig();
  await f.store.saveSession({ sessionId: 'other-collection-session', expiresAt: '2999-01-01T00:00:00Z',
    scope: 'collection', credentialAuthorityDigest: await credentialAuthorityDigest(f.credential.accessToken),
    acceptedProtocolVersion: '0.2', snapshotRequired: false,
    collection: { collectionId: 'other-collection', serverCursor: 'cursor0', serverRevision: 'r0' },
    replicaLease: { leaseId: 'other-lease', generation: '1', state: 'active', expiresAt: '2999-01-01T00:00:00Z' } });
  const held = holdingNetwork(config, false);
  // Selecting another Collection used to clear the stored Session and mint
  // directly, so the reuse decision and the mint were two separate steps and a
  // concurrent flow could mint a second Session for the same Replica. The lane
  // now decides: a Session for a different Collection is not reusable.
  await assert.rejects(f.api.pushSessionAuthority(), /Failed to fetch/);
  assert.equal(held.sessionPosts, 1, 'a Session for another Collection must not be reused');
});

test('an explicit scope hydration waits for the in-flight Session mint', async () => {
  const f = await disconnectedSession();
  const config = await fixtureConfig();
  const held = holdingNetwork(config);
  const mint = f.api.pushSessionAuthority();
  await Promise.resolve();
  // Two flows race on a first run: the engine asks the Session lane for
  // authority while an explicit hydration finds no stored Session. The
  // hydration used to bypass the lane and mint a second Session ~30ms later;
  // that mint advanced the Replica's lifecycle revision under the first flow's
  // in-flight Ack, which was then denied `stale_replica` (measured in
  // e2e/mv3-first-run-remediation.spec.ts) and cost a recovery cycle.
  const hydration = f.api.requireSyncScope();
  await new Promise((resolve) => { setTimeout(resolve, 250); });
  assert.equal(held.sessionPosts, 1, 'the hydration must wait for the in-flight mint, not mint again');
  held.release();
  await Promise.allSettled([mint, hydration]);
});

test('a Session for another Collection is not a fallback when the switch mint fails', async () => {
  // Switching Collection is a local binding change, and the mint for the new
  // Collection can fail offline. The Session for the OLD Collection must not
  // survive that: the lane retains a prior Session on a transient failure, and
  // `currentSyncScope` preferred the Session's Collection over the binding, so a
  // failed switch left the extension able to Push/Pull the Collection the user
  // had just left.
  const f = await disconnectedSession();
  await f.store.saveSession({ sessionId: 'other-collection-session', expiresAt: '2999-01-01T00:00:00Z',
    scope: 'collection', credentialAuthorityDigest: await credentialAuthorityDigest(f.credential.accessToken),
    acceptedProtocolVersion: '0.2', snapshotRequired: false,
    collection: { collectionId: 'other-collection', serverCursor: 'cursor0', serverRevision: 'r0' },
    replicaLease: { leaseId: 'other-lease', generation: '1', state: 'active', expiresAt: '2999-01-01T00:00:00Z' } });
  const config = await fixtureConfig()
  holdingNetwork(config, false)
  await assert.rejects(f.api.pushSessionAuthority(), /Failed to fetch/)
  assert.equal(await f.store.loadSession(), null,
    'a Session that authenticates another Collection must not be kept as a fallback')
  await assert.rejects(f.api.requireSyncScope(), /Failed to fetch/)
});

test('the scope refuses a Session that authenticates another Collection', async () => {
  // The invariant behind the case above, pinned on its own: whatever leaves such
  // a Session behind, no caller may be told this is the bound Collection's scope.
  const f = await disconnectedSession();
  await f.store.saveSession({ sessionId: 'cross-collection-session', expiresAt: '2999-01-01T00:00:00Z',
    scope: 'collection', credentialAuthorityDigest: await credentialAuthorityDigest(f.credential.accessToken),
    acceptedProtocolVersion: '0.2', snapshotRequired: false,
    collection: { collectionId: 'other-collection', serverCursor: 'cursor0', serverRevision: 'r0' },
    replicaLease: { leaseId: 'cross-lease', generation: '1', state: 'active', expiresAt: '2999-01-01T00:00:00Z' } });
  await f.local.set({ [f.COLLECTION_BINDING]: 'reconnect-collection' })
  await assert.rejects(f.api.currentSyncScope(), /not_connected/)
});

test('explicit scope hydration still tries to mint the missing Session', async () => {
  const f = await disconnectedSession();
  await assert.rejects(f.api.requireSyncScope(), /Failed to fetch/);
  assert.equal(serverCalls(f.network), 1);
});

for (const boundary of ['no durable scope', 'no credential', 'different collection', 'different generation', 'retired scope'] as const) {
  test(`Session-less scope lookup fails closed for ${boundary}`, async () => {
    const f = await disconnectedSession(boundary !== 'no durable scope');
    if (boundary === 'no credential') await f.store.clearCredential();
    if (boundary === 'different collection') await f.local.set({ [f.COLLECTION_BINDING]: 'other-collection' });
    // The authority binding is durable identity, so it lives in local storage;
    // only secrets are session-scoped.
    if (boundary === 'different generation') {
      await f.local.set({ 'known.auth.binding.v1': { ...f.binding, generation: '2' } });
    }
    if (boundary === 'retired scope') await f.syncState.retireScope(f.scope, { retiredAt: Date.now(), reason: 'test' });
    await assert.rejects(f.api.currentSyncScope(), /not_connected/);
    assert.equal(serverCalls(f.network), 0);
  });
}
