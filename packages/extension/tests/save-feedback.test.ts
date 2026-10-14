import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import {
  parseSaveFeedback, presentSaveFeedback, SAVE_FEEDBACK_BADGE, SAVE_FEEDBACK_CACHE,
  SAVE_FEEDBACK_CREATE_FAILED, SAVE_FEEDBACK_NO_FOLDER, SAVE_FEEDBACK_PERMISSION, saveFeedbackIsError,
  saveFeedbackMessage,
} from '../src/save-feedback.js';
import { SAVE_SAVED_TO_BROWSER } from '../src/save-status.js';
import { AUTOMATION_BADGE_KEY } from '../src/action-badge.js';

afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

describe('native save user-visible feedback', () => {
  test('permission copy is actionable and distinct from create failure', () => {
    assert.equal(saveFeedbackMessage('permission_required'), SAVE_FEEDBACK_PERMISSION);
    assert.equal(SAVE_FEEDBACK_PERMISSION, 'Allow bookmark access to save this page.');
    assert.equal(saveFeedbackMessage('create_failed'), SAVE_FEEDBACK_CREATE_FAILED);
    assert.equal(saveFeedbackMessage('saved'), SAVE_SAVED_TO_BROWSER);
    assert.equal(saveFeedbackMessage('no_folder'), SAVE_FEEDBACK_NO_FOLDER);
    assert.equal(saveFeedbackIsError('permission_required'), true);
    assert.equal(saveFeedbackIsError('saved'), false);
    assert.equal(saveFeedbackIsError('no_folder'), false);
  });

  test('rejects malformed or expired records', () => {
    const now = 10_000;
    assert.equal(parseSaveFeedback(undefined), undefined);
    assert.equal(parseSaveFeedback({ code: 'permission_required', message: 'x', entry: 'page' }), undefined);
    assert.equal(parseSaveFeedback({
      code: 'permission_required', message: SAVE_FEEDBACK_PERMISSION, entry: 'page', updatedAt: now - 6 * 60_000,
    }, now), undefined);
    assert.equal(parseSaveFeedback({
      code: 'permission_required', message: SAVE_FEEDBACK_PERMISSION, entry: 'page', updatedAt: now, nativeId: 1,
    }, now), undefined);
  });

  test('permission failure sets a badge without stealing focus to options', async () => {
    const opened: string[] = [];
    const badges: string[] = [];
    installChrome(opened, badges);
    await presentSaveFeedback({ code: 'permission_required', entry: 'page', now: 1 });
    assert.deepEqual(opened, []);
    assert.deepEqual(badges, [SAVE_FEEDBACK_BADGE]);
    const stored = await chrome.storage.local.get(SAVE_FEEDBACK_CACHE);
    assert.equal((stored[SAVE_FEEDBACK_CACHE] as { code: string }).code, 'permission_required');

    opened.length = 0; badges.length = 0;
    await presentSaveFeedback({ code: 'create_failed', entry: 'window', now: 2 });
    assert.deepEqual(opened, []);
    assert.deepEqual(badges, [SAVE_FEEDBACK_BADGE]);
  });
});

describe('the toolbar badge’s two owners', () => {
  test('a save without a problem gives the badge back to new automation results, never blanks it', async () => {
    const badges: string[] = [];
    installChrome([], badges);
    await presentSaveFeedback({ code: 'permission_required', entry: 'page', now: 1 });
    await chrome.storage.local.set({ [AUTOMATION_BADGE_KEY]: { text: '1', color: '#386695', title: '1 new digest.' } });
    await presentSaveFeedback({ code: 'saved', entry: 'page', now: 2 });
    assert.deepEqual(badges, [SAVE_FEEDBACK_BADGE, '1']);
    await chrome.storage.local.remove(AUTOMATION_BADGE_KEY);
    await presentSaveFeedback({ code: 'saved', entry: 'page', now: 3 });
    assert.deepEqual(badges, [SAVE_FEEDBACK_BADGE, '1', '']);
  });
});

function installChrome(opened: string[], badges: string[]): void {
  const local = new Map<string, unknown>();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string) { return local.has(keys) ? { [keys]: local.get(keys) } : {}; },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) local.set(key, value);
        },
        async remove(keys: string) { local.delete(keys); },
      },
    },
    action: {
      async setBadgeText(details: { text: string }) { badges.push(details.text); },
      async setBadgeBackgroundColor() { /* test double */ },
      async setTitle() { /* test double */ },
    },
    runtime: { async openOptionsPage() { opened.push('options'); } },
  };
}
