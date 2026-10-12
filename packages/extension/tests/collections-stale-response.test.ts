import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { COLLECTIONS_CACHE } from '../src/collections-cache.js';

const f = vi.hoisted(() => ({ target: 'old', generation: 1,
  refreshes: 0, refreshedSubject: 'owner',
  credential: { serverOrigin: 'https://known.test', subject: 'owner', accessToken: 'fixture' } }));
vi.mock('../src/sw/runtime.js', () => ({ extensionOrigin: () => 'chrome-extension://fixture',
  store: { loadCredential: async () => f.credential, fence: {
    capture: async () => ({ generation: f.generation, signal: new AbortController().signal }),
    read: async () => ({ generation: f.generation, revoked: false }) } } }));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: 'https://known.test' }),
  createRuntimeAuth: () => ({ ensureFreshCredential: async (force = false) => {
    if (force) { f.refreshes++; return { ...f.credential, accessToken: 'fresh', subject: f.refreshedSubject }; }
    return { ...f.credential };
  } }), boundCollectionId: async () => f.target }));
import { handleCollectionList, verifyCollectionAvailability } from '../src/sw/collections.js';

const storage = new MemoryStorageArea(), policy = createPersonalSyncPolicyStore(storage);
configurePersonalSyncTransport(policy);
const owner = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'old' };
beforeEach(async () => {
  vi.stubGlobal('chrome', { storage: { local: storage } });
  f.target = 'old'; f.generation = 1; f.credential.subject = 'owner';
  f.refreshes = 0; f.refreshedSubject = 'owner';
  await storage.remove(COLLECTIONS_CACHE); await policy.write(owner, 'enabled');
});
afterEach(() => vi.unstubAllGlobals());
function deferredListing() {
  let deliver!: (response: Response) => void, enter!: () => void;
  const response = new Promise<Response>(resolve => { deliver = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  vi.stubGlobal('fetch', async () => { enter(); return response; });
  return { started, deliver: (items: unknown[] = []) => deliver(new Response(JSON.stringify({ items }))) };
}
test('an older list cannot disable or replace cache for a newer verified target', async () => {
  const pending = deferredListing(), listing = handleCollectionList(); await pending.started;
  f.target = 'new'; await policy.write({ ...owner, collectionId: 'new' }, 'enabled');
  pending.deliver([{ id: 'old', title: 'Old', kind: 'bookmarks', visibility: 'private' }]); await listing;
  assert.equal((await policy.read({ ...owner, collectionId: 'new' })).mode, 'enabled');
  assert.equal((await storage.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE], undefined);
});
test.each(['policy', 'account', 'generation'])('a list ignores a newer %s decision even when the target id is unchanged', async change => {
  const pending = deferredListing(), listing = handleCollectionList(); await pending.started;
  if (change === 'policy') await policy.write(owner, 'paused');
  if (change === 'account') f.credential.subject = 'other';
  if (change === 'generation') f.generation++;
  pending.deliver(); await listing;
  assert.equal((await policy.read(owner)).mode, change === 'policy' ? 'paused' : 'enabled');
  assert.equal((await storage.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE], undefined);
});
test('current complete absence stops sync but never erases an unfinished disconnect', async () => {
  const pending = deferredListing(), listing = handleCollectionList(); await pending.started;
  pending.deliver(); assert.equal((await listing).ok, true);
  assert.equal((await policy.read(owner)).mode, 'target-unavailable');
  await policy.write(owner, 'disconnected');
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ items: [] })));
  assert.equal((await handleCollectionList()).ok, true);
  assert.equal((await policy.read(owner)).mode, 'disconnected');
});

test.each(['list', 'resume'])('a revoked credential refreshes once before %s without changing the binding', async action => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Headers(init?.headers).get('Authorization') === 'Bearer fresh'
      ? Response.json({ items: [{ id: 'old', title: 'Library', kind: 'bookmarks', visibility: 'private', rootNodeId: 'root' }] })
      : new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  if (action === 'list') assert.equal((await handleCollectionList()).ok, true);
  else assert.equal(await verifyCollectionAvailability(owner), 'available');
  assert.equal(f.refreshes, 1); assert.equal(fetcher.mock.calls.length, 2);
  assert.equal(f.target, 'old');
  assert.equal((await policy.read(owner)).mode, 'enabled');
});

test('rejected refresh and account changes cannot resume sync or retry as another owner', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  assert.equal(await verifyCollectionAvailability(owner), 'unknown');
  assert.equal(f.refreshes, 1); assert.equal(fetcher.mock.calls.length, 2);
  fetcher.mockClear(); f.refreshedSubject = 'other';
  assert.equal(await verifyCollectionAvailability(owner), 'unknown');
  assert.equal(fetcher.mock.calls.length, 1);
});
