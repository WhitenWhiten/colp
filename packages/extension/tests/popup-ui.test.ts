import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readEnglishSource } from './english-source.js';
import { describe, test } from 'vitest';
import { isSavableUrl } from '../src/popup-dom.js';
import { syncTone } from '../src/sync-status.js';
import { renderGeneratedTokens, tokensSourcePath } from '../scripts/sync-tokens.mjs';

describe('extension popup capture UI', () => {
  test('declares a 380px popup with save, folder, tag and note controls', async () => {
    const html = await readEnglishSource(new URL('../popup.html', import.meta.url));
    for (const marker of ['tab-title', 'tab-url', 'tab-url-display', 'save', 'open-options', 'open-account', 'account-label',
      'pp-fields', 'dest-toggle', 'dest-current', 'dest-placeholder', 'dest-folder', 'dest-parent', 'dest-panel', 'dest-search',
      'folder-tree', 'folder-new', 'folder-new-open', 'folder-create', 'folder-new-name', 'folder-suggest', 'ai-mark',
      'tag-field', 'tag-text', 'tag-suggest', 'note-text', 'pp-note', 'capture-status', 'capture-alert', 'capture-progress',
      'permission-note', 'permission-grant', 'remove-bookmark', 'capture-done', 'capture-undo', 'capture-history',
      'open-bookmarks', 'save-tabs', 'clear-icon', 'open-native-wait', 'popup-more', 'permission-note-text', 'capture-boot']) {
      assert.match(html, new RegExp(`id="${marker}"`), marker);
    }
    // The old chrome is gone: no sync chip, no stacked Folder block, no saved-line, no feedback strip.
    for (const marker of ['sync-chip', 'sync-label', 'sync-dot', 'dest-row', 'dest-sync', 'save-status', 'saved-line', 'feedback',
      'classification-preview', 'classification-run', 'classification-choose', 'classification-cost', 'classification-tags',
      'classification-save-status', 'capture-result',
      // Save position lives in Options → Saving, not on the popup.
      'insert-position', 'insert-position-top', 'insert-position-bottom', 'collection-label', 'folder-toggle', 'folder-picker',
      'credits-summary', 'sync-attention', 'open-credits',
      // The popup never picks a collection: that rebinds the whole sync scope.
      'collection-select', 'dest-collection',
      // An out-of-range folder saves without a question; sync is passive status.
      'local-only-prompt', 'save-local-only', 'sync-this-folder']) {
      assert.doesNotMatch(html, new RegExp(`id="${marker}"`), marker);
    }
    assert.doesNotMatch(html, /name="bookmark-insert-position"/);
    assert.match(html, /Clear auto-captured icon/); // FO-04 clear consumer surface
    assert.match(html, /aria-label="Settings"/);
    assert.match(html, /width=380/);
    assert.match(html, /<button id="save" class="btn btn-primary btn-save"[^>]*>Save<\/button>/);
    // Unsigned capture is the popup surface; sign-in lives on the Account page.
    assert.doesNotMatch(html, /Not signed in — saves stay on this device/);
    assert.match(html, /id="folder-tree"[^>]*role="listbox"/);
    // Native-first: the destination reads as a folder, the way the browser's star dialog does.
    assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/gu, ''), /[Cc]ollection/);
    assert.match(html, /id="dest-panel"[^>]*hidden|hidden[^>]*id="dest-panel"/);
    assert.match(html, /aria-expanded="false"[^>]*aria-controls="dest-panel"/);
    assert.match(html, /<input[^>]*id="tab-url"|id="tab-url"[^>]*type="text"/);
    // The title is an auto-growing textarea, not an input.
    assert.match(html, /<textarea id="tab-title" class="pp-title"/);
    // R12-20: the web's drawn wordmark, not "Know-" text plus the mark.
    assert.match(html, /<img class="brand-wordmark" src="brand-wordmark\.svg" alt="Know-N"/);
    assert.doesNotMatch(html, /favicon\.svg|>Know-</);
    // Tags and note use the kit's fields and work without an account.
    assert.match(html, /id="tag-field" class="field-quiet tag-input"/);
    assert.match(html, /<textarea id="note-text" class="field-quiet"/);
    // Every field keeps a label: visible in the label column or hidden for the page block.
    assert.match(html, /<label class="pp-label" for="tag-text"/);
    assert.match(html, /<label class="pp-label" for="note-text"/);
    assert.match(html, /<label class="visually-hidden" for="tab-title"/);
    assert.match(html, /aria-labelledby="folder-label dest-current"/);
    // The footer carries quiet actions on the left and one primary on the right.
    assert.match(html, /<footer id="popup-foot" class="pp-foot"/);
    // Saving to the library is the only popup path: privacy boundaries live
    // in sync settings ("Stay local" folders), never as a per-save decision.
    assert.doesNotMatch(html, /id="private-toggle"/);
    assert.doesNotMatch(html, /Only in this browser/);
    assert.doesNotMatch(html, /match-badge/);
    assert.doesNotMatch(html, /<select\b/);
    assert.doesNotMatch(html, /innerHTML|demo timer/i);
  });

  test('the boot state is a skeleton in the page-block layout, not text', async () => {
    const html = await readEnglishSource(new URL('../popup.html', import.meta.url));
    const boot = /<div id="capture-boot"[\s\S]*?<\/div>/u.exec(html)![0];
    assert.match(boot, /class="pp-skeleton"/);
    assert.match(boot, /class="pp-tile"/);
    assert.match(boot, /pp-skeleton-lines/);
    // Screen readers still hear that something is loading.
    assert.match(boot, /visually-hidden[^>]*>Preparing bookmark capture…/);
    const css = await readFile(new URL('../popup.css', import.meta.url), 'utf8');
    assert.match(css, /\.pp-skeleton \.pp-tile \{[^}]*background: var\(--paper-2\)/);
    assert.match(css, /\.pp-skeleton-lines > span \{[^}]*background: var\(--paper-2\)/);
  });

  test('popup stylesheet is token-driven, reduced-motion safe, and sized for the toolbar', async () => {
    const css = await readFile(new URL('../popup.css', import.meta.url), 'utf8');
    assert.match(css, /@import url\("tokens\.generated\.css"\)/);
    // 380px wide, at most 600px tall, and only the body scrolls.
    assert.match(css, /html, body \{ width: 380px; margin: 0; \}/);
    assert.match(css, /body\.pp \{[^}]*max-height: 600px;[^}]*overflow: hidden/);
    assert.match(css, /\.pp-body \{[^}]*overflow-y: auto/);
    assert.match(css, /\.pp-foot \{[^}]*flex: none/);
    assert.match(css, /\.pp-head \{[^}]*flex: none/);
    assert.doesNotMatch(css, /\.collection-list/);
    assert.match(css, /text-overflow: ellipsis/);
    // The title grows with its text up to three lines, with no ink ring and a paper fill on hover and focus.
    assert.match(css, /\.pp-title \{[^}]*field-sizing: content;[^}]*max-height: calc\(3em \* var\(--leading-meta\)/);
    assert.match(css, /\.pp-title:hover \{ background: var\(--paper\); \}/);
    assert.match(css, /\.pp-title:focus, \.pp-title:focus-visible \{[^}]*outline: none;[^}]*box-shadow: none;[^}]*background: var\(--paper\)/);
    // The field rows keep a 3.25rem right-aligned label column.
    assert.match(css, /\.pp-fields \{[^}]*grid-template-columns: 3\.25rem minmax\(0, 1fr\)/);
    assert.match(css, /\.pp-label \{[^}]*text-align: right/);
    // Primary footer buttons are 2.125rem and hug their label; the popup has no full-width Save.
    assert.match(css, /\.pp-foot \.btn-primary, \.pp-foot \.btn-secondary \{ min-height: 2\.125rem;/);
    assert.doesNotMatch(css, /\.btn-save \{\s*width:\s*100%/);
    assert.doesNotMatch(css, /^\.btn-primary \{ width:\s*100%/m);
    // Focus ring is the shared double-ring recipe from chrome.css (D1);
    // popup.css carries no accent-outline specialization of its own.
    const chrome = await readFile(new URL('../chrome.css', import.meta.url), 'utf8');
    assert.match(chrome, /:focus-visible \{[^}]*outline:\s*1px solid var\(--ink\)/);
    assert.doesNotMatch(css, /outline:[^;]*var\(--accent\)/);
    assert.match(css, /prefers-reduced-motion/);
    // Only the check mark is drawn from a data URI; user-visible captions go through i18n, never CSS `content` strings.
    assert.equal((css.match(/data:image\/svg\+xml/gu) ?? []).length, 1);
    assert.doesNotMatch(css, /content: "[A-Za-z]/);
    // The folder pill is the folder control; the panel grows the popup instead of overlaying it.
    assert.match(css, /\.folder-panel \{[^}]*grid-column: 1 \/ -1;/);
    assert.doesNotMatch(css, /\.folder-panel \{[^}]*position: absolute/);
    assert.match(css, /#dest-current:has\(#dest-folder:not\(:empty\)\) #dest-placeholder \{ display: none; \}/);
    assert.match(css, /\.icon-btn\s*\{/);
    assert.match(css, /\.popup-more-menu\s*\{/);
    // The sync chip is gone for good; an attention dot on the avatar replaces it.
    assert.doesNotMatch(css, /\.sync-chip|\.status-dot/);
    assert.match(css, /\.pp-avatar-btn \.avatar \{/);
    assert.match(css, /\.pp-status \{/);
    // Only the folder list scrolls inside the panel; search and "New folder" stay pinned.
    assert.match(css, /\.folder-list \{[^}]*max-height: 13\.5rem;[^}]*overflow-y: auto/);
    // The selected folder carries a check, not an accent wash.
    assert.match(css, /\.folder-opt\[aria-selected="true"\]::after \{/);
    assert.doesNotMatch(css, /\.folder-opt\[aria-selected="true"\] \{[^}]*(background|--accent)/);
    // One note line, in the error tone only for errors.
    assert.match(css, /\.pp-note\[data-tone="error"\] \{ color: var\(--danger\); \}/);
    assert.doesNotMatch(css, /\.insert-position|\.credits-summary|\.sync-attention|\.folder-toggle|\.folder-picker|\.popup-meta/);
    // No blue or accent fills on surfaces, no italics, no all-caps labels.
    assert.doesNotMatch(css, /var\(--accent(?:-soft)?\)/);
    assert.doesNotMatch(css, /font-style:\s*italic|text-transform:\s*uppercase/);
  });

  test('popup script reads the active tab and never injects HTML', async () => {
    const source = [
      await readEnglishSource(new URL('../src/popup.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/popup-save-position.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/save-folder.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/save-folder-ui.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/popup-native-save.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/save-entry.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/save-native.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/save-feedback.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/clear-icon-ui.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/icon-policy-feedback.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/popup-device-save.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/popup-permission.ts', import.meta.url)),
      await readEnglishSource(new URL('../src/popup-shell.ts', import.meta.url)),
    ].join('\n');
    assert.match(source, /chrome\.tabs\.query/);
    assert.match(source, /savePagesThroughNativeIngress|saveBookmarkWithFaviconCapture/);
    // The worker verifies the existing binding; saving never changes it.
    assert.match(source, /known\.capture\.start/);
    assert.match(await readEnglishSource(new URL('../src/sw/capture.ts', import.meta.url)), /input\.collectionId !== scope\.collectionId/);
    // The save destination is resolved when the popup opens, so the folder
    // picker is available on the first save of a fresh install.
    assert.match(source, /primeSaveContext/);
    assert.match(source, /setAttribute\('role', 'option'\)/);
    assert.match(source, /paintFavicon/);
    assert.match(source, /urlInput\.value/);
    assert.match(source, /metaKey|ctrlKey/);
    assert.match(source, /COLLECTIONS_CACHE|known\.collections\.cache\.v1/);
    assert.match(source, /AUTH_SNAPSHOT|known\.auth\.snapshot\.v1/); // offline-first paint from cache
    assert.match(source, /SAVE_CONTEXT_CACHE|known\.sync\.save-context\.v1/); // offline save stays in the boundary
    assert.match(source, /known\.sync\.folder\.v1/); // remembered save folder (Edge-like target)
    // Unfinished edits survive the popup closing (session-scoped draft).
    assert.match(source, /readPopupDraft/);
    assert.match(source, /writePopupDraft/);
    assert.match(source, /clearPopupDraft/);
    // The popup reads the bound library; choosing one lives in Options › Sync.
    assert.doesNotMatch(source, /rememberCollection|renderCollectionList|collectionSelect/);
    assert.match(source, /createBoundCollection/);
    // First paint comes from chrome.storage; the worker round trip only reconciles afterwards.
    assert.match(source, /renderAuth\(snapshot\)[\s\S]*request\(\{ kind: 'known\.auth\.status' \}\)/);
    assert.doesNotMatch(source, /Loading collections|only syncs collections you own/);
    assert.match(source, /paintStatusLine\(\{ icon: 'check-circle', text: t\('popup_savedTo', 'Saved to \$1'/);
    assert.match(source, /ICON_POLICY_DISABLED_COPY|automatic icons are off/);
    assert.match(source, /ICON_POLICY_UNREACHABLE_COPY|the icon will sync when you are online/);
    assert.doesNotMatch(source, /已保存到浏览器/);
    assert.match(source, /SAVE_FEEDBACK_PERMISSION|Allow bookmark access to save this page/);
    assert.match(source, /presentSaveFeedback/);
    assert.match(source, /resolveInRangeSaveParent/);
    assert.match(source, /allowManualCapture/); // duplicate-save awareness
    // FO-04 clear consumer call site: the popup binds the action and sends the
    // clear message with the native bookmark id.
    assert.match(source, /bindClearIconAction/);
    assert.match(source, /known\.favicon\.clear/);
    assert.match(source, /Auto-captured icon cleared\./);
    // A pathological IndexedDB failure must never surface the save-error path:
    // the popup stubs the sidecar exactly like save-native so the save proceeds.
    assert.match(source, /savePopupNativePage/);
    assert.match(source, /known\.bookmark\.preferences\.get/);
    assert.match(source, /frozenInsertPosition/);
    assert.match(source, /requestVersion/);
    assert.match(source, /touched/);
    // Signed-out local saves (§12.4): the save lane closes only for transient
    // auth churn, never merely because no account is connected.
    assert.match(source, /localSaveCapable/);
    assert.match(source, /canSaveNow\(currentAuthState, document\.body\.dataset\.state\)/);
    assert.match(source, /paintSaveGate/);
    assert.match(source, /bindDeviceSave/);
    assert.match(source, /deviceSave\.init\(snapshot\)|deviceSave\.init\(settled\)/);
    assert.match(source, /DEVICE_FOLDER_SCOPE/);
    assert.match(source, /'device'/);
    // Signing in lives on the options page; the popup carries no sign-in form.
    assert.doesNotMatch(source, /signedOut|bindLoginForm|completeLogin/);
    assert.match(source, /savePopupNativePage\([\s\S]*?,\s*frozenInsertPosition, annotation[,)]/);
    assert.match(source, /put:\s*async\s*\(\)\s*=>\s*undefined/);
    const manifest = await readFile(new URL('../manifest.base.json', import.meta.url), 'utf8');
    assert.match(manifest, /"_execute_action"/);
    assert.match(manifest, /"default": "Alt\+S"/);
    assert.doesNotMatch(source, /matchScore|% match/); // no synthetic relevance theater
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
  });

  test('popup saved state offers Edit, then closes after a beat unless touched (UX-02)', async () => {
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    assert.match(source, /savedCloseTimer/);
    assert.match(source, /handleEditAfterSave/);
    assert.match(source, /if \(document\.body\.dataset\.state === 'saved'\) \{\s*\n?\s*restoreSave\(\);/);
    // R16-01: the saved-state button must not stay disabled — a greyed 'Edit'
    // reads (and was) dead although submit() already turns a click into restoreSave().
    assert.match(source, /save\.textContent = 'Edit'; save\.disabled = false;/);
    // No title selection on open: the page opens quiet, the title is not pre-selected.
    assert.doesNotMatch(source, /titleInput\.select\(\)|setSelectionRange/);
    assert.doesNotMatch(source, /titleInput\.focus\(\)/);
    assert.match(source, /classList\.replace\('btn-primary', 'btn-secondary'\)/);
    assert.match(source, /setFooterMode\('saved'\)/);
    // A rule that matched but could not act leaves its line up a little longer (AW-19).
    assert.match(source, /window\.setTimeout\(\(\) => \{ window\.close\(\); \}, ruleLine\?\.attention \? 5000 : 1500\)/);
    assert.match(source, /document\.addEventListener\('pointerdown', cancelClose/);
    assert.match(source, /document\.addEventListener\('focusin', cancelClose/);
    // Edit reopens the bookmark that was just saved, so the edit lands on it instead of a second copy.
    assert.match(source, /if \(wasSaved && tabUrl\) void showManualCaptureExistence\(tabUrl\)/);
  });

  test('popup enforces permission-note path before save and omits inline request in submit (UX-19)', async () => {
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    const permission = await readEnglishSource(new URL('../src/popup-permission.ts', import.meta.url));
    // submit checks contains and reveals the alert instead of requesting inline
    const submitBody = source.slice(source.indexOf('async function submit('));
    assert.doesNotMatch(submitBody, /permissions\.request/);
    assert.match(submitBody, /permissions\.contains/);
    assert.match(submitBody, /permission\.show\(\)/);
    assert.match(permission, /show\(\): void \{ note\.hidden = false; paintPermissionGate\(\); \}/);
    // Only the Allow button asks, and the dialog never opens mid-save.
    assert.match(permission, /chrome\.permissions\.request/);
    // Clearing the existence card repaints the gate instead of dropping aria-disabled.
    assert.match(source, /'known:existence-cleared'[\s\S]*permission\.reflect\(\)/);
    assert.doesNotMatch(source, /removeAttribute\('aria-disabled'\)/);
  });

  test('popup save and suggestion copy is plain (R13 E-06)', async () => {
    const read = (path: string) => readEnglishSource(new URL(path, import.meta.url));
    const popup = await read('../src/popup.ts');
    const classification = await read('../src/popup-classification.ts');
    const panel = await read('../src/capture/result-panel.ts');
    const actions = await read('../src/popup-result-actions.ts');
    assert.match(popup, /Couldn't save this page\. Check that the browser allows bookmarks, then try again\./);
    assert.match(popup, /'Click Save to save this page\.'/);
    // Guidance is the neutral note; only real failures carry the error tone.
    assert.doesNotMatch(popup, /Click Save to save this page\.'\), 'error'/);
    assert.doesNotMatch(popup, /Sign in to save this page\.'\), 'error'/);
    assert.doesNotMatch(classification, /Short codes such as|go directly to Cloudflare|Start new classification/);
    // The old button and its sentences are one chip now.
    assert.match(classification, /'Suggest'/);
    assert.match(classification, /'Suggesting…'/);
    assert.match(classification, /'Check again'/);
    assert.match(classification, /The connection dropped\. Check again, or save without suggestions\./);
    assert.doesNotMatch(classification, /Classify tags|Considered|Finding a folder|Maximum cost/);
    // "Right folder" and "Change folder" are gone: the pill picks, Done confirms.
    assert.doesNotMatch(panel + actions, /Right folder|Change folder/);
    assert.doesNotMatch(panel, /needs attention \(\$\{next\.reason\}\)/);
  });

  test('signed-out auth error toasts humanized copy, like the web login (UX-14)', async () => {
    const source = await readEnglishSource(new URL('../src/options.ts', import.meta.url));
    const form = await readEnglishSource(new URL('../src/login-form.ts', import.meta.url));
    const copy = await readEnglishSource(new URL('../src/auth-error-copy.ts', import.meta.url));
    assert.match(source, /if \(!signedInView\) announceAuthReason\(state\)/);
    assert.match(form, /state\.status === 'error' \|\| state\.status === 'signed_out'/);
    assert.match(form, /showToast\(authErrorCopy\(reason\)/);
    assert.match(copy, /binding_mismatch/);
  });

  test('managed classification displays and confirms the server price before billing', async () => {
    const classification = await readEnglishSource(new URL('../src/popup-classification.ts', import.meta.url));
    const credits = await readEnglishSource(new URL('../src/popup-credits.ts', import.meta.url));
    assert.match(classification, /getManagedPrice/);
    assert.match(classification, /'Uses \$1 credit', 'Uses \$1 credits'/);
    assert.match(classification, /managedPrice!?\.priceVersion/);
    assert.match(classification, /managedPrice!?\.unitPoints/);
    assert.doesNotMatch(classification, /bookmark-classify\.v1/);
    assert.match(credits, /overview\.prices\.find/);
    assert.match(credits, /readPrice/);
  });

  test('chrome://extensions cannot be bookmarked: save is disabled with UNSAVABLE_FEEDBACK', async () => {
    assert.equal(isSavableUrl('chrome://extensions'), false);
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    // The feedback surface and the savability gate live in their own module (the
    // popup is under a shrinking-only source-size cap), so the pin follows it.
    const feedback = await readEnglishSource(new URL('../src/popup-feedback-ui.ts', import.meta.url));
    assert.match(feedback, /UNSAVABLE_FEEDBACK = 'This browser page cannot be bookmarked\.'/);
    assert.match(feedback, /function reflectSavable\(\): boolean/);
    assert.match(feedback, /save\.disabled = true/);
    assert.match(feedback, /fields\.hidden = true/);
    assert.match(feedback, /setFeedback\(UNSAVABLE_FEEDBACK\)/);
    assert.match(feedback, /document\.body\.toggleAttribute\('data-unsavable', !savable\)/);
    assert.match(source, /if \(!reflectSavable\(\)\) return/);
  });

  test('existence returns exact.length>0 when opening a savable page', async () => {
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    const existence = await readEnglishSource(new URL('../src/capture/manual-existence.ts', import.meta.url));
    assert.match(source, /if \(tabUrl && isSavableUrl\(tabUrl\)\) void showManualCaptureExistence\(tabUrl\)/);
    assert.match(source, /from '\.\/capture\/manual-existence\.js'/);
    assert.match(existence, /id = 'capture-existing-locations'/);
    assert.match(existence, /exact\.length/);
    assert.doesNotMatch(existence, /Cloud status cannot be verified/);
  });

  test('syncTone follows stable status and account identity', () => {
    assert.equal(syncTone('synced', 'connected'), 'ok');
    assert.equal(syncTone('review-conflicts', 'connected'), 'attention');
    assert.equal(syncTone('action-required', 'connected'), 'attention');
    assert.equal(syncTone('setup-required', 'connected'), 'setup');
    assert.equal(syncTone('syncing', 'connected'), 'busy');
    assert.equal(syncTone('waiting-network', 'connected'), 'busy');
    assert.equal(syncTone('syncing', 'connecting'), 'busy');
    assert.equal(syncTone('syncing', 'refreshing'), 'busy');
    for (const auth of ['signed_out', 'offline', 'error', 'policy_blocked'] as const) assert.equal(syncTone('signed-out', auth), 'signin');
  });

  test('the avatar and its dot are the sync and account path', async () => {
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    const header = await readEnglishSource(new URL('../src/popup-header.ts', import.meta.url));
    assert.match(source, /header\.paint\(state\)/);
    assert.match(header, /syncTone\(kind, auth\)/);
    assert.match(header, /signedInSyncStatus\(\)\.then\(\(status\) =>/);
    assert.match(header, /version !== readVersion/);
    assert.match(header, /options\.html#account/);
    assert.match(header, /chrome\.runtime\.openOptionsPage/);
    assert.doesNotMatch(source + header, /Open sync settings|Open account settings|sync-chip/);
  });

  test('save success leaves the note empty and paints the status line with a check and Saved to text', async () => {
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    assert.match(source, /paintStatusLine\(\{ icon: 'check-circle', text: t\('popup_savedTo', 'Saved to \$1'/);
    assert.match(source, /void clearPopupDraft\(\);\s*setFeedback\(''\)/);
  });

  test('a manual save carries typed and AI tags and a note through the worker-owned save path', async () => {
    const source = await readEnglishSource(new URL('../src/popup.ts', import.meta.url));
    const native = await readEnglishSource(new URL('../src/popup-native-save.ts', import.meta.url));
    // Tags and note ride on known.capture.start only when there is something to keep.
    assert.match(native, /\.\.\.\(annotation \? \{ annotation \} : \{\}\)/);
    assert.match(native, /kind: 'known\.capture\.start'/);
    assert.match(source, /captureAnnotation\(\{ tags: fields\.tags\.tags\(\), note: fields\.noteField\.value \}\)/);
    // All tags share local persistence and the worker's eligible metadata sync lane.
    assert.match(source, /savePopupNativePage\([\s\S]*?,\s*frozenInsertPosition, annotation[,)]/);
    assert.doesNotMatch(source, /Saved without tags/);
  });
});

describe('token sync pipeline', () => {
  test('extension stylesheets reference only defined design tokens', async () => {
    const tokens = renderGeneratedTokens(await readFile(tokensSourcePath, 'utf8'));
    const defined = new Set([...tokens.matchAll(/--[\w-]+(?=\s*:)/gu)].map((match) => match[0]));
    // Custom properties assigned at runtime via style.setProperty, and icon masks.
    const runtime = new Set(['--depth', '--check-mask', '--disclosure-chevron', '--select-chevron', '--sync-progress']);
    const sheets = await Promise.all(['popup.css', 'options.css', 'auth.css', 'chrome.css'].map(async sheet => ({
      sheet, css: await readFile(new URL(`../${sheet}`, import.meta.url), 'utf8'),
    })));
    // Shared extension stylesheets can define their own properties, such as the toast dimensions.
    for (const { css } of sheets) {
      for (const match of css.matchAll(/--[\w-]+(?=\s*:)/gu)) defined.add(match[0]);
    }
    for (const { sheet, css } of sheets) {
      for (const match of css.matchAll(/var\((--[\w-]+)/gu)) {
        const name = match[1]!;
        assert.ok(defined.has(name) || runtime.has(name),
          `${sheet} references unknown design token ${name}`);
      }
    }
  });

  test('build script copies web tokens into a generated extension stylesheet', async () => {
    const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    const sync = await readFile(new URL('../scripts/sync-tokens.mjs', import.meta.url), 'utf8');
    const generated = renderGeneratedTokens(await readFile(tokensSourcePath, 'utf8'));
    assert.match(build, /syncTokens/);
    assert.match(build, /design\/brand-wordmark\.svg/);
    assert.match(sync, /design\/tokens\.css/);
    assert.match(generated, /GENERATED from design\/tokens\.css/);
    assert.match(generated, /--paper:/);
    assert.match(generated, /--duration-fast:/);
    assert.match(generated, /--tracking-tight:/);
    assert.doesNotMatch(generated, /--weight-demibold/);
  });
});
