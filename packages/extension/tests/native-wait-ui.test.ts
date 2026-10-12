import { parseHubRoute } from '../src/options-router.js';
/**
 * S1 / B0-1 (SR-01): options/popup contract for the native-wait exit.
 *
 * Same shape as `remote-delete-ui.test.ts`: pure copy/label functions plus a
 * readFile pin on the markup and the service-worker wiring.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import {
  NATIVE_WAIT_BIND_LABEL, NATIVE_WAIT_CANCEL_LABEL, NATIVE_WAIT_KEEP_LOCAL_LABEL, NATIVE_WAIT_LINK_LABEL,
  NATIVE_WAIT_NATIVE_ID_REQUIRED, NATIVE_WAIT_OPTIONS_PATH, isNativeWaitDeepLink, nativeWaitActionLabel,
  nativeWaitCandidateLabel, nativeWaitConfirmRequest, nativeWaitDetailCopy,
  nativeWaitFeedbackCopy, nativeWaitIntroCopy, nativeWaitReasonCopy, nativeWaitResultCopy,
  nativeWaitShortLabel, nativeWaitSummaryCopy, nativeWaitTargetCopy, nativeWaitTitleCopy,
} from '../src/native-wait-ui.js';
import { validNativeWaitRequest } from '../src/sw/messages.js';
import type { PublicNativeWait } from '../src/types.js';

const wait: PublicNativeWait = {
  waitRef: 'nwr:intent:cursor:3:42', intentId: 'intent:cursor', colpId: 'node-created-1',
  waitReason: 'native_result_unknown', candidates: [{ nativeId: 'bm-1', title: 'Remote' }],
  affectedRange: { parentNativeId: 'native-root' }, generation: 3,
};

describe('P1 native-wait Options contract', () => {
  test('states the blast radius and offers the three decisions', () => {
    const intro = nativeWaitIntroCopy();
    assert.match(intro, /incoming sync/i);
    assert.doesNotMatch(intro, /Pull\/Ack/);
    assert.match(intro, /uploads continue/i);
    assert.match(intro, /Don’t place/);
    assert.equal(nativeWaitSummaryCopy(1), '1 bookmark from Know-N needs your decision before it’s added here.');
    assert.equal(nativeWaitSummaryCopy(2), '2 bookmarks from Know-N need your decision before they’re added here.');
    // A row carries short words; the long sentences stay as the tooltip and accessible name.
    assert.deepEqual((['bind', 'keep_local_and_create', 'cancel'] as const).map(nativeWaitShortLabel), ['Use existing', 'Keep both', "Don't place"]);
    assert.equal(nativeWaitTitleCopy({ ...wait, title: 'GitHub', url: 'https://github.com/x' }), 'GitHub');
    assert.equal(nativeWaitTitleCopy({ ...wait, url: 'https://github.com/x' }), 'https://github.com/x');
    assert.equal(nativeWaitTitleCopy(wait), 'Bookmark waiting for confirmation');
    assert.equal(nativeWaitDetailCopy({ ...wait, title: 'GitHub', url: 'https://github.com/x' }),
      'github.com · This browser created the bookmark, but the result was not recorded');
    assert.equal(nativeWaitDetailCopy(wait), 'This browser created the bookmark, but the result was not recorded');
    assert.equal(nativeWaitActionLabel('bind'), NATIVE_WAIT_BIND_LABEL);
    assert.equal(nativeWaitActionLabel('keep_local_and_create'), NATIVE_WAIT_KEEP_LOCAL_LABEL);
    assert.equal(nativeWaitActionLabel('cancel'), NATIVE_WAIT_CANCEL_LABEL);
    assert.match(NATIVE_WAIT_BIND_LABEL, /Use a bookmark already on this device/);
    assert.match(NATIVE_WAIT_KEEP_LOCAL_LABEL, /Keep on this device and create a new one/);
    assert.match(NATIVE_WAIT_CANCEL_LABEL, /Don't place this cloud item on this device/);
    assert.match(NATIVE_WAIT_NATIVE_ID_REQUIRED, /bookmark/);
    assert.equal(nativeWaitReasonCopy('native_result_unknown'), 'This browser created the bookmark, but the result was not recorded');
    assert.equal(nativeWaitReasonCopy('waiting_dependency'), 'Waiting for the parent folder');
    assert.equal(nativeWaitTargetCopy(wait), 'Bookmark waiting for confirmation · This browser created the bookmark, but the result was not recorded');
    assert.equal(nativeWaitTargetCopy({ ...wait, colpId: '' }), 'Bookmark waiting for confirmation · This browser created the bookmark, but the result was not recorded');
    assert.equal(
      nativeWaitTargetCopy({ ...wait, title: 'GitHub', url: 'https://github.com' }),
      'GitHub (https://github.com) · This browser created the bookmark, but the result was not recorded',
    );
    assert.equal(nativeWaitCandidateLabel({ nativeId: 'bm-1', title: 'Remote' }), 'Remote');
    assert.equal(nativeWaitCandidateLabel({ nativeId: 'bm-1' }), 'Bookmark on this device');
    assert.match(nativeWaitResultCopy('bound'), /Bound to an existing bookmark/);
    assert.match(nativeWaitResultCopy('kept_local'), /Kept the local bookmark and created a new one/);
    assert.match(nativeWaitResultCopy('cancelled'), /Cancelled/);
    assert.match(nativeWaitResultCopy('duplicate'), /already handled/);
  });

  test('turns every refusal code into readable copy instead of a fake success', () => {
    for (const code of ['stale_ref', 'generation_mismatch', 'account_switch', 'detached', 'revoked',
      'permission_required', 'native_result_cas', 'intent_not_found', 'request_invalid', 'not_connected',
      'extension_unavailable']) {
      const copy = nativeWaitFeedbackCopy(code);
      assert.ok(copy.length > 0 && copy !== code, code);
      assert.doesNotMatch(copy, /Bound to|Kept the local|Cancelled:/, code);
    }
    assert.match(nativeWaitFeedbackCopy('stale_ref'), /changed/);
    assert.match(nativeWaitFeedbackCopy('revoked'), /Bookmark permission/);
    // An unknown or missing code still reads as a sentence: never a silent result, never the code itself.
    for (const code of ['native_wait_mystery', undefined as unknown as string]) {
      const copy = nativeWaitFeedbackCopy(code);
      assert.equal(copy, 'Could not complete this action. Try again.');
      assert.doesNotMatch(copy, /native_wait_mystery|undefined/);
    }
  });

  test('builds confirm messages the service worker whitelist accepts', () => {
    const bind = nativeWaitConfirmRequest(wait, 'bind', 'bm-1');
    assert.deepEqual(bind, {
      kind: 'known.nativeWait.confirm', userGesture: true, waitRef: wait.waitRef, intentId: wait.intentId,
      generation: 3, action: 'bind', nativeId: 'bm-1',
    });
    assert.equal(validNativeWaitRequest(bind), true);
    for (const action of ['keep_local_and_create', 'cancel'] as const) {
      const request = nativeWaitConfirmRequest(wait, action);
      assert.equal('nativeId' in request, false, action);
      assert.equal(validNativeWaitRequest(request), true, action);
    }
    // A bind with no id is refused by the UI and by the whitelist.
    const blindBind = nativeWaitConfirmRequest(wait, 'bind');
    assert.equal('nativeId' in blindBind, false);
    assert.equal(validNativeWaitRequest(blindBind), false);
    assert.equal(validNativeWaitRequest({ ...bind, userGesture: undefined }), false);
  });

  test('deep link points at the options card and stays whitespace-insensitive to the hash', () => {
    assert.equal(NATIVE_WAIT_OPTIONS_PATH, 'options.html#native-wait-settings');
    assert.equal(isNativeWaitDeepLink('#native-wait-settings'), true);
    assert.equal(isNativeWaitDeepLink('native-wait-settings'), true);
    assert.equal(isNativeWaitDeepLink('#folders'), false);
    assert.equal(isNativeWaitDeepLink(''), false);
    assert.match(NATIVE_WAIT_LINK_LABEL, /waiting for confirmation/);
  });

  test('Options markup, service worker and popup keep the exit wired', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const ui = await readFile(resolve(root, 'src/native-wait-ui.ts'), 'utf8');
    const html = await readFile(resolve(root, 'options.html'), 'utf8');
    const css = await readFile(resolve(root, 'options.css'), 'utf8');
    const worker = await readFile(resolve(root, 'src/service-worker.ts'), 'utf8');
    const options = await readFile(resolve(root, 'src/options.ts'), 'utf8');
    const popup = await readFile(resolve(root, 'src/popup.ts'), 'utf8');
    const popupHtml = await readFile(resolve(root, 'popup.html'), 'utf8');

    assert.ok(html.indexOf('id="sync-card"') < html.indexOf('id="native-wait-settings"'),
      'the wait card lives inside the Sync center pane');
    assert.ok(html.indexOf('id="native-wait-settings"') < html.indexOf('id="import-card"'));
    assert.match(ui, /dataset\.pane === 'sync'/);
    for (const marker of ['id="native-wait-settings"', 'id="native-wait-intro"', 'id="sync-summary"',
      'id="native-wait-list"', 'id="native-wait-feedback"', 'id="native-wait-item"']) {
      assert.ok(html.includes(marker), marker);
    }
    assert.match(html, /id="native-wait-feedback"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.ok(html.includes(nativeWaitIntroCopy()), 'the documented blast radius is in the markup');
    // Two actions sit on the row; the third (and destructive) one lives in the ⋯ menu behind a confirmation.
    for (const action of ['bind', 'keep_local_and_create'] as const) {
      assert.ok(html.includes(`data-native-wait-action="${action}"`), action);
      assert.ok(html.includes(nativeWaitActionLabel(action)), action);
    }
    assert.equal(html.includes('data-native-wait-action="cancel"'), false);
    assert.match(ui, /nativeWaitActionLabel\('cancel'\), tone: 'danger'/);
    assert.match(css, /\.native-wait-settings\.native-wait-highlight/);

    assert.match(ui, /known\.nativeWait\.list/);
    assert.match(ui, /known\.nativeWait\.confirm/);
    assert.match(ui, /userGesture: true/);
    assert.match(ui, /nativeWaitConfirmRequest\(wait, action, nativeId\)/);
    // An empty bind target is refused with the documented copy, never silently.
    assert.match(ui, /NATIVE_WAIT_NATIVE_ID_REQUIRED\)/);
    assert.match(ui, /scrollIntoView/);
    assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|document\.write/);

    assert.match(worker, /validNativeWaitRequest\(message\)/);
    assert.match(worker, /handleNativeWaitRequest\(message, nativeWaitDeps\)/);
    assert.match(worker, /scope: currentSyncScope, store: syncState, permissionGranted: hasBookmarkPermission/);
    assert.match(worker, /scheduleSyncEngineWake\('manual'\)/);
    assert.match(options, /bindSecondarySettings\(\)/);
    assert.match(await readFile(new URL('../src/options-secondary-settings.ts',import.meta.url),'utf8'), /initializeSettingsSection\('native-wait-settings', bindNativeWaitSettings\)/);
    assert.match(options, /createOptionsRouter/);
    assert.equal(parseHubRoute('#native-wait-settings').pane, 'sync');

    assert.match(popupHtml, /id="open-native-wait"/);
    assert.ok(popupHtml.includes(NATIVE_WAIT_LINK_LABEL));
    assert.match(popup, /status\.status\.kind === 'action-required'/);
    // The deep link lives with the header's overflow menu.
    const header = await readFile(new URL('../src/popup-header.ts', import.meta.url), 'utf8');
    assert.match(header, /chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\(NATIVE_WAIT_OPTIONS_PATH\) \}\)/);
    assert.match(popup, /reflectNativeWaitLink/);
    // A park keeps the engine in `sleeping`, so the popup also asks the wait list.
    assert.match(popup, /known\.nativeWait\.list/);
    assert.match(popup, /probeNativeWait\(\)/);
  });

  test('cancel action requires secondary confirmation before executing (UX-16)', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const ui = await readFile(resolve(root, 'src/native-wait-ui.ts'), 'utf8');
    assert.match(ui, /showCancelConfirmation/);
    assert.match(ui, /native-wait-cancel-confirm/);
    assert.match(ui, /Keep item/);
  });
});
