import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

for (const failed of [false, true]) test(`real options binder renders attention and feedback in Chromium (${failed})`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const html = await readFile('options.html', 'utf8');
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''));
  await page.evaluate(fail => {
    const status = { ok: true, firstRun: 'completed', phase: 'needs_attention',
      attention: { reportId: 'test', candidateCount: 0, conflictCount: 4, pendingCount: 4 } };
    Object.assign(window, { chrome: { storage: { local: { get: async () => ({}) } }, runtime: {
      sendMessage: async (message: { kind: string }) => message.kind === 'known.firstRun.status' ? status
        : fail ? { ok: false, error: 'request_invalid' } : { ...status, items: Array.from({ length: 4 }, (_, i) => ({
          itemId: `item-${i}`, kind: 'conflict', label: `Local bookmark ${i}`, decision: 'open', locationCount: 2 })) } } } });
  }, failed);
  const bundle = await build({ stdin: { contents: `import { bindFirstRunOnboarding } from './src/first-run-ui.ts';
    const el = id => document.getElementById(id);
    bindFirstRunOnboarding({ rootTree: el('root-tree'), saveRoots: el('save-roots'), requestPermission: el('request-bookmark-permission'),
      folderHeading: el('folder-heading'), folderIntro: el('folder-intro'), showPane() {} });`, resolveDir: process.cwd() },
    write: false, bundle: true, format: 'iife', platform: 'browser' });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(page.locator('#first-run-error')).toContainText('4 items');
  // options.html contains the actual button; click it through the browser DOM.
  await page.locator('#sync-card, #folder-card').evaluateAll(elements => { for (const element of elements) (element as HTMLElement).hidden = false; });
  await page.locator('#first-run-view-attention').click();
  if (failed) await expect(page.locator('#first-run-error')).toContainText('Could not load');
  else await expect(page.locator('#first-run-attention-list')).toContainText('Local bookmark 3');
  expect(errors).toEqual([]);
});
