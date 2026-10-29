import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { contentBindingKey } from '../src/site-adapters/content-identity.js';
import type { ContentBindingRow } from '../src/site-adapters/content-bindings.js';

const fixture = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof createSourceDatabase> }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return fixture.db; } }, SITE_RECOVERY_ALARM: 'site' }));
vi.mock('../src/site-adapters/semantic-associations.js', () => ({ semanticContext: async () => ({ scopeId: 'library', scope: {} }), scopedSemanticBindings: vi.fn(), importSharedSemantic: vi.fn(), adoptSemanticAssociation: vi.fn() }));
vi.mock('../src/sw/capture.js', () => ({ captureStore: { getForOwner: async () => undefined } }));
vi.mock('../src/site-adapters/semantic-capture.js', () => ({ prepareSemanticCapture: vi.fn(), releaseSemanticCaptureClaim: async () => {} }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: vi.fn(), nativeCaptureLocation: vi.fn(), assertCaptureOwner: vi.fn(), assertCaptureScope: vi.fn() }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: {}, workCoordinator: {} }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: vi.fn() }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: vi.fn() }));
vi.mock('../src/site-adapters/local-semantic-transfer.js', () => ({ queueLocalSemanticAssociation: vi.fn() }));
vi.mock('../src/site-adapters/portable.js', () => ({ assertSourceRebound: vi.fn(), assertRestoredItemAvailable: vi.fn() }));
import { handleContentRequest } from '../src/site-adapters/content-runtime.js';
import { legacySite } from '../src/site-adapters/registry.js';

const row = (itemId: string, id: string): ContentBindingRow => ({ id, content: { siteKey: legacySite.siteKey, identityVersion: legacySite.identityVersion, itemId },
  scopeId: 'library', purpose: 'semantic', native: null, captureIntentId: id, connectionId: null, commandId: id, requestDigest: 'digest',
  state: 'pending', mode: 'create', policyRevision: null, title: id, url: 'https://example.test/', parentId: 'folder' });
test('management list pages past superseded history and retries an exact binding beyond the first page', async () => {
  fixture.db = createSourceDatabase(new IDBFactory());
  try {
    await fixture.db.transaction(['contentBindings'], 'readwrite', async tx => {
      const store = tx.objectStore('contentBindings');
      for (let i = 0; i < 1001; i++) { const old = { ...row('a', `old-${i}`), supersededBy: 'later' }; store.put(old, contentBindingKey(old.content, old.id)); }
      for (let i = 0; i < 65; i++) { const b = row('b', `pending-${String(i).padStart(3, '0')}`); store.put(b, contentBindingKey(b.content, b.id)); }
    });
    const first = await handleContentRequest({ kind: 'known.siteAdapters.content.list' });
    expect(first.bindings).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await handleContentRequest({ kind: 'known.siteAdapters.content.list', cursor: first.nextCursor });
    expect(second.bindings).toHaveLength(15);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.bindings!, ...second.bindings!].map(b => b.id)).size).toBe(65);
    await expect(handleContentRequest({ kind: 'known.siteAdapters.content.retryUnsubmitted', itemId: 'b', bindingId: 'pending-064' })).resolves.toEqual({ ok: true });
    expect(await fixture.db.read('contentBindings', contentBindingKey(row('b', 'pending-064').content, 'pending-064'))).toBeUndefined();
  } finally { await fixture.db.close(); }
});

test('retry rejects bindings from a different account or scope and preserves them', async () => {
  fixture.db = createSourceDatabase(new IDBFactory());
  try {
    const wrongAccount = { ...row('account-item', 'account'), content: { ...row('account-item', 'account').content, accountId: 'other' }, connectionId: 'old' };
    const wrongScope = { ...row('scope-item', 'scope'), scopeId: 'other-library' };
    await fixture.db.transaction(['authorities', 'contentBindings'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, connectionId: 'current', accountId: 'current' }, legacySite.adapterId);
      for (const b of [wrongAccount, wrongScope]) tx.objectStore('contentBindings').put(b, contentBindingKey(b.content, b.id));
    });
    for (const b of [wrongAccount, wrongScope]) {
      await expect(handleContentRequest({ kind: 'known.siteAdapters.content.retryUnsubmitted', itemId: b.content.itemId, bindingId: b.id })).rejects.toThrow('content_retry_unavailable');
      expect(await fixture.db.read('contentBindings', contentBindingKey(b.content, b.id))).toEqual(b);
    }
    await expect(handleContentRequest({ kind: 'known.siteAdapters.content.list', cursor: 'other-site' })).rejects.toThrow('invalid');
  } finally { await fixture.db.close(); }
});
