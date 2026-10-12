// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createSubscriptionList, rowBadge, type MappingRow } from '../src/subscriptions-ui/list.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';

const now = Date.now();
function mapping(n: number, title: string, state: string, over: Record<string, unknown> = {}, local: Record<string, unknown> = {}): MappingRow {
  return { mappingId: `00000000-0000-4000-8000-00000000000${n}`, subscriptionId: `sub-${n}`, generation: 'g1', status: 'active', createdAt: `2026-09-0${n}`, profileLabel: 'This browser',
    sourceRef: { sourceType: n % 2 ? 'digest_series' : 'collection', sourceId: `src-${n}` }, availability: 'available',
    source: { title, owner: { displayName: 'An author' }, openUrl: 'https://know-n.com/x' }, digestMode: null, editionLimit: null, checkIntervalMinutes: 15,
    local: { state, enabled: state !== 'paused', mountPath: ['Subscriptions', title], bookmarkCount: 12, lastCheckedAt: now - 300_000, ...local }, ...over } as unknown as MappingRow;
}
const page = (items: MappingRow[], over: Record<string, unknown> = {}) => ({ profileId: 'p', mappings: { items, nextCursor: null }, subscriptions: { items: [], nextCursor: null }, capabilities: { protocolVersion: 1, contentEnabled: true }, pendingExits: [], ...over });
let host: HTMLElement; const disposers: Array<() => void> = []; const navigate = vi.fn(); const sent: SubscriptionCommand[] = [];

function mount(response: unknown, params = new URLSearchParams(), history = false) {
  const send = (async (command: SubscriptionCommand) => { sent.push(command); return typeof response === 'function' ? (response as (c: SubscriptionCommand) => unknown)(command) : response; }) as Send;
  disposers.push(createSubscriptionList(host, send, navigate, params, history).dispose);
}
beforeEach(() => { document.body.replaceChildren(); host = document.createElement('div'); document.body.append(host); sent.length = 0; navigate.mockClear(); vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => p }, permissions: { request: vi.fn(async () => true) } }); });
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); vi.unstubAllGlobals(); });

test('a row is a tile, a title, a meta line and at most one badge and one action', async () => {
  mount(page([mapping(1, 'Rust Digest', 'retrying'), mapping(2, 'Reading list', 'paused'), mapping(3, 'Frontend Weekly', 'current')]));
  await vi.waitFor(() => expect(host.querySelectorAll('.sub-row')).toHaveLength(3));
  const rows = Array.from(host.querySelectorAll<HTMLElement>('.sub-row'));
  for (const row of rows) { expect(row.querySelectorAll('.badge').length).toBeLessThanOrEqual(1); expect(row.querySelectorAll('.list-row-tail > button, .list-row-tail > a').length).toBeLessThanOrEqual(2); }
  const byTitle = (title: string) => rows.find((row) => row.querySelector('.list-row-title')?.textContent === title)!;
  expect(byTitle('Rust Digest').querySelector('.badge')?.textContent).toBe('Can’t reach source');
  expect(byTitle('Rust Digest').querySelector<HTMLElement>('.badge')!.dataset.tone).toBe('danger');
  expect(Array.from(byTitle('Rust Digest').querySelectorAll('.list-row-tail button')).map((b) => b.textContent)).toEqual(['Retry']);
  expect(byTitle('Reading list').querySelector('.badge')?.textContent).toBe('Paused');
  expect(byTitle('Reading list').querySelector<HTMLElement>('.badge')!.dataset.tone).toBe('warning');
  expect(byTitle('Frontend Weekly').querySelector('.badge')).toBeNull();
  expect(byTitle('Frontend Weekly').querySelector('button[aria-label^="More actions"]')).not.toBeNull();
  expect(byTitle('Frontend Weekly').querySelector('.list-row-meta')?.textContent).toMatch(/12 bookmarks/u);
  expect(host.textContent).not.toMatch(/undefined|Folder ID|local_change/u);
});

test('the toolbar is a search field and Type, State and Browsers pills, and the view switch is In this browser | Removed', async () => {
  mount(page([mapping(1, 'Rust Digest', 'current')]));
  await vi.waitFor(() => expect(host.querySelectorAll('.sub-row')).toHaveLength(1));
  expect(Array.from(host.querySelectorAll('.select-pill')).map((pill) => pill.querySelector('span')!.textContent)).toEqual(['Source type: ', 'State: ', 'Browsers: ']);
  expect(Array.from(host.querySelectorAll('.view-switch a')).map((tab) => tab.textContent)).toEqual(['In this browser', 'Removed']);
  expect(host.querySelector('.view-switch a[aria-current="page"]')?.textContent).toBe('In this browser');
  const type = host.querySelector<HTMLSelectElement>('.select-pill select[aria-label="Source type"]')!;
  type.value = 'collection'; type.dispatchEvent(new Event('change'));
  expect(navigate).toHaveBeenCalledWith('#subscriptions/list?source=collection');
});

test('Add subscription is a primary action in the page head and goes to the wizard', async () => {
  document.body.insertAdjacentHTML('afterbegin', '<div data-subscriptions-actions></div>');
  mount(page([mapping(1, 'Rust Digest', 'current')]));
  await vi.waitFor(() => expect(document.querySelector('[data-subscriptions-actions] .btn-primary')).not.toBeNull());
  const add = document.querySelector<HTMLButtonElement>('[data-subscriptions-actions] .btn-primary')!;
  expect(add.textContent).toBe('Add subscription');
  add.click();
  expect(navigate).toHaveBeenCalledWith('#subscriptions/new');
  disposers.splice(0).forEach((dispose) => dispose());
  expect(document.querySelector('[data-subscriptions-actions] .btn-primary')).toBeNull();
});

test('with nothing followed the list is one empty card that offers to add', async () => {
  mount(page([]));
  await vi.waitFor(() => expect(host.querySelector('.empty')).not.toBeNull());
  expect(host.querySelector('.empty-title')?.textContent).toBe('No subscriptions yet');
  host.querySelector<HTMLButtonElement>('.empty .btn')!.click();
  expect(navigate).toHaveBeenCalledWith('#subscriptions/new');
});

test('filters that match nothing say so and offer to clear', async () => {
  mount(page([mapping(1, 'Rust Digest', 'current')]), new URLSearchParams('q=zzz'));
  await vi.waitFor(() => expect(host.querySelector('.empty-title')?.textContent).toBe('No subscription folders match these filters.'));
  host.querySelector<HTMLButtonElement>('.empty .btn')!.click();
  expect(navigate).toHaveBeenCalledWith('#subscriptions/list');
});

test('the row menu offers Update now and Manage, and Update now asks the worker for that folder', async () => {
  const item = mapping(2, 'Reading list', 'current');
  mount((command: SubscriptionCommand) => command.kind === 'refresh' ? {} : page([item]));
  await vi.waitFor(() => expect(host.querySelector('button[aria-label^="More actions"]')).not.toBeNull());
  host.querySelector<HTMLButtonElement>('button[aria-label^="More actions"]')!.click();
  expect(Array.from(document.querySelectorAll('.mgr-menu-item')).map((choice) => choice.textContent)).toEqual(['Update now', 'Manage']);
  document.querySelectorAll<HTMLButtonElement>('.mgr-menu-item')[0]!.click();
  await vi.waitFor(() => expect(sent).toContainEqual({ kind: 'refresh', mappingId: item.mappingId, expectedGeneration: 'g1' }));
});

test('a problem that needs the person is a Fix link to the subscription', async () => {
  mount(page([mapping(3, 'Design Weekly', 'local_change')]));
  await vi.waitFor(() => expect(host.querySelectorAll('.sub-row')).toHaveLength(1));
  const fix = host.querySelector<HTMLAnchorElement>('.list-row-tail a')!;
  expect(fix.textContent).toBe('Fix');
  expect(fix.getAttribute('href')).toContain('#subscriptions/detail?mapping=00000000-0000-4000-8000-000000000003');
  expect(host.querySelector('.badge')?.textContent).toBe('Changed in this browser');
});

test('a failed load is one alert with Retry; a missing account is a sign-in card', async () => {
  mount(() => { throw new Error('subscription_runtime_unavailable'); });
  await vi.waitFor(() => expect(host.querySelector('.inline-alert[data-tone="danger"]')).not.toBeNull());
  expect(host.querySelector('.inline-alert')?.textContent).toContain('Subscriptions are unavailable');
  expect(host.textContent).not.toMatch(/subscription_runtime_unavailable|undefined/u);
  disposers.splice(0).forEach((dispose) => dispose()); host.replaceChildren();
  mount(() => { throw new Error('sign_in_required'); });
  await vi.waitFor(() => expect(host.querySelector('.connect-card .empty')).not.toBeNull());
  expect(host.querySelector('.connect-card a')?.getAttribute('href')).toBe('#account');
});

test('removed subscriptions wear one neutral Removed badge and no actions', async () => {
  mount(page([{ ...mapping(4, 'Old newsletter', 'detached', { status: 'detached' }), local: null } as MappingRow]), new URLSearchParams(), true);
  await vi.waitFor(() => expect(host.querySelectorAll('.sub-row')).toHaveLength(1));
  expect(host.querySelector('.badge')?.textContent).toBe('Removed');
  expect(host.querySelector('.list-row-tail button, .list-row-tail a')).toBeNull();
  expect(rowBadge(mapping(1, 'x', 'current'), false)).toBeUndefined();
});
