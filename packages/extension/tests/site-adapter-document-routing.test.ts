// @vitest-environment happy-dom
import { createPageContext } from '../src/site-adapters/page-context.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey, type SourceDatabase } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createConfirmationQueue } from '../src/site-adapters/confirmation-queue.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { selectReadLease } from '../src/site-adapters/read-source.js';
import { installationKey } from '../src/site-adapters/installation.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { SourceContext } from '../src/site-adapters/ledger-types.js';
import type { SiteDefinition } from '../src/site-adapters/registry-types.js';
import type { Lease } from '../src/site-adapters/transport.js';
import type { HostCommand } from '../src/site-adapters/contracts.js';
import { createDomPostsAdapter, post, saved, postsDefinition } from './fixtures/site-adapters/posts.js';

function page(withItem: boolean, url: string) {
  const doc = document.implementation.createHTMLDocument(); doc.documentElement.dataset.account = 'acct:reader';
  if (withItem) { const node = doc.createElement('article'); node.dataset.postId = post.id; node.dataset.title = 'DOM title'; node.dataset.url = url;
    const edge = doc.createElement('span'); edge.dataset.collectionId = saved.id; edge.dataset.present = 'true'; node.append(edge); doc.body.append(node); }
  return doc;
}
async function fixture(db: SourceDatabase, storage: MemoryStorageArea, definition = postsDefinition) {
  const ledger = createSourceLedger(db, {}, definition), authority = await ledger.setAuthority({ enabled: true, accountId: 'acct:reader', installationGeneration: 1, sourceSessionGeneration: 1, negativeReadback: true });
  let time = Date.now();
  const contexts = [1, 2].map(tabId => ({ installationId: definition.adapterId, connectionId: authority.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1,
    documentId: `${definition.adapterId}:doc:${tabId}`, leaseId: `${definition.adapterId}:lease:${tabId}`, tabId, routeEpoch: 0 } satisfies SourceContext));
  const documents = [page(false, post.url), page(true, definition.itemUrl(post.id)!)];
  let leases: Lease[] = contexts.map(c => ({ id: c.leaseId, capability: 'private', tabId: c.tabId, documentId: c.documentId, url: definition.origin, routeEpoch: 0,
    generation: 1, sourceGeneration: 1, accountId: 'acct:reader', expiresAt: time + 600000 }));
  for (const c of contexts) await ledger.bindLease(c, time + 600000);
  const sent: { context: SourceContext; command: HostCommand }[] = [];
  const queue = createConfirmationQueue(ledger, createReadScheduler(storage, installationKey('queue', definition), () => time), {
    source: async origin => { const lease = selectReadLease(definition, leases, () => true, time, origin); const context = contexts.find(c => c.leaseId === lease?.id); return context ? { context, expiresAt: time + 60000 } : null; },
    send: (context, command) => { sent.push({ context, command }); }, alarm: () => {},
  }, () => time);
  const hint = { interactionId: 'same-hint', itemId: post.id, added: [saved.id], removed: [], code: 0 };
  const adapter = createDomPostsAdapter();
  async function dispatch() {
    const { context: c, command } = sent.at(-1)!; const reject = async () => ({ status: 'rejected' as const, reason: 'paused' as const });
    const ctx = { ...createPageContext({ document: documents[c.tabId - 1]!, signal: new AbortController().signal, accountId: 'acct:reader', deadlineAt: time + 30000,
      routeEpoch: c.routeEpoch, routeEvent: 'fixture-route', controls: false, emit: reject, hint: reject, requestCapture: reject }), readSessionId: 'read' };
    if (command.operation === 'readMemberships') return queue.accept(c, { protocolVersion: 1, leaseId: c.leaseId, capability: 'private', requestId: command.readRequestId,
      operation: 'membership.result', readSessionId: command.readSessionId, readRequestId: command.readRequestId, result: await adapter.readMemberships!(ctx, command.query) });
    if (command.operation !== 'resolveItem') throw new Error('unexpectedCommand');
    return queue.accept(c, { protocolVersion: 1, leaseId: c.leaseId, capability: 'private', requestId: command.resolutionId, operation: 'item.result', resolutionId: command.resolutionId,
      result: await adapter.resolveItem!(ctx, command.url) });
  }
  return { ledger, queue, contexts, documents, sent, dispatch, hint, definition, enqueue: () => queue.enqueue(contexts[1]!, 'same-request', hint),
    removeOrigin: () => { leases = leases.slice(0, 1); }, advance: (ms = 2000) => { time += ms; },
    edge: () => db.read('memberships', sourceKey(authority.connectionId, post.id, saved.id)) };
}
test('two same-site documents read only the hint-origin DOM for both membership and resolution', async () => {
  const db = createSourceDatabase(new IDBFactory()); try {
    const f = await fixture(db, new MemoryStorageArea()); await f.enqueue(); await f.queue.wake(); await f.dispatch(); f.advance(); await f.queue.wake(); await f.dispatch();
    expect(f.sent.map(x => x.context.documentId)).toEqual([f.contexts[1]!.documentId, f.contexts[1]!.documentId]);
    expect(await f.edge()).toMatchObject({ state: 'present' }); expect(await f.queue.status()).toMatchObject({ pending: 0, last: { state: 'observed' } });
  } finally { await db.close(); }
});
test('missing origin pauses boundedly instead of reading another document; account readers explicitly permit fallback', async () => {
  const db = createSourceDatabase(new IDBFactory()); try {
    const f = await fixture(db, new MemoryStorageArea()); await f.enqueue(); f.removeOrigin(); await f.queue.wake(); f.advance(31000); await f.queue.wake();
    expect(f.sent).toEqual([]); expect(await f.queue.status()).toMatchObject({ last: { reason: 'pageUnavailable' } });
    const shared: SiteDefinition = { ...postsDefinition, adapterId: 'fixture.account', siteKey: 'account-posts', readScope: 'account' };
    const other = await fixture(db, new MemoryStorageArea(), shared); await other.enqueue(); other.removeOrigin(); await other.queue.wake(); expect(other.sent[0]?.context.tabId).toBe(1);
  } finally { await db.close(); }
});
test('document-local import cursors wait for their renewed lease while account reads can use another tab', () => {
  const origin: SourceContext = { connectionId: 'connection', installationGeneration: 1, sourceSessionGeneration: 1,
    tabId: 1, documentId: 'origin', routeEpoch: 0, leaseId: 'old' };
  const lease: Lease = { id: 'old', capability: 'private', tabId: 1, documentId: 'origin', routeEpoch: 0,
    url: postsDefinition.origin, generation: 1, sourceGeneration: 1, accountId: 'acct:reader', expiresAt: 60000 };
  const other = { ...lease, id: 'other', tabId: 2, documentId: 'other' }, renewed = { ...lease, id: 'renewed', expiresAt: 90000 };
  const available = [other, lease];
  expect(selectReadLease({ readScope: 'account' }, available, id => id !== 'old', 30000, origin)).toBe(other);
  expect(selectReadLease({ readScope: 'document' }, available, id => id !== 'old', 30000, origin)).toBeUndefined();
  expect(selectReadLease({ readScope: 'document' }, [other, renewed], () => true, 30000, origin)).toBe(renewed);
  expect(selectReadLease({ readScope: 'document' }, [other, { ...renewed, routeEpoch: 1 }], () => true, 30000, origin)).toBeUndefined();
});
test('two site queues and DOM readers run in parallel with identical account/item/request IDs without sharing facts or pauses', async () => {
  const db = createSourceDatabase(new IDBFactory()), storage = new MemoryStorageArea(); try {
    const second: SiteDefinition = { ...postsDefinition, adapterId: 'fixture.other', siteKey: 'other', origin: 'https://other.example', matches: ['https://other.example/*'],
      itemUrl: id => `https://other.example/posts/${id.slice(5)}`, validateItem: i => i.url.startsWith('https://other.example/posts/'), validateMessage: () => true };
    const [a, b] = await Promise.all([fixture(db, storage), fixture(db, storage, second)]);
    await Promise.all([a.enqueue(), b.enqueue()]); await Promise.all([a.queue.wake(), b.queue.wake()]);
    const first = a.sent[0]!; if (first.command.operation !== 'readMemberships') throw new Error('missingRead');
    await a.queue.accept(first.context, { protocolVersion: 1, leaseId: first.context.leaseId, capability: 'private', requestId: first.command.readRequestId, operation: 'membership.result',
      readSessionId: first.command.readSessionId, readRequestId: first.command.readRequestId, result: { status: 'failed', error: { code: 'challenge' } } });
    await b.dispatch(); b.advance(); await b.queue.wake(); await b.dispatch();
    expect(await a.queue.status()).toMatchObject({ paused: 'challenge' }); expect(await a.edge()).toBeUndefined();
    expect(await b.queue.status()).toMatchObject({ paused: null, last: { state: 'observed' } }); expect(await b.edge()).toMatchObject({ state: 'present' });
    expect(a.contexts[0]!.connectionId).not.toBe(b.contexts[0]!.connectionId);
  } finally { await db.close(); }
});
