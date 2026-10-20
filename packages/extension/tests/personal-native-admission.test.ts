import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { subscriptionStore as db } from '../src/bookmark-subscriptions/store.js';
import { assertPersonalNativeAllowed, exclusionIds, isSubscriptionExcluded, personalBookmarks } from '../src/bookmark-subscriptions/guards.js';
import { nativeFixture, row, root, owned } from './bookmark-subscriptions-fixture.js';

let f: ReturnType<typeof nativeFixture>;
beforeEach(async () => {
  await db.close(); vi.stubGlobal('indexedDB', new IDBFactory()); f = nativeFixture();
  const subtree = (id: string): chrome.bookmarks.BookmarkTreeNode => ({ ...f.nodes.get(id)!,
    children: [...f.nodes.values()].filter(node => node.parentId === id).map(node => subtree(node.id)) });
  vi.stubGlobal('chrome', { bookmarks: { ...f.api, getSubTree: async (id: string) => [subtree(id)], removeTree: vi.fn() } });
});
afterEach(async () => { await db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('read-only ownership blocks direct and descendant edits with a current owner diagnostic', async () => {
  const mapping = { ...row(), rootNativeId: 'readonly', state: 'current' as const };
  f.nodes.set('readonly', { id: 'readonly', title: 'Source', parentId: 'bar' });
  f.nodes.set('nested', { id: 'nested', title: 'Nested', parentId: 'readonly' });
  await db.put('mappings', mapping); await db.put('nodes', owned(mapping, root, 'readonly'));
  for (const id of ['readonly', 'nested']) await expect(personalBookmarks.update(id, { title: 'must stay' })).rejects.toThrow('readonly_write_blocked');
  expect(f.calls).toEqual([]); expect((await db.all('diagnostics')).map(value => value.mappingId)).toEqual([mapping.id, mapping.id]);
  expect(f.nodes.get('nested')?.title).toBe('Nested');
});

test('recursive personal deletion cannot cross a quarantined descendant and does not acquire it', async () => {
  f.nodes.set('personal', { id: 'personal', title: 'Personal', parentId: 'bar' });
  f.nodes.set('deep', { id: 'deep', title: 'Deep', parentId: 'personal' });
  f.nodes.set('quarantine', { id: 'quarantine', title: 'Unknown receipt', parentId: 'deep' });
  await db.put('exclusions', { id: 'quarantine', nativeId: 'quarantine', reason: 'quarantine', accountId: 'account', serverOrigin: 'https://known.test' });
  await expect(personalBookmarks.removeTree('personal')).rejects.toThrow('readonly_write_blocked');
  expect(chrome.bookmarks.removeTree).not.toHaveBeenCalled(); expect(f.nodes.has('quarantine')).toBe(true);
  // A different, unowned subtree remains editable even when exclusions exist.
  f.nodes.set('other', { id: 'other', title: 'Other', parentId: 'bar' });
  await expect(personalBookmarks.move('other', { parentId: 'bar' })).resolves.toMatchObject({ id: 'other' });
});

test('quarantine without an owner still blocks a write, while a preserved copy is writable', async () => {
  for (const reason of ['quarantine', 'preserved'] as const) {
    f.nodes.set(reason, { id: reason, title: reason, parentId: 'bar' });
    await db.put('exclusions', { id: reason, nativeId: reason, reason, accountId: 'account', serverOrigin: 'https://known.test' });
  }
  await expect(personalBookmarks.update('quarantine', { title: 'unsafe' })).rejects.toThrow('readonly_write_blocked');
  await expect(personalBookmarks.update('preserved', { title: 'My copy' })).resolves.toMatchObject({ title: 'My copy' });
  expect(await exclusionIds()).toEqual(new Set(['quarantine', 'preserved']));
  expect(await exclusionIds(true)).toEqual(new Set(['quarantine']));
  expect(await db.all('diagnostics')).toEqual([]);
  await expect(assertPersonalNativeAllowed(undefined)).resolves.toBeUndefined();
});

test('an unreadable or cyclic native ancestor cannot turn subscription evidence into permission', async () => {
  await db.put('exclusions', { id: 'elsewhere', nativeId: 'elsewhere', reason: 'quarantine', accountId: 'account', serverOrigin: 'https://known.test' });
  await expect(isSubscriptionExcluded('missing')).resolves.toBe(false);
  vi.spyOn(chrome.bookmarks, 'get').mockRejectedValueOnce(new Error('Permission denied'));
  await expect(isSubscriptionExcluded('missing')).rejects.toThrow('Permission denied');
  f.nodes.set('loop', { id: 'loop', parentId: 'loop', title: 'Loop' });
  await expect(isSubscriptionExcluded('loop')).rejects.toThrow('subscription_ancestry_unproven');
  expect(f.calls).toEqual([]);
});
