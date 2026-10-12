import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateSourceFileSizes,
  inspectProductionSourceFileSizes,
} from '../scripts/check-source-file-sizes.mjs';

/**
 * CI gate contract (allowlisted in tests/static-anchor-allowlist.ts): the gate script,
 * its frozen 600-line limit and its npm/CI wiring are the artifacts under test. The
 * third case already runs the real evaluator over the live src tree.
 */
const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
};
const workflow = readFileSync(
  resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'),
  'utf8',
);

describe('Extension source-size ratchet [SYNC-Q-018]', () => {
  it('rejects a 601-line new production file', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(packageRoot, 'tests/fixtures/source-file-size-baseline.json'), 'utf8'),
    ) as { maximumNewFileLines: number };
    expect(baseline.maximumNewFileLines).toBe(600);
    expect(
      evaluateSourceFileSizes({ 'src/new-module.ts': 601 }, { maximumNewFileLines: 600, grandfathered: {} }),
    ).toEqual(['src/new-module.ts: 601 lines exceeds the new-file limit 600']);
  });

  it('wires check:source-size into npm and the static CI job', () => {
    expect(packageJson.scripts?.['check:source-size']).toBe('node scripts/check-source-file-sizes.mjs');
    expect(workflow).toContain('npm run typecheck && npm run lint && npm run check:source-size && npm run build');
  });

  it('current src tree stays within the shrinking-only baseline', async () => {
    const result = await inspectProductionSourceFileSizes();
    expect(result.errors).toEqual([]);
    expect(result.fileCount).toBeGreaterThan(0);
  });
});
