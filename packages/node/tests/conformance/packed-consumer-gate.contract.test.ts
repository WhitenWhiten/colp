import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
};
const gate = readFileSync(resolve(packageRoot, 'scripts', 'packed-consumer-smoke.mjs'), 'utf8');

describe('packed npm consumer gate', () => {
  it('runs the actual tarball smoke after static package-shape checks', () => {
    expect(packageJson.scripts?.['pack:consumer-smoke']).toBe('node scripts/packed-consumer-smoke.mjs');
    expect(packageJson.scripts?.['pack:check']).toMatch(
      /npm pack --dry-run.+publint.+attw.+npm run pack:consumer-smoke/u,
    );
  });

  it('extracts the tarball without lifecycle scripts and probes every ESM/CJS export plus JSON Schema', () => {
    expect(gate).toContain("'pack', '--json'");
    expect(gate).toContain("'tar', ['-xzf'");
    expect(gate).toContain('linkInstalledDependency');
    expect(gate).not.toContain("'install'");
    expect(gate).toContain('Object.entries(packageJson.exports)');
    expect(gate).toContain("probeSource(specifiers, 'esm'");
    expect(gate).toContain("probeSource(specifiers, 'cjs'");
    expect(gate).toContain('/schema/collection-protocol.schema.json');
    expect(gate).toContain('assert.deepEqual(cjs, esm');
  });
});
