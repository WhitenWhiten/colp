import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { readEnglishSource } from './english-source.js';
import { describe, test } from 'vitest';

/* Extension UX round 2. */
const read = (path: string) => readEnglishSource(new URL(`../${path}`, import.meta.url));

describe('extension UX round 2', () => {
  test('R16-11: the Stay local pill is never washed in accent while its own box is unticked', async () => {
    const css = await read('options.css');
    assert.doesNotMatch(css, /\+ \.privacy-control:not\(:has\(input:checked\)\)/);
    for (const block of css.match(/[^{}]*\.privacy-control[^{}]*\{[^}]*\}/g) ?? []) {
      if (block.includes('.sync-pill')) continue;
      assert.doesNotMatch(block, /--accent/, `accent on the Stay local pill: ${block.trim()}`);
    }
  });

  test('R16-12: Remove bookmark access is a quiet link after the list, not a padlock in the pane header', async () => {
    const html = await read('options.html');
    const header = html.slice(html.indexOf('id="folder-heading"'), html.indexOf('id="root-alert"'));
    assert.doesNotMatch(header, /remove-bookmark-permission|data-icon="lock"/);
    assert.ok(html.indexOf('id="save-roots"') < html.indexOf('id="remove-bookmark-permission"'));
    assert.match(html, /<div class="page-foot-links">\s*(?:<!--[^>]*-->\s*)?<button id="remove-bookmark-permission" class="folder-revoke" type="button" hidden disabled>Remove bookmark access<\/button>/);
  });

  test('R16-13: the unsavable save button shares the popup\'s light disabled treatment', async () => {
    const css = await read('popup.css');
    const start = css.indexOf('.btn.btn-save[aria-disabled="true"],');
    const block = css.slice(start, css.indexOf('}', start));
    assert.match(block, /body\[data-unsavable\] \.btn\.btn-save:disabled \{/);
    assert.match(block, /background: var\(--paper-2\)/);
  });

  test('R16-14: Sync › Status leads with what stopped or waits; the deletion policy comes last', async () => {
    const html = await read('options.html');
    const summary = html.indexOf('id="sync-summary"');
    const attention = html.indexOf('id="sync-attention-settings"');
    const wait = html.indexOf('id="native-wait-settings"');
    const policy = html.indexOf('id="remote-delete-settings"');
    const pane = html.indexOf('id="sync-center"');
    assert.ok(pane < summary && summary < attention && attention < wait && wait < policy && policy < html.indexOf('id="import-card"'));
  });

  test('R16-15: grids holding selects give each value room for one line', async () => {
    const css = await read('options.css');
    // Save tabs: the two setup selects sit in settings rows and may use the whole row, so a folder path is never cut to a half-width select.
    assert.match(css, /\.tabs-setup \.select-quiet \{ max-width: 100%; \}/);
    assert.match(css, /\.tabs-setup \.set-row-control \{ max-width: 100%;/);
  });

  test('script-built dialogs come from createDialog so heading, body and actions are always styled', async () => {
    const files = (await readdir(new URL('../src', import.meta.url), { recursive: true })).filter((file) => file.endsWith('.ts') && file !== 'dialog.ts');
    for (const file of files) {
      assert.doesNotMatch(await read(`src/${file}`), /\b(?:createElement|element|el)\(\s*['"`]dialog['"`]/, `${file} builds a <dialog> by hand; use createDialog() from src/dialog.ts`);
    }
    const css = await read('options.css');
    for (const part of ['.capture-dialog {', '.capture-dialog > h3', '.capture-dialog-body {', '.capture-dialog-actions {']) assert.ok(css.includes(part), `options.css lost ${part}`);
  });
});
