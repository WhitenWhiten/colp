import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateSourceFileSizes,
  inspectProductionSourceFileSizes,
} from '../../scripts/check-source-file-sizes.mjs';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
};
const workflow = readFileSync(resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'), 'utf8');
const baseline = JSON.parse(
  readFileSync(resolve(packageRoot, 'tests/fixtures/source-file-size-baseline.json'), 'utf8'),
) as { maximumNewFileLines: number; excludeFileNames?: readonly string[] };

describe('COLP source-size ratchet [SYNC-Q-018]', () => {
  it('rejects a 601-line new production file and excludes generated.ts', () => {
    expect(baseline.maximumNewFileLines).toBe(600);
    expect(baseline.excludeFileNames).toEqual(['generated.ts']);
    expect(
      evaluateSourceFileSizes({ 'src/new-module.ts': 601 }, { maximumNewFileLines: 600, grandfathered: {} }),
    ).toEqual(['src/new-module.ts: 601 lines exceeds the new-file limit 600']);
  });

  it('wires check:source-size into npm check and the static CI job', () => {
    expect(packageJson.scripts?.['check:source-size']).toBe('node scripts/check-source-file-sizes.mjs');
    expect(packageJson.scripts?.check).toContain('npm run check:source-size');
    expect(workflow).toContain('npm run check:source-size');
  });

  it('current src tree stays within the shrinking-only baseline', async () => {
    const result = await inspectProductionSourceFileSizes();
    expect(result.errors).toEqual([]);
    expect(result.fileCount).toBeGreaterThan(0);
  });
});
