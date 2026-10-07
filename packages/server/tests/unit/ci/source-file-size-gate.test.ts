import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  evaluateSourceFileSizes,
  inspectProductionSourceFileSizes,
} from '../../../scripts/check-source-file-sizes.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');

describe('production source-size ratchet [SYNC-Q-018]', () => {
  test('a 601-line new file fails and grandfathered files cannot grow', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(backendRoot, 'tests/fixtures/source-file-size-baseline.json'), 'utf8'),
    ) as { maximumNewFileLines: number; grandfathered: Record<string, number> };
    assert.equal(baseline.maximumNewFileLines, 600);
    assert.deepEqual(
      evaluateSourceFileSizes({ 'src/new-module.ts': 601 }, { ...baseline, grandfathered: {} }),
      ['src/new-module.ts: 601 lines exceeds the new-file limit 600'],
    );
    const [grandfatheredPath, cap] = Object.entries(baseline.grandfathered)[0]!;
    assert.match(
      evaluateSourceFileSizes({ [grandfatheredPath]: cap + 1 }, baseline)[0] ?? '',
      /grew from its /u,
    );
  });

  test('current src tree stays within the shrinking-only baseline', async () => {
    const result = await inspectProductionSourceFileSizes();
    assert.deepEqual(result.errors, []);
    assert.ok(result.fileCount > 0);
  });
});
