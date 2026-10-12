import { expect, test, vi } from 'vitest';
import 'fake-indexeddb/auto';
const f = vi.hoisted(() => ({ selected: '', release: vi.fn(), lanes: [] as string[] }));
vi.mock('../src/metadata-transfer.js', () => ({ releaseMetadataBindings: f.release }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({ prepareSubscriptionLogout: vi.fn(), maintenance: { cleanup: async () => undefined }, wakeSubscriptions: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/personal-sync.js', () => ({ suspendPersonalSyncForLogout: vi.fn() }));
vi.mock('../src/sw/runtime.js', () => ({ COLLECTION_BINDING: 'known.sync.collection.v1', WELCOME_FLAG: 'welcome', sw: {}, syncState: {},
  store: { loadCredential: async () => ({ subject: 'owner', serverOrigin: 'https://known.test' }), loadSession: async () => null,
    loadBinding: async () => null, clearAuthority: async () => undefined },
  workCoordinator: { drain: async (exclude?: string) => { if (exclude !== 'auth') throw new Error('unrelated engine work must not block collection selection'); },
    run: async (lane: string, work: () => Promise<void>) => { f.lanes.push(lane); await work(); } },
}));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: 'https://known.test' }), enforceManagedPolicy: async () => undefined,
  boundCollectionId: async () => null,
  createRuntimeAuth: () => ({ status: async () => ({ status: 'connected' }), logout: async () => ({ status: 'signed_out' }) }),
  pushSessionAuthority: async () => { throw new Error('offline'); }, ensureSyncScope: vi.fn(), hasBoundCollection: async () => true,
  currentSyncScope: async () => { throw new Error('offline'); }, retire: vi.fn(), scheduleSessionFreshen: vi.fn(),
}));
import { handle } from '../src/sw/auth.js';
test('explicit migration changes selection first and serializes metadata work without draining authentication', async () => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
      if (typeof values['known.sync.collection.v1'] === 'string') f.selected = values['known.sync.collection.v1'];
    },
  } } });
  f.release.mockImplementation(async () => { expect(f.selected).toBe('new-collection'); });
  try {
    expect((await handle({ kind: 'known.collection.select', collectionId: 'new-collection', userGesture: true, migrateMetadata: true },
      { generation: 1, signal: new AbortController().signal })).ok).toBe(true);
    expect(f.release).toHaveBeenCalledOnce(); expect(f.lanes).toEqual(['local-bookmark']);
  } finally { vi.unstubAllGlobals(); }
});

test('logout invokes Chrome storage methods with their StorageArea receiver', async () => {
  const removed: string[] = [];
  const local = { async remove(this: unknown, key: string) {
    if (this !== local) throw new TypeError('Illegal invocation'); removed.push(key);
  } };
  vi.stubGlobal('chrome', { storage: { local } });
  try {
    expect(await handle({ kind: 'known.auth.logout', userGesture: true },
      { generation: 1, signal: new AbortController().signal })).toMatchObject({ ok: true, state: { status: 'signed_out' } });
    expect(removed).toContain('known.sync.collection.v1');
  } finally { vi.unstubAllGlobals(); }
});
