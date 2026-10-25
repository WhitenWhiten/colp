// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bilibiliDefinition } from '../src/site-adapters/bilibili/definition.js';
import { createBilibiliAdapter } from '../src/site-adapters/bilibili/adapter.js';
import { startAdapterRuntime } from '../src/site-adapters/page-runtime.js';
import { validateAdapterImplementation } from '../src/site-adapters/registry-validation.js';
import type { AdapterMessage, SourcePage, SiteCollection } from '../src/site-adapters/contracts.js';
import { createPostsAdapter, postsDefinition, saved, post } from './fixtures/site-adapters/posts.js';
afterEach(() => { window.dispatchEvent(new Event('known-site-adapter-stop:bundled.bilibili')); window.dispatchEvent(new Event(`known-site-adapter-stop:${postsDefinition.adapterId}`)); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test('a DOM/post adapter emits confirmed events, replays immutable pages and disposes its SDK listeners', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000); vi.stubGlobal('location', { href: post.url });
  const listeners: ((raw: unknown) => void)[] = [], sent: AdapterMessage[] = [];
  const port = { onMessage: { addListener: (fn: (raw: unknown) => void) => listeners.push(fn) }, onDisconnect: { addListener: () => {} }, disconnect: () => {},
    postMessage: (message: AdapterMessage) => { sent.push(structuredClone(message)); if (message.operation === 'emit') for (const fn of listeners) fn({ operation: 'reply', requestId: message.requestId, reply: { status: 'accepted', receiptId: 'receipt' } }); } };
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (m: { kind: string }) => m.kind.endsWith('.activation') ? { status: 'ready', activationId: 'activation', deadlineAt: 11000 }
    : { status: 'ready', leaseId: 'lease', capability: 'secret', routeEpoch: 0, expiresAt: 61000, readerEpoch: 'epoch' }, connect: () => port } });
  const page: SourcePage<SiteCollection> = { items: [{ ...saved }], nextCursor: null, coverage: 'complete', consistency: 'bestEffort' };
  const adapter = createPostsAdapter(page); validateAdapterImplementation(postsDefinition, adapter);
  startAdapterRuntime(postsDefinition, () => adapter); await vi.advanceTimersByTimeAsync(0);
  expect(sent.some(m => m.operation === 'connect')).toBe(true);
  document.body.innerHTML = '<button data-favorite>Favorite</button>'; document.querySelector('button')!.click(); await vi.advanceTimersByTimeAsync(0);
  expect(sent.find(m => m.operation === 'emit')).toMatchObject({ data: { type: 'favorite.confirmed', item: { kind: 'post' }, confirmation: { kind: 'settledDom' } } });
  const command = { operation: 'readPage', leaseId: 'lease', readSessionId: 'run', pageRequestId: 'page', deadlineAt: 31000, query: { kind: 'collections', cursor: null } };
  for (const fn of listeners) fn(command); await vi.advanceTimersByTimeAsync(0);
  const original = sent.find(m => m.operation === 'page.result'); expect(original).toBeDefined();
  page.items[0]!.title = 'Changed by later DOM observation';
  for (const fn of listeners) fn(command); await vi.advanceTimersByTimeAsync(0);
  expect(sent.filter(m => m.operation === 'page.result').at(-1)).toEqual(original);
  const firstItems = { ...command, pageRequestId: 'items-first', query: { kind: 'items', collectionId: saved.id, cursor: null } };
  for (const fn of listeners) fn(firstItems); await vi.advanceTimersByTimeAsync(0);
  expect(sent.at(-1)).toMatchObject({ result: { page: { nextCursor: 'stable:next', items: [{ item: post }] } } });
  for (const fn of listeners) fn({ operation: 'renewLease', leaseId: 'lease' }); await vi.advanceTimersByTimeAsync(0);
  for (const fn of listeners) fn({ ...firstItems, pageRequestId: 'items-next', query: { ...firstItems.query, cursor: 'stable:next' } }); await vi.advanceTimersByTimeAsync(0);
  expect(sent.at(-1)).toMatchObject({ result: { page: { nextCursor: null, items: [] } } });
  window.dispatchEvent(new Event(`known-site-adapter-stop:${postsDefinition.adapterId}`)); await vi.advanceTimersByTimeAsync(0);
  document.querySelector('button')!.click(); expect(sent.filter(m => m.operation === 'emit')).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});

test('upgrading an old page runtime applies factory request policy to bootstrap and command-internal HTTP reads', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000); vi.stubGlobal('location', { href: 'https://www.bilibili.com/video/av1' });
  const calls: number[] = [], listeners: ((raw: unknown) => void)[] = [], sent: AdapterMessage[] = [];
  vi.stubGlobal('fetch', async (url: string) => { calls.push(Date.now()); return new Response(JSON.stringify({ code: 0,
    data: new URL(url).pathname.endsWith('/nav') ? { isLogin: true, mid: 42 } : { list: [] } })); });
  const port = { onMessage: { addListener: (fn: (raw: unknown) => void) => listeners.push(fn) }, onDisconnect: { addListener: () => {} }, disconnect: () => {}, postMessage: (m: AdapterMessage) => { sent.push(structuredClone(m)); } };
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (m: { kind: string }) => m.kind.endsWith('.activation') ? { status: 'ready', activationId: 'activation', deadlineAt: 11000 }
    : { status: 'ready', leaseId: 'lease', capability: 'secret', routeEpoch: 0, expiresAt: 61000, readerEpoch: 'epoch' }, connect: () => port } });
  const oldRestart = vi.fn(), slot = '__knownSiteAdapterV1:bundled.bilibili';
  vi.stubGlobal(slot, { version: 4, restart: oldRestart });
  window.addEventListener('known-site-adapter-stop:bundled.bilibili', () => { Reflect.deleteProperty(globalThis, slot); }, { once: true });
  startAdapterRuntime({ ...bilibiliDefinition, readPolicy: { spacingMs: 5000 } }, createBilibiliAdapter);
  expect(oldRestart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0); expect(sent.some(m => m.operation === 'connect')).toBe(true);
  for (const fn of listeners) fn({ operation: 'readPage', leaseId: 'lease', readSessionId: 'run', pageRequestId: 'page', deadlineAt: 31000, query: { kind: 'collections', cursor: null } });
  await vi.advanceTimersByTimeAsync(16000); expect(sent.some(m => m.operation === 'page.result')).toBe(true);
  expect(calls.slice(1).map((at, i) => at - calls[i]!)).toEqual([5000, 5000, 5000]);
});
