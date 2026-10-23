import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { capturePopupTarget } from './capture-popup-cdp.js';

test('automatic popup removes an existing bookmark and restores it through Undo', async () => {
  const server = createServer((_request, response) => { response.end('<title>Existing bookmark removal</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
  const pageUrl = `http://127.0.0.1:${address.port}/existing`;
  const profile = await mkdtemp(resolve(tmpdir(), 'known-popup-remove-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
      args: ['--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const options = context.pages()[0] ?? await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known existing bookmark removal');
    const bookmark = await options.evaluate(async url => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Original location' });
      await chrome.storage.local.set({ 'known.sync.folder.v1': { collectionId: 'device', folderNativeId: folder.id } });
      const node = await chrome.bookmarks.create({ parentId: folder.id, title: 'Already saved', url });
      return node;
    }, pageUrl);
    await options.locator('#nav-saving').click();
    await options.getByRole('radio', { name: /^Automatic/ }).check();
    await options.getByRole('button', { name: 'Save automatic mode' }).click();
    await expect.poll(() => options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' })))
      .toMatchObject({ preferences: { captureMode: 'automatic' } });
    const active = await context.newPage(); await active.goto(pageUrl);
    const popup = await capturePopupTarget(context, profile, active);
    await expect.poll(() => popup.evaluate<string>('document.body.dataset.captureMode')).toBe('automatic');
    await expect.poll(async () => {
      const state = await popup.evaluate<{ removeHidden: boolean; existing: string; text: string }>(
        '({removeHidden:document.getElementById("remove-bookmark")?.hidden,existing:document.body.dataset.existing,text:document.body.innerText.slice(0,1500)})');
      return state.removeHidden ? JSON.stringify(state) : 'editable';
    }).toBe('editable');
    async function click(id: string) {
      const point = await popup.evaluate<{ x: number; y: number }>(`(() => { const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await popup.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await popup.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    await click('remove-bookmark');
    await expect.poll(() => options.evaluate(parentId => chrome.bookmarks.getChildren(parentId!), bookmark.parentId)).toEqual([]);
    await expect.poll(() => popup.evaluate<string>('document.getElementById("capture-status-text")?.textContent')).toBe('Removed');
    await expect.poll(() => popup.evaluate<string>('document.getElementById("remove-bookmark")?.textContent')).toBe('Undo');
    await popup.evaluate('new Promise(resolve => setTimeout(resolve, 1100))');
    expect(await popup.evaluate<string>('document.getElementById("capture-status-text")?.textContent')).toBe('Removed');
    expect(await popup.evaluate<boolean>('document.getElementById("pp-fields")?.hidden')).toBe(true);
    await click('remove-bookmark');
    await expect.poll(async () => (await options.evaluate(parentId => chrome.bookmarks.getChildren(parentId!), bookmark.parentId))
      .map(node => ({ title: node.title, url: node.url }))).toEqual([{ title: 'Already saved', url: pageUrl }]);
  } finally {
    await context?.close(); await rm(profile, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
