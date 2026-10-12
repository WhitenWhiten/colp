// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { historyBadge, isAiPick, renderHistoryRow } from '../src/capture/history-row.js';
import type { LocalHistoryItem } from '../src/capture/local-history.js';
import { task } from './fixtures/capture.js';

beforeEach(() => { vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test${path}` } }); });
afterEach(() => { vi.unstubAllGlobals(); });

const item = (over: Partial<LocalHistoryItem>): LocalHistoryItem => ({ ...task, save: 'local-saved', classification: 'none', sync: 'local-only', ...over });
const context = (over: Partial<Parameters<typeof renderHistoryRow>[1]> = {}) => ({ timezone: 'UTC', selected: false, open: () => undefined, select: () => undefined, retry: async () => undefined, ...over });

test('a settled save says nothing about itself', () => {
  expect(historyBadge(item({}))).toBeUndefined();
});

test('a capture whose bookmark Undo removed reads as removed, not saved', () => {
  expect(historyBadge(item({ disposition: 'cancelled' }))?.label).toBe('Removed');
});

test('a cancelled capture that never saved keeps its own save wording and offers to resume', () => {
  expect(historyBadge(item({ disposition: 'cancelled', save: 'unsubmitted' }))).toMatchObject({ label: 'Not submitted', retry: 'resume' });
});

test('only the most serious problem is shown, and failures are not retryable from the row', () => {
  expect(historyBadge(item({ save: 'failed', sync: 'attention' }))).toEqual({ label: 'Not saved', tone: 'danger' });
  expect(historyBadge(item({ save: 'unknown', sync: 'attention' }))).toMatchObject({ label: 'Needs checking', tone: 'warning', retry: 'check' });
  expect(historyBadge(item({ sync: 'attention' }))).toEqual({ label: 'Sync needs attention', tone: 'warning' });
});

test('a row has one badge at most and the Retry action only beside a retryable problem', () => {
  const row = renderHistoryRow(item({ save: 'unknown', sync: 'attention', classification: 'failed' }), context());
  expect(row.querySelectorAll('.badge')).toHaveLength(1);
  expect(Array.from(row.querySelectorAll('.list-row-tail button')).map((b) => b.textContent)).toEqual(['Retry']);
  const quiet = renderHistoryRow(item({}), context());
  expect(quiet.querySelector('.badge')).toBeNull();
  expect(quiet.querySelector('.list-row-tail button')).toBeNull();
});

test('the retry action runs the row action once and does not open the entry', async () => {
  const calls: string[] = [];
  let opened = 0;
  const row = renderHistoryRow(item({ save: 'unknown' }), context({ open: () => { opened++; }, retry: async (kind) => { calls.push(kind); } }));
  row.querySelector<HTMLButtonElement>('.list-row-tail button')!.click();
  await Promise.resolve();
  expect(calls).toEqual(['check']);
  expect(opened).toBe(0);
  row.querySelector<HTMLElement>('.list-row-main')!.click();
  expect(opened).toBe(1);
});

test('the AI pick mark shows on an automatically placed save until the user overrules it', () => {
  const placed = item({ classification: 'applied', appliedRevision: 'r1', historyAutomaticApplied: true });
  expect(isAiPick(placed)).toBe(true);
  expect(renderHistoryRow(placed, context()).querySelector('.ai-pick')?.textContent).toBe('AI pick');
  expect(isAiPick({ ...placed, feedbackKind: 'correction_applied' })).toBe(false);
  expect(isAiPick({ ...placed, historyAutomaticApplied: false })).toBe(false);
});

test('a row shows domain, folder and time, and never raw ids or state codes', () => {
  const row = renderHistoryRow(item({ url: 'https://www.example.org/a', localLocation: { path: ['Bookmarks bar', 'Research'] } as never }), context());
  const meta = row.querySelector('.list-row-meta')?.textContent ?? '';
  expect(meta).toContain('example.org');
  expect(meta).toContain('Research');
  expect(row.textContent).not.toMatch(/undefined|local-saved|unsubmitted/u);
});
