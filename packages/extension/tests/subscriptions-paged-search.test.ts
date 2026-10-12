// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { LocalMapping } from '../src/bookmark-subscriptions/local-types.js';
import type { MappingListItem, MappingPage } from '../src/bookmark-subscriptions/contracts.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, ctx: undefined as unknown as MaintenanceContext }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({
  subscriptionContext: async () => state.ctx,
  maintenance: { belongs: (r: LocalMapping, s: MaintenanceContext['scope']) => r.scope.accountId === s.accountId && r.scope.serverOrigin === s.serverOrigin && r.scope.profileId === s.profileId },
  subscriptionNative: { read: async (id: string) => ({ id, title: 'Bar' }) }, wakeSubscriptions: vi.fn(),
}));
import { handleSubscriptionRequest } from '../src/bookmark-subscriptions/worker.js';
import { validateCommand } from '../src/bookmark-subscriptions/commands.js';
import { createSubscriptionList } from '../src/subscriptions-ui/list.js';
import { database, row, scope } from './bookmark-subscriptions-fixture.js';
let host: HTMLElement, dispose: (() => void) | undefined;
beforeEach(() => { state.db = database(); document.body.replaceChildren(); host = document.createElement('div'); document.body.append(host); vi.stubGlobal('chrome', {}); });
afterEach(async () => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); await state.db.close(); });
function mapping(title: string, sourceType: 'collection' | 'digest_series' = 'digest_series'): MappingListItem {
  const sourceRef = { sourceType, sourceId: title };
  return { ...row().mapping, mappingId: crypto.randomUUID(), sourceRef, availability: 'available',
    source: { ...sourceRef, title, owner: null, visibility: 'private', relations: ['shared'], sourceRole: 'viewer', openUrl: 'https://known.test/source', updatedAt: '2026-09-25', allowedMappingModes: ['readonly'] } };
}
function api(handler: (query: URLSearchParams) => MappingPage) {
  const queries: URLSearchParams[] = [];
  state.ctx = { scope, assertCurrent: async () => {}, client: { request: (async path => {
    const url = new URL(path, scope.serverOrigin); let data: unknown;
    if (url.pathname === '/me/bookmark-subscription-mappings') { queries.push(url.searchParams); data = handler(url.searchParams); }
    else if (url.pathname.endsWith('capabilities')) data = { protocolVersion: 1, contentEnabled: true };
    else data = { items: [], nextCursor: null };
    return { status: 200, etag: null, data };
  }) as MaintenanceContext['client']['request'] } };
  return queries;
}
function render(params: URLSearchParams, history: boolean) {
  const commands: SubscriptionCommand[] = [];
  const send: Send = async <T>(command: SubscriptionCommand) => { commands.push(command); return await handleSubscriptionRequest({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command }) as T; };
  dispose = createSubscriptionList(host, send, vi.fn(), params, history).dispose;
  return commands;
}

test.each([
  { history: false, devices: 'all_browsers' },
  { history: true, devices: 'this_browser' },
  { history: true, devices: 'all_browsers' },
])('search reaches matches beyond the unfiltered first page: %j', async ({ history, devices }) => {
  const candidates = [...Array.from({ length: 50 }, (_, i) => mapping('Unrelated ' + i)), mapping('Needle first'), mapping('Needle second'), mapping('Needle collection', 'collection')];
  let selected: MappingListItem[] = [];
  const queries = api(query => {
    if (query.has('cursor')) return { items: selected.slice(1), nextCursor: null };
    selected = candidates.filter(m => (!query.has('q') || m.source!.title.toLowerCase().includes(query.get('q')!.toLowerCase())) && (!query.has('sourceType') || m.sourceRef.sourceType === query.get('sourceType')));
    return { items: selected.slice(0, query.has('q') ? 1 : 50), nextCursor: 'filtered-next' };
  });
  const commands = render(new URLSearchParams({ devices, q: '  Needle  ', source: 'digest_series' }), history);
  await vi.waitFor(() => expect(host.querySelector('.subscription-rows')?.textContent).toContain('Needle first'));
  expect(commands[0]).toEqual({ kind: 'list', status: history ? 'detached' : 'live', scope: devices, q: 'Needle', sourceType: 'digest_series' });
  expect(Object.fromEntries(queries[0]!)).toEqual({ status: history ? 'detached' : 'live', limit: '50', q: 'Needle', sourceType: 'digest_series', ...(devices === 'this_browser' ? { profileId: scope.profileId } : {}) });
  // Editing an unsubmitted form must not change the filter bound into the next-page cursor.
  host.querySelector<HTMLInputElement>('input[type=search]')!.value = 'Unsubmitted edit';
  Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Next page')!.click();
  await vi.waitFor(() => expect(host.querySelector('.subscription-rows')?.textContent).toContain('Needle second'));
  expect(host.querySelector('.subscription-rows')?.textContent).not.toContain('Needle collection');
  expect(commands[1]).toEqual({ kind: 'list', cursor: 'filtered-next' });
  expect(Object.fromEntries(queries[1]!)).toEqual({ cursor: 'filtered-next' });
});

test('current-browser live search still loads all pages before local state filtering', async () => {
  const first = mapping('Unrelated'), last = mapping('Needle paused');
  await state.db.put('mappings', { ...row(), id: last.mappingId, mapping: last, state: 'paused', enabled: false });
  const queries = api(query => query.has('cursor') ? { items: [last], nextCursor: null } : { items: [first], nextCursor: 'local-next' });
  const commands = render(new URLSearchParams('q=Needle&source=digest_series&status=paused'), false);
  await vi.waitFor(() => expect(host.querySelector('.subscription-rows')?.textContent).toContain('Needle paused'));
  expect(host.querySelector('.subscription-rows')?.textContent).not.toContain('Unrelated');
  expect(commands).toEqual([{ kind: 'list', status: 'live', scope: 'this_browser' }, { kind: 'list', cursor: 'local-next' }]);
  expect(queries[0]!.has('q')).toBe(false); expect(queries[0]!.has('sourceType')).toBe(false);
});

test('list filters remain a closed validated command and continuation accepts only its cursor', () => {
  const valid = (command: unknown) => validateCommand({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command });
  expect(valid({ kind: 'list', scope: 'all_browsers', q: 'Needle', sourceType: 'digest_series' })).toBe(true);
  expect(valid({ kind: 'list', cursor: 'bound-cursor' })).toBe(true);
  for (const extra of [{ q: '' }, { q: '   ' }, { q: 1 }, { q: 'a'.repeat(101) }, { sourceType: 'unknown' }, { secret: 'field' }, { cursor: 'bound-cursor', q: 'changed' }, { cursor: 'bound-cursor', scope: 'all_browsers' }]) {
    expect(valid({ kind: 'list', ...extra }), JSON.stringify(extra)).toBe(false);
  }
});
