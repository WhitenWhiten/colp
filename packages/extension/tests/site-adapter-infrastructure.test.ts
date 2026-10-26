import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSiteImporter } from '../src/site-adapters/import-coordinator.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { createSiteActivity } from '../src/site-adapters/activity.js';
import { createSiteTransport, initialTransportState, type TransportState } from '../src/site-adapters/transport.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { siteFeatures } from '../src/site-adapters/capabilities.js';
import { validateSiteDefinitions } from '../src/site-adapters/registry-validation.js';
import type { createSourceLayout } from '../src/site-adapters/layout.js';
import type { HostCommand, AdapterMessage } from '../src/site-adapters/contracts.js';
import { postsDefinition, post, saved } from './fixtures/site-adapters/posts.js';

const single = { ...postsDefinition, capabilities: ['enumerateItems'] as const, negativeReadback: false, defaultCollection: saved, connectionKind: 'page' as const };
afterEach(() => vi.restoreAllMocks());
test('a non-video single-list source uses the common import and diagnostic infrastructure without catalog enumeration', async () => {
  expect(validateSiteDefinitions([single])).toHaveLength(1);
  expect(siteFeatures(single)).toMatchObject({ import: true, collections: false, observe: false });
  let now = 10000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, single), storage = new MemoryStorageArea();
  const activity = createSiteActivity(storage, single, { extensionVersion: 'test' }, () => now);
  try {
    const authority = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: false });
    const context = { installationId: single.adapterId, connectionId: authority.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', routeEpoch: 0, tabId: 1 };
    await ledger.bindLease(context, now + 100000);
    const plan = vi.fn(async () => ({ status: 'represented' as const }));
    const layout = { plan, authorize: async () => {} } as unknown as ReturnType<typeof createSourceLayout>;
    const sent: HostCommand[] = [], writes = vi.fn(async () => ({ status: 'confirmed' }));
    const importer = createSiteImporter(ledger, layout, createReadScheduler(storage, 'queue'), {
      activity, source: async () => ({ context, expiresAt: now + 60000 }), send: (_, command) => { sent.push(command); },
      prioritizeLive: async () => {}, snapshot: async () => ({ browserRules: { storageVersion: 3, listRevision: 1, contentVersions: {} }, policyRevision: 1 }),
      execute: writes, alarm: () => {},
    });
    await expect(importer.start(['list:other'])).rejects.toThrow('invalidScope');
    const id = await importer.start([saved.id]); await importer.wake();
    const command = sent[0]!; expect(command).toMatchObject({ operation: 'readPage', query: { kind: 'items', collectionId: saved.id, cursor: null } });
    if (command.operation !== 'readPage') throw new Error('no page');
    const message: AdapterMessage = { protocolVersion: 1, capability: 'host', operation: 'page.result', leaseId: context.leaseId,
      requestId: 'reply', readSessionId: id, pageRequestId: command.pageRequestId, result: { status: 'ok', kind: 'items', collectionId: saved.id,
        page: { items: [{ item: post }], omissions: [{ id: 'post:gone', reason: 'invalid' }], nextCursor: null, coverage: 'partial', consistency: 'bestEffort' } } };
    expect((await importer.accept(context, message))?.status).toBe('accepted'); now += 2000; await importer.wake();
    expect(await importer.status()).toMatchObject({ phase: 'preview', omissionCounts: { invalid: 1 }, preview: { counts: { reuseBookmarks: 1, review: 0 } } });
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ itemId: post.id, collectionId: saved.id }));
    expect(writes).not.toHaveBeenCalled();
    expect((await activity.list()).map(e => e.kind)).toEqual(['checked', 'started']);
  } finally { await db.close(); }
});

test('page connections need no account confirmation, while identity changes still fence old capabilities', async () => {
  let state: TransportState = initialTransportState(); let n = 0;
  const sender = { id: 'ext', url: post.url, origin: single.origin, frameId: 0, documentId: 'doc', documentLifecycle: 'active', tab: { id: 1 } };
  const transport = createSiteTransport({ extensionId: 'ext', now: () => 1000, random: () => `nonce-${++n}`,
    read: async () => structuredClone(state), write: async s => { state = structuredClone(s); }, permitted: async () => true, current: async () => post.url }, single);
  await transport.configure(true);
  const hello = { protocolVersion: 1, operation: 'hello', runtime: 'bundled', adapterId: single.adapterId, activationId: 'activation',
    source: { state: 'signedIn', accountId: 'acct:reader', displayName: 'Current page' } };
  const first = await transport.bootstrap(hello, sender); expect(first.status).toBe('ready');
  expect(await transport.status()).toMatchObject({ connected: true, candidateAccount: null, accountLabel: 'Current page' });
  const next = await transport.bootstrap({ ...hello, source: { state: 'signedIn', accountId: 'acct:other' } }, sender);
  expect(next.status).toBe('ready');
  if (first.status !== 'ready') throw new Error('no lease');
  expect(await transport.authorize({ protocolVersion: 1, requestId: 'old', operation: 'connect', leaseId: first.leaseId, capability: first.capability }, sender)).toBeNull();
});

test('observation and resolution alone never advertise a full existing-content import', () => {
  expect(siteFeatures({ capabilities: ['observeFavorites'] })).toMatchObject({ archive: true, liveArchive: true, import: false });
  expect(siteFeatures({ capabilities: ['resolveItem'] })).toMatchObject({ archive: false, liveArchive: false, import: false, resolve: true });
  expect(() => validateSiteDefinitions([{ ...single, defaultCollection: { ...saved, id: 'not-a-valid-collection' } }])).toThrow('invalidDefaultCollection');
});
