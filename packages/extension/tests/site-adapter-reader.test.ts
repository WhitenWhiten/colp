import { test, expect } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { boundedJson, createPageHttp, operationUrl, retryAfter, type Operation } from '../src/site-adapters/bilibili/http.js';
import { BilibiliReader } from '../src/site-adapters/bilibili/reader.js';
import { fixtures } from './fixtures/site-adapters/bilibili.js';
const ctx = { signal: new AbortController().signal, deadlineAt: 30000 };
const read = (handler: (op: Operation) => unknown) => async (op: Operation) => handler(op);
function http(replies: (Response | Error)[]) {
  let time = 0, calls = 0;
  const api = createPageHttp({ now: () => time, sleep: async ms => { time += ms; }, fetch: async () => {
    const r = replies[calls++]; if (r instanceof Error) throw r; return r!;
  } });
  return { api, calls: () => calls, now: () => time };
}
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
test('bounded stream cancels before parsing overflow and rejects malformed JSON', async () => {
  await expect(boundedJson(new Response('x'.repeat(100)), 10)).rejects.toMatchObject({ failure: { code: 'capacity' } });
  await expect(boundedJson(new Response('<challenge>'))).rejects.toMatchObject({ failure: { code: 'invalidData' } });
});
test('fixed operation schemas reject arbitrary origins and oversized parameters', () => {
  expect(operationUrl({ kind: 'ids', collectionId: '101', page: 1 })).toBe('https://api.bilibili.com/x/v3/fav/resource/ids?media_id=101&pn=1&ps=1000');
  expect(() => operationUrl({ kind: 'collections', accountId: 'https://evil.test/' })).toThrow('invalidData');
  expect(() => operationUrl({ kind: 'details', ids: [{ id: '1', type: 12 }] })).toThrow('invalidData');
});
test('412, business -412, auth loss and 200 business failures never become success', async () => {
  for (const [r, code] of [[response({}, 412), 'challenge'], [response(fixtures.failure), 'challenge'], [response(fixtures.signedOut), 'signedOut'], [response({ code: -1 }), 'invalidData']] as const) {
    const h = http([r]); await expect(h.api({ kind: 'account' }, ctx)).rejects.toMatchObject({ failure: { code } }); expect(h.calls()).toBe(1);
  }
});
test('transient retries are paced and bounded; Retry-After is honored or paused', async () => {
  const h = http([new Error('offline'), response({}, 500), response(fixtures.nav)]);
  expect(await h.api({ kind: 'account' }, ctx)).toEqual(fixtures.nav.data); expect(h.calls()).toBe(3); expect(h.now()).toBeGreaterThanOrEqual(6000);
  const limited = http([response({}, 429, { 'Retry-After': '120' })]);
  await expect(limited.api({ kind: 'account' }, ctx)).rejects.toMatchObject({ failure: { code: 'rateLimited', retryAfterMs: 120000 } }); expect(limited.calls()).toBe(1);
  expect(retryAfter('bad', 0)).toBe(3000); expect(retryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 0)).toBe(5000);
  await expect(h.api({ kind: 'account' }, { ...ctx, deadlineAt: 1 })).rejects.toMatchObject({ failure: { code: 'timeout' } });
});
test('missing catalog is invalidData; catalog split is bounded and same-name IDs remain distinct', async () => {
  const bad = new BilibiliReader(read(() => fixtures.missingCatalog.data));
  await expect(bad.readCollectionsPage('42', null, ctx)).rejects.toThrow('invalidData');
  let serial = 0; const reader = new BilibiliReader(read(() => ({ list: Array.from({ length: 205 }, (_, i) => ({ id: i + 1, title: 'Same' })) })), () => String(++serial));
  const first = await reader.readCollectionsPage('42', null, ctx), second = await reader.readCollectionsPage('42', first.nextCursor, ctx);
  expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(100);
  expect(await reader.readCollectionsPage('42', first.nextCursor, ctx)).toEqual(second);
  expect((await reader.readCollectionsPage('42', second.nextCursor, ctx)).items).toHaveLength(5);
});
test('first SDK item page never preloads the collection; omitted and unsupported details stay partial', async () => {
  const calls: Operation[] = []; let seq = 0;
  const reader = new BilibiliReader(read(op => { calls.push(op); return op.kind === 'ids' ? fixtures.ids.data : fixtures.details.data; }), () => String(++seq));
  const first = await reader.readItemsPage('101', null, ctx);
  expect(calls.map(c => c.kind)).toEqual(['ids', 'details']); expect(first.items).toHaveLength(1);
  expect(first.omissions?.map(x => x.reason)).toEqual(['invalid', 'unsupported']); expect(first.coverage).toBe('partial');
  reader.clear(); await expect(reader.readItemsPage('101', first.nextCursor, ctx)).rejects.toThrow('staleCursor');
});
test('1000 API IDs split into SDK pages with detail batches at most 100 and exact cursor replay', async () => {
  const calls: Operation[] = []; let seq = 0;
  const reader = new BilibiliReader(read(op => {
    calls.push(op);
    if (op.kind === 'ids') return op.page === 1 ? Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, type: 2 })) : [];
    return op.kind === 'details' ? op.ids.map(x => ({ ...x, title: 'Video', attr: 0 })) : {};
  }), () => String(++seq));
  let page = await reader.readItemsPage('101', null, ctx); expect(page.items).toHaveLength(100);
  const cursor = page.nextCursor!; const second = await reader.readItemsPage('101', cursor, ctx);
  expect(await reader.readItemsPage('101', cursor, ctx)).toEqual(second);
  page = second; let count = 200;
  while (page.nextCursor) { page = await reader.readItemsPage('101', page.nextCursor, ctx); count += page.items.length; }
  expect(count).toBe(1000); expect(calls.filter(x => x.kind === 'ids')).toHaveLength(2);
  expect(calls.filter(x => x.kind === 'details')).toHaveLength(10);
});
test('duplicate-only API pages and omitted details cannot prove complete traversal', async () => {
  let seq = 0; const reader = new BilibiliReader(read(op => op.kind === 'ids' ? [{ id: 1, type: 2 }] : []), () => String(++seq));
  const first = await reader.readItemsPage('101', null, ctx); expect(first.coverage).toBe('partial'); expect(first.omissions?.[0]?.reason).toBe('missing');
  await expect(reader.readItemsPage('101', first.nextCursor, ctx)).rejects.toThrow('invalidData');
});
test('a failed continuation cannot advance the API page or consume its identities', async () => {
  const pages: number[] = []; let seq = 0, failDetails = true;
  const reader = new BilibiliReader(read(op => {
    if (op.kind === 'ids') { pages.push(op.page); return op.page < 3 ? [{ id: op.page, type: 2 }] : []; }
    if (op.kind === 'details') {
      if (op.ids[0]?.id === '2' && failDetails) { failDetails = false; throw new Error('interrupted'); }
      return op.ids.map(x => ({ ...x, title: 'Video', attr: 0 }));
    }
    return {};
  }), () => String(++seq));
  const first = await reader.readItemsPage('101', null, ctx);
  await expect(reader.readItemsPage('101', first.nextCursor, ctx)).rejects.toThrow('interrupted');
  const second = await reader.readItemsPage('101', first.nextCursor, ctx);
  expect(second.items.map(x => x.item.id)).toEqual(['video:av:2']);
  expect(pages).toEqual([1, 2, 2]);
  expect((await reader.readItemsPage('101', second.nextCursor, ctx)).nextCursor).toBeNull();
});
test('fresh scoped readback returns positive or unknown, never inferred absence; account mismatch stops', async () => {
  const reader = new BilibiliReader(read(op => op.kind === 'account' ? fixtures.nav.data : fixtures.ids.data));
  const present = await reader.readMemberships({ itemId: 'video:av:1', collectionIds: ['101'] }, ctx);
  expect(present).toMatchObject({ status: 'ok', edges: [{ state: 'present' }] });
  expect(await reader.readMemberships({ itemId: 'video:av:99', collectionIds: ['101'] }, ctx)).toMatchObject({ edges: [{ state: 'unknown' }] });
  await expect(reader.verifyAccount('43', ctx)).rejects.toThrow('signedOut');
});
test('durable scheduler prevents tabs/worker reconstruction from bypassing ownership or cooldown', async () => {
  let time = 1000; const storage = new MemoryStorageArea(); const queue = createReadScheduler(storage, 'queue', () => time);
  const one = { id: 'one', documentId: 'doc1', deadlineAt: 31000 }, two = { id: 'two', documentId: 'doc2', deadlineAt: 31000 };
  const results = await Promise.all([queue.acquire(one), queue.acquire(two)]); expect(results.map(x => x.status)).toEqual(['ready', 'paused']);
  const restarted = createReadScheduler(storage, 'queue', () => time);
  expect((await restarted.acquire(two)).status).toBe('paused');
  await queue.finish('wrong'); expect((await restarted.acquire(two)).status).toBe('paused');
  await queue.finish('one'); time += 1500; expect((await restarted.acquire(two)).status).toBe('ready');
});
test('confirmation reports fresh observed state, keeps failed or unproven hints uncertain', async () => {
  const { confirmHint } = await import('../src/site-adapters/bilibili/confirmation.js');
  let calls = 0;
  const reader = new BilibiliReader(read(op => { calls++; return op.kind === 'ids' ? fixtures.ids.data : fixtures.details.data; }));
  const hint = { interactionId: 'hint-1', itemId: 'video:av:1', added: ['101'], removed: [], code: 0 };
  expect(await confirmHint(reader, { ...hint, code: -1 }, ctx)).toMatchObject({ type: 'favorite.uncertain' }); expect(calls).toBe(0);
  expect(await confirmHint(reader, hint, ctx)).toMatchObject({ type: 'membership.observed', memberships: { added: ['101'], removed: [] } });
  expect(await confirmHint(reader, { ...hint, itemId: 'video:av:99' }, ctx)).toMatchObject({ type: 'favorite.uncertain' });
});

test('BV and parameterized av links resolve to one numeric identity using a matching fixed view response', async () => {
  const reader = new BilibiliReader(read(op => op.kind === 'video' ? fixtures.view.data : fixtures.details.data));
  const av = await reader.resolveItem('https://www.bilibili.com/video/av1?tracking=value', ctx);
  expect(await reader.resolveItem('https://www.bilibili.com/video/BV1xx411c7mD/?tracking=value', ctx)).toEqual(av);
  expect(operationUrl({ kind: 'video', bvid: 'BV1xx411c7mD' })).toBe('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD');
  expect(() => operationUrl({ kind: 'video', bvid: 'BV1xx411c7mD&url=evil' })).toThrow('invalidData');
  expect(await reader.resolveItem('https://b23.tv/unresolved', ctx)).toMatchObject({ status: 'unresolved', reason: 'unsupportedUrl' });
  for (const data of [{ aid: 1, bvid: 'BV1xx411c7mE', title: 'Other', state: 0 }, { aid: 9007199254740992, bvid: 'BV1xx411c7mD', title: 'Video', state: 0 },
    { aid: 1, bvid: 'BV1xx411c7mD', title: 'Video' }]) {
    expect(await new BilibiliReader(read(() => data)).resolveItem('https://www.bilibili.com/video/BV1xx411c7mD', ctx)).toMatchObject({ status: 'unresolved', reason: 'ambiguousIdentity' });
  }
});
