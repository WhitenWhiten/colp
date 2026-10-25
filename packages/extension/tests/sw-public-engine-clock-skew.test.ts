import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { createExtensionWorkCoordinator } from '../src/authority-fence.js';
import { parseBuildConfig } from '../src/config.js';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { credentialAuthorityDigest } from '../src/session-client.js';
import type { StoredSession } from '../src/types.js';
import { scope, setup } from './durable-sync-engine-harness.js';

// K4 / W2B-P0-1: the status the popup and options read says how far this computer's clock is from the
// server's (only when it is more than two minutes off), and judges the credential and Session in server time.
const MINUTE = 60_000;

async function statusWorker() {
  vi.resetModules();
  const fixture = await setup();
  const storage = new MemoryStorageArea(); const credentials = createCredentialStore(storage);
  const workCoordinator = createExtensionWorkCoordinator(credentials.fence);
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  const credential = { accessToken: 'skew-test-credential', tokenType: 'Bearer' as const,
    expiresAt: Date.now() + 30 * MINUTE, scope: config.scopes, issuer: config.issuer,
    audience: config.audience, clientId: config.clientId, serverOrigin: config.serverOrigin,
    subject: scope.accountId, accountLabel: 'Skew test' };
  const sessionAt = async (clientClockSkewMilliseconds: number | undefined): Promise<StoredSession> => ({
    credentialAuthorityDigest: await credentialAuthorityDigest(credential.accessToken),
    sessionId: fixture.sessionId, scope: 'collection', acceptedProtocolVersion: '0.2', snapshotRequired: false,
    // Server time: a Session that expires 10 minutes from the server's "now".
    expiresAt: new Date(Date.now() - (clientClockSkewMilliseconds ?? 0) + 10 * MINUTE).toISOString(),
    ...(clientClockSkewMilliseconds === undefined ? {} : { clientClockSkewMilliseconds }),
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'r1' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active',
      expiresAt: new Date(Date.now() - (clientClockSkewMilliseconds ?? 0) + 24 * 60 * MINUTE).toISOString() },
    conversionPolicy: { separator: 'preserve_remote' } });
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  const port = () => { const listeners = new Set<unknown>();
    return { addListener: (listener: unknown) => { listeners.add(listener); }, hasListener: (listener: unknown) => listeners.has(listener) }; };
  vi.stubGlobal('chrome', { bookmarks: { onCreated: port(), onChanged: port(), onMoved: port(), onRemoved: port(),
    get: async () => [], getChildren: async () => [] }, alarms: { create: vi.fn() },
    storage: { local: storage }, runtime: { id: config.extensionId }, tabs: { create: vi.fn() } });
  vi.doMock('../src/sw/runtime.js', () => ({
    store: credentials, syncState: fixture.store, workCoordinator,
    sw: { configPromise: Promise.resolve(config), sessionRetryNotBefore: 0 },
    extensionOrigin: () => `chrome-extension://${config.extensionId}`,
    rootScopeKey: () => JSON.stringify(scope), hasBookmarkPermission: async () => true,
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery', COLLECTION_BINDING: 'known.sync.collection.v1',
    faviconSidecar: { list: async () => [], prune: async () => 0 }, safeError: () => 'network_unavailable',
  }));
  const engine = await import('../src/sw/engine.js');
  return { fixture, credential, config, engine, sessionAt };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test('the public engine state reports a clock more than two minutes off, in either direction, and still calls the Session ready', async () => {
  const f = await statusWorker();
  try {
    for (const skew of [20 * MINUTE, -20 * MINUTE, 3 * 60 * MINUTE]) {
      const state = await f.engine.publicSyncEngineState(scope, f.credential, await f.sessionAt(skew), f.config);
      assert.equal(state.clockSkewMilliseconds, skew);
      assert.equal(state.sessionReady, true, `Session is ready with the clock ${skew / MINUTE} min off`);
      assert.equal(state.credentialReady, true);
    }
    const healthy = await f.engine.publicSyncEngineState(scope, f.credential, await f.sessionAt(MINUTE), f.config);
    assert.equal('clockSkewMilliseconds' in healthy, false, 'a small skew is not worth a warning');
    const unmeasured = await f.engine.publicSyncEngineState(scope, f.credential, await f.sessionAt(undefined), f.config);
    assert.equal('clockSkewMilliseconds' in unmeasured, false);
  } finally { f.fixture.store.close(); }
});

test('the credential is judged in server time too', async () => {
  const f = await statusWorker();
  try {
    const state = (credential: typeof f.credential, session: StoredSession) =>
      f.engine.publicSyncEngineState(scope, credential, session, f.config);
    // Clock 40 minutes ahead: a credential with 30 server minutes left reads 10 minutes expired locally.
    const ahead = await f.sessionAt(40 * MINUTE);
    const live = { ...f.credential, expiresAt: Date.now() - 40 * MINUTE + 30 * MINUTE };
    assert.equal((await state(live, ahead)).credentialReady, true);
    const closing = { ...f.credential, expiresAt: Date.now() - 40 * MINUTE + 30 * 1_000 };
    assert.equal((await state(closing, ahead)).credentialReady, false, 'inside the 60 s refresh window in server time');
    // Clock 20 minutes behind: a credential the server expired 5 minutes ago still shows 15 minutes locally.
    const behind = await f.sessionAt(-20 * MINUTE);
    const lapsed = { ...f.credential, expiresAt: Date.now() + 15 * MINUTE };
    assert.equal((await state(lapsed, behind)).credentialReady, false);
  } finally { f.fixture.store.close(); }
});
