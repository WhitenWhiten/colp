import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, expect } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLedger } from '../src/site-adapters/ledger.js';
import { createConfirmationQueue } from '../src/site-adapters/confirmation-queue.js';
import { validMembershipHint, validAdapterMessage } from '../src/site-adapters/schemas.js';
import { validBilibiliMessage } from '../src/site-adapters/bilibili/wire.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import type { AdapterMessage, HostCommand, MembershipHint } from '../src/site-adapters/contracts.js';
import type { SourceContext, LedgerEdge, ObservationRow } from '../src/site-adapters/ledger-types.js';
import { video } from './fixtures/site-adapters/bilibili.js';
const hint: MembershipHint = { interactionId: 'interaction', itemId: video.id, added: ['101'], removed: [], code: 0 };
type Command = Extract<HostCommand, { operation: 'readMemberships' | 'resolveItem' }>;
async function fixture(beforeCommit?: (tx: IDBTransaction) => void, authorizeOrigin?: (context: SourceContext, collectionIds: readonly string[]) => Promise<void>) {
  const db = createSourceDatabase(new IDBFactory()), ledger = createSourceLedger(db, { beforeCommit });
  const a = await ledger.setAuthority({ enabled: true, installationGeneration: 1, sourceSessionGeneration: 1, accountId: '42', negativeReadback: false });
  const context: SourceContext = { connectionId: a.connectionId!, installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease' };
  await ledger.bindLease(context, Date.now() + 1000000);
  let time = Date.now(); const storage = new MemoryStorageArea(), sent: Command[] = [];
  const scheduler = () => createReadScheduler(storage, 'readQueue', () => time);
  const ports = { authorizeOrigin, source: async () => ({ context, expiresAt: time + 60000 }), send: (_: SourceContext, c: Command) => { sent.push(c); }, alarm: (_: number) => {} };
  const create = () => createConfirmationQueue(ledger, scheduler(), ports, () => time);
  const queue = create();
  const advance = (ms = 2000) => { time += ms; };
  const reply = (c: Command, result: unknown): AdapterMessage => ({ protocolVersion: 1, requestId: c.operation === 'readMemberships' ? c.readRequestId : c.resolutionId,
    leaseId: c.leaseId, capability: 'host-validated', ...(c.operation === 'readMemberships' ? { operation: 'membership.result', readSessionId: c.readSessionId, readRequestId: c.readRequestId }
      : { operation: 'item.result', resolutionId: c.resolutionId }), result }) as AdapterMessage;
  const membership = { status: 'ok', itemId: video.id, edges: [{ collectionId: '101', state: 'present', evidence: { kind: 'siteResponse', operation: 'ids.fresh' } }] };
  return { db, ledger, context, sent, queue, create, advance, reply, membership, storage };
}
test('durably accepts and deduplicates hints, then atomically records only observed positive membership', async () => {
  const f = await fixture(), accepted = await f.queue.enqueue(f.context, 'request', hint);
  expect(accepted.status).toBe('accepted');
  expect(await f.create().enqueue(f.context, 'request', hint)).toEqual({ ...accepted, status: 'duplicate' });
  expect(await f.queue.enqueue(f.context, 'request', { ...hint, code: 1 })).toMatchObject({ status: 'rejected', reason: 'conflict' });
  await f.queue.wake(); expect(f.sent[0]?.operation).toBe('readMemberships');
  expect(await f.queue.accept(f.context, f.reply(f.sent[0]!, f.membership))).toBe(true);
  await f.queue.wake(); expect(f.sent).toHaveLength(1); // persisted cooldown applies between stages
  f.advance(); await f.create().wake(); expect(f.sent[1]?.operation).toBe('resolveItem');
  await f.queue.accept(f.context, f.reply(f.sent[1]!, { status: 'resolved', item: video }));
  const status = await f.queue.status(); expect(status).toMatchObject({ pending: 0, last: { state: 'observed' } });
  const id = (status.last as { observationId: string }).observationId;
  expect(await f.db.read<ObservationRow>('observations', id)).toMatchObject({ cause: 'reconcile', observation: { type: 'membership.observed', memberships: { added: ['101'], removed: [] } } });
  expect(await f.db.read<LedgerEdge>('memberships', sourceKey(f.context.connectionId, video.id, '101'))).toMatchObject({ state: 'present' });
  expect(await f.queue.accept(f.context, f.reply(f.sent[1]!, { status: 'resolved', item: video }))).toBe(false);
  await f.db.close();
});
test('community confirmation preserves its grant provenance and stops before the next read after revocation', async () => {
  let permitted = true;
  const f = await fixture(undefined, async () => { if (!permitted) throw new Error('revoked'); });
  f.context.communityOrigin = { installationId: 'i', generation: 2, scopeDigest: 'scope', packageDigest: 'bytes' };
  await f.queue.enqueue(f.context, 'community-request', hint); await f.queue.wake();
  await f.queue.accept(f.context, f.reply(f.sent[0]!, f.membership)); f.advance(); await f.queue.wake();
  await f.queue.accept(f.context, f.reply(f.sent[1]!, { status: 'resolved', item: video }));
  const id = (await f.queue.status()).last as { observationId: string };
  expect(await f.db.read<ObservationRow>('observations', id.observationId)).toMatchObject({ context: { communityOrigin: f.context.communityOrigin } });
  await f.queue.enqueue(f.context, 'community-later', hint); f.advance(); await f.queue.wake(); const reads = f.sent.length;
  permitted = false; f.advance(); await f.queue.wake();
  expect(f.sent).toHaveLength(reads); expect((await f.queue.status()).last).toMatchObject({ reason: 'communityArchiveRevoked' }); await f.db.close();
});
test('failed writes, removal-only hints and unknown readback create no positive or negative fact', async () => {
  const f = await fixture();
  await f.queue.enqueue(f.context, 'failed', { ...hint, code: -101 }); await f.queue.enqueue(f.context, 'remove', { ...hint, added: [], removed: ['101'] });
  await f.queue.wake(); expect(f.sent).toHaveLength(0);
  await f.queue.enqueue(f.context, 'unknown', hint); await f.queue.wake();
  await f.queue.accept(f.context, f.reply(f.sent[0]!, { ...f.membership, edges: [{ collectionId: '101', state: 'unknown', reason: 'ambiguousState' }] }));
  expect(await f.queue.status()).toMatchObject({ pending: 1 });
  for (let attempt = 0; attempt < 2; attempt++) { f.advance(); await f.queue.wake();
    await f.queue.accept(f.context, f.reply(f.sent.at(-1)!, { ...f.membership, edges: [{ collectionId: '101', state: 'unknown', reason: 'ambiguousState' }] })); }
  expect(await f.queue.status()).toMatchObject({ pending: 0, last: { state: 'uncertain', reason: 'membershipUncertain' } });
  expect(await f.db.read('memberships', sourceKey(f.context.connectionId, video.id, '101'))).toBeUndefined(); await f.db.close();
});
test('restart retains issued commands and cooldown; expired commands get bounded new read identities', async () => {
  const f = await fixture(); await f.queue.enqueue(f.context, 'request', hint); await f.queue.wake();
  await f.create().wake(); expect(f.sent).toHaveLength(1);
  f.advance(40000); await f.create().wake(); expect(f.sent).toHaveLength(2);
  expect(f.sent[1]).not.toEqual(f.sent[0]);
  expect(await f.queue.accept(f.context, f.reply(f.sent[0]!, f.membership))).toBe(false);
  f.advance(40000); await f.create().wake(); f.advance(40000); await f.create().wake();
  expect(f.sent).toHaveLength(3); expect(await f.queue.status()).toMatchObject({ pending: 0, last: { state: 'uncertain', reason: 'pageUnavailable' } }); await f.db.close();
});
test('challenge pauses automatic confirmation until an explicit retry; stale accounts and leases cannot settle it', async () => {
  const f = await fixture(); await f.queue.enqueue(f.context, 'request', hint); await f.queue.wake();
  expect(await f.queue.accept({ ...f.context, leaseId: 'forged' }, f.reply(f.sent[0]!, f.membership))).toBe(false);
  await f.queue.accept(f.context, f.reply(f.sent[0]!, { status: 'failed', error: { code: 'challenge' } }));
  expect(await f.create().enqueue(f.context, 'another', hint)).toMatchObject({ status: 'rejected', reason: 'paused' });
  await f.queue.retry(); expect(await f.queue.status()).toMatchObject({ paused: null, pending: 1 });
  f.advance(); await f.queue.wake(); expect(f.sent).toHaveLength(2); expect(f.sent[1]).not.toEqual(f.sent[0]);
  await f.ledger.setAuthority({ enabled: false, installationGeneration: 2, sourceSessionGeneration: 1, accountId: '42', negativeReadback: false });
  await expect(f.queue.enqueue(f.context, 'stale', hint)).rejects.toThrow('staleContext'); await f.db.close();
});
test('hint capacity is explicit and never evicts pending observations', async () => {
  const f = await fixture(); for (let i = 0; i < 16; i++) expect((await f.queue.enqueue(f.context, `request-${i}`, hint)).status).toBe('accepted');
  expect(await f.queue.enqueue(f.context, 'overflow', hint)).toMatchObject({ status: 'rejected', reason: 'capacity' });
  expect((await f.queue.status()).pending).toBe(16); await f.db.close();
});

test('confirmation completion and source facts roll back together before acknowledgment', async () => {
  const f = await fixture(tx => tx.abort());
  await f.queue.enqueue(f.context, 'request', hint); await f.queue.wake();
  await f.queue.accept(f.context, f.reply(f.sent[0]!, f.membership)); f.advance(); await f.queue.wake();
  await f.queue.accept(f.context, f.reply(f.sent[1]!, { status: 'resolved', item: video }));
  expect(await f.db.read('meta', 'ordinal')).toBeUndefined();
  expect(await f.queue.status()).toMatchObject({ last: { state: 'uncertain', observationId: null } });
  expect(await f.db.read('memberships', sourceKey(f.context.connectionId, video.id, '101'))).toBeUndefined(); await f.db.close();
});
test('the hint boundary is closed, bounded and registry-specific', () => {
  expect(validMembershipHint(hint)).toBe(true);
  for (const value of [{ ...hint, csrf: 'private' }, { ...hint, code: Infinity }, { ...hint, added: ['101', '101'] },
    { ...hint, removed: ['101'] }, { ...hint, added: Array.from({ length: 65 }, (_, i) => String(i + 1)) }]) expect(validMembershipHint(value)).toBe(false);
  const message: AdapterMessage = { protocolVersion: 1, requestId: 'request', capability: 'private', leaseId: 'lease', operation: 'membership.hint', hint };
  expect(validAdapterMessage(message)).toBe(true); expect(validBilibiliMessage(message)).toBe(true);
  expect(validBilibiliMessage({ ...message, hint: { ...hint, itemId: 'foreign:1' } })).toBe(false);
});

test('transient read failures retry durably within the original hint budget', async () => {
  const f = await fixture();
  try {
    await f.queue.enqueue(f.context, 'network', hint); await f.queue.wake();
    await f.queue.accept(f.context, f.reply(f.sent[0]!, { status: 'failed', error: { code: 'network', retryAfterMs: 4000 } }));
    expect(await f.queue.status()).toMatchObject({ pending: 1, paused: null });
    f.advance(2000); await f.create().wake(); expect(f.sent).toHaveLength(1);
    f.advance(2500); await f.create().wake(); expect(f.sent).toHaveLength(2);
    await f.queue.accept(f.context, f.reply(f.sent[1]!, f.membership)); f.advance(); await f.queue.wake();
    await f.queue.accept(f.context, f.reply(f.sent[2]!, { status: 'resolved', item: video }));
    expect(await f.queue.status()).toMatchObject({ pending: 0, last: { state: 'observed' } });
  } finally { await f.db.close(); }
});
