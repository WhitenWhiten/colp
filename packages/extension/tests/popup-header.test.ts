// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { readEnglishSource } from './english-source.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { bindOverflowMenu, paintAccountLabel } from '../src/popup-dom.js';
import { attentionFor, bindPopupHeader, paintAttention } from '../src/popup-header.js';
import type { PublicAuthState } from '../src/types.js';
import type { SyncStatusKind } from '../src/sync-status.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

function mountMenu(): { more: HTMLDetailsElement; summary: HTMLElement; item: HTMLButtonElement; outside: HTMLElement } {
  mountPopupShell();
  const more = byId<HTMLDetailsElement>('popup-more');
  bindOverflowMenu(more);
  more.querySelector<HTMLElement>('#clear-icon')!.hidden = false;
  more.hidden = false;
  return {
    more, summary: more.querySelector('summary')!, item: byId<HTMLButtonElement>('clear-icon'),
    outside: byId('open-options'),
  };
}

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

test('the overflow menu closes on a press outside it but not inside it', () => {
  const { more, item, outside } = mountMenu();
  more.open = true;
  item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(more.open).toBe(true);
  outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(more.open).toBe(false);
});

test('the overflow menu closes after a pick', () => {
  const { more, item } = mountMenu();
  more.open = true;
  item.click();
  expect(more.open).toBe(false);
});

test('Escape closes the overflow menu and returns focus to its summary', () => {
  const { more, summary, item } = mountMenu();
  more.open = true;
  item.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(more.open).toBe(false);
  expect(document.activeElement).toBe(summary);
});

test('the account monogram names who is signed in and the avatar button exists only for an account', () => {
  mountPopupShell();
  const host = byId('account-label');
  const button = byId('open-account');
  expect(button.hidden).toBe(true);
  paintAccountLabel(host, { status: 'connected', accountLabel: 'kai@example.com' } as unknown as PublicAuthState);
  expect(host.title).toBe('kai@example.com');
  expect(host.querySelector('.avatar')?.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('.avatar')?.textContent).toBe('K');
  expect(button.hidden).toBe(false);
  paintAccountLabel(host, { status: 'signed_out' } as unknown as PublicAuthState);
  expect(host.title).toBe('');
  expect(host.children).toHaveLength(0);
  expect(button.hidden).toBe(true);
});

test.each<[SyncStatusKind, PublicAuthState['status'], 'danger' | 'warning' | undefined]>([
  ['synced', 'connected', undefined],
  ['syncing', 'connected', undefined],
  ['setup-required', 'connected', undefined],
  ['paused', 'connected', undefined],
  ['saved-locally', 'connected', undefined],
  ['action-required', 'connected', 'danger'],
  ['review-conflicts', 'connected', 'danger'],
  ['retrying', 'connected', 'warning'],
  ['waiting-network', 'connected', 'warning'],
  ['syncing', 'connecting', undefined],
  ['signed-out', 'signed_out', undefined],
])('the avatar dot for "%s" while %s is %s', (kind, auth, expected) => {
  expect(attentionFor(kind, auth)).toBe(expected);
});

test('the dot is a data-attention attribute that only appears when sync needs the user', () => {
  mountPopupShell();
  const host = byId('account-label');
  paintAttention(host, 'danger');
  expect(host.getAttribute('data-attention')).toBe('danger');
  paintAttention(host, 'warning');
  expect(host.getAttribute('data-attention')).toBe('');
  paintAttention(host, undefined);
  expect(host.hasAttribute('data-attention')).toBe(false);
});

test('the avatar opens Account and the gear opens Options', () => {
  mountPopupShell();
  const create = vi.fn();
  const openOptionsPage = vi.fn();
  vi.stubGlobal('chrome', { tabs: { create }, runtime: { openOptionsPage, getURL: (path: string) => `chrome-extension://id/${path}` } });
  bindPopupHeader();
  byId('open-account').click();
  expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://id/options.html#account' });
  byId('open-options').click();
  expect(openOptionsPage).toHaveBeenCalledOnce();
});

test('the header has no sync chip: the wordmark is followed by the overflow, avatar and gear only', () => {
  mountPopupShell();
  expect(document.getElementById('sync-chip')).toBeNull();
  expect(document.querySelector('.sync-chip')).toBeNull();
  const actions = Array.from(document.querySelector('.pp-head-actions')!.children).map((node) => node.id);
  expect(actions).toEqual(['popup-more', 'open-account', 'open-options']);
});

test('header icon buttons are 32px targets', async () => {
  const css = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../popup.css'), 'utf8');
  expect(css).toMatch(/\.icon-btn \{[^}]*width: 2rem;[^}]*height: 2rem;/);
});

test('before first sync, the popup opens sync setup', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const popup = await readEnglishSource(resolve(here, '../src/popup.ts'));
  const note = await readEnglishSource(resolve(here, '../src/popup-dest-sync.ts'));
  expect(popup).toContain("currentAuthState?.status !== 'connected' ? 'none' : 'sync-off'");
  expect(note).toContain("chrome.runtime.getURL('options.html#sync/folders')");
  expect(popup).not.toContain('showCollectionHint');
});
