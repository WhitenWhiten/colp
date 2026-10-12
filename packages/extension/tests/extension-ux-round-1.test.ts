import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

/* Extension UX round 1. */
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

describe('extension UX round 1', () => {
  test('R16-06: the chosen collection row says Syncing here in ink and every other row offers a button', async () => {
    const source = await read('src/sync-collections.ts');
    assert.match(source, /Syncing here/);
    assert.match(source, /Use this collection/);
    const css = await read('options.css');
    const chosen = rule(css, '.collection-row .set-row-value');
    assert.match(chosen, /color: var\(--ink\)/);
    assert.doesNotMatch(chosen, /--accent/);
  });

  test('R16-07: folder rows show the kind line only for the managed-by-policy reason', async () => {
    const source = await read('src/sync-folders.ts');
    assert.match(source, /meta\.textContent = folderMetaCopy\(root\); meta\.hidden = !root\.managed && root\.exclusionReason !== 'managed';/);
  });

  test('R16-08: nothing waiting means no waiting group and no explainer', async () => {
    const source = await read('src/native-wait-ui.ts');
    assert.match(source, /host\.hidden = waits\.length === 0;/);
    assert.match(source, /summary\.hidden = waits\.length === 0;/);
  });

  test('R16-09: the Save tabs list has no nested scroller and the footer stays sticky', async () => {
    const css = await read('options.css');
    const list = rule(css, '.tabs-list');
    assert.doesNotMatch(list, /max-height|overflow/);
    assert.match(rule(css, '.tabs-foot'), /position: sticky/);
  });

  // R16-10 (the offline override after the tab list) was retired by 8dfc0fc00: browser bookmarks are saved without a
  // remote lookup, so Save tabs no longer offers a "save even if Know-N can't check" override.
  test('R16-10: Save tabs has no cloud-check override left to place', async () => {
    const html = await read('capture-tabs.html');
    assert.doesNotMatch(html, /tabs-allow-cloud/);
  });
});
