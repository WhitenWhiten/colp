import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { capturePopupTarget } from './capture-popup-cdp.js';

const extensionPath = resolve(import.meta.dirname, process.env.KNOWN_EXTENSION_E2E_ARTIFACT === 'production' ? '../dist/production' : '../dist/development');

test('manual and automatic popups retry later explicitly while preserving the default and saving once', async ({}, testInfo) => {
  test.setTimeout(90_000);
  let providerCalls = 0;
  let failNext = false;
  let abstainNext = false;
  const folderOptions: string[][] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'text/html'); response.end('<title>Manual classification fixture</title><p>Pasta recipes</p>'); return;
    }
    providerCalls++;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { questions: Record<string, { type: string; criteria: Record<string, string> }> };
    if (failNext) { failNext = false; response.end(JSON.stringify({ model: 'jev-1.13.0', answers: {} })); return; }
    if (Object.values(body.questions).some(question => question.type === 'choice' && Object.keys(question.criteria).length < 2)) {
      response.statusCode = 400; response.end('{}'); return;
    }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      if (question.type === 'noul') return [key, { noul: 1 }];
      const options = Object.keys(question.criteria);
      folderOptions.push(options);
      const choice = (providerCalls === 1 || providerCalls === 3 || abstainNext) && options.includes('later') ? 'later'
        : options.includes('parent_root') ? 'parent_root'
          : options.find(option => question.criteria[option]?.includes('Recipes')) ?? options[0]!;
      if (choice === 'later') abstainNext = false;
      return [key, { choice, confidence: 1, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) }];
    }));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'jev-1.13.0', answers }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
  const origin = `http://127.0.0.1:${address.port}`, endpoint = `${origin}/classify`, pageUrl = `${origin}/pasta`;
  const profile = await mkdtemp(resolve(tmpdir(), 'known-manual-classification-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
      '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    ] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const options = context.pages().find(page => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known manual suggestions');
    const folder = await options.evaluate(() => chrome.bookmarks.create({ parentId: '1', title: 'Recipes' }));
    const defaultFolder = await options.evaluate(async () => {
      const node = await chrome.bookmarks.create({ parentId: '1', title: 'Default inbox' });
      await chrome.storage.local.set({ 'known.sync.folder.v1': { collectionId: 'device', folderNativeId: node.id } });
      return node;
    });
    await options.locator('#nav-ai').click();
    await expect(options.locator('#capture-manual-suggestions')).toHaveAttribute('aria-checked', 'false');
    await options.locator('#classification-source-own').check();
    await expect(options.locator('#classification-local-settings')).toBeVisible();
    await options.locator('#classification-local-advanced > summary').click();
    await options.locator('#classification-local-preset').selectOption('custom');
    await options.locator('#classification-local-endpoint').fill(endpoint);
    await options.locator('#classification-local-model').fill('jev-1.13.0');
    await options.locator('#classification-local-disclosure').check();
    await grantOptionalBookmarks(options, 'Use this AI service', 'Known local provider', { origins: [`${origin}/*`] });
    await expect(options.locator('#classification-local-status')).toHaveAttribute('data-active', 'true');
    await expect(options.locator('#classification-local-disclosure-option')).toBeHidden();
    await options.reload();
    await expect(options.locator('#classification-local-disclosure-option')).toBeHidden();
    await options.locator('#nav-saving').click();
    await expect(options.locator('#capture-manual-suggestions')).toHaveAttribute('aria-checked', 'false');
    await options.locator('#capture-manual-suggestions').click();
    await expect(options.locator('#capture-manual-suggestions')).toBeEnabled();
    expect(await options.evaluate(() => chrome.storage.local.get('known.classification.manual-auto-suggest.v1')))
      .toMatchObject({ 'known.classification.manual-auto-suggest.v1': true });
    // Capture the actual Chinese settings, including the existing choice-card styles.
    await options.locator('#nav-general').click();
    await options.locator('#ui-language').selectOption('zh-CN');
    await options.locator('#nav-saving').click();
    await expect(options.locator('#capture-manual-suggestions')).toHaveAttribute('aria-checked', 'true');
    await expect(options.locator('#manual-classification-settings')).toContainText('打开表单时给出建议');
    await options.locator('#pref-capture').screenshot({ path: testInfo.outputPath('manual-settings.png') });
    await options.locator('#nav-ai').click();
    await options.locator('#classification-local-settings').screenshot({ path: testInfo.outputPath('local-enabled.png') });
    const active = await context.newPage(); await active.goto(pageUrl);
    let popup = await capturePopupTarget(context, profile, active);
    async function clickPopup(id: string, surface = popup) {
      const point = await surface.evaluate<{ x: number; y: number }>(`(() => { const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await surface.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await surface.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    await expect.poll(() => popup.evaluate<string>('document.getElementById("folder-suggest-label")?.textContent')).toBe('再次建议');
    expect(providerCalls).toBe(1);
    expect(await popup.evaluate<string>('document.getElementById("dest-folder")?.textContent')).toBe('Default inbox');
    // Closing an unfinished form must observe the same suggestion on reopening.
    await popup.evaluate('window.close()').catch(() => undefined);
    await active.bringToFront();
    popup = await capturePopupTarget(context, profile, active);
    await expect.poll(() => popup.evaluate<string>('document.getElementById("folder-suggest-label")?.textContent')).toBe('再次建议');
    expect(providerCalls).toBe(1);
    await clickPopup('folder-suggest');
    await expect.poll(() => popup.evaluate<string>('document.getElementById("folder-suggest")?.dataset.state')).toBe('apply');
    expect(providerCalls).toBe(2);
    expect(folderOptions[1]).not.toContain('later');
    expect(await popup.evaluate<string>('document.getElementById("dest-folder")?.textContent')).toBe('Default inbox');
    await clickPopup('folder-suggest');
    await expect.poll(() => popup.evaluate<string>('document.getElementById("dest-folder")?.textContent')).toContain('Recipes');
    expect(providerCalls).toBe(2);
    await expect.poll(() => popup.evaluate<string>('document.getElementById("dest-folder")?.textContent')).toContain('Recipes');
    expect(await popup.evaluate<boolean>('document.getElementById("folder-suggest")?.hidden')).toBe(true);
    expect(await popup.evaluate<boolean>('document.getElementById("ai-mark")?.hidden')).toBe(false);
    expect(await options.evaluate(url => chrome.bookmarks.search({ url }), pageUrl)).toHaveLength(0);
    const screenshot = await popup.send('Page.captureScreenshot', {}) as { data: string };
    await writeFile(testInfo.outputPath('manual-candidates.png'), Buffer.from(screenshot.data, 'base64'));
    await clickPopup('save');
    await expect.poll(async () => (await options.evaluate(url => chrome.bookmarks.search({ url }), pageUrl)).map(node => node.parentId)).toEqual([folder.id]);
    expect(await options.evaluate(() => chrome.storage.local.get('known.sync.folder.v1')))
      .toMatchObject({ 'known.sync.folder.v1': { folderNativeId: defaultFolder.id } });
    expect(providerCalls).toBe(2);
    await popup.evaluate('window.close()').catch(() => undefined);
    // An already-saved page still offers explicit suggestions, but never runs one on form-open.
    await active.bringToFront();
    const existing = await capturePopupTarget(context, profile, active);
    await expect.poll(() => existing.evaluate<string>('document.body.dataset.existing')).toBe('edit');
    await expect.poll(() => existing.evaluate<string>('document.getElementById("folder-suggest")?.dataset.state')).toBe('run');
    expect(providerCalls).toBe(2);
    expect(await options.evaluate(url => chrome.bookmarks.search({ url }), pageUrl)).toHaveLength(1);
    await existing.evaluate('window.close()').catch(() => undefined);
    await options.bringToFront();
    await options.locator('#nav-saving').click();
    // A disabled switch must keep the next real popup from spending a provider call.
    await options.locator('#capture-manual-suggestions').click();
    await expect(options.locator('#capture-manual-suggestions')).toHaveAttribute('aria-checked', 'false');
    await expect(options.locator('#capture-manual-suggestions')).toBeEnabled();
    await active.goto(`${origin}/next`);
    await active.bringToFront();
    const quiet = await capturePopupTarget(context, profile, active);
    await expect.poll(() => quiet.evaluate<string>('document.body.dataset.captureMode')).toBe('manual');
    // The popup now always offers an on-demand Suggest chip; with the switch off it must not run by itself.
    await expect.poll(() => quiet.evaluate<string>('document.getElementById("folder-suggest")?.dataset.state')).toBe('run');
    expect(await quiet.evaluate(`(async () => ({ url: document.getElementById('tab-url').value, once: await chrome.storage.session.get('known.sync.folder.once.v1'), defaultFolder: await chrome.storage.local.get('known.sync.folder.v1') }))()`))
      .toEqual({ url: `${origin}/next`, once: {}, defaultFolder: { 'known.sync.folder.v1': { collectionId: 'device', folderNativeId: defaultFolder.id } } });
    await expect.poll(() => quiet.evaluate<string>('document.getElementById("dest-folder")?.textContent')).toBe('Default inbox');
    expect(providerCalls).toBe(2);
    expect(await quiet.evaluate(`chrome.runtime.sendMessage({kind:'known.classification.local-preview',automatic:true,commandId:crypto.randomUUID(),document:{source:'extension',bookmark:{title:'Pasta',url:${JSON.stringify(pageUrl)},description:null},requested:{folder:true,tags:false}}})`))
      .toMatchObject({ ok: false, error: 'manual_suggestions_disabled' });
    await quiet.evaluate('window.close()').catch(() => undefined);
    await options.bringToFront();
    await options.locator('#nav-saving').click();
    await options.getByRole('radio', { name: /^自动/ }).check();
    await options.getByRole('button', { name: '保存自动模式' }).click();
    await expect.poll(() => options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' })))
      .toMatchObject({ preferences: { captureMode: 'automatic' } });
    const automaticUrl = `${origin}/automatic-later`;
    await active.goto(automaticUrl);
    const automatic = await capturePopupTarget(context, profile, active);
    await expect.poll(() => automatic.evaluate<string>('document.getElementById("folder-suggest-label")?.textContent')).toBe('再次建议');
    expect(providerCalls).toBe(3);
    const before = await options.evaluate(url => chrome.bookmarks.search({ url }), automaticUrl);
    expect(before).toHaveLength(1);
    expect(before[0]!.parentId).toBe(defaultFolder.id);
    await clickPopup('folder-suggest', automatic);
    await expect.poll(() => automatic.evaluate<string>('document.getElementById("folder-suggest")?.dataset.state')).toBe('apply');
    expect(providerCalls).toBe(4);
    expect(folderOptions[3]).not.toContain('later');
    expect((await options.evaluate(url => chrome.bookmarks.search({ url }), automaticUrl))[0]!.parentId).toBe(defaultFolder.id);
    await clickPopup('folder-suggest', automatic);
    await expect.poll(async () => (await options.evaluate(url => chrome.bookmarks.search({ url }), automaticUrl))
      .map(node => ({ id: node.id, parentId: node.parentId }))).toEqual([{ id: before[0]!.id, parentId: folder.id }]);
    expect(await options.evaluate(() => chrome.storage.local.get('known.sync.folder.v1')))
      .toMatchObject({ 'known.sync.folder.v1': { folderNativeId: defaultFolder.id } });
    await automatic.evaluate('window.close()').catch(() => undefined);
    failNext = true;
    const failedUrl = `${origin}/automatic-failure`;
    await active.goto(failedUrl);
    const failed = await capturePopupTarget(context, profile, active);
    await expect.poll(() => failed.evaluate<string>('document.getElementById("folder-suggest-label")?.textContent')).toBe('再试一次');
    expect(await failed.evaluate<string>('document.getElementById("capture-alert-text")?.textContent')).toContain('回复格式异常');
    expect(providerCalls).toBe(5);
    const savedAfterFailure = await options.evaluate(url => chrome.bookmarks.search({ url }), failedUrl);
    expect(savedAfterFailure).toHaveLength(1);
    await clickPopup('folder-suggest', failed);
    await expect.poll(() => failed.evaluate<string>('document.getElementById("folder-suggest")?.dataset.state')).toBe('apply');
    expect(providerCalls).toBe(6);
    await clickPopup('folder-suggest', failed);
    await expect.poll(async () => (await options.evaluate(url => chrome.bookmarks.search({ url }), failedUrl))
      .map(node => ({ id: node.id, parentId: node.parentId }))).toEqual([{ id: savedAfterFailure[0]!.id, parentId: folder.id }]);
    await failed.evaluate('window.close()').catch(() => undefined);
    await options.evaluate(async ({ defaultId, parentId }) => { await chrome.bookmarks.move(defaultId, { parentId }); },
      { defaultId: defaultFolder.id, parentId: folder.id });
    abstainNext = true;
    const singleUrl = `${origin}/automatic-single-root`;
    await active.goto(singleUrl);
    const single = await capturePopupTarget(context, profile, active);
    await expect.poll(() => single.evaluate<string>('document.getElementById("folder-suggest-label")?.textContent')).toBe('再次建议');
    expect(providerCalls).toBe(7);
    const savedSingle = await options.evaluate(url => chrome.bookmarks.search({ url }), singleUrl);
    await clickPopup('folder-suggest', single);
    await expect.poll(() => single.evaluate<string>('document.getElementById("folder-suggest")?.dataset.state')).toBe('apply');
    expect(providerCalls).toBe(8);
    expect(folderOptions.at(-1)).toEqual(['f0', 'parent_root']);
    await clickPopup('folder-suggest', single);
    await expect.poll(async () => (await options.evaluate(url => chrome.bookmarks.search({ url }), singleUrl))
      .map(node => ({ id: node.id, parentId: node.parentId }))).toEqual([{ id: savedSingle[0]!.id, parentId: folder.id }]);
    await single.evaluate('window.close()').catch(() => undefined);
    await options.bringToFront();
    await options.locator('#nav-ai').click();
    await options.locator('#classification-local-disable').click();
    // Switching back to Know-N suggestions returns to that source; the service's settings reappear on request.
    await expect(options.locator('#classification-source-know-n')).toBeChecked();
    await options.locator('#classification-source-own').check();
    await expect(options.locator('#classification-local-disclosure-option')).toBeVisible();
    await expect(options.locator('#classification-local-disclosure')).not.toBeChecked();
    await expect(options.locator('#classification-local-status')).toHaveAttribute('data-active', 'false');
  } finally {
    await context?.close(); await rm(profile, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
