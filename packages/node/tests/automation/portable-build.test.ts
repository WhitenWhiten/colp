import { test, expect } from 'vitest';
import { build } from 'esbuild';

test('optional automation entry bundles for a browser without host imports', async () => {
  const result = await build({ entryPoints: ['src/automation/index.ts'], bundle: true, platform: 'browser',
    format: 'esm', write: false, metafile: true });
  const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
  expect(imports).toEqual([]);
  expect(Object.keys(result.metafile!.inputs).some((input) => /chrome|react|transport|database/.test(input))).toBe(false);
});
