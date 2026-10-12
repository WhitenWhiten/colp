// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCaptureHistoryViews } from '../src/capture/history-view.js';
import type { HubRoute } from '../src/options-router.js';
import { task as base } from './fixtures/capture.js';

const day = 86_400_000;
// Midday, so "1 and 2 hours ago" stay on Today whatever time the suite runs. Only Date is faked; waitFor's timers stay real.
const at = new Date(2026, 5, 15, 12).getTime();
const entry = (n: number, over: Record<string, unknown> = {}) => ({ ...base, captureId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, title: `Page ${n}`, url: `https://site${n}.example.org/a`,
  save: 'local-saved', classification: 'none', sync: 'local-only', createdAt: at - n * 3_600_000, nativeId: `b${n}`, localLocation: { path: ['Bookmarks bar', 'Research'] }, ...over });
let items: unknown[];
let history: ReturnType<typeof vi.fn>;
const messages: Array<{ kind: string; [key: string]: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  document.body.innerHTML = '<section id="history-card"><header class="page-head"></header><div data-capture-controls></div>'
    + '<section data-capture-view="history"><div data-capture-content></div></section></section>';
  items = [entry(1), entry(2, { save: 'unknown' }), entry(30, { createdAt: at - 2 * day })];
  messages.length = 0;
  history = vi.fn(async () => ({ ok: true, items, remoteItems: [], next: null, unreported: 0, statistics: { updatedAt: at, counts: {}, days: [] } }));
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener() {} }, getURL: (path: string) => `chrome-extension://x${path}`,
    sendMessage: vi.fn(async (message: { kind: string }) => {
      messages.push(message);
      if (message.kind === 'known.capture.history') return history(message);
      if (message.kind === 'known.capture.get') return { ok: true, task: (items as Array<{ captureId: string }>).find((it) => it.captureId === (message as unknown as { captureId: string }).captureId) };
      if (message.kind === 'known.capture.cloudAvailable') return { available: false };
      if (message.kind === 'known.collections.list') return { ok: true, collections: [] };
      return { ok: true };
    }) } });
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); location.hash = ''; });

const route = (query = ''): HubRoute => ({ pane: 'history', view: 'default' as never, params: new URLSearchParams(query), hash: `#history${query ? `?${query}` : ''}` });
async function open(query = '') {
  const views = createCaptureHistoryViews(document.body);
  views.activate(route(query));
  await vi.waitFor(() => expect(document.querySelector('.hist-list')?.childElementCount).toBeGreaterThan(0));
  return views;
}

test('saves are grouped by day, one list-card per day, newest first', async () => {
  await open();
  const labels = Array.from(document.querySelectorAll('.day-label')).map((label) => label.textContent);
  expect(labels).toHaveLength(2);
  expect(labels[0]).toBe('Today');
  expect(document.querySelectorAll('.hist-list > .list-card')).toHaveLength(2);
  expect(document.querySelectorAll('.hist-row')).toHaveLength(3);
});

test('the toolbar is a search field and Status and Period pills, with the rest behind More filters', async () => {
  await open();
  const pills = Array.from(document.querySelectorAll('.hist-toolbar .select-pill')).map((pill) => `${pill.querySelector('span')!.textContent}${pill.querySelector('strong')!.textContent}`);
  expect(pills).toEqual(['Status: All', 'Period: 7 days']);
  expect(document.querySelector<HTMLElement>('.hist-more')!.hidden).toBe(true);
  document.querySelector<HTMLButtonElement>('.hist-toolbar button[aria-expanded]')!.click();
  expect(document.querySelector<HTMLElement>('.hist-more')!.hidden).toBe(false);
  expect(document.body.textContent).not.toMatch(/Apply filters|updated \d/u);
});

test('changing a filter applies at once by changing the route', async () => {
  await open();
  const status = document.querySelector<HTMLSelectElement>('.hist-toolbar select[aria-label="Status"]')!;
  status.value = 'attention'; status.dispatchEvent(new Event('change', { bubbles: true }));
  expect(location.hash).toContain('status=attention');
});

test('a row opens its entry by task id, keeping the filters', async () => {
  await open('days=30');
  document.querySelector<HTMLButtonElement>('.hist-title')!.click();
  expect(location.hash).toContain('task=00000000-0000-4000-8000-000000000001');
  expect(location.hash).toContain('days=30');
});

test('Retry on a row asks the worker once and then reloads the list', async () => {
  await open();
  const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('.hist-row .list-row-tail button')).find((button) => button.textContent === 'Retry')!;
  retry.click();
  await vi.waitFor(() => expect(messages.some((message) => message.kind === 'known.capture.check')).toBe(true));
  expect(messages.filter((message) => message.kind === 'known.capture.check')).toHaveLength(1);
  await vi.waitFor(() => expect(messages.filter((message) => message.kind === 'known.capture.history').length).toBeGreaterThan(1));
});

test('Select shows checkboxes and a bar that only checks results that need checking', async () => {
  await open();
  const select = Array.from(document.querySelectorAll<HTMLButtonElement>('.hist-toolbar button')).find((button) => button.textContent === 'Select')!;
  select.click();
  expect(document.querySelector<HTMLElement>('.hist-selection')!.hidden).toBe(false);
  expect(document.querySelectorAll('.hist-list > .list-card[data-selecting]')).toHaveLength(2);
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('.hist-row .mgr-select'));
  boxes[0]!.checked = true; boxes[0]!.dispatchEvent(new Event('change'));
  const check = document.querySelector<HTMLButtonElement>('.hist-selection .btn-secondary')!;
  expect(check.disabled).toBe(true);
  boxes[1]!.checked = true; boxes[1]!.dispatchEvent(new Event('change'));
  expect(check.disabled).toBe(false);
  check.click();
  await vi.waitFor(() => expect(messages.filter((message) => message.kind === 'known.capture.check')).toHaveLength(1));
});

test('opening an entry swaps the list for the detail and hides the page head', async () => {
  const views = createCaptureHistoryViews(document.body);
  views.activate(route('task=00000000-0000-4000-8000-000000000001'));
  await vi.waitFor(() => expect(document.querySelector('.hist-detail h1')?.textContent).toBe('Page 1'));
  expect(document.querySelector<HTMLElement>('.hist-listing')!.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>('#history-card')!.dataset.view).toBe('detail');
});

test('an empty history says so and a filtered one offers to clear the filters', async () => {
  items = [];
  await vi.waitFor(async () => { await open().catch(() => undefined); }).catch(() => undefined);
  expect(document.querySelector('.empty-title')?.textContent).toBe('Nothing saved yet');
  document.body.replaceChildren();
  document.body.innerHTML = '<section id="history-card"><header class="page-head"></header><div data-capture-controls></div><section data-capture-view="history"><div data-capture-content></div></section></section>';
  const views = createCaptureHistoryViews(document.body);
  views.activate(route('status=attention'));
  await vi.waitFor(() => expect(document.querySelector('.empty-title')?.textContent).toBe('Nothing matches these filters'));
  expect(document.querySelector('.empty .btn')?.textContent).toBe('Clear filters');
});

test('a failed load is one alert with Retry, never a bare line, and shows no stale Load more', async () => {
  history.mockResolvedValue({ ok: false });
  const views = createCaptureHistoryViews(document.body);
  views.activate(route());
  await vi.waitFor(() => expect(document.querySelector('.hist-failure .inline-alert')).not.toBeNull());
  expect(document.querySelector('.hist-failure .inline-alert')?.textContent).toContain('could not be loaded');
  expect(document.querySelector<HTMLElement>('.capture-load-more')!.hidden).toBe(true);
  history.mockResolvedValue({ ok: true, items, remoteItems: [], next: null, unreported: 0, statistics: { updatedAt: at, counts: {}, days: [] } });
  document.querySelector<HTMLButtonElement>('.hist-failure .btn')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll('.hist-row').length).toBeGreaterThan(0));
  expect(document.querySelector<HTMLElement>('.hist-failure')!.hidden).toBe(true);
});

test('leaving a save with unsaved edits parks them, and opening the same save again finds them where they were left', async () => {
  const views = await open();
  const id = '00000000-0000-4000-8000-000000000001';
  views.activate(route(`task=${id}`));
  await vi.waitFor(() => expect(document.querySelector('.hist-detail')).not.toBeNull());
  const detail = document.querySelector('.hist-detail')!;
  const draft = document.createElement('div'); draft.dataset.dirty = ''; detail.append(draft);
  views.activate(route());
  expect(document.querySelector('.hist-detail')).toBeNull();
  views.activate(route(`task=${id}`));
  await vi.waitFor(() => expect(document.querySelector('.hist-detail')).toBe(detail));
  expect(document.querySelector('[data-dirty]')).toBe(draft);
  // A clean detail is not kept: the next visit fetches a fresh one.
  draft.remove();
  views.activate(route());
  views.activate(route(`task=${id}`));
  await vi.waitFor(() => expect(document.querySelector('.hist-detail')).not.toBeNull());
  expect(document.querySelector('.hist-detail')).not.toBe(detail);
});
