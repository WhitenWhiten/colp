import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('capture history hides Load more before the empty-state return', async () => {
  const source = await readFile(new URL('../src/capture/history-view.ts', import.meta.url), 'utf8');
  const paint = source.slice(source.indexOf('function paintRows()'), source.indexOf('async function load('));
  const hide = paint.indexOf('more.hidden = !next;');
  const empty = paint.indexOf('const holder = el(');
  assert.ok(hide >= 0, 'paintRows must set Load more visibility');
  assert.ok(empty > hide, 'an empty page must not return before Load more is hidden');
  assert.equal(paint.split('more.hidden = !next;').length - 1, 1);
});
