import { parseHubRoute } from '../src/options-router.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readEnglishSource } from './english-source.js';
import { describe, test } from 'vitest';

import { MAX_IMPORT_FILE_BYTES, importErrorMessage, nativeImportMessage } from '../src/import-ui.js';

/** The Sync page's behaviour lives in the pane modules; the page script only wires them. */
async function syncSource(): Promise<string> {
  const files = ['options.ts', 'sync-folders.ts', 'sync-import.ts'];
  return (await Promise.all(files.map((file) => readEnglishSource(new URL(`../src/${file}`, import.meta.url))))).join('\n');
}

describe('P3-35 native import request behavior', () => {
  const tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', index: 0, title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', index: 0, title: 'Example', url: 'https://example.com/' }] }] }];

  test('embeds the tree when the document can read it', async () => {
    const message = await nativeImportMessage(async () => tree);
    assert.equal(message.kind, 'known.import.previewNative');
    assert.deepEqual(message.tree, tree);
  });

  test('falls back to a worker-side read when the bookmarks binding is missing', async () => {
    // A page opened before the runtime grant: chrome.bookmarks is undefined
    // and the read throws synchronously.
    const message = await nativeImportMessage(() => {
      throw new TypeError('Cannot read properties of undefined (reading \'getTree\')');
    });
    assert.deepEqual(message, { kind: 'known.import.previewNative' });
  });

  test('falls back to a worker-side read when the tree rejects or exceeds the message bound', async () => {
    assert.deepEqual(await nativeImportMessage(() => Promise.reject(new Error('tree_unavailable'))),
      { kind: 'known.import.previewNative' });
    const huge = [{ id: '0', title: 'x'.repeat(MAX_IMPORT_FILE_BYTES) }];
    assert.deepEqual(await nativeImportMessage(async () => huge), { kind: 'known.import.previewNative' });
  });

  test('maps known import error codes to sentences and gives unknown codes a general one', () => {
    assert.equal(importErrorMessage('permission_required'), 'Allow bookmark access before reading this browser\'s bookmarks.');
    assert.equal(importErrorMessage('collection_required'), 'Your bookmark library is connecting. Try importing again in a moment.');
    assert.match(importErrorMessage('offline'), /could not be reached/);
    assert.match(importErrorMessage('session_invalid'), /no longer valid/);
    assert.match(importErrorMessage('credential_revoked'), /no longer valid/);
    assert.match(importErrorMessage('authentication_required'), /no longer valid/);
    assert.match(importErrorMessage('unsupported_format'), /HTML bookmark file/);
    assert.match(importErrorMessage('import_empty'), /no bookmarks to import/);
    assert.match(importErrorMessage('folder_choice_invalid'), /outside the selected sync folders/);
    assert.match(importErrorMessage('folder_choice_required'), /Map or skip every imported folder/);
    // The generic fallback never prints the code.
    assert.match(importErrorMessage('push_problem_status_mismatch'), /could not continue\. Review the source/);
    assert.doesNotMatch(importErrorMessage('push_problem_status_mismatch'), /push_problem/);
  });
});

describe('P3-35 extension options import UI', () => {
  test('contains real file/native source, preview, mapping, commit and recovery controls', async () => {
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    for (const marker of ['import-file', 'import-native', 'import-preview', 'import-mappings', 'commit-import', 'cancel-import',
      'pause-import', 'resume-import', 'retry-import', 'import-progress', 'import-progress-meter']) assert.match(html, new RegExp(`id="${marker}"`));
    assert.match(html, /HTML bookmarks file/);
    assert.match(html, /Exported from any browser or service/);
    assert.match(html, /Pick folders to copy/);
    assert.match(html, /<div id="import-progress-meter" class="meter" role="progressbar"/);
    assert.doesNotMatch(html, /Chromium JSON\/tree/);
    assert.doesNotMatch(html, /accept="[^"]*\.json/);
    assert.match(html, /aria-live="polite"/); assert.doesNotMatch(html, /demo|timer|atomic batch/i);
    for (const pane of ['nav-account', 'nav-saving', 'nav-sync', 'nav-bookmarks']) {
      assert.match(html, new RegExp(`id="${pane}"`));
    }
    // The sidebar lists the five library pages (Automations included), the four settings pages and Help & diagnostics.
    assert.equal((html.match(/class="side-item" data-step=/g) ?? []).length, 10);
    assert.match(html, /data-pane="bookmarks"/);
    assert.match(html, /id="saving-card"/);
    assert.match(html, /id="sync-card"/);
    // Former cards keep their ids as merged sub-sections so deep links and
    // script bindings keep resolving.
    for (const merged of ['folder-card', 'import-card', 'credits-card']) {
      assert.match(html, new RegExp(`id="${merged}"`));
    }
    assert.doesNotMatch(html, /class="welcome-actions"[^>]*role="list"|role="list"[^>]*class="welcome-actions"/);
    assert.doesNotMatch(html, /id="collection-id"|id="select-collection"|Paste a collection link/i);
    assert.match(html, /Keep this browser’s bookmarks in sync with your bookmark library/);
    assert.doesNotMatch(html, /hub-nav-kicker/);
    assert.match(html, /class="set-group account-login" id="login-panel"/);
    assert.match(html, /id="session-stage"/);
    assert.doesNotMatch(html, /class="auth-card"[^>]*id="login-panel"|id="login-panel"[^>]*class="auth-card"/);
    // R12-20: the topbar shows the web's drawn wordmark, not "Know-" text plus the mark.
    assert.match(html, /<img class="brand-wordmark" src="brand-wordmark\.svg" alt="Know-N"/);
    assert.doesNotMatch(html, /<span aria-hidden>Know-<\/span>|favicon\.svg/);
    assert.doesNotMatch(html, /icons\/icon-48\.png|<span>Know-N<\/span>/);
  });

  test('uses restrained responsive layout and explicit keyboard focus without oversized headings', async () => {
    const css = await readFile(new URL('../options.css', import.meta.url), 'utf8');
    assert.match(css, /focus-visible/); assert.match(css, /max-width:\s*540px/);
    assert.match(css, /max-width:\s*1099px/);
    assert.match(css, /max-width:\s*899px/);
    assert.doesNotMatch(css, /max-width:\s*(?:1023|859|420)px/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /@import url\("tokens\.generated\.css"\)/);
    // Four nav items never needed 18.5rem of rail.
    assert.match(css, /grid-template-columns:\s*15rem minmax\(0, 1fr\)/);
    assert.match(css, /\.brand-wordmark/);
    assert.doesNotMatch(css, /body:not\(\[data-state="connected"\]\)[^{]*\.account-card/);
    assert.doesNotMatch(css, /--weight-demibold|--weight-strong|--weight-heavy/);
    assert.doesNotMatch(css, /gradient|font-size:\s*(?:[4-9]\d|\d{3,})px/i);
    // The web sign-in card's width, on the page's left edge (not centred under a left-aligned head).
    assert.match(css, /\.account-login > \.login-card \{[^}]*width:\s*min\(100%, 26rem\)/);
    assert.doesNotMatch(css, /\.account-login > \.[\w-]+ \{[^}]*margin-inline:\s*auto/);
    assert.match(css, /@media \(max-width: 56rem\)/);
    assert.doesNotMatch(css, /\.auth-oauth-row \{ justify-content: flex-start/);
  });

  test('renders untrusted names with textContent and never injects imported HTML', async () => {
    const source = await syncSource();
    assert.match(source, /textContent/); assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
    assert.match(source, /known\.import\.(?:previewFile|previewNative|commit|pause|resume|retry|status)/);
    assert.match(source, /chrome\.bookmarks\.getTree/);
    assert.match(source, /previewNative[\s\S]*getTree/);
    assert.match(source, /showPane/);
    assert.equal(parseHubRoute('#native-wait-settings').pane, 'sync');
    assert.equal(parseHubRoute('#unknown').pane, 'bookmarks');
    assert.equal(parseHubRoute('#account').pane, 'account');
    assert.match(source, /if \(signedInView\) welcome\.hidden = true/);
    assert.match(source, /collection_required/);
    assert.doesNotMatch(source, /extractCollectionId|Paste a collection link/);
  });

  test('the import sources follow the connection and an idle pane shows no status line (UX-06)', async () => {
    const source = await syncSource();
    assert.match(source, /onConnection\(connected: boolean\): void \{\s*file\.disabled = !connected; native\.disabled = !connected;/);
    assert.match(source, /importPane\.onConnection\(connected\)/);
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    assert.match(html, /<div class="inline-alert" data-tone="warning" id="import-alert" hidden>/);
  });

  test('handles missing view in root responses without getting stuck (UX-07)', async () => {
    const source = await syncSource();
    assert.match(source, /if \(!response\.ok \|\| !\('view' in response\)\) \{\s*\n?\s*renderFailure\(response\.ok \? 'request_invalid' : response\.error\);/);
  });

  test('offline and error states offer Retry or Sign in again instead of only Sign out (UX-20)', async () => {
    const source = await readEnglishSource(new URL('../src/options.ts', import.meta.url));
    assert.match(source, /case 'offline': return \{ [^}]*action: 'Retry'/);
    assert.match(source, /needsReauth \? 'Sign in again' : 'Retry'/);
    assert.doesNotMatch(source, /case 'offline': return \{ [^}]*action: 'Sign out'/);
  });

  test('import attention state provides actionable guidance and navigation links (UX-23)', async () => {
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    const source = await syncSource();
    assert.match(html, /id="import-attention-actions"/);
    assert.match(html, /id="import-goto-sync"/);
    assert.match(html, /id="import-goto-folders"/);
    assert.match(html, /Check folder access or review Status, then retry\./);
    assert.match(source, /attention\.hidden = value\.state !== 'attention'/);
  });

  test('Account and collection panes say the right thing (R13 E-10)', async () => {
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    const source = await syncSource();
    // The welcome card no longer loops a signed-out user between panes.
    assert.doesNotMatch(html, /id="welcome-signin"|id="welcome-open-collections"/);
    assert.match(html, /id="dismiss-welcome"/);
    // Collection rows are a group; the chosen one is marked current, the others carry a button.
    assert.doesNotMatch(source, /setAttribute\('role', 'option'\)/);
    // Offline is its own neutral state, not "Not signed in" in red.
    const pill = await readEnglishSource(new URL('../src/options-hub-chrome.ts', import.meta.url));
    assert.match(pill, /status === 'offline' \? 'Offline'/);
    assert.match(pill, /status === 'error' \|\| status === 'policy_blocked' \? 'Sign-in problem'/);
    assert.doesNotMatch(source, /Could not select this library/);
  });

  test('the clipped file input shows focus on its visible card (R13 E-12)', async () => {
    const css = await readFile(new URL('../options.css', import.meta.url), 'utf8');
    assert.match(css, /\.import-sources:has\(#import-file:focus-visible\) label\[for="import-file"\] \{[^}]*outline: 1px solid var\(--ink\);[^}]*box-shadow: var\(--shadow-ring\);/);
  });

  test('options copy is English and free of developer terms (R13 E-13)', async () => {
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    assert.doesNotMatch(html, /[\u3000-\u9fff\uff00-\uffef]/u);
    assert.match(html, /Keep your TypeSafe key in your own Cloudflare AI Gateway \(alias "default"\)\. The extension only stores the Cloudflare token\./);
    assert.doesNotMatch(html, /immutable activity|>Charge ID<|>Run ID</);
    // The two references only arrive through links from a row; they are not form fields.
    assert.match(html, /<input id="credit-filter-charge" name="chargeId" type="hidden">/);
    assert.match(html, /<input id="credit-filter-run" name="runId" type="hidden">/);
  });

  test('the local Status tab and the web Sync center have separate names (R13 E-14)', async () => {
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    const source = await syncSource();
    const diagnostics = await readEnglishSource(new URL('../src/capture/diagnostics-view.ts', import.meta.url));
    assert.match(html, /id="tab-sync-center"[^>]*>Status<\/button>/);
    // Everything that opens the local tab says Sync › Status and goes to #sync/center.
    assert.match(html, /id="import-goto-sync"[^>]*>Review Sync › Status<\/button>/);
    assert.match(source, /showStatus: \(\) => showPane\('sync-center'\)/);
    assert.match(source, /required\('import-goto-sync'\)\.addEventListener\('click', host\.showStatus\)/);
    assert.match(diagnostics, /'#sync\/center', 'Open Sync › Status'/);
    // Links that open the web page say so.
    const webLinks = [...html.matchAll(/target="_blank"[^>]*>([^<]*Sync center[^<]*)</g)].map((match) => match[1]);
    assert.equal(webLinks.length, 3);
    for (const label of webLinks) assert.match(label!, / on the web$/);
    assert.doesNotMatch(html, />(?:Open|Resolve conflicts in|Review conflicts in) Sync center</);
  });

  test('options polish (R13 E-15)', async () => {
    const html = await readEnglishSource(new URL('../options.html', import.meta.url));
    const remoteDelete = await readEnglishSource(new URL('../src/remote-delete-ui.ts', import.meta.url));
    const tabsPage = await readEnglishSource(new URL('../src/capture/tabs-page.ts', import.meta.url));
    assert.match(html, /<main class="main" id="main">/);
    assert.doesNotMatch(html, /Know-N settings<\/h1>/);
    // Every page carries exactly one title, in its page head.
    assert.equal((html.match(/<header class="page-head">\s*<div class="page-head-copy">\s*<h1/g) ?? []).length, (html.match(/<h1/g) ?? []).length);
    // A zero count line is hidden; with nothing waiting the waiting group steps aside whole.
    assert.match(html, /<p id="remote-delete-pending-count" hidden>/);
    assert.match(remoteDelete, /count\.hidden = response\.pendingCount === 0;/);
    assert.match(html, /<strong>This browser’s bookmarks<\/strong>/);
    assert.doesNotMatch(html, /<strong>Chrome bookmarks<\/strong>/);
    // Capture states print as words, not raw state codes.
    assert.match(tabsPage, /CAPTURE_SAVE_COPY\[task\.save\] \?\? task\.save/);
    assert.match(tabsPage, /CAPTURE_SYNC_COPY\[task\.sync\] \?\? task\.sync/);
  });
});
