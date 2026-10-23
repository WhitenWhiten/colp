import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectTypeScriptFiles, countSourceLines, evaluateSourceFileSizes, normalizedSrcPath,
  parseSourceSizeBaseline,
} from '../../../scripts/production-source-size.mjs';

export { countSourceLines, evaluateSourceFileSizes, parseSourceSizeBaseline };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(packageRoot, 'src');
const baselinePath = join(packageRoot, 'tests/fixtures/source-file-size-baseline.json');

export async function inspectProductionSourceFileSizes() {
  const baseline = parseSourceSizeBaseline(await readFile(baselinePath, 'utf8'));
  const lineCounts = {};
  for (const path of await collectTypeScriptFiles(sourceRoot, baseline.excludeFileNames)) {
    lineCounts[normalizedSrcPath(packageRoot, path)] = countSourceLines(await readFile(path, 'utf8'));
  }
  return {
    baseline,
    fileCount: Object.keys(lineCounts).length,
    errors: evaluateSourceFileSizes(lineCounts, baseline),
  };
}

async function main() {
  const result = await inspectProductionSourceFileSizes();
  if (result.errors.length > 0) {
    for (const error of result.errors) process.stderr.write(`source-size: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `source-size: ${result.fileCount} files checked; `
      + `${Object.keys(result.baseline.grandfathered).length} shrinking-only exceptions\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
