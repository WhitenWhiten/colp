import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

/**
 * Static boundary contract (allowlisted in tests/static-anchor-allowlist.ts): the
 * ownership of the canonical digest implementation and the absence of a second
 * browser digest module — neither has a runtime trace. Digest behaviour itself is
 * covered by the pull/effect suites.
 */
const productionSources = [
  'src/sw/evidence.ts',
  'src/pull-codec.ts',
  'src/effect-page-download.ts',
  'src/bookmark-import-plan.ts',
];

describe('SYNC-Q-020 Extension uses COLP ./sync/canonical', () => {
  test('deletes the duplicate browser digest module and imports the COLP subpath', async () => {
    assert.equal(existsSync(resolve('src/colp-authoritative-effect-browser.ts')), false);
    for (const file of productionSources) {
      const source = await readFile(resolve(file), 'utf8');
      assert.match(source, /@know-n\/colp\/sync\/canonical/);
      assert.doesNotMatch(source, /colp-authoritative-effect-browser/);
    }
  });

  test('production MV3 bundle does not embed node:crypto when dist exists', async () => {
    const bundle = resolve('dist/production/service-worker.js');
    if (!existsSync(bundle)) return;
    const source = await readFile(bundle, 'utf8');
    assert.doesNotMatch(source, /node:crypto/);
    assert.doesNotMatch(source, /createHash/);
    assert.match(source, /sha-256=:/);
  });
});
