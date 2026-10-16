import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import {
  canSaveNow, DEVICE_FOLDER_SCOPE, PERMISSION_NOTE, SAVE_BUTTON,
  localSaveCapable, saveButtonLabel,
} from '../src/popup-device-save.js';
import { parseFolderBinding } from '../src/save-folder.js';
import type { PublicAuthState, UiStatus } from '../src/types.js';

function state(status: UiStatus): PublicAuthState {
  return { status, environment: 'production', serverOrigin: 'https://known.example' };
}

describe('signed-out popup local saves (capture plan §12.4)', () => {
  test('every settled non-connected state keeps the local lane; transient auth does not', () => {
    for (const status of ['signed_out', 'offline', 'error', 'policy_blocked'] as const) {
      assert.equal(localSaveCapable(state(status)), true, status);
      assert.equal(canSaveNow(state(status), status), true, status);
    }
    for (const status of ['connecting', 'refreshing'] as const) {
      assert.equal(localSaveCapable(state(status)), false, status);
      assert.equal(canSaveNow(state(status), status), false, status);
    }
    assert.equal(localSaveCapable(state('connected')), false);
    assert.equal(localSaveCapable(undefined), false);
  });

  test('the submit gate accepts connected or an echoed local-capable state only', () => {
    assert.equal(canSaveNow(state('connected'), 'connected'), true);
    assert.equal(canSaveNow(state('signed_out'), 'connected'), true);
    assert.equal(canSaveNow(state('signed_out'), 'saving'), false);
    assert.equal(canSaveNow(state('signed_out'), 'connecting'), false);
    assert.equal(canSaveNow(undefined, 'signed_out'), false);
    assert.equal(canSaveNow(state('connected'), 'signed_out'), false);
  });

  test('the save button is one word in every lane instead of demanding sign-in', () => {
    assert.equal(SAVE_BUTTON, 'Save');
    for (const status of ['connected', 'signed_out', 'offline'] as const) assert.equal(saveButtonLabel(state(status)), 'Save');
    assert.equal(saveButtonLabel(undefined), 'Save');
    assert.equal(saveButtonLabel(state('connecting')), 'Sign in to save');
    assert.doesNotMatch(PERMISSION_NOTE, /sync/u);
  });

  test('the device folder scope round-trips and never bleeds into an account scope', () => {
    const binding = { collectionId: DEVICE_FOLDER_SCOPE, folderNativeId: '42' };
    assert.equal(parseFolderBinding(binding, DEVICE_FOLDER_SCOPE)?.folderNativeId, '42');
    assert.equal(parseFolderBinding(binding, 'collection-a'), undefined);
    assert.equal(parseFolderBinding({ collectionId: 'collection-a', folderNativeId: '9' }, DEVICE_FOLDER_SCOPE), undefined);
  });

  test('the worker resolve order prefers the remembered device folder for signed-out captures', async () => {
    const target = await readFile(new URL('../src/sw/capture-target.ts', import.meta.url), 'utf8');
    assert.match(target, /requestedId \?\? remembered\?\.folderNativeId/);
    const popup = await readFile(new URL('../src/popup.ts', import.meta.url), 'utf8');
    assert.match(popup, /deviceSave\.init\(snapshot\)/);
    assert.match(popup, /deviceSave\.init\(settled\)/);
    assert.match(popup, /folders\.commit\(collectionId \?\? DEVICE_FOLDER_SCOPE\)/);
    // The local lane never borrows a stale collection selection from the DOM.
    assert.match(popup, /status === 'connected' \? selectedCollection\(\) : undefined/);
  });
});
