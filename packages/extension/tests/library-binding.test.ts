import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { LIBRARY_STATE, COLLECTION_BINDING } from '../src/library.js';

const f = vi.hoisted(() => ({ target: null as string | null, generation: 1,
  refreshes: 0, refreshedSubject: 'owner',
  credential: { serverOrigin: 'https://known.test', subject: 'owner', accessToken: 'fixture' } }));
vi.mock('../src/sw/runtime.js', () => ({ extensionOrigin: () => 'chrome-extension://fixture',
  workCoordinator: { run: async (_lane: string, work: () => Promise<unknown>) => work() },
  store: { assertWritable: async () => undefined, clearSession: async () => undefined, loadCredential: async () => ({ ...f.credential }), fence: {
    capture: async () => ({ generation: f.generation, signal: new AbortController().signal }),
    read: async () => ({ generation: f.generation, revoked: false }) } } }));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: 'https://known.test' }),
  createRuntimeAuth: () => ({ ensureFreshCredential: async (force = false) => {
    if (force) { f.refreshes++; return { ...f.credential, accessToken: 'fresh', subject: f.refreshedSubject }; }
    return { ...f.credential };
  } }), boundCollectionId: async () => f.target }));
import { ensureLibraryBinding, verifyLibraryAvailability, bindLibraryOnStartup } from '../src/sw/library.js';

const storage = new MemoryStorageArea(), policy = createPersonalSyncPolicyStore(storage);
configurePersonalSyncTransport(policy);
const owner = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'old' };
beforeEach(async () => {
  vi.stubGlobal('chrome', { storage: { local: storage } });
  f.target = 'old'; f.generation = 1; f.credential.subject = 'owner';
  f.refreshes = 0; f.refreshedSubject = 'owner';
  f.credential.serverOrigin = 'https://known.test';
  await storage.remove([LIBRARY_STATE, COLLECTION_BINDING]); await policy.write(owner, 'enabled');
});
afterEach(() => vi.unstubAllGlobals());
const library = { id: 'old', title: 'Bookmarks', rootNodeId: 'root', library: true, bookmarksBarId: 'bar', otherBookmarksId: 'other' };
function deferredLibrary() {
  let deliver!: (response: Response) => void, enter!: () => void;
  const response = new Promise<Response>(resolve => { deliver = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  vi.stubGlobal('fetch', async () => { enter(); return response; });
  return { started, deliver: () => deliver(Response.json(library)) };
}
test('a fresh account binds its library without a selection message', async () => {
  f.target = null;
  vi.stubGlobal('fetch', async () => Response.json(library));
  await bindLibraryOnStartup();
  assert.equal((await storage.get(COLLECTION_BINDING))[COLLECTION_BINDING], library.id);
  assert.equal((await policy.read(owner)).mode, 'enabled');
});
test.each(['target', 'policy', 'account', 'origin', 'generation'])('a late library response cannot replace a newer %s decision', async change => {
  const pending = deferredLibrary(), binding = ensureLibraryBinding(); await pending.started;
  if (change === 'target') f.target = 'new';
  if (change === 'policy') await policy.write(owner, 'paused');
  if (change === 'account') f.credential.subject = 'other';
  if (change === 'origin') f.credential.serverOrigin = 'https://other.test';
  if (change === 'generation') f.generation++;
  pending.deliver(); await binding;
  assert.equal((await storage.get(LIBRARY_STATE))[LIBRARY_STATE], undefined);
  assert.equal((await storage.get(COLLECTION_BINDING))[COLLECTION_BINDING], undefined);
});
test('a worker restart preserves a disconnected policy; signing in explicitly binds again', async () => {
  f.target = null;
  await policy.write(owner, 'disconnected');
  vi.stubGlobal('fetch', async () => Response.json(library));
  assert.equal(await ensureLibraryBinding(), undefined);
  assert.equal((await storage.get(COLLECTION_BINDING))[COLLECTION_BINDING], undefined);
  assert.deepEqual(await ensureLibraryBinding({ login: true }), library);
  assert.equal((await policy.read(owner)).mode, 'enabled');
});
test('404 records unsupported sync and leaves no binding or fallback picker', async () => {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await ensureLibraryBinding(), undefined);
  assert.equal(((await storage.get(LIBRARY_STATE))[LIBRARY_STATE] as { status: string }).status, 'unsupported');
  assert.equal((await storage.get(COLLECTION_BINDING))[COLLECTION_BINDING], undefined);
});
test.each(['bind', 'resume'])('a revoked credential refreshes once before %s', async action => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Headers(init?.headers).get('Authorization') === 'Bearer fresh'
      ? Response.json(library) : new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  if (action === 'bind') assert.deepEqual(await ensureLibraryBinding(), library);
  else assert.equal(await verifyLibraryAvailability(owner), 'available');
  assert.equal(f.refreshes, 1); assert.equal(fetcher.mock.calls.length, 2);
});
test('a refresh that switched accounts cannot retry as another owner', async () => {
  f.refreshedSubject = 'other';
  const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  assert.equal(await verifyLibraryAvailability(owner), 'unknown');
  assert.equal(fetcher.mock.calls.length, 1);
});

test.each([false, true])('discovery preserves a paused policy on login=%s when the binding was absent', async login => {
  f.target = null;
  await policy.write(owner, 'paused');
  vi.stubGlobal('fetch', async () => Response.json(library));
  if (login) await ensureLibraryBinding({ login: true }); else await bindLibraryOnStartup();
  assert.equal((await storage.get(COLLECTION_BINDING))[COLLECTION_BINDING], library.id);
  assert.equal((await policy.read(owner)).mode, 'paused');
});
