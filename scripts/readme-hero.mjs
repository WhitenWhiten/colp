#!/usr/bin/env node
/**
 * Lays a web screenshot and an extension popup screenshot out as the README hero.
 *
 *   node scripts/readme-hero.mjs <web.png> <popup.png> <out.png>
 *
 * Both images keep their pixel size, so nothing is resampled. Run through xvfb
 * from scripts/capture-readme.mjs.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [webPath, popupPath, outPath] = process.argv.slice(2);
if (!outPath) throw new Error('usage: readme-hero.mjs <web.png> <popup.png> <out.png>');
const { chromium } = createRequire(resolve(import.meta.dirname, '../packages/web/package.json'))('@playwright/test');
const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const MARGIN = 40, BAR = 36, WEB = { width: 1280, height: 800 }, POPUP_WIDTH = 380;
const width = MARGIN + WEB.width + MARGIN + POPUP_WIDTH / 2, height = MARGIN + BAR + WEB.height + MARGIN * 2;

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${width}px; height: ${height}px; background: #e9ecf1; position: relative; overflow: hidden;
    font: 13px Inter, 'Segoe UI', system-ui, sans-serif; color: #4b5563; }
  .window { position: absolute; left: ${MARGIN}px; top: ${MARGIN}px; width: ${WEB.width}px; border-radius: 12px; overflow: hidden;
    background: #fff; box-shadow: 0 1px 2px rgb(15 23 42 / .08), 0 24px 64px rgb(15 23 42 / .16); }
  .bar { height: ${BAR}px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #f6f7f9; border-bottom: 1px solid #e5e7eb; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #d4d7dd; }
  .url { margin-left: 16px; padding: 4px 14px; border-radius: 999px; background: #fff; border: 1px solid #e5e7eb; }
  .window img, .popup img { display: block; }
  .popup { position: absolute; right: ${MARGIN}px; bottom: ${MARGIN}px; width: ${POPUP_WIDTH}px; border-radius: 12px; overflow: hidden;
    background: #fff; box-shadow: 0 1px 2px rgb(15 23 42 / .1), 0 28px 72px rgb(15 23 42 / .28); }
</style>
<div class="window"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
  <span class="url">colp.example/library</span></div><img src="${dataUrl(webPath)}" width="${WEB.width}" height="${WEB.height}" alt=""></div>
<div class="popup"><img src="${dataUrl(popupPath)}" width="${POPUP_WIDTH}" alt=""></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: outPath });
} finally {
  await browser.close();
}
