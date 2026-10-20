import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['update', 'move', 'delete'] as const)('ordinary Pull %s reaches the real wrapper in an unchanged scope', async kind => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage(kind); await applier.resume();
    expect(f.native.calls).toEqual([{ kind: kind === 'delete' ? 'delete' : kind, nativeId: '2' }]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});

test('ordinary Pull update preserves a local title authored during the real subscription admission', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('update');
    const injected = duringNativeAdmission(() => f.native.update('2', { title: 'Unflushed local title' }));
    await applier.resume().catch(() => undefined);
    expect(injected()).toBe(true);
    expect(f.native.getNode('2')?.title).toBe('Unflushed local title');
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.projection.revision).toBe('target-r1');
  } finally { f.close(); }
});

test('ordinary Pull move preserves a target moved into private during the real subscription admission', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('move');
    const injected = duringNativeAdmission(() => f.native.move('2', { parentId: '3', index: 0 }));
    await applier.resume().catch(() => undefined);
    expect(injected()).toBe(true);
    expect(f.native.getNode('2')?.parentId).toBe('3');
    expect(f.native.calls).toEqual([{ kind: 'move', nativeId: '2' }]);
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.parentNativeId).toBe('1');
  } finally { f.close(); }
});

test('ordinary Pull delete preserves a local title authored during the real subscription admission', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('delete');
    const injected = duringNativeAdmission(() => f.native.update('2', { title: 'Keep this local edit' }));
    await applier.resume().catch(() => undefined);
    expect(injected()).toBe(true);
    expect(f.native.getNode('2')?.title).toBe('Keep this local edit');
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect(await f.store.getMappingByColpId(f.scope, 'target')).not.toBeNull();
  } finally { f.close(); }
});
