import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  createCollectionOgImageRenderer,
  loadOgBrandAssets,
} from '../../../src/infrastructure/http/index.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdrSize(png: Buffer): { readonly width: number; readonly height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('renders a 1200x630 PNG for a mixed-script collection card', async () => {
  const renderer = createCollectionOgImageRenderer();
  const png = await renderer.render({
    slug: 'llm-path',
    title: 'LLM 学习路径 — from prompts to evals',
    curator: 'Ada Curator',
    itemCount: 7,
    updatedAt: '2026-08-29T04:19:21.427Z',
  });
  assert.ok(png.subarray(0, 8).equals(PNG_MAGIC));
  assert.deepEqual(ihdrSize(png), { width: 1200, height: 630 });
});

test('memoizes by slug+updatedAt; a content change re-renders', async () => {
  const renderer = createCollectionOgImageRenderer();
  const input = {
    slug: 'llm-path',
    title: 'LLM path',
    curator: 'Ada',
    itemCount: 7,
    updatedAt: '2026-08-29T04:19:21.427Z',
  };
  const first = await renderer.render(input);
  const again = await renderer.render(input);
  assert.ok(first === again, 'same content key must return the cached buffer');
  assert.equal(renderer.size, 1);
  const edited = await renderer.render({ ...input, updatedAt: '2026-08-30T00:00:00.000Z' });
  assert.ok(first !== edited);
  assert.equal(renderer.size, 2);
});

test('evicts the oldest card past the entry bound', async () => {
  const renderer = createCollectionOgImageRenderer({ maxEntries: 2 });
  const base = { title: 'T', curator: 'C', itemCount: 1, updatedAt: '2026-08-01T00:00:00.000Z' };
  await renderer.render({ ...base, slug: 'a-slug' });
  await renderer.render({ ...base, slug: 'b-slug' });
  await renderer.render({ ...base, slug: 'c-slug' });
  assert.equal(renderer.size, 2);
});

test('vendored brand mark stays byte-identical to the site favicon', () => {
  const frontendFavicon = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../Known-Frontend/web/public/favicon.svg',
  );
  assert.equal(loadOgBrandAssets().brandMarkSvg, readFileSync(frontendFavicon, 'utf8'));
});
