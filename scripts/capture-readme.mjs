#!/usr/bin/env node
/**
 * Captures the product screenshots the READMEs show, into docs/assets/screens.
 *
 *   node scripts/capture-readme.mjs [--skip-build] [--only extension,web,hero]
 *
 * Every image renders the real UI against synthetic data, never a live account:
 * the extension through its stubbed-browser shots harness (`npm run shots`, en
 * and zh_CN), the web app through a Playwright spec with mocked API routes
 * (packages/web/e2e/readme.capture.ts, English only, since the web app ships one
 * language), and the hero by laying those two out on one page. The clock is
 * pinned, so a rerun with unchanged UI produces the same images. Each browser
 * run goes through xvfb, as the repository's browser tests do. Needs ffmpeg,
 * and `npm ci` in packages/extension and packages/web.
 *
 * Files: <name>.<language>.png, where language is en or zh-CN. A README in a
 * language with no capture of its own uses the English one.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'docs/assets/screens');
const extension = join(root, 'packages/extension'), web = join(root, 'packages/web');
const xvfb = join(extension, 'scripts/with-xvfb.mjs');
const SHOT_TIME = '2026-10-28T09:30:00Z';
const HEIGHT = 800;

/** Extension harness state → README name. Options pages are cropped to the web shots' height. */
export const EXTENSION_SHOTS = Object.freeze({
  '380-popup-auto-rule': 'extension-popup',
  '1280-bm-folder': 'extension-bookmarks',
  '1280-automations-browser-runs': 'extension-rules',
  '1280-sites-complete': 'extension-sites',
});
export const WEB_SHOTS = Object.freeze(['web-library', 'web-approval', 'web-automations', 'web-activity', 'web-shared']);
const LOCALES = Object.freeze({ en: 'en', zh_CN: 'zh-CN' });

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set(args[onlyAt + 1]?.split(',')) : new Set(['extension', 'web', 'hero']);
const run = (command, argv, cwd, env = {}) => execFileSync(command, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const crop = (from, to) => run('ffmpeg', ['-y', '-loglevel', 'error', '-i', from, '-vf', `crop=iw:min(ih\\,${HEIGHT}):0:0`, to], root);

mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'colp-readme-'));
try {
  if (only.has('extension')) {
    if (!skipBuild) run('npm', ['run', 'build:development'], extension);
    for (const [locale, language] of Object.entries(LOCALES)) {
      const dir = join(scratch, `extension-${locale}`);
      run('npm', ['run', 'shots'], extension, { SHOT_OUT: dir, SHOT_LOCALE: locale, SHOT_WIDTHS: '1280', SHOT_TIME,
        SHOT_ONLY: Object.keys(EXTENSION_SHOTS).join(',') });
      for (const [shot, name] of Object.entries(EXTENSION_SHOTS)) crop(join(dir, `${locale}-${shot}.png`), join(out, `${name}.${language}.png`));
    }
  }
  if (only.has('web')) {
    const dir = join(scratch, 'web');
    run('node', [xvfb, 'npx', 'playwright', 'test', '-c', 'playwright.captures.config.ts'], web, { README_CAPTURE_OUT: dir });
    for (const name of WEB_SHOTS) copyFileSync(join(dir, `${name}.en.png`), join(out, `${name}.en.png`));
  }
  if (only.has('hero')) {
    for (const language of Object.values(LOCALES)) {
      run('node', [xvfb, 'node', join(root, 'scripts/readme-hero.mjs'), join(out, 'web-library.en.png'),
        join(out, `extension-popup.${language}.png`), join(out, `hero.${language}.png`)], root);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
