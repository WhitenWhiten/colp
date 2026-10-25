import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createConfirmationQueue } from '../src/site-adapters/confirmation-queue.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { HostCommand, MembershipReadResult } from '../src/site-adapters/contracts.js';
import { post, saved, postsDefinition } from './fixtures/site-adapters/posts.js';

async function fixture(negativeReadback = true) {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, {}, { ...postsDefinition, negativeReadback });
  const authority = await ledger.setAuthority({ enabled: true, installationGeneration: 1, sourceSessionGeneration: 1, accountId: 'acct:reader', negativeReadback });
  const context = { installationId: postsDefinition.adapterId, connectionId: authority.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', tabId: 1, routeEpoch: 0 };
  await ledger.bindLease(context, Date.now() + 600000);
  let time = Date.now(); const sent: HostCommand[] = [];
  const scheduler = createReadScheduler(new MemoryStorageArea(), 'reads', () => time);
  const make = () => createConfirmationQueue(ledger, scheduler, { source: async () => ({ context, expiresAt: time + 60000 }), send: (_, command) => { sent.push(command); }, alarm: () => {} }, () => time);
  const queue = make();
  const observe = (id: string, present: boolean) => ledger.acceptObservation(context, id, { type: 'membership.observed', item: post, memberships: { mode: 'delta', added: present ? [saved.id] : [], removed: present ? [] : [saved.id] } });
  const enqueue = (removed = false) => queue.enqueue(context, 'hint', { interactionId: 'hint', itemId: post.id, added: removed ? [] : [saved.id], removed: removed ? [saved.id] : [], code: 0 });
  const reply = (result: MembershipReadResult) => {
    const c = sent.at(-1); if (c?.operation !== 'readMemberships') throw new Error('missingMembershipRead');
    return queue.accept(context, { protocolVersion: 1, requestId: c.readRequestId, leaseId: c.leaseId, capability: 'host', operation: 'membership.result', readSessionId: c.readSessionId, readRequestId: c.readRequestId, result });
  };
  const resolve = async () => {
    time += 2000; await make().wake(); const c = sent.at(-1); if (c?.operation !== 'resolveItem') throw new Error('missingResolution');
    return make().accept(context, { protocolVersion: 1, requestId: c.resolutionId, leaseId: c.leaseId, capability: 'host', operation: 'item.result', resolutionId: c.resolutionId, result: { status: 'resolved', item: post } });
  };
  const result = (state: 'present' | 'absent'): MembershipReadResult => ({ status: 'ok', itemId: post.id, edges: [{ collectionId: saved.id, state, evidence: { kind: 'refreshedDom', detector: 'fresh' } }] });
  return { db, ledger, context, sent, queue, make, observe, enqueue, reply, resolve, result, edge: () => db.read('memberships', sourceKey(context.connectionId, post.id, saved.id)), advance: () => { time += 2000; } };
}
test('qualified removal reads update facts without item resolution or native deletion, including after restart', async () => {
  const f = await fixture(); try {
    await f.observe('present', true); await f.enqueue(true); await f.make().wake();
    expect(f.sent[0]).toMatchObject({ operation: 'readMemberships', query: { collectionIds: [saved.id] } });
    await f.reply(f.result('absent'));
    expect(await f.edge()).toMatchObject({ state: 'absent', conflicts: [], evidence: 'read' });
    expect(await f.queue.status()).toMatchObject({ pending: 0, last: { state: 'observed' } }); expect(f.sent).toHaveLength(1);
    expect(await f.db.transaction(['outbox'], 'readonly', async tx => new Promise(resolve => { const r = tx.objectStore('outbox').count(); r.onsuccess = () => resolve(r.result); }))).toBe(0);
  } finally { await f.db.close(); }
});
test('fresh positive confirmation clears old contradictions atomically and retains observation provenance', async () => {
  const f = await fixture(); try {
    await f.observe('present', true); await f.observe('absent', false); await f.enqueue(); await f.queue.wake();
    await f.reply(f.result('present')); await f.resolve();
    expect(await f.edge()).toMatchObject({ state: 'present', conflicts: [], evidence: 'read' });
    const last = (await f.queue.status()).last as { observationId: string };
    expect(await f.db.read('observations', last.observationId)).toMatchObject({ cause: 'reconcile', context: { connectionId: f.context.connectionId }, observation: { memberships: { added: [saved.id] } } });
  } finally { await f.db.close(); }
});
test.each(['membership', 'item'])('observations arriving during %s resolution cannot be overwritten or replanned by old reads', async stage => {
  const f = await fixture(); try {
    await f.enqueue(); await f.queue.wake();
    if (stage === 'membership') await f.observe('newer', false);
    await f.reply(f.result('present'));
    if (stage === 'item') await f.observe('newer', false);
    const before = await f.edge(); await f.resolve(); expect(await f.edge()).toEqual(before);
    const last = (await f.queue.status()).last as { observationId: string };
    expect(await f.db.read('observations', last.observationId)).toMatchObject({ observation: { memberships: { added: [], removed: [] } } });
  } finally { await f.db.close(); }
});
test('negative capability stays closed when disabled and forged negative results are rejected', async () => {
  const f = await fixture(false); try {
    await f.enqueue(true); await f.queue.wake(); expect(f.sent).toHaveLength(0);
    await f.queue.enqueue(f.context, 'positive', { interactionId: 'positive', itemId: post.id, added: [saved.id], removed: [], code: 0 }); await f.queue.wake();
    expect(await f.reply(f.result('absent'))).toBe(false); expect(await f.edge()).toBeUndefined();
  } finally { await f.db.close(); }
});
test('removal-only challenge can be explicitly retried under a fresh read identity', async () => {
  const f = await fixture(); try {
    await f.enqueue(true); await f.queue.wake(); const first = f.sent[0];
    await f.reply({ status: 'failed', error: { code: 'challenge' } }); await f.queue.retry(); f.advance(); await f.queue.wake();
    expect(f.sent).toHaveLength(2); expect(f.sent[1]).not.toEqual(first);
    await f.reply(f.result('absent')); expect(await f.edge()).toMatchObject({ state: 'absent' });
  } finally { await f.db.close(); }
});
test('mixed hints query the full qualified scope and commit both positive and negative facts', async () => {
  const f = await fixture(); try {
    await f.queue.enqueue(f.context, 'mixed', { interactionId: 'mixed', itemId: post.id, added: [saved.id], removed: ['list:old'], code: 0 }); await f.queue.wake();
    expect(f.sent[0]).toMatchObject({ query: { collectionIds: [saved.id, 'list:old'] } });
    await f.reply({ status: 'ok', itemId: post.id, edges: [{ collectionId: saved.id, state: 'present', evidence: { kind: 'refreshedDom', detector: 'fresh' } }, { collectionId: 'list:old', state: 'absent', evidence: { kind: 'refreshedDom', detector: 'fresh' } }] });
    await f.resolve(); expect(await f.edge()).toMatchObject({ state: 'present' });
    expect(await f.db.read('memberships', sourceKey(f.context.connectionId, post.id, 'list:old'))).toMatchObject({ state: 'absent' });
  } finally { await f.db.close(); }
});

test('negative readback overlays an older import without deleting or resurrecting archived content', async () => {
  const f = await fixture(); try {
    await f.ledger.startImport(f.context, 'run'); await f.enqueue(true); await f.queue.wake(); await f.reply(f.result('absent'));
    await f.ledger.issuePage({ id: 'page', runId: 'run', context: f.context, deadlineAt: Date.now() + 30000, query: { kind: 'items', collectionId: saved.id, cursor: null } });
    expect(await f.ledger.acceptPage(f.context, 'page', { status: 'ok', kind: 'items', collectionId: saved.id, page: { items: [{ item: post }], nextCursor: null, coverage: 'complete', consistency: 'bestEffort' } })).toMatchObject({ status: 'accepted' });
    expect(await f.edge()).toMatchObject({ state: 'absent', evidence: 'read' });
  } finally { await f.db.close(); }
});
test('newer observations retain their facts during negative readback', async () => {
  const f = await fixture(); try {
    await f.enqueue(true); await f.queue.wake(); await f.observe('newer', true);
    const before = await f.edge(); await f.reply(f.result('absent')); expect(await f.edge()).toEqual(before);
  } finally { await f.db.close(); }
});
