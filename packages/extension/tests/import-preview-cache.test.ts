import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { IMPORT_PREVIEW_CACHE, clearImportPreviewCache, readImportPreviewCache,
  writeImportPreviewCache } from '../src/import-preview-cache.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

const fixture = (name: string) => readFile(resolve('tests/fixtures', name));

function fakeSessionArea() {
  const values = new Map<string, unknown>();
  return {
    values,
    async get(keys: string | string[] | null) {
      const wanted = typeof keys === 'string' ? [keys] : keys ?? [...values.keys()];
      return Object.fromEntries(wanted.filter((key) => values.has(key)).map((key) => [key, values.get(key)]));
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) values.set(key, JSON.parse(JSON.stringify(value)));
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key);
    },
  };
}

describe('P3-34 durable import preview cache', () => {
  test('a preview survives a service-worker restart: write, drop RAM, read by digest', async () => {
    // The RAM map dies with the MV3 worker between preview and commit; the
    // durable cache must return the exact same conversion for the digest.
    const conversion = previewNetscapeBookmarkImport(await fixture('chrome-bookmarks-export.html'));
    const area = fakeSessionArea();
    await writeImportPreviewCache(area, conversion);
    const restored = await readImportPreviewCache(area, conversion.digest);
    assert.deepEqual(restored, conversion);
  });

  test('fails closed on digest mismatch and on tampered stored bytes', async () => {
    const conversion = previewNetscapeBookmarkImport(await fixture('chrome-bookmarks-export.html'));
    const area = fakeSessionArea();
    await writeImportPreviewCache(area, conversion);
    assert.equal(await readImportPreviewCache(area, 'sha256:0000000000000000000000000000000000000000000000000000000000000000'),
      undefined);
    const stored = area.values.get(IMPORT_PREVIEW_CACHE) as { conversion: { tree: Array<{ title?: string }> } };
    stored.conversion.tree[0]!.title = 'tampered';
    assert.equal(await readImportPreviewCache(area, conversion.digest), undefined,
      'a stored conversion whose recomputed digest differs must be rejected');
  });

  test('rejects malformed records and clears cleanly', async () => {
    const area = fakeSessionArea();
    assert.equal(await readImportPreviewCache(area, 'sha256:x'), undefined);
    area.values.set(IMPORT_PREVIEW_CACHE, { conversion: 'not-an-object' });
    assert.equal(await readImportPreviewCache(area, 'sha256:x'), undefined);
    area.values.set(IMPORT_PREVIEW_CACHE, { conversion: { source: {}, duplicatePolicy: 'preserve-occurrences',
      preview: {}, tree: [], digest: 'sha256:x' } });
    assert.equal(await readImportPreviewCache(area, 'sha256:x'), undefined);
    const conversion = previewNetscapeBookmarkImport(await fixture('chrome-bookmarks-export.html'));
    await writeImportPreviewCache(area, conversion);
    await clearImportPreviewCache(area);
    assert.equal(await readImportPreviewCache(area, conversion.digest), undefined);
  });

  test('service worker rehydrates a commit after the RAM preview map is gone', async () => {
    const source = await readServiceWorkerGraph();
    assert.match(source, /readImportPreviewCache/);
    assert.match(source, /writeImportPreviewCache/);
    assert.match(source, /importPreviews\.clear/);
    // Commit must fall back to the durable cache before declaring expiry.
    assert.match(source, /importPreviews\.get\(message\.digest\)[\s\S]{0,200}readImportPreviewCache/);
    assert.match(source, /chrome\.storage\.session/);
    assert.match(source, /assertLiveNativeImportUnchanged/);
  });
});
