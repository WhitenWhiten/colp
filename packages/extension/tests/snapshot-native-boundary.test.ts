import { expect, test } from 'vitest';
import { BookmarkApiError, CHROME_BOOKMARK_NOT_FOUND } from '../src/bookmark-api-error.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { assertSnapshotNativeBoundary } from '../src/snapshot-native-boundary.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { snapshotNativeFixture } from './snapshot-native-authority-fixture.js';

type Fixture = Awaited<ReturnType<typeof snapshotNativeFixture>>;
async function check(f: Fixture, mapping = f.root, kind: 'create' | 'delete' = 'create') {
  const authority = await f.effects(); await authority.assertCurrent();
  return assertSnapshotNativeBoundary({ store: f.store, scope: f.scope, api: authority.api,
    mapping, kind, legacyRootNativeId: '1' });
}

test('each active mount uses its own native root, including a first verified virtual-root bind', async () => {
  const f = await snapshotNativeFixture();
  try {
    const second: MappingInput = { ...f.root, nativeId: '6', rootNativeId: '6', colpId: 'second', mountId: 'second-mount' };
    f.chrome.nodes.set('6', { id: '6', parentId: '0', title: 'Other selected root' });
    await f.store.putMountBinding(f.scope, { mountId: 'second-mount', nativeRootId: '6', remoteMountNodeId: 'second',
      customSourceKey: 'folder:6', boundaryVersion: '2', status: 'active', materialized: true });
    // An exact active binding proves a root before that root's mapping commits.
    await check(f, second);
    await f.store.putMapping(f.scope, { ...second, nativeId: 'recovery:second', rootNativeId: 'recovery:second' });
    await check(f, second);
    await f.store.putMapping(f.scope, second);
    await check(f, second); await check(f, f.root); await check(f, f.target, 'delete');
    // A detached neighbour does not revoke the first mount's authority.
    await detachScopeMount(f.store, f.scope, 'second-mount');
    await check(f, f.root);
    await expect(check(f, second)).rejects.toThrow('need_authority');
  } finally { f.close(); }
});

test.each(['private', 'managed'] as const)('checks ancestors above the selected mount itself (%s)', async boundary => {
  const f = await snapshotNativeFixture();
  try {
    await f.chrome.api.move('3', { parentId: '0', index: 0 });
    await f.chrome.api.move('1', { parentId: '3', index: 0 });
    if (boundary === 'managed') {
      // A different outer native ancestor is managed; the private folder stays
      // outside the ancestry, so the managed check is the reason for refusal.
      await f.chrome.api.move('1', { parentId: '0', index: 0 });
      Object.assign(f.chrome.nodes.get('0')!, { unmodifiable: 'managed' });
    }
    await expect(check(f)).rejects.toThrow('need_authority');
    await expect(check(f, f.target, 'delete')).rejects.toThrow('need_authority');
    expect(f.chrome.creates).toBe(0); expect(f.removals).toEqual([]);
  } finally { f.close(); }
});

test.each(['missing', 'virtual'] as const)('a private root with %s mapping cannot become public', async state => {
  const f = await snapshotNativeFixture();
  try {
    await f.store.deleteMapping(f.scope, '3');
    if (state === 'virtual') await f.store.putMapping(f.scope, { ...f.privateRoot, nativeId: 'recovery:private' });
    await expect(check(f)).rejects.toThrow('need_authority');
    expect(f.chrome.nodes.has('3')).toBe(true);
  } finally { f.close(); }
});

test.each(['permission_required', 'tree_unavailable', 'corrupt'] as const)(
  'an unavailable current root classification blocks native calls (%s)', async status => {
    const f = await snapshotNativeFixture();
    try {
      await f.store.setBrowserRootStatus(f.scope, status);
      await expect(check(f)).rejects.toThrow('need_authority');
      await expect(check(f, f.target, 'delete')).rejects.toThrow('need_authority');
    } finally { f.close(); }
  });

test.each(['missing-target', 'rebound-target', 'ordinary-virtual', 'root-alias', 'mount-root-delete'] as const)(
  'identity proof rejects %s instead of borrowing a selected root', async state => {
    const f = await snapshotNativeFixture();
    try {
      if (['missing-target', 'rebound-target', 'ordinary-virtual'].includes(state)) await f.store.deleteMapping(f.scope, '2');
      if (state === 'rebound-target') await f.store.putMapping(f.scope, { ...f.target, nativeId: '4' });
      if (state === 'ordinary-virtual') await f.store.putMapping(f.scope, { ...f.target, nativeId: 'recovery:target' });
      const mapping = state === 'mount-root-delete' ? f.root : state === 'root-alias'
        ? { ...f.root, colpId: 'not-the-bound-root' } : f.target;
      await expect(check(f, mapping, state === 'ordinary-virtual' || state === 'root-alias' ? 'create' : 'delete'))
        .rejects.toThrow('need_authority');
      expect(f.chrome.nodes.has('2')).toBe(true); expect(f.removals).toEqual([]);
    } finally { f.close(); }
  });

test.each(['permission_denied', 'managed_not_writable', 'other_failure', 'not_found'] as const)(
  'an unreadable native ancestor is never an absence proof (%s)', async failure => {
    const f = await snapshotNativeFixture();
    try {
      const get = f.chrome.api.get;
      f.chrome.api.get = async id => {
        if (id === '1') throw new BookmarkApiError(failure,
          failure === 'not_found' ? CHROME_BOOKMARK_NOT_FOUND : `native_${failure}`);
        return get(id);
      };
      await expect(check(f, f.target, 'delete')).rejects.toThrow(failure === 'not_found' ? 'need_authority' : `native_${failure}`);
      expect(f.chrome.nodes.has('2')).toBe(true); expect(f.removals).toEqual([]);
    } finally { f.close(); }
  });

test.each(['cycle', 'outside', 'bookmark-parent', 'wrong-identity'] as const)(
  'native ancestry cannot prove a %s target', async state => {
    const f = await snapshotNativeFixture();
    try {
      if (state === 'cycle') await f.chrome.api.move('1', { parentId: '2' });
      if (state === 'outside') await f.chrome.api.move('2', { parentId: '0' });
      if (state === 'wrong-identity') {
        const get = f.chrome.api.get;
        f.chrome.api.get = async id => (await get(id)).map(row => ({ ...row, id: 'wrong' }));
      }
      await expect(check(f, f.target, state === 'bookmark-parent' ? 'create' : 'delete')).rejects.toThrow('need_authority');
    } finally { f.close(); }
  });

test('a detach during native reads invalidates the earlier boundary proof', async () => {
  const f = await snapshotNativeFixture();
  try {
    f.ports.afterGet = async id => { if (id === '0') await detachScopeMount(f.store, f.scope, 'mount'); };
    await expect(check(f)).rejects.toThrow('need_authority');
    expect((await f.store.getMountBinding(f.scope, 'mount'))?.status).toBe('detached');
  } finally { f.close(); }
});

test('a changed boundary revision requires a new proof even when its final selection looks equal', async () => {
  const f = await snapshotNativeFixture();
  try {
    f.ports.afterGet = async id => {
      if (id !== '0') return;
      const { scopeKey: _key, ...mount } = (await f.store.getMountBinding(f.scope, 'mount'))!;
      await f.store.putMountBinding(f.scope, { ...mount, boundaryVersion: 'later-confirmation' });
    };
    await expect(check(f)).rejects.toThrow('need_authority');
  } finally { f.close(); }
});
