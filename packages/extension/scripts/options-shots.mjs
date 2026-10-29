// Screenshot harness: serves a built extension over http with a stubbed chrome.* API (scripts/shots-stub.mjs) so
// the options pages, the tabs page and the popup render real states, then screenshots each one.
//
//   npm run build:development && npm run shots
//   DIST=dist/development PORT=8931 SHOT_OUT=/tmp/shots SHOT_LOCALE=zh_CN SHOT_ONLY=popup,in-ai npm run shots
//
// Env: DIST (build to serve, default dist/development), PORT (default 8931), SHOT_OUT (default /tmp/options-shots),
// SHOT_LOCALE (en | zh_CN), SHOT_ONLY (comma separated; keeps files whose name contains any entry, e.g. "popup",
// "-in-sync", "820-out"), SHOT_WIDTHS (options widths, default 1280,820,320).
// SHOT_TIME (an ISO time) pins the pages' clock, so relative and absolute times render the same on every run.
// Files: <locale>-<width>-<in|out>-<page>.png for the settings pages (signed in / out), <locale>-<width>-<state>.png
// for other options states, <locale>-380-popup-<state>.png for the popup.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import { installStub } from './shots-stub.mjs';

const dist = resolve(process.env.DIST ?? join(import.meta.dirname, '../dist/development'));
const port = Number(process.env.PORT ?? 8931);
const locale = process.env.SHOT_LOCALE ?? 'en';
const out = resolve(process.env.SHOT_OUT ?? '/tmp/options-shots');
const widths = (process.env.SHOT_WIDTHS ?? '1280,820,320').split(',').map(Number);
const only = process.env.SHOT_ONLY ? process.env.SHOT_ONLY.split(',') : null;
const fixedTime = process.env.SHOT_TIME ? new Date(process.env.SHOT_TIME) : null;
if (fixedTime && Number.isNaN(fixedTime.getTime())) throw new Error('SHOT_TIME must be an ISO time');
const wanted = (file) => !only || only.some((o) => file.includes(o));
const messages = JSON.parse(await readFile(join(dist, '_locales', locale, 'messages.json'), 'utf8'));
await mkdir(out, { recursive: true });

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(dist)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((done) => server.listen(port, done));
const browser = await chromium.launch();

// ---- preparation steps ---------------------------------------------------------------------------------------
const open = (selector) => (page) => page.evaluate((s) => { const d = document.querySelector(s); if (d) d.open = true; }, selector);
const openAll = (page) => page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
const click = (selector) => async (page) => { await page.click(selector); await page.waitForTimeout(400); };
const clearMemory = async (page) => { await page.waitForSelector('[data-capture-learning] .btn'); await page.click('[data-capture-learning] .btn'); await page.waitForTimeout(300); };

// Every settings page, in sidebar order, with the route it has today. Signed in and signed out are both shot.
const PAGES = [
  ['bookmarks', 'bookmarks'], ['history', 'history'], ['subscriptions', 'subscriptions'],
  ['sync', 'sync'], ['sync-folders', 'sync/folders'], ['sync-status', 'sync/center'], ['sync-import', 'sync/import'], ['automations', 'automations'],
  ['saving', 'saving'], ['ai', 'ai'], ['general', 'general'], ['account', 'account'], ['credits', 'account/credits'], ['help', 'help'],
];
// Other options states: [name, url, prepare, fullPage]
const STATES = [
  ['firstrun', 'options.html?shot=firstrun#bookmarks'],
  ['own-ai', 'options.html?shot=own#ai', open('#classification-local-advanced')],
  ['own-ai-closed', 'options.html?shot=own#ai'],
  // Account against a COLP Server: no code sign-in, no providers, the reset command.
  ['account-selfhosted-out', 'options.html?shot=signedout,selfhosted#account'],
  ['account-selfhosted-reset', 'options.html?shot=signedout,selfhosted#account', open('#login-password-help')],
  ['account-selfhosted-empty', 'options.html?shot=signedout,selfhosted#account', click('#login-submit')],
  ['account-selfhosted-in', 'options.html?shot=selfhosted#account'],
  ['dialog-logout', 'options.html#account', click('#sign-out'), false],
  ['dialog-revoke', 'options.html#general', click('#permissions-revoke-bookmarks'), false],
  ['dialog-export-general', 'options.html#general', click('#general-export'), false],
  ['dialog-clear-memory', 'options.html#ai', clearMemory, false],
  ...['history', 'saving', 'ai', 'credits', 'help', 'account', 'subscriptions'].map((name) => [`err-${name}`, `options.html?shot=error#${PAGES.find(([n]) => n === name)[1]}`]),
  ['open-saving', 'options.html#saving', openAll],
  ['open-bookmarks', 'options.html#bookmarks', openAll],
  ['open-help', 'options.html#help', openAll],
  ['conflict-saving', 'options.html?shot=conflict#saving'],
  ['sync-progress-prep', 'options.html?shot=syncprep#sync/folders'],
  ['sync-progress-run', 'options.html?shot=syncrun#sync/center'],
  ['sync-progress-stall', 'options.html?shot=syncstall#sync/center'],
  ['sync-progress-paused', 'options.html?shot=syncrun,ps-paused#sync/center'],
  ['sync-progress-paused-prep', 'options.html?shot=syncprep,ps-paused#sync/folders'],
  ['manual-saving', 'options.html?shot=manual#saving'],
  ...['paused', 'expired', 'none', 'off', 'rejected', 'missing', 'empty', 'server-offline', 'server-signin', 'server-empty']
    .map((name) => [`automations-${name}`, `options.html?shot=auto-${name}#automations`]),
  ['manual-ai', 'options.html?shot=manual#ai'],
  // Rules in this browser (AW-68): signed out with rules and with none, the editor (new and edit) and the delete question.
  ['automations-browser-out', 'options.html?shot=signedout#automations'],
  ['automations-browser-out-empty', 'options.html?shot=signedout,browser-none#automations'],
  ['automations-browser-in-empty', 'options.html?shot=browser-empty#automations'],
  ['automations-browser-new', 'options.html?shot=signedout#automations', async (p) => { await p.click('[data-automations-new]'); await p.waitForTimeout(500); }, false],
  ['automations-browser-new-problems', 'options.html?shot=signedout#automations', async (p) => { await p.click('[data-automations-new]'); await p.waitForTimeout(400);
    await p.click('.automation-rule-editor button[type="submit"]'); await p.waitForTimeout(300); }, false],
  ['automations-browser-edit', 'options.html?shot=signedout#automations', async (p) => { await p.click('.automation-browser-rule >> nth=1'); await p.waitForTimeout(500);
    await p.click('.automation-rule-editor .folder-pill'); await p.waitForTimeout(300); }, false],
  // How a page you save finds its folder (U3): Manual mode, and Automatic with no AI, signed in and out.
  ['automations-flow-manual', 'options.html?shot=flow-manual#automations'],
  ['automations-flow-noai-out', 'options.html?shot=signedout,flow-noai#automations'],
  // One New rule, signed in (follow-up U2): where the rule is used comes first.
  ['automations-new-signedin', 'options.html#automations', async (p) => { await p.click('[data-automations-new]'); await p.waitForTimeout(500); }, false],
  ['automations-new-account', 'options.html#automations', async (p) => { await p.click('[data-automations-new]'); await p.waitForTimeout(400);
    await p.click('.automation-use-on .choice >> nth=1'); await p.waitForTimeout(300); }, false],
  // Next to the account's rules (AW-69): the notice and badges, then the review.
  ['automations-browser-overlap', 'options.html?shot=browser-overlap#automations'],
  ['automations-browser-review', 'options.html?shot=browser-overlap#automations', async (p) => { await p.click('.automation-browser .inline-alert button');
    await p.waitForTimeout(500); }, false],
  // Moving to the account (AW-71): a rule waiting for the account's copy, one that can only stay here.
  ['automations-browser-move', 'options.html?shot=browser-move#automations'],
  // Saves a browser rule matched but left where they were saved, with why (follow-up U6).
  ['automations-browser-kept', 'options.html?shot=signedout,browser-kept#automations'],
  // A move the account has not finished after a day (follow-up U5).
  ['automations-browser-stale', 'options.html?shot=browser-stale#automations'],
  // The ordered list (doc 17 RW-04): a set of the Owner's, the one-time order notice, and the editor's Then.
  ['automations-browser-set', 'options.html?shot=signedout,browser-set,browser-order#automations'],
  ['automations-browser-set-edit', 'options.html?shot=signedout,browser-set#automations', async (p) => { await p.click('.rule-set-rules .automation-browser-rule >> nth=0');
    await p.waitForTimeout(500); }, false],
  ['automations-browser-delete', 'options.html?shot=signedout#automations', async (p) => { await p.hover('.automation-browser-rule >> nth=0');
    await p.click('.automation-browser-rule >> nth=0 >> button:has(svg[data-icon="trash"])'); await p.waitForTimeout(400); }, false],
  // Doc 17 Stage 1: a page tried against the list, Run once's preview, the runs with Undo, Recent activity's actions, and a rules file to import.
  ['automations-browser-try', 'options.html?shot=signedout#automations', async (p) => { await p.fill('.automation-preview-form input[type="url"]', 'https://arxiv.org/abs/1706.03762');
    await p.click('.automation-preview-form button[type="submit"]'); await p.waitForTimeout(400); }],
  ['automations-browser-run', 'options.html?shot=signedout#automations', async (p) => { await p.click('[data-run-once]'); await p.waitForTimeout(400);
    await p.click('.automation-run-dialog .folder-pill'); await p.click('.automation-run-dialog .folder-opt >> nth=1'); await p.click('.automation-run-dialog .btn-primary');
    await p.waitForTimeout(400); }, false],
  ['automations-browser-runs', 'options.html?shot=signedout,browser-runs#automations'],
  ['automations-browser-activity', 'options.html?shot=signedout#automations', async (p) => { await p.hover('.automation-placements > li >> nth=0'); await p.waitForTimeout(200); }],
  ['automations-browser-import', 'options.html?shot=signedout#automations', async (p) => { await p.setInputFiles('.automation-config input[type="file"]', { name: 'known-rules-config-2026-10-18.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'known-rules-config/v1', exportedAt: 1, list: { enabled: true, entries: [
      { kind: 'rule', rule: { id: 'r1', enabled: true, name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId: '9' } } },
      { kind: 'rule', rule: { id: 'r2', enabled: true, name: 'Docs', combinator: 'all', conditions: [{ kind: 'pathUnder', value: '/docs' }], action: { kind: 'file', folderNativeId: '12' } } }] },
    folders: [{ nativeId: '9', title: 'Research', path: ['Bookmarks bar', 'Research'] }, { nativeId: '12', title: 'Manuals', path: ['Other bookmarks', 'Manuals'] }] })) });
    await p.waitForTimeout(500); }, false],
  // Doc 17 Stage 2: a rule-set file to import, an imported set with a role still to bind, and Copy to my rules.
  ['automations-browser-import-set', 'options.html?shot=signedout#automations', async (p) => {
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-import-set]')]);
    await chooser.setFiles({ name: 'community-tech.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"colp.ruleset/v1"}') });
    await p.waitForTimeout(500); }, false],
  ['automations-browser-imported', 'options.html?shot=signedout,browser-set,browser-imported#automations'],
  ['automations-browser-copy', 'options.html?shot=signedout,browser-set,browser-imported#automations', async (p) => {
    await p.hover('.rule-set-rules .automation-browser-rule >> nth=0'); await p.click('.rule-set-rules .automation-browser-rule >> nth=0 >> button:has(svg[data-icon="fork"])');
    await p.waitForTimeout(400); }, false],
  // Subscriptions (doc 17 RW-13, RW-14): the block with its fold open, one not ready, Subscribe, Review and its settings.
  ['automations-browser-subscribed', 'options.html?shot=signedout,browser-subscribed#automations', async (p) => {
    await p.click('.automation-sub-about > summary'); await p.waitForTimeout(200); }],
  ['automations-browser-sub-failed', 'options.html?shot=signedout,browser-sub-failed#automations'],
  ['automations-browser-subscribe', 'options.html?shot=signedout#automations', async (p) => {
    await p.click('[data-subscribe]'); await p.fill('dialog.automation-subscribe input[type="url"]', 'https://rules.example.org/community-tech.json');
    await p.click('dialog.automation-subscribe button[type="submit"]'); await p.waitForTimeout(500); }, false],
  ['automations-browser-sub-review', 'options.html?shot=signedout,browser-subscribed#automations', async (p) => {
    await p.click('[data-review]'); await p.waitForTimeout(500); }, false],
  ['automations-browser-sub-settings', 'options.html?shot=signedout,browser-subscribed#automations', async (p) => {
    await p.hover('.automation-subscription > .rule-set-head'); await p.click('.automation-subscription > .rule-set-head button:has(svg[data-icon="settings"])');
    await p.waitForTimeout(300); }, false],
  // Risk alerts (doc 17 RW-15 – RW-17): the section with its lists and exceptions, on while browsing, and Subscribe.
  ['automations-risk', 'options.html?shot=signedout,risk#automations'],
  ['automations-risk-browse', 'options.html?shot=signedout,risk,risk-browse#automations'],
  ['automations-risk-subscribe', 'options.html?shot=signedout,risk#automations', async (p) => {
    await p.click('[data-risk-subscribe]'); await p.fill('dialog input[type="url"]', 'https://lists.example.org/phish.json'); await p.waitForTimeout(300); }, false],
  // The account's activity inbox (doc 19): the latest item and the unread count, a run waiting on you, long names, nothing yet.
  ...['activity', 'activity-run', 'activity-long', 'activity-empty'].map((name) => [`automations-${name}`, `options.html?shot=${name}#automations`]),
  // A rule filed a page starred in the browser while Know-N was in front (AW-20).
  ['automations-notice', 'options.html#automations', (p) => p.evaluate(() => window.__workerMessage({ kind: 'known.automation.notice',
    text: 'Moved “Attention Is All You Need” to Academic by rule “arXiv papers”.', attention: false }))],
];

// ---- library pages: Bookmarks, History, Subscriptions, Sync, their dialogs and wizard steps -----------------------------
const R = 'options.html';
const importFile = { name: 'bookmarks_9_30_26.html', mimeType: 'text/html', buffer: Buffer.from('<DL><DT><A HREF="https://a.example">A</A></DL>') };
const packageFile = { name: 'bili-hints.json', mimeType: 'application/json', buffer: Buffer.from('{"manifest":{}}') };
const wait = (ms) => (page) => page.waitForTimeout(ms);
const program = async (page) => { await page.click('.mgr-folder:has-text("Programming")'); await page.waitForTimeout(350); };
const hoverRow = async (page) => { await page.hover('.mgr-row >> nth=0'); };
const editRow = async (page) => { await program(page); await hoverRow(page); await page.click('.mgr-row >> nth=0 >> button:has(svg[data-icon="pencil"])'); await page.waitForTimeout(500); };
const rowMenu = async (page) => { await program(page); await hoverRow(page); await page.click('.mgr-row >> nth=0 >> button:has(svg[data-icon="more-horizontal"])'); await page.waitForTimeout(300); };
const menuItem = (position) => async (page) => { await rowMenu(page); await page.click(`.mgr-menu-item >> nth=${position}`); await page.waitForTimeout(450); };
const importDialog = (prepare) => async (page) => { await page.click('#manager-import'); await page.waitForTimeout(500); if (prepare) await prepare(page); };
const taskId = (n) => `20000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
const mappingId = (n) => `20000000-0000-4000-8000-${String(300 + n).padStart(12, '0')}`;
const wizardSource = async (page) => { await page.click('.subscription-source-row >> nth=0 >> button'); await page.waitForTimeout(700); };
const wizardNext = async (page) => { await page.click('.subscription-wizard-actions .btn-primary'); await page.waitForTimeout(700); };
const chooseImport = async (page) => { await page.setInputFiles('#import-file', importFile); await page.waitForTimeout(700); };
const LIBRARY = [
  // Bookmarks
  ['bm-folder', `${R}#bookmarks`, program], ['bm-hover', `${R}#bookmarks`, async (p) => { await program(p); await hoverRow(p); }],
  ['bm-select', `${R}#bookmarks`, async (p) => { await program(p); await p.click('#manager-select'); await p.locator('.mgr-select').nth(0).check(); await p.locator('.mgr-select').nth(2).check(); }],
  // Viewport-sized: the selection bar must stay on screen while the rows scroll under it.
  ['bm-select-scrolled', `${R}?shot=long#bookmarks`, async (p) => { await program(p); await p.click('#manager-select'); await p.locator('.mgr-select').nth(0).check(); await p.locator('.mgr-select').nth(1).check(); await p.mouse.wheel(0, 260); await p.waitForTimeout(300); }, false],
  ['bm-search', `${R}#bookmarks`, async (p) => { await program(p); await p.fill('#manager-search', 'zapier'); await p.waitForTimeout(400); }],
  ['bm-search-hover', `${R}#bookmarks`, async (p) => { await program(p); await p.fill('#manager-search', 'zapier'); await p.waitForTimeout(400); await hoverRow(p); }],
  ['bm-search-note', `${R}#bookmarks`, async (p) => { await program(p); await p.fill('#manager-search', 'Oct release'); await p.waitForTimeout(500); }],
  ['bm-signedout', `${R}?shot=signedout#bookmarks`, program], ['bm-empty', `${R}?shot=empty#bookmarks`],
  ['bm-emptyfolder', `${R}#bookmarks`, async (p) => { await p.click('.mgr-folder:has-text("Personal") >> nth=0'); await p.waitForTimeout(350); }],
  ['bm-noperm', `${R}?shot=noperm#bookmarks`], ['bm-long', `${R}?shot=long#bookmarks`, program],
  ['bm-composer', `${R}#bookmarks`, async (p) => { await program(p); await p.click('#manager-new-bookmark'); await p.waitForTimeout(300); }],
  ['bm-importalert', `${R}?shot=importattn#bookmarks`, program],
  ['dlg-edit-bookmark', `${R}#bookmarks`, editRow, false],
  ['dlg-edit-bookmark-folder', `${R}#bookmarks`, async (p) => { await editRow(p); await p.click('.folder-pill'); await p.waitForTimeout(300); }, false],
  ['dlg-edit-folder', `${R}#bookmarks`, async (p) => { await program(p); await p.hover('.mgr-row >> nth=0'); await p.click('button:has-text("Programming") >> nth=0'); }, false],
  ['dlg-row-menu', `${R}#bookmarks`, rowMenu],
  // Counted from the end: Move and Delete close the menu, whatever optional items (Pin, Show in folder) come before them.
  ['dlg-move', `${R}#bookmarks`, menuItem(-2), false], ['dlg-delete', `${R}#bookmarks`, menuItem(-1), false],
  ['dlg-import', `${R}#bookmarks`, importDialog(), false],
  ['dlg-import-chosen', `${R}#bookmarks`, importDialog(async (p) => { await p.setInputFiles('#local-import-file', importFile); await p.waitForTimeout(600); }), false],
  ['dlg-import-picker', `${R}#bookmarks`, importDialog(async (p) => { await p.setInputFiles('#local-import-file', importFile); await p.waitForTimeout(600); await p.click('#local-import-target'); await p.waitForTimeout(300); }), false],
  ['dlg-import-noperm', `${R}?shot=noperm#bookmarks`, importDialog(), false], ['dlg-import-running', `${R}?shot=importing#bookmarks`, importDialog(wait(300)), false],
  ['dlg-export', `${R}#bookmarks`, async (p) => { await p.click('#manager-export'); await p.waitForTimeout(400); }, false],
  // History
  ['hist-default', `${R}#history`], ['hist-signedout', `${R}?shot=signedout#history`], ['hist-empty', `${R}?shot=empty#history`], ['hist-error', `${R}?shot=herr#history`],
  ['hist-long', `${R}?shot=long#history`], ['hist-paused', `${R}?shot=paused#history`],
  ['hist-more', `${R}#history`, async (p) => { await p.click('.hist-toolbar button[aria-expanded]'); await p.waitForTimeout(200); }],
  ['hist-select', `${R}#history`, async (p) => { await p.click('.hist-toolbar button[aria-pressed]'); await p.locator('.mgr-select').nth(1).check(); }],
  ['hist-select-scrolled', `${R}?shot=long#history`, async (p) => { await p.click('.hist-toolbar button[aria-pressed]'); await p.locator('.mgr-select').nth(1).check(); await p.mouse.wheel(0, 300); await p.waitForTimeout(300); }, false],
  ['hist-nomatch', `${R}#history?status=progress&q=zzz`],
  ['hist-search', `${R}#history`, async (p) => { await p.fill('#capture-history-search', 'attention'); await p.waitForTimeout(700); }],
  ['hist-detail', `${R}#history?task=${taskId(1)}`],
  ['hist-detail-picker', `${R}#history?task=${taskId(1)}`, async (p) => { await p.click('.detail-fields .folder-pill'); await p.waitForTimeout(300); }],
  ['hist-detail-dirty', `${R}#history?task=${taskId(1)}`, async (p) => { await p.fill('.detail-fields .tag-input input', 'newtag'); await p.keyboard.press('Enter'); await p.fill('.detail-fields textarea', 'Worth a second look.'); await p.waitForTimeout(250); }],
  ['hist-detail-sync', `${R}#history?task=${taskId(2)}`], ['hist-detail-unknown', `${R}#history?task=${taskId(3)}`],
  ['hist-detail-failed', `${R}?shot=long#history?task=${taskId(7)}`], ['hist-detail-missing', `${R}#history?task=${taskId(55)}`],
  // Subscriptions
  ['sub-list', `${R}#subscriptions/list`], ['sub-signedout', `${R}?shot=signedout,subout#subscriptions/list`], ['sub-noperm', `${R}?shot=subnoperm#subscriptions/list`],
  ['sub-empty', `${R}?shot=subempty#subscriptions/list`], ['sub-error', `${R}?shot=suberr#subscriptions/list`], ['sub-wait', `${R}?shot=subwait#subscriptions/list`],
  ['sub-long', `${R}?shot=sublong#subscriptions/list`], ['sub-removed', `${R}#subscriptions/history`], ['sub-nomatch', `${R}#subscriptions/list?q=zzz`],
  ['sub-menu', `${R}#subscriptions/list`, async (p) => { await p.click('.sub-row >> nth=1 >> button:has(svg[data-icon="more-horizontal"])'); await p.waitForTimeout(250); }],
  ['sub-wiz-source', `${R}#subscriptions/new`], ['sub-wiz-content', `${R}#subscriptions/new`, wizardSource],
  ['sub-wiz-location', `${R}#subscriptions/new`, async (p) => { await wizardSource(p); await wizardNext(p); }],
  ['sub-wiz-review', `${R}#subscriptions/new`, async (p) => { await wizardSource(p); await wizardNext(p); await p.click('.subscription-tree-name >> nth=0'); await p.waitForTimeout(200); await wizardNext(p); }],
  ['sub-detail', `${R}#subscriptions/detail?mapping=${mappingId(1)}`], ['sub-detail-recovery', `${R}?shot=subwait#subscriptions/detail?mapping=${mappingId(4)}`],
  ['sub-detail-exit', `${R}#subscriptions/detail?mapping=${mappingId(1)}`, async (p) => { await p.click('.subscription-exit-actions .section-commands button >> nth=0'); await p.waitForTimeout(500); }, false],
  ['sub-detail-move', `${R}#subscriptions/detail?mapping=${mappingId(1)}`, async (p) => { await p.click('.subscription-section .section-commands >> nth=0'); await p.waitForTimeout(500); }, false],
  // Sync
  ['sync-collection', `${R}#sync`], ['sync-collection-signedout', `${R}?shot=signedout#sync`], ['sync-collection-none', `${R}?shot=nocollection#sync`],
  ['sync-collection-paused', `${R}?shot=ps-paused#sync`], ['sync-collection-disconnected', `${R}?shot=ps-disconnected#sync`],
  ['sync-collection-new', `${R}?shot=frnew#sync`],
  ['sync-collection-create', `${R}#sync`, async (p) => { await p.click('#library-create-open'); await p.waitForTimeout(300); }],
  ['sync-folders-list', `${R}#sync/folders`],
  ['sync-folders-edit', `${R}#sync/folders`, async (p) => { await p.click('.root-row[data-ref="r-prog"] .root-select'); await p.hover('.root-row[data-ref="r-pers"]'); await p.click('.root-row[data-ref="r-pers"] .root-private input'); await p.hover('.root-row[data-ref="r-pers"]'); await p.waitForTimeout(300); }],
  ['sync-folders-parent', `${R}#sync/folders`, async (p) => { await p.click('.root-row[data-ref="r-bar"] .root-select'); await p.hover('.root-row[data-ref="r-seo"] .root-select'); await p.waitForTimeout(300); }],
  ['sync-folders-collapsed', `${R}#sync/folders`, async (p) => { await p.click('.root-row[data-ref="r-mkt"] .tree-toggle'); await p.waitForTimeout(300); }],
  ['sync-folders-preview', `${R}?shot=rshift,rnested#sync/folders`, async (p) => { await p.click('.root-row[data-ref="r-prog"] .root-select'); await p.click('#save-roots'); await p.waitForTimeout(500); }],
  ['sync-folders-perm', `${R}?shot=rperm,noperm#sync/folders`], ['sync-folders-tree', `${R}?shot=rtree#sync/folders`], ['sync-folders-fail', `${R}?shot=rfail#sync/folders`],
  ['sync-folders-managed', `${R}?shot=rmanaged,long#sync/folders`], ['sync-folders-firstrun', `${R}?shot=frnew#sync/folders`, wait(600)],
  ['sync-folders-firstrun-adv', `${R}?shot=frnew#sync/folders`, async (p) => { await p.waitForTimeout(500); await p.click('#first-run-advanced summary'); await p.selectOption('#first-run-advanced-mode', 'preview-only'); await p.click('#first-run-advanced-preview'); await p.waitForTimeout(600); }],
  ['sync-folders-firstrun-attn', `${R}?shot=frattn#sync/folders`, wait(600)],
  ['sync-status-quiet', `${R}#sync/center`], ['sync-status-wait', `${R}?shot=nwait,rdel#sync/center`], ['sync-status-wait-long', `${R}?shot=nwait,rdel,long,rconf#sync/center`],
  ['sync-status-menu', `${R}?shot=nwait#sync/center`, async (p) => { await p.click('.native-wait-item >> nth=0 >> button:has(svg[data-icon="more-horizontal"])'); await p.waitForTimeout(300); }],
  ['sync-status-cancel', `${R}?shot=nwait#sync/center`, async (p) => { await p.click('.native-wait-item >> nth=0 >> button:has(svg[data-icon="more-horizontal"])'); await p.click('.mgr-menu-item'); await p.waitForTimeout(300); }],
  ['sync-status-error', `${R}?shot=nwait,nwerr#sync/center`, async (p) => { await p.click('.native-wait-item >> nth=1 >> button[data-native-wait-action="keep_local_and_create"]'); await p.waitForTimeout(500); }],
  ['sync-status-attn', `${R}?shot=attn,rdel#sync/center`],
  ['sync-status-attn-confirm', `${R}?shot=attn#sync/center`, async (p) => { await p.click('#sync-attention-settings-rebuild'); await p.waitForTimeout(500); }],
  ['sync-import-idle', `${R}#sync/import`], ['sync-import-active', `${R}?shot=imp-active#sync/import`], ['sync-import-paused', `${R}?shot=imp-paused#sync/import`],
  ['sync-import-attn', `${R}?shot=imp-attn#sync/import`], ['sync-import-done', `${R}?shot=imp-done#sync/import`],
  ['sync-import-preview', `${R}?shot=warn#sync/import`, chooseImport],
  ['sync-import-mapped', `${R}?shot=warn#sync/import`, async (p) => { await chooseImport(p); await p.selectOption('#map-n1', '0'); await p.selectOption('#map-n2', '1'); await p.selectOption('#map-n3', 'skip'); await p.waitForTimeout(200); }],
  ['sync-import-signedout', `${R}?shot=signedout#sync/import`],
  // Save tabs
  ['tabs-default', 'capture-tabs.html'], ['tabs-notabs', 'capture-tabs.html?shot=tabs-notabs'], ['tabs-nobookmarks', 'capture-tabs.html?shot=noperm,tabs-notabs'],
  ['tabs-dupe', 'capture-tabs.html?shot=tabs-dupe'], ['tabs-long', 'capture-tabs.html?shot=tabs-long'], ['tabs-many', 'capture-tabs.html?shot=tabs-many'],
  ['tabs-confirmed', 'capture-tabs.html?batch=20000000-0000-4000-8000-000000000800&shot=tabs-confirmed'],
  ['tabs-rule', 'capture-tabs.html?batch=20000000-0000-4000-8000-000000000800&shot=tabs-confirmed,tabs-rule'], ['tabs-hover', 'capture-tabs.html', async (p) => { await p.hover('.tabs-row >> nth=1'); }],
  ['tabs-search', 'capture-tabs.html', async (p) => { await p.fill('#tabs-search', 'attention'); await p.waitForTimeout(300); }],
  ['tabs-none', 'capture-tabs.html', async (p) => { await p.click('#tabs-invert'); await p.waitForTimeout(200); }],
  ['tabs-folder', 'capture-tabs.html', async (p) => { await p.selectOption('#tabs-target', { index: 2 }); await p.waitForTimeout(200); }],
  // Site adapters: off, an account to confirm, connected with an archive, a scan, a preview, an unsupported browser, a failed read,
  // a root on hold, no bookmark access, the review rows (associations, restored backups) and community packages.
  ['sites-off', 'site-adapters.html'], ['sites-waiting', 'site-adapters.html?shot=site-waiting'], ['sites-candidate', 'site-adapters.html?shot=site-candidate'],
  ['sites-choose', 'site-adapters.html?shot=site-choose'], ['sites-reading', 'site-adapters.html?shot=site-choose,site-reading'],
  ['sites-many', 'site-adapters.html?shot=site-choose,site-many', async (p) => { await p.click('#select-all'); await p.click('#archive-root'); await p.waitForTimeout(300); }],
  ['sites-notab', 'site-adapters.html?shot=site-on,site-notab'], ['sites-on', 'site-adapters.html?shot=site-on'],
  ['sites-settings', 'site-adapters.html?shot=site-on', click('#site-configure')],
  ['sites-options', 'site-adapters.html?shot=site-on', async (p) => { await p.click('#site-configure'); await open('#archive-options')(p); }],
  ['sites-scan', 'site-adapters.html?shot=site-scan'], ['sites-preview', 'site-adapters.html?shot=site-preview'],
  ['sites-preparing', 'site-adapters.html?shot=site-preparing'], ['sites-saving', 'site-adapters.html?shot=site-saving'],
  ['sites-sync-wait', 'site-adapters.html?shot=site-sync-wait,site-notab'], ['sites-cancelled', 'site-adapters.html?shot=site-cancelled,site-notab'],
  ['sites-complete', 'site-adapters.html?shot=site-complete'], ['sites-paused', 'site-adapters.html?shot=site-paused'],
  ['sites-history', 'site-adapters.html?shot=site-paused', open('#site-history')],
  ['sites-attention', 'site-adapters.html?shot=site-attention'], ['sites-item-review', 'site-adapters.html?shot=site-attention', open('#reconcile-details')],
  ['sites-all-skipped', 'site-adapters.html?shot=site-all-skipped', open('#import-omissions')],
  ['sites-unsupported', 'site-adapters.html?shot=site-unsupported'], ['sites-error', 'site-adapters.html?shot=site-error'],
  ['sites-hold', 'site-adapters.html?shot=site-hold'], ['sites-noperm', 'site-adapters.html?shot=noperm'],
  ['sites-review', 'site-adapters.html?shot=site-on,site-repair#recovery', async (p) => { await p.click('#read-bindings'); await p.click('#repair-status'); await p.click('#reconcile-history-load'); await p.waitForTimeout(300); await p.click('#reconcile-history-list [data-run-id="run-2"]'); await p.waitForTimeout(400); }],
  ['sites-tools', 'site-adapters.html?shot=site-on', open('#site-tools')], ['sites-cloud', 'site-adapters.html?shot=site-on#cloud'],
  ['sites-packages', 'site-adapters.html?shot=site-on,site-packages#packages', async (p) => { await p.setInputFiles('#community-file', packageFile); await p.waitForTimeout(400); }],
  // Help: the ingress list ("Bookmarks not included in sync") with real rows
  ['help-ingress', `${R}?shot=ingress#help?category=sync`],
];

async function settle(page, url, prepare) {
  await page.goto('about:blank');
  await page.goto(`http://localhost:${port}/${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  // The pointer stays where the last state left it; park it in the corner so no button reads as hovered.
  await page.mouse.move(0, 0);
  if (prepare) await prepare(page);
  await page.waitForTimeout(300);
}
/** Seed the annotation store (same origin) so tags and notes render on the options pages and in tag autocomplete. */
async function seedAnnotations(page) {
  await page.goto(`http://localhost:${port}/brand-wordmark.svg`);
  await page.evaluate(() => new Promise((done, fail) => {
    const rows = [
      { nativeId: 'b-gh', url: 'https://github.com/adeze/raindrop-mcp', tags: ['mcp', 'raindrop'], note: 'Compare with our own MCP server before the Oct release.' },
      { nativeId: 'b-an', url: 'https://www.anthropic.com/research/building-effective-agents', tags: ['agents'], note: null },
      { nativeId: 'b-zp', url: 'https://zapier.com/apps/instapaper/integrations', tags: ['automation', 'zapier'], note: null },
      { nativeId: 'b-long', url: 'https://very-long-domain-name.example.com', tags: ['a-fairly-long-tag-name', 'another-long-tag', 'research', 'ai', 'reading'],
        note: 'A long note that goes on and on so the one-line clamp has to cut it off with an ellipsis before it reaches the edge of the row.' },
    ];
    const request = indexedDB.open('known-bookmark-annotations', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('bookmarks', { keyPath: 'nativeId' }); };
    request.onsuccess = () => {
      const tx = request.result.transaction('bookmarks', 'readwrite');
      for (const row of rows) tx.objectStore('bookmarks').put({ ...row, updatedAt: 1, version: 1 });
      tx.oncomplete = () => { request.result.close(); done(); }; tx.onerror = () => fail(tx.error);
    };
    request.onerror = () => fail(request.error);
  }));
}
const track = (page) => {
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_UNKNOWN_URL_SCHEME')) console.log('CONSOLE.ERROR:', m.text().slice(0, 160)); });
};

// ---- options pages -------------------------------------------------------------------------------------------
for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (fixedTime) await page.clock.setFixedTime(fixedTime);
  await page.addInitScript(installStub, messages);
  track(page);
  const shoot = async (name, url, prepare, full = true) => {
    const file = `${locale}-${width}-${name}`;
    if (!wanted(file)) return;
    try {
      await settle(page, url, prepare);
      await page.screenshot({ path: join(out, `${file}.png`), fullPage: full });
      console.log('shot', file);
    } catch (e) { console.log('FAIL', file, e.message.split('\n')[0]); }
  };
  for (const [name, route] of PAGES) await shoot(`in-${name}`, `options.html#${route}`);
  for (const [name, route] of PAGES) await shoot(`out-${name}`, `options.html?shot=signedout#${route}`);
  for (const [name, url, prepare, full] of STATES) await shoot(name, url, prepare, full);
  await seedAnnotations(page);
  for (const [name, url, prepare, full] of LIBRARY) await shoot(name, url, prepare, full);
  await page.close();
}

// ---- popup (380 wide, as tall as its content up to 600) -------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  if (fixedTime) await page.clock.setFixedTime(fixedTime);
  await page.addInitScript(installStub, messages);
  track(page);
  /** Seed the annotation store (same origin) so tag autocomplete has something to offer. */
  const seedTags = async () => {
    await page.goto(`http://localhost:${port}/brand-wordmark.svg`);
    await page.evaluate(() => new Promise((done, fail) => {
      const request = indexedDB.open('known-bookmark-annotations', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('bookmarks', { keyPath: 'nativeId' }); };
      request.onsuccess = () => {
        const tx = request.result.transaction('bookmarks', 'readwrite');
        [['a', ['automation', 'automotive', 'api']], ['b', ['automation', 'apps']], ['c', ['zapier-tips']]]
          .forEach(([id, tags]) => tx.objectStore('bookmarks').put({ nativeId: id, url: null, tags, note: null, updatedAt: 1, version: 1 }));
        tx.oncomplete = () => done(); tx.onerror = () => fail(tx.error);
      };
    }));
  };
  const popup = async (name, shot, prepare, { seed = false } = {}) => {
    const file = `${locale}-380-popup-${name}`;
    if (!wanted(file)) return;
    try {
      if (seed) await seedTags();
      await settle(page, `popup.html${shot.startsWith('?') ? shot : `?shot=${shot}`}`, prepare);
      const height = await page.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
      await page.screenshot({ path: join(out, `${file}.png`), clip: { x: 0, y: 0, width: 380, height: Math.min(Math.max(height, 40), 600) } });
      console.log('shot', file, height);
    } catch (e) { console.log('FAIL', file, e.message.split('\n')[0]); }
  };
  // A popup with no folder yet opens its picker by itself; open it only when it is still closed.
  const pickerOpen = async (p) => { if (await p.locator('#dest-panel').isHidden()) await p.click('#dest-toggle'); await p.waitForTimeout(500); };
  const suggest = async (p) => { await p.click('#folder-suggest'); await p.waitForTimeout(500); };
  // Manual capture
  await popup('manual', 'manual');
  // A page two of the Owner's risk lists name (doc 17 RW-16), and its exception choices.
  await popup('risk', 'manual,risk');
  await popup('risk-except', 'manual,risk', async (p) => { await p.click('#risk-notice .risk-notice-actions button >> nth=1'); await p.waitForTimeout(200); });
  await popup('sync-progress', 'manual,syncrun');
  await popup('sync-progress-paused', 'manual,syncrun,ps-paused');
  await popup('manual-signedout', 'manual,signedout');
  await popup('picker', 'manual', pickerOpen);
  await popup('picker-new', 'manual', async (p) => { await pickerOpen(p); await p.click('#folder-new-open'); await p.keyboard.type('Reading'); });
  // A nested tree folds past its first level; a recent folder opens onto its subfolders; a search lists paths.
  await popup('picker-big', 'manual,bigtree', pickerOpen);
  await popup('picker-recent-open', 'manual,bigtree', async (p) => { await pickerOpen(p); await p.click('[data-folder-group="recent"] [data-folder-id="f-prog"] .folder-twisty'); await p.waitForTimeout(200); });
  await popup('picker-branch-open', 'manual,bigtree', async (p) => { await pickerOpen(p); await p.click('[data-folder-group="all"] [data-folder-id="f-research"] .folder-twisty'); await p.waitForTimeout(200); });
  await popup('picker-search', 'manual,bigtree', async (p) => { await pickerOpen(p); await p.keyboard.type('py'); await p.waitForTimeout(200); });
  await popup('suggest', 'manual,suggest');
  await popup('suggesting', 'manual,suggest,suggesting', (p) => p.click('#folder-suggest'));
  await popup('suggested', 'manual,suggest', suggest);
  await popup('suggested-applied', 'manual,suggest', async (p) => { await suggest(p); await p.click('#folder-suggest'); });
  const applySuggestion = async (p) => { await suggest(p); await p.click('#folder-suggest'); await p.waitForTimeout(300); };
  const another = async (p) => { await applySuggestion(p); await p.click('#folder-retry'); await p.waitForTimeout(500); };
  await popup('suggested-applied-long', 'manual,suggest,longfolder', applySuggestion);
  await popup('suggest-another', 'manual,suggest', another);
  await popup('suggest-another-long', 'manual,suggest,longfolder', another);
  await popup('suggest-another-running', 'manual,suggest,retrying,longfolder', another);
  await popup('tags', 'manual', async (p) => {
    await p.click('#tag-text'); await p.keyboard.type('web,design,'); await p.keyboard.type('auto');
    await p.fill('#note-text', 'Compare with our own MCP server before the Oct release. Check the rate limits, the pagination behaviour and how they handle bulk updates, then write up the differences for the team so we can decide on the approach before the roadmap review next week.');
  }, { seed: true });
  await popup('tags-ai', 'manual,suggest', async (p) => { await suggest(p); await p.click('#tag-suggest button'); });
  await popup('existing', 'manual,existing');
  await popup('perm', 'manual,perm');
  await popup('error', 'manual', (p) => p.evaluate(() => document.getElementById('save').click()));
  await popup('note-attention', 'manual,attention');
  await popup('boot', 'autoboot');
  await popup('longtitle', 'manual,longtitle,longfolder');
  await popup('nofavicon', 'manual,nofavicon');
  // Pre-save rules: the rule's folder before Save, then what the save did
  const saveNow = async (p) => { await p.click('#save'); await p.waitForTimeout(700); };
  await popup('rule', 'manual,rule');
  await popup('rule-saved', 'manual,rule', saveNow);
  await popup('rule-picked', 'manual,rule', async (p) => { await pickerOpen(p); await p.click('#folder-tree [role="option"] >> nth=1'); await p.waitForTimeout(300); });
  await popup('rule-blocked-saved', 'manual,ruleblocked', saveNow);
  await popup('auto-rule', 'autorule');
  await popup('auto-rule-blocked', 'autoruleblocked');
  await popup('rule-observed', 'manual,observed');
  // New automation results (AW-60): what the toolbar's count means
  await popup('digest', 'manual,digest');
  await popup('digests-stale', 'manual,digests-stale');
  await popup('auto-digest', 'auto,digest');
  await popup('auto-activity', 'auto,activity');
  await popup('auto-activity-stale', 'auto,activity-stale');
  await popup('stuck', 'manual,stuck');
  // Automatic capture result card
  await popup('auto', 'auto');
  await popup('auto-undone', 'auto', async (p) => { await p.click('#capture-undo'); await p.waitForTimeout(1000); });
  await popup('auto-picker', 'auto', pickerOpen);
  await popup('auto-local', 'autolocal');
  await popup('auto-attention', 'autoattention');
  await popup('auto-waiting', 'autowaiting');
  await popup('auto-existing', 'autoexisting');
  await popup('auto-noline', 'autonoline');
  await popup('preview-compact', '?preview=compact');
  await popup('preview-expanded', '?preview=expanded');
  await page.close();
}
await browser.close();
server.close();
