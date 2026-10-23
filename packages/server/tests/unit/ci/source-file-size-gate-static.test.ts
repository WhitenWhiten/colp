import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  evaluateSourceFileSizes,
  inspectProductionSourceFileSizes,
} from '../../../scripts/check-source-file-sizes.mjs';

/**
 * The gate the node and extension packages already run. The server lost its
 * copy when the upstream suite was dropped (db332c7a) and its baseline
 * (386bee6f), so files could grow without bound.
 */
const backendRoot = resolve(import.meta.dirname, '../../..');
const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
  readonly scripts: Readonly<Record<string, string>>;
};
const workflow = readFileSync(resolve(backendRoot, '../../.github/workflows/colp-ci.yml'), 'utf8');
const baseline = JSON.parse(
  readFileSync(resolve(backendRoot, 'tests/fixtures/source-file-size-baseline.json'), 'utf8'),
) as { maximumNewFileLines: number; grandfathered: Record<string, number> };

describe('server source-size ratchet [SYNC-Q-018]', () => {
  test('a 601-line new file fails and a grandfathered file cannot grow', () => {
    assert.equal(baseline.maximumNewFileLines, 600);
    assert.deepEqual(
      evaluateSourceFileSizes({ 'src/new-module.ts': 601 }, { ...baseline, grandfathered: {} }),
      ['src/new-module.ts: 601 lines exceeds the new-file limit 600'],
    );
    const [path, cap] = Object.entries(baseline.grandfathered)[0]!;
    assert.match(evaluateSourceFileSizes({ [path]: cap + 1 }, { ...baseline, grandfathered: { [path]: cap } })[0] ?? '',
      /grew from its /u);
  });

  test('runs as its own step in the server CI job', () => {
    assert.equal(packageJson.scripts['check:source-size'], 'node scripts/check-source-file-sizes.mjs');
    assert.match(workflow, /- name: Source-size ratchet\n\s+run: npm run check:source-size\n\s+working-directory: packages\/server\n/u);
  });

  test('current src tree stays within the shrinking-only baseline', async () => {
    const result = await inspectProductionSourceFileSizes();
    assert.deepEqual(result.errors, []);
    assert.ok(result.fileCount > 0);
  });
});
