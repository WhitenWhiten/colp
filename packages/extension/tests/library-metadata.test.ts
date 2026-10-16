import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { browserMetadataSyncPolicy } from '../src/metadata-sync-policy.js';
import { validMetadataPolicyConfigureRequest } from '../src/metadata-policy-status.js';

const f = vi.hoisted(() => ({ generation: 1, releases: 0, afterRelease: async () => {} }));
vi.mock('../src/sw/runtime.js', () => ({
  store: { loadCredential: async () => ({ subject: 'owner', serverOrigin: 'https://known.test' }),
    fence: { capture: async () => ({ generation: f.generation, signal: new AbortController().signal }) },
    assertWritable: async (generation: number) => { if (generation !== f.generation) throw new Error('authority_fenced'); },
  },
  workCoordinator: { run: async (_lane: string, work: () => Promise<unknown>) => work() },
}));
vi.mock('../src/sw/scope.js', () => ({ boundCollectionId: async () => 'library' }));
vi.mock('../src/metadata-transfer.js', () => ({ releaseMetadataBindings: async () => { f.releases++; await f.afterRelease(); } }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
import { configureLibraryMetadata } from '../src/sw/library-metadata.js';

const storage = new MemoryStorageArea();
const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'library' };
beforeEach(async () => {
  vi.stubGlobal('chrome', { storage: { local: storage } });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('metadata consent must not require network'); }));
  f.generation = 1; f.releases = 0; f.afterRelease = async () => {};
  await browserMetadataSyncPolicy().write(identity, false);
});
afterEach(() => vi.unstubAllGlobals());

test('metadata configuration requires an explicit gesture and cannot target another library', () => {
  assert.equal(validMetadataPolicyConfigureRequest({ kind: 'known.metadataSync.configure', enabled: true, userGesture: true }), true);
  assert.equal(validMetadataPolicyConfigureRequest({ kind: 'known.metadataSync.configure', enabled: true }), false);
  assert.equal(validMetadataPolicyConfigureRequest({ kind: 'known.metadataSync.configure', enabled: true, userGesture: true, collectionId: 'other' }), false);
});
test('keeping metadata local works offline without releasing any bindings', async () => {
  await browserMetadataSyncPolicy().write(identity, true);
  assert.deepEqual(await configureLibraryMetadata(false), { ok: true });
  assert.equal((await browserMetadataSyncPolicy().read(identity)).mode, 'local-only');
  assert.equal(f.releases, 0);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});
test('positive consent releases previous metadata authority before enabling sync', async () => {
  f.afterRelease = async () => {
    assert.equal((await browserMetadataSyncPolicy().read(identity)).mode, 'local-only');
  };
  await configureLibraryMetadata(true);
  assert.equal(f.releases, 1);
  assert.equal((await browserMetadataSyncPolicy().read(identity)).mode, 'sync');
});
test('an authority change during transfer leaves metadata local', async () => {
  f.afterRelease = async () => { f.generation++; };
  await assert.rejects(configureLibraryMetadata(true), /authority_fenced/);
  assert.equal((await browserMetadataSyncPolicy().read(identity)).mode, 'local-only');
});
