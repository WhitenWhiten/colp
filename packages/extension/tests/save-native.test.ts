/**
 * Owner: KNS-08 (QA). Fixture: in-memory chrome.bookmarks/storage doubles.
 * Run: npx vitest run tests/save-native.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { fixture, mapping, scope } from './bookmark-event-queue-harness.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createBookmarkCreatePlacementStore } from '../src/bookmark-create-placement.js';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { SAVE_FEEDBACK_CACHE, SAVE_FEEDBACK_PERMISSION } from '../src/save-feedback.js';
import { NATIVE_SAVE_INGRESS } from '../src/save-entry.js';
import {
  clearNativeSaveInflight, nativeSaveIdentity, parseSaveAction, reuseNativeSave, runNativeSave,
  SAVE_ACTION_CACHE, SAVE_ACTION_TTL_MS, SAVE_PAGE_MENU_ID, SAVE_WINDOW_COMMAND, SAVE_WINDOW_MENU_ID,
} from '../src/save-native.js';
import { FOLDER_DEFAULT_BINDING as FOLDER_KEY } from '../src/save-folder.js';
import { SAVE_LAST_CACHE } from '../src/save-status.js';

const noopSidecar = { close() { /* test double */ }, put: async () => undefined } as never;

afterEach(() => {
  clearNativeSaveInflight();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('native save identity', () => {
  test('page identity is the URL; window identity is the sorted URL set', () => {
    assert.equal(nativeSaveIdentity('page', [{ title: 'A', url: 'https://a.test/' }]), 'page:https://a.test/');
    assert.equal(nativeSaveIdentity('window', [
      { title: 'B', url: 'https://b.test/' }, { title: 'A', url: 'https://a.test/' },
    ]), 'window:https://a.test/\nhttps://b.test/');
  });

  test('completed identity reuses only inside the TTL window', () => {
    const record = parseSaveAction({
      identity: 'page:https://a.test/', status: 'completed', nativeIds: ['bm-1'], updatedAt: 1_000,
    });
    assert.equal(reuseNativeSave(record, 'page:https://a.test/', 1_000 + SAVE_ACTION_TTL_MS - 1), 'completed');
    assert.equal(reuseNativeSave(record, 'page:https://a.test/', 1_000 + SAVE_ACTION_TTL_MS + 1), undefined);
    assert.equal(reuseNativeSave(record, 'page:https://other.test/', 1_001), undefined);
  });

  test('effective target and ordered URLs are part of a new native-save identity', () => {
    const pages = [{ title: 'A', url: 'https://a.test/' }, { title: 'B', url: 'https://b.test/' }];
    const top = nativeSaveIdentity('window', pages, 'folder-a', 'top');
    assert.notEqual(top, nativeSaveIdentity('window', pages, 'folder-a', 'bottom'));
    assert.notEqual(top, nativeSaveIdentity('window', pages, 'folder-b', 'top'));
    assert.notEqual(top, nativeSaveIdentity('window', [...pages].reverse(), 'folder-a', 'top'));
  });
});

describe('runNativeSave entries', () => {
  const entries = ['page', 'window'] as const;

  beforeEach(() => { clearNativeSaveInflight(); });

  for (const kind of entries) {
    describe(`${kind} entry`, () => {
      test('creates a native bookmark in the remembered in-range folder and does not enqueue', async () => {
        const env = installEnv({ kind, defaultFolder: 'research' });
        const result = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
        });
        assert.equal(NATIVE_SAVE_INGRESS, 'chrome.bookmarks.create');
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.reused, false);
        assert.equal(result.parentNativeId, 'research');
        assert.equal(result.localOnly, false);
        assert.equal(env.creates.length, kind === 'window' ? 2 : 1);
        assert.equal((env.creates[0] as { parentId?: string }).parentId, 'research');
        assert.equal(env.local.get(FOLDER_KEY)?.folderNativeId, 'research');
        assert.equal(typeof env.local.get(SAVE_LAST_CACHE)?.nativeId, 'string');
      });

      test('permission denied presents actionable feedback and does not create', async () => {
        const env = installEnv({ kind });
        const result = await runNativeSave({
          kind, hasPermission: false, mountNativeIds: ['bar'], sidecar: noopSidecar,
          bookmarks: env.bookmarks, queryTabs: env.queryTabs,
        });
        assert.deepEqual(result, { ok: false, error: 'permission_required' });
        assert.equal(env.creates.length, 0);
        assert.deepEqual(env.opened, []);
        assert.equal(env.local.get(SAVE_FEEDBACK_CACHE)?.code, 'permission_required');
        assert.equal(env.local.get(SAVE_FEEDBACK_CACHE)?.message, SAVE_FEEDBACK_PERMISSION);
      });

      test('an explicitly chosen browser-only folder stays the destination', async () => {
        const env = installEnv({ kind, defaultFolder: 'scratch' });
        const result = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
        });
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.localOnly, true);
        assert.equal((env.creates[0] as { parentId?: string }).parentId, 'scratch');
        assert.equal(env.local.get(FOLDER_KEY)?.folderNativeId, 'scratch');
      });

      test('with no explicit folder, saving asks for a destination and creates nothing', async () => {
        const env = installEnv({ kind });
        const result = await runNativeSave({ kind, hasPermission: true, collectionId: 'col', mountNativeIds: ['bar'],
          sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs });
        assert.deepEqual(result, { ok: false, error: 'folder_required' });
        assert.equal(env.creates.length, 0);
        assert.equal(env.local.get(SAVE_FEEDBACK_CACHE)?.code, 'folder_required');
      });

      test('duplicate click reuses the same native ids', async () => {
        const env = installEnv({ kind, defaultFolder: 'research' });
        const first = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
          now: () => 5_000,
        });
        const second = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
          now: () => 5_100,
        });
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        if (!first.ok || !second.ok) return;
        assert.equal(second.reused, true);
        assert.deepEqual(second.nativeIds, first.nativeIds);
        assert.equal(env.creates.length, kind === 'window' ? 2 : 1);
      });

      test('browser restart (session cleared) still native-creates', async () => {
        const env = installEnv({ kind, defaultFolder: 'research' });
        const first = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
          now: () => 1_000,
        });
        env.session.clear();
        clearNativeSaveInflight();
        const second = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
          now: () => 1_100,
        });
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        if (!second.ok) return;
        assert.equal(second.reused, false);
        assert.equal(env.creates.length, kind === 'window' ? 4 : 2);
        assert.equal(env.local.get(FOLDER_KEY)?.folderNativeId, 'research');
      });

      test('offline still native-creates into the remembered folder', async () => {
        const env = installEnv({ kind, defaultFolder: 'research' });
        const result = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: [], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
        });
        assert.equal(result.ok, true);
        assert.equal((env.creates[0] as { parentId?: string }).parentId, 'research');
      });

      test('unknown Chrome create failure stays pending and does not blindly recreate', async () => {
        const env = installEnv({ kind, defaultFolder: 'research', failCreate: true });
        const result = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
        });
        assert.deepEqual(result, { ok: false, error: 'create_failed' });
        assert.equal(env.local.get(SAVE_FEEDBACK_CACHE)?.code, 'create_failed');
        const pending = env.session.get(SAVE_ACTION_CACHE) as { status?: string; nativeIds?: string[] };
        assert.equal(pending.status, 'pending');
        assert.deepEqual(pending.nativeIds, []);
        const retry = await runNativeSave({
          kind, hasPermission: true, collectionId: 'col',
          mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
        });
        assert.deepEqual(retry, { ok: false, error: 'busy' });
      });
    });
  }

  test('favicon sidecar failure does not roll back the native row', async () => {
    const env = installEnv({ kind: 'page', defaultFolder: 'research' });
    const sidecar = { close() { /* test double */ }, put: async () => { throw new Error('sidecar'); } } as never;
    const result = await runNativeSave({
      kind: 'page', hasPermission: true, collectionId: 'col',
      mountNativeIds: ['bar'], sidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.nativeIds.length, 1);
    assert.equal(env.creates.length, 1);
  });

  test('partial window failure resumes the durable prefix without recreating it', async () => {
    const env = installEnv({ kind: 'window', defaultFolder: 'research', failAfter: 1 });
    const first = await runNativeSave({ kind: 'window', hasPermission: true, insertPosition: 'top', collectionId: 'col', mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs });
    assert.deepEqual(first, { ok: false, error: 'create_failed' });
    assert.equal(env.creates.length, 1);
    env.failAfter = undefined;
    const second = await runNativeSave({ kind: 'window', hasPermission: true, insertPosition: 'top', collectionId: 'col', mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs });
    assert.equal(second.ok, true);
    assert.equal(env.creates.length, 2);
    assert.equal((env.creates[0] as { index?: number }).index, 0);
    assert.equal((env.creates[1] as { index?: number }).index, 1);
  });

  test('a committed create with a lost result is recovered from native children without duplication', async () => {
    const env = installEnv({ kind: 'window', defaultFolder: 'research', commitThenThrowAt: 1 });
    const first = await runNativeSave({ kind: 'window', hasPermission: true, insertPosition: 'top', collectionId: 'col', mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks,
      queryTabs: env.queryTabs });
    assert.deepEqual(first, { ok: false, error: 'create_failed' });
    assert.equal(env.creates.length, 2);
    env.commitThenThrowAt = undefined;
    const recovered = await runNativeSave({ kind: 'window', hasPermission: true, insertPosition: 'top', collectionId: 'col', mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks,
      queryTabs: env.queryTabs });
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(env.creates.length, 2);
    assert.equal(recovered.nativeIds.length, 2);
  });

  test('a pending operation for another page cannot capture a new save click', async () => {
    const env = installEnv({ kind: 'page', defaultFolder: 'research' });
    env.session.set(SAVE_ACTION_CACHE, {
      identity: nativeSaveIdentity('page', [{ title: 'Old', url: 'https://old.example/' }], 'research', 'bottom'),
      status: 'pending', nativeIds: [], pages: [{ title: 'Old', url: 'https://old.example/' }], updatedAt: Date.now(),
    });
    const result = await runNativeSave({ kind: 'page', hasPermission: true, collectionId: 'col', mountNativeIds: ['bar'], sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs,
      insertPosition: 'bottom' });
    assert.deepEqual(result, { ok: false, error: 'busy' });
    assert.equal(env.creates.length, 0);
  });

  test('menu and command ids stay on the shared runner', () => {
    assert.equal(SAVE_PAGE_MENU_ID, 'known-save-page');
    assert.equal(SAVE_WINDOW_MENU_ID, 'known-save-window');
    assert.equal(SAVE_WINDOW_COMMAND, 'save-window-tabs');
  });
});

function installEnv(input: {
  readonly kind: 'page' | 'window';
  readonly defaultFolder?: 'research' | 'scratch';
  readonly failCreate?: boolean;
  readonly failAfter?: number;
  readonly commitThenThrowAt?: number;
  readonly afterCreated?: (node: { id: string; title: string; parentId?: string; index?: number;
    url?: string; dateAdded?: number }) => Promise<void>;
}) {
  const nodes = new Map<string, { id: string; title: string; parentId?: string; index?: number;
    url?: string; dateAdded?: number }>([
    ['0', { id: '0', title: 'root' }],
    ['bar', { id: 'bar', title: 'Bar', parentId: '0' }],
    ['research', { id: 'research', title: '研究资料', parentId: 'bar' }],
    ['other', { id: 'other', title: 'Other', parentId: '0' }],
    ['scratch', { id: 'scratch', title: '草稿', parentId: 'other' }],
  ]);
  const local = new Map<string, Record<string, unknown>>();
  const session = new Map<string, unknown>();
  const creates: unknown[] = [];
  const opened: string[] = [];
  let nextId = 200;
  let failAfter = input.failAfter;
  let commitThenThrowAt = input.commitThenThrowAt;
  let attempts = 0;
  const bookmarks = {
    async get(id: string) {
      const node = nodes.get(id);
      if (!node) throw new Error('not_found');
      return [node];
    },
    async getChildren(id: string) {
      return [...nodes.values()].filter((node) => node.parentId === id)
        .map((node, index) => ({ ...node, index: node.index ?? index }))
        .sort((left, right) => left.index - right.index);
    },
    async create(bookmark: { parentId?: string; index?: number; title?: string; url?: string }) {
      if (input.failCreate || (failAfter !== undefined && creates.length >= failAfter)) throw new Error('create_denied');
      const attempt = attempts++;
      creates.push(bookmark);
      const id = `bm-${nextId++}`;
      const siblings = [...nodes.values()].filter(node => node.parentId === bookmark.parentId)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const index = bookmark.index ?? siblings.length;
      if (index < 0 || index > siblings.length) throw new Error('invalid_index');
      siblings.forEach((node, offset) => { node.index = offset >= index ? offset + 1 : offset; });
      const node = { id, title: bookmark.title ?? '', parentId: bookmark.parentId, index,
        url: bookmark.url, dateAdded: Date.now() };
      nodes.set(id, node);
      await input.afterCreated?.(node);
      if (attempt === commitThenThrowAt) throw new Error('response_lost');
      return node;
    },
  };
  const tabs = input.kind === 'window'
    ? [{ title: 'One', url: 'https://one.example/a' }, { title: 'Two', url: 'https://two.example/b' }]
    : [{ title: 'Page', url: 'https://page.example/' }];
  if (input.defaultFolder) {
    local.set(FOLDER_KEY, { collectionId: 'col', folderNativeId: input.defaultFolder });
  }
  const area = (map: Map<string, unknown>) => ({
    async get(keys: string | string[] | null) {
      return Object.fromEntries((keys === null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys])
        .filter(key => map.has(key)).map(key => [key, structuredClone(map.get(key))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key); },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local as Map<string, unknown>), session: area(session) },
    bookmarks, tabs: { query: async () => tabs },
    action: {
      async setBadgeText() { /* test double */ },
      async setBadgeBackgroundColor() { /* test double */ },
      async setTitle() { /* test double */ },
    },
    runtime: { async openOptionsPage() { opened.push('options'); } },
    alarms: { create() { /* test double */ } },
  };
  return {
    bookmarks, queryTabs: async () => tabs, creates, local, session, opened,
    moveNative: (id: string, parentId: string) => { nodes.get(id)!.parentId = parentId; },
    removeNative: (id: string) => nodes.delete(id),
    set failAfter(value: number | undefined) { failAfter = value; },
    set commitThenThrowAt(value: number | undefined) { commitThenThrowAt = value; },
  };
}


for (const position of ['top', 'bottom'] as const) {
  test(`partial ${position} batch resumes its frozen placement after preference and folder changes`, async () => {
    const env = installEnv({ kind: 'window', defaultFolder: 'research', failAfter: 1 });
    const input = { kind: 'window' as const, hasPermission: true, collectionId: 'col', mountNativeIds: ['bar'], sidecar: noopSidecar,
      bookmarks: env.bookmarks, queryTabs: env.queryTabs };
    assert.equal((await runNativeSave({ ...input, insertPosition: position })).ok, false);
    env.failAfter = undefined;
    clearNativeSaveInflight(); // The durable record must also work in a fresh worker.
    env.local.set(FOLDER_KEY, { collectionId: 'col', folderNativeId: 'bar' });
    const retry = await runNativeSave({ ...input, insertPosition: position === 'top' ? 'bottom' : 'top' });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(env.creates.length, 2);
    assert.equal((env.creates[1] as { index?: number }).index, 1);
    assert.equal((env.creates[1] as { parentId?: string }).parentId, 'research');
    assert.equal((env.session.get(SAVE_ACTION_CACHE) as { insertPosition: string }).insertPosition, position);
  });
}

test('pending batch cannot be resumed in a different collection or a removed sync boundary', async () => {
  const env = installEnv({ kind: 'window', defaultFolder: 'research', failAfter: 1 });
  const input = { kind: 'window' as const, hasPermission: true, collectionId: 'col', insertPosition: 'top' as const, mountNativeIds: ['bar'], sidecar: noopSidecar,
    bookmarks: env.bookmarks, queryTabs: env.queryTabs };
  await runNativeSave(input);
  env.failAfter = undefined;
  const pending = structuredClone(env.session.get(SAVE_ACTION_CACHE));
  assert.deepEqual(await runNativeSave({ ...input, collectionId: 'other' }), { ok: false, error: 'busy' });
  assert.deepEqual(await runNativeSave({ ...input, mountNativeIds: ['other'] }), { ok: false, error: 'busy' });
  assert.equal(env.creates.length, 1);
  assert.deepEqual(env.session.get(SAVE_ACTION_CACHE), pending);
});

for (const position of ['top', 'bottom'] as const) {
  for (const mutation of ['insert', 'delete'] as const) {
    test(`partial ${position} batch preserves final native order after sibling ${mutation}`, async () => {
      const env = installEnv({ kind: 'window', defaultFolder: 'research' });
      const old = await env.bookmarks.create({ parentId: 'research', title: 'Old', url: 'https://old.test/' });
      env.failAfter = 2;
      const input = { kind: 'window' as const, hasPermission: true, collectionId: 'col', insertPosition: position, mountNativeIds: ['bar'], sidecar: noopSidecar,
        bookmarks: env.bookmarks, queryTabs: env.queryTabs };
      assert.equal((await runNativeSave(input)).ok, false);
      env.failAfter = undefined;
      if (mutation === 'insert') await env.bookmarks.create({ parentId: 'research', index: 0,
        title: 'Concurrent', url: 'https://concurrent.test/' });
      else env.removeNative(old.id);
      clearNativeSaveInflight();
      const result = await runNativeSave(input);
      assert.equal(result.ok, true);
      assert.deepEqual((await env.bookmarks.getChildren('research')).map(node => node.title),
        mutation === 'delete' ? ['One', 'Two']
          : position === 'top' ? ['Concurrent', 'One', 'Two', 'Old'] : ['Concurrent', 'Old', 'One', 'Two']);
      if (result.ok) assert.equal(new Set(result.nativeIds).size, 2);
    });
  }
}

test('a confirmed prefix moved into another folder requires review without further creation', async () => {
  const env = installEnv({ kind: 'window', defaultFolder: 'research', failAfter: 1 });
  const input = { kind: 'window' as const, hasPermission: true, collectionId: 'col', insertPosition: 'top' as const, mountNativeIds: ['bar'], sidecar: noopSidecar,
    bookmarks: env.bookmarks, queryTabs: env.queryTabs };
  await runNativeSave(input);
  const prior = parseSaveAction(env.session.get(SAVE_ACTION_CACHE))!;
  env.moveNative(prior.nativeIds[0]!, 'scratch');
  env.failAfter = undefined;
  assert.deepEqual(await runNativeSave(input), { ok: false, error: 'busy' });
  assert.equal(env.creates.length, 1);
  assert.match(String(env.local.get(SAVE_FEEDBACK_CACHE)?.message), /Review their location/u);
});


for (const removed of [false, true]) {
  test(`onCreated receipt recovers lost native result without duplication (removed=${removed})`, async () => {
    const { store } = await fixture(new IDBFactory(), { autoFlush: false });
    await store.configureBrowserRoots(scope, { discovered: [
      { nativeId: 'bar', ancestorNativeIds: [] }, { nativeId: 'research', ancestorNativeIds: ['bar'] },
    ], selectedNativeIds: ['bar'], privateNativeIds: [], status: 'ready' });
    await mapping(store, 'research', 'research-colp', 'bar', 'r1', { title: 'Research' }, 'bar');
    let queue!: ReturnType<typeof createBookmarkEventQueue>;
    const env = installEnv({ kind: 'window', defaultFolder: 'research', commitThenThrowAt: 1,
      afterCreated: async node => { assert.equal((await queue.created(node.id, node)).outcome, 'staged'); } });
    const placements = createBookmarkCreatePlacementStore();
    queue = createBookmarkEventQueue({ scope, store, api: env.bookmarks, autoFlush: false,
      resolveCreatePlacement: async (id, node) => placements.consumeForCreated({ ...node, id }),
      completeCreatePlacement: placements.complete });
    const input = { kind: 'window' as const, hasPermission: true, collectionId: scope.collectionId,
      insertPosition: 'top' as const, mountNativeIds: ['bar'],
      sidecar: noopSidecar, bookmarks: env.bookmarks, queryTabs: env.queryTabs };
    assert.deepEqual(await runNativeSave(input), { ok: false, error: 'create_failed' });
    const pending = parseSaveAction(env.session.get(SAVE_ACTION_CACHE))!;
    assert.equal(await placements.get(pending.placementIntentId!), undefined);
    const receipt = await placements.getReceipt(pending.placementIntentId!);
    assert.ok(receipt?.nativeId);
    assert.equal((await store.listBookmarkEvents(scope)).length, 2);
    const [original] = await env.bookmarks.get(receipt.nativeId);
    if (removed) env.removeNative(receipt.nativeId);
    env.commitThenThrowAt = undefined;
    await env.bookmarks.create({ parentId: original!.parentId, index: original!.index,
      title: original!.title, url: original!.url });
    clearNativeSaveInflight();
    const retry = await runNativeSave(input);
    assert.equal(retry.ok, !removed, JSON.stringify(retry));
    if (retry.ok) assert.deepEqual(retry.nativeIds, [...pending.nativeIds, receipt.nativeId]);
    else assert.equal(retry.error, 'busy');
    assert.equal(env.creates.length, 3);
    assert.equal((await store.listBookmarkEvents(scope)).length, 3);
    store.close();
  });
}
