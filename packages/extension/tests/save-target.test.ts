import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { FOLDER_DEFAULT_BINDING } from '../src/save-folder.js';
import { resolveInRangeSaveParent } from '../src/save-target.js';

afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

describe('in-range recent folder target', () => {
  test('keeps the device default after attaching an account collection', async () => {
    installLocal({ collectionId: 'device', folderNativeId: 'research' });
    const resolved = await resolveInRangeSaveParent({ collectionId: 'new-collection',
      mountNativeIds: ['bar'], getParent, folderExists });
    assert.deepEqual(resolved, { parentNativeId: 'research', source: 'default', inRange: true });
  });
  test('prefers the remembered in-range default over save-context', async () => {
    installLocal({ collectionId: 'col', folderNativeId: 'research' });
    const resolved = await resolveInRangeSaveParent({
      collectionId: 'col', mountNativeIds: ['bar'],
      getParent, folderExists,
    });
    assert.deepEqual(resolved, { parentNativeId: 'research', source: 'default', inRange: true });
  });

  test('keeps an explicitly chosen browser-only destination', async () => {
    installLocal({ collectionId: 'col', folderNativeId: 'scratch' });
    const resolved = await resolveInRangeSaveParent({
      collectionId: 'col', mountNativeIds: ['bar'],
      getParent, folderExists,
    });
    assert.deepEqual(resolved, { parentNativeId: 'scratch', source: 'default', inRange: false });
  });

  test('unknown mounts still use the remembered default (offline / restart)', async () => {
    installLocal({ collectionId: 'col', folderNativeId: 'research' });
    const resolved = await resolveInRangeSaveParent({
      collectionId: 'col', mountNativeIds: [],
      getParent, folderExists,
    });
    assert.deepEqual(resolved, { parentNativeId: 'research', source: 'default', inRange: false });
  });

  test('no chosen folder yields no automatic destination', async () => {
    installLocal(undefined);
    const fromContext = await resolveInRangeSaveParent({
      collectionId: 'col', mountNativeIds: ['bar'],
      getParent, folderExists,
    });
    assert.equal(fromContext, undefined);
    const missing = await resolveInRangeSaveParent({
      collectionId: 'col', mountNativeIds: ['bar'], getParent, folderExists,
    });
    assert.equal(missing, undefined);
  });

  test('deleted remembered folder does not become the target', async () => {
    installLocal({ collectionId: 'col', folderNativeId: 'gone' });
    const resolved = await resolveInRangeSaveParent({
      collectionId: 'col', mountNativeIds: ['bar'],
      getParent, folderExists,
    });
    assert.equal(resolved, undefined);
  });
});

function installLocal(binding: { collectionId: string; folderNativeId: string } | undefined): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string) {
          return keys === FOLDER_DEFAULT_BINDING && binding ? { [FOLDER_DEFAULT_BINDING]: binding } : {};
        },
      },
    },
  };
}

async function getParent(id: string): Promise<string | undefined> {
  return ({ research: 'bar', scratch: 'other', bar: '0', other: '0' } as Record<string, string>)[id];
}

async function folderExists(id: string): Promise<boolean> {
  return id !== 'gone';
}
