import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
test('AC-11 compares actual shared controls and checks capture layouts at all planned widths', async () => {
  const webOrigin = process.env.KNOWN_CAPTURE_WEB_ORIGIN;
  test.skip(!webOrigin, 'Set KNOWN_CAPTURE_WEB_ORIGIN to the running Web client for visual parity evidence.');
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-visual-')), extension = resolve(import.meta.dirname, '../dist/production');
  const evidence = resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture');
  await mkdir(evidence, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const { page } = await openExtensionOptions(context), web = await context.newPage();
    await web.goto(`${webOrigin}/login`); await expect(web.locator('input[type=email]').first()).toBeVisible();
    await page.setViewportSize({ width: 768, height: 900 }); await web.setViewportSize({ width: 768, height: 900 });
    await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'extension-auth-controls.png'), fullPage: true });
    await web.screenshot({ animations: 'disabled', path: resolve(evidence, 'web-auth-controls.png'), fullPage: true });
    const metrics = async (surface: typeof page) => surface.locator('input[type=email]').first().evaluate(node => {
      const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color,
        borderColor: style.borderColor, borderRadius: style.borderRadius, background: style.backgroundColor };
    });
    const controls = { extension: await metrics(page), web: await metrics(web) };
    expect(controls.extension.borderRadius).toBe(controls.web.borderRadius);
    expect(controls.extension.color).toBe(controls.web.color);
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      // History, Saving settings and Help & diagnostics: the same reflow contract at every width.
      await page.locator('#nav-history').click();
      await expect(page.locator('[data-capture-view=history]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.locator('#nav-saving').click();
      await expect(page.locator('#bookmark-preferences')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.locator('#nav-help').click();
      for (const view of ['overview', 'diagnostics']) await expect(page.locator(`[data-capture-view=${view}]`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ animations: 'disabled', path: resolve(evidence, `diagnostics-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 768, height: 900 });
    await page.locator('#nav-saving').click();
    await page.bringToFront(); await page.evaluate(() => { document.title = 'Known capture visual zoom'; });
    const run = promisify(execFile); let windowId = '';
    await expect.poll(async () => { try { const windows = await run('xdotool', ['search', '--name', 'Known capture visual zoom']); windowId = windows.stdout.trim().split('\n').at(-1)!; return Boolean(windowId); } catch { return false; } }).toBe(true);
    await run('xdotool', ['windowfocus', '--sync', windowId]);
    await run('xdotool', ['key', 'ctrl+0']); const initialRatio = await page.evaluate(() => devicePixelRatio);
    await run('xdotool', ['key', '--repeat', '5', '--delay', '120', 'ctrl+plus']);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(initialRatio * 2);
    const zoom = await page.evaluate(() => ({ devicePixelRatio, cssWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(zoom.scrollWidth).toBeLessThanOrEqual(zoom.cssWidth);
    await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'settings-scale-200.png'), fullPage: true });
    await run('xdotool', ['key', 'ctrl+0']);
    await writeFile(resolve(evidence, 'shared-control-styles.json'), JSON.stringify({ actualPages: true, controls,
      browser: await context.browser()?.version(), widths: [1440, 1024, 768, 390, 320],
      zoom, scaleNote: 'Actual Chromium browser zoom using native Ctrl+plus; verified devicePixelRatio doubled. 320 CSS px reflow is separately tested.' }, null, 2));
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
