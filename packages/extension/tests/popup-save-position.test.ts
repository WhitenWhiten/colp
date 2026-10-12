import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { bindPopupSavePosition } from '../src/popup-save-position.js';

afterEach(() => vi.unstubAllGlobals());

test('a restored draft position wins over a late account preference response', async () => {
  let resolvePreference!: (value: unknown) => void;
  const preference = new Promise((resolve) => { resolvePreference = resolve; });
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => preference } });
  const control = bindPopupSavePosition();
  const refreshing = control.refresh();
  control.restore('top');
  resolvePreference({ ok: true, preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: true },
    scope: 'account', source: 'server', revision: '1', etag: '"1"', pending: false, conflict: false });
  await refreshing;
  assert.equal(control.current(), 'top');
  assert.equal(control.draft(), 'top');
});


test('cached top initializes and saves while the remote refresh remains pending', async () => {
  let releaseLocal!: (value: unknown) => void;
  let releaseRemote!: (value: unknown) => void;
  const local = new Promise(resolve => { releaseLocal = resolve; });
  const remote = new Promise(resolve => { releaseRemote = resolve; });
  vi.stubGlobal('chrome', { runtime: { sendMessage: ({ kind }: { kind: string }) =>
    kind === 'known.bookmark.preferences.local' ? local : remote } });
  const control = bindPopupSavePosition();
  const refreshing = control.refresh();
  const saving = control.forSave();
  releaseLocal({ ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: true } });
  assert.equal(await saving, 'top');
  assert.equal(control.current(), 'top');
  releaseRemote({ ok: true, preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: true } });
  await refreshing;
  assert.equal(control.current(), 'bottom');
  assert.equal(await saving, 'top');
});

test('saving waits for the newest local read when initialization refreshes overlap', async () => {
  const releases: ((value: unknown) => void)[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: ({ kind }: { kind: string }) =>
    kind === 'known.bookmark.preferences.local'
      ? new Promise(resolve => { releases.push(resolve); }) : Promise.resolve(undefined) } });
  const control = bindPopupSavePosition();
  const first = control.refresh();
  const save = control.forSave();
  const second = control.refresh();
  releases[0]!({ ok: true, preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: true } });
  await first;
  releases[1]!({ ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: true } });
  assert.equal(await save, 'top');
  await second;
});
