import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { contentBindingKey } from '../src/site-adapters/content-identity.js';
import type { ContentBindingRow } from '../src/site-adapters/content-bindings.js';
import type { CaptureTask } from '../src/capture/contracts.js';
import type { installCaptureContentBindings } from '../src/capture/content-binding.js';
const f = vi.hoisted(() => ({ db: null as ReturnType<typeof createSourceDatabase> | null, hooks: null as Parameters<typeof installCaptureContentBindings>[0] | null, parent: 'inbox', validScope: true, dateAdded: 10 }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db!; } }, SITE_RECOVERY_ALARM: 'site' }));
vi.mock('../src/capture/content-binding.js', () => ({ installCaptureContentBindings: (hooks: Parameters<typeof installCaptureContentBindings>[0]) => { f.hooks = hooks; }, assertCaptureContent: (task: CaptureTask) => f.hooks!.assert(task) }));
vi.mock('../src/site-adapters/local-semantic-transfer.js', () => ({ queueLocalSemanticAssociation: vi.fn() }));
vi.mock('../src/site-adapters/wake-scheduler.js', () => ({ scheduleSourceAlarm: vi.fn() }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/capture.js', () => ({ captureStore: {} }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: vi.fn(), nativeCaptureLocation: vi.fn(), assertCaptureScope: async () => { if (!f.validScope) throw new Error('capture_scope_changed'); } }));
vi.mock('../src/site-adapters/semantic-associations.js', () => ({ semanticContext: vi.fn(), scopedSemanticBindings: vi.fn(), importSharedSemantic: vi.fn(), adoptSemanticAssociation: vi.fn() }));
vi.mock('../src/site-adapters/semantic-capture.js', () => ({ prepareSemanticCapture: vi.fn(), releaseSemanticCaptureClaim: vi.fn() }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => ({ serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' }) }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: { getMappingByNativeId: async (_scope: unknown, id: string) => ({ colpId: `cloud-${id}` }) } }));
test('interrupted explicit content move recovers the proven target without moving twice', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.parent = 'inbox'; f.validScope = true; f.dateAdded = 10;
  const runtime = await import('../src/site-adapters/content-runtime.js');
  runtime.installContentBindings();
  const b = { id: 'binding', content: { siteKey: 'bilibili', identityVersion: 1, itemId: 'video:av:1' },
    captureIntentId: 'capture', commandId: 'command', connectionId: null, purpose: 'semantic', state: 'active', mode: 'reuse',
    title: 'Video', parentId: 'inbox', url: 'https://www.bilibili.com/video/av1', policyRevision: null, requestDigest: 'request',
    native: { nativeId: 'bookmark', dateAdded: 10, deviceId: 'device', kind: 'bookmark', bindingId: 'native', proof: { kind: 'writeReceipt', id: 'native' } } } as ContentBindingRow;
  const task = { captureId: 'capture', commandId: 'command', nativeId: 'bookmark', nativeDateAdded: 10, targetNativeId: 'inbox', save: 'local-saved', classification: 'none',
    contentIntent: { bindingId: 'binding', mode: 'reuse', desiredParentId: 'target' } } as CaptureTask;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'bookmark', dateAdded: f.dateAdded, title: b.title, url: b.url, parentId: f.parent }] } });
  try {
    await f.db!.transaction(['contentBindings'], 'readwrite', async tx => { tx.objectStore('contentBindings').put(b, contentBindingKey(b.content, b.id)); });
    await expect(f.hooks!.move!(task, 'target', async () => { f.parent = 'target'; throw Error('lost_native_reply'); })).rejects.toThrow('lost_native_reply');
    await f.hooks!.acknowledge(task);
    f.parent = 'somewhere-else';
    await expect(f.hooks!.move!(task, 'target', async () => {})).rejects.toThrow('content_binding_needs_review');
    expect(await runtime.contentBindings.forIntent('capture')).toMatchObject({ parentId: 'inbox' });
    f.parent = 'inbox';
    await expect(f.hooks!.move!(task, 'target', async () => {})).rejects.toThrow('content_binding_needs_review');
    f.parent = 'target'; f.dateAdded = 11;
    await expect(f.hooks!.move!(task, 'target', async () => {})).rejects.toThrow('content_binding_needs_review');
    f.dateAdded = 10; f.validScope = false;
    await expect(f.hooks!.move!(task, 'target', async () => {})).rejects.toThrow('capture_scope_changed');
    f.validScope = true;
    const repeatMove = vi.fn(async () => {});
    await expect(f.hooks!.move!(task, 'target', repeatMove)).resolves.toBeUndefined();
    expect(repeatMove).not.toHaveBeenCalled();
    await f.hooks!.move!(task, 'target', repeatMove);
    expect(repeatMove).not.toHaveBeenCalled();
    expect(await runtime.contentBindings.forIntent('capture')).toMatchObject({ parentId: 'target' });
    expect(await f.db!.read('meta', 'contentMove:bookmark')).toMatchObject({ from: 'inbox', to: 'target', state: 'confirmed' });
    expect(f.parent).toBe('target');
  } finally { vi.unstubAllGlobals(); await f.db!.close(); }
});


test('a recovered shared move retains the original cloud relocation and is idempotent', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.parent = 'target'; f.validScope = true; f.dateAdded = 10; vi.resetModules();
  const runtime = await import('../src/site-adapters/content-runtime.js'); runtime.installContentBindings();
  const b = { id: 'binding', content: { siteKey: 'bilibili', identityVersion: 1, itemId: 'video:av:1' }, captureIntentId: 'capture',
    commandId: 'command', connectionId: null, purpose: 'semantic', state: 'active', mode: 'reuse', title: 'Video', parentId: 'inbox',
    url: 'https://www.bilibili.com/video/av1', policyRevision: null, requestDigest: 'request',
    native: { nativeId: 'bookmark', dateAdded: 10, deviceId: 'device', kind: 'bookmark', bindingId: 'native', proof: { kind: 'writeReceipt', id: 'native' } },
    shared: { library: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' }, nodeId: 'cloud-node', slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'bilibili', identityVersion: 1, itemId: 'video:av:1', accountId: null } } } } } as ContentBindingRow;
  const task = { captureId: 'capture', commandId: 'command', nativeId: 'bookmark', nativeDateAdded: 10, targetNativeId: 'inbox', save: 'local-saved', classification: 'none',
    contentIntent: { bindingId: 'binding', mode: 'reuse', desiredParentId: 'target' } } as CaptureTask;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'bookmark', dateAdded: f.dateAdded, title: b.title, url: b.url, parentId: f.parent }] } });
  try {
    await f.db!.transaction(['contentBindings', 'meta'], 'readwrite', async tx => {
      tx.objectStore('contentBindings').put(b, contentBindingKey(b.content, b.id));
      tx.objectStore('meta').put({ nativeId: 'bookmark', dateAdded: 10, title: 'Video', from: 'inbox', to: 'target', at: 1, state: 'submitted' }, 'contentMove:bookmark');
    });
    const move = vi.fn(async () => {}); await f.hooks!.move!(task, 'target', move); await f.hooks!.move!(task, 'target', move);
    expect(move).not.toHaveBeenCalled();
    const values = await f.db!.transaction(['meta'], 'readonly', tx => new Promise<unknown[]>(resolve => { const request = tx.objectStore('meta').getAll(); request.onsuccess = () => resolve(request.result); }));
    expect(values).toContainEqual(expect.objectContaining({ nativeParent: 'target', expected: expect.objectContaining({ nodeId: 'cloud-node', from: 'cloud-inbox', to: 'cloud-target' }) }));
  } finally { vi.unstubAllGlobals(); await f.db!.close(); }
});
