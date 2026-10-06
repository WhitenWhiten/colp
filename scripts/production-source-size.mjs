import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export function countSourceLines(source) {
  if (source.length === 0) return 0;
  return source.split(/\r\n|\n|\r/u).length - (/(?:\r\n|\n|\r)$/u.test(source) ? 1 : 0);
}

export function parseSourceSizeBaseline(source) {
  const parsed = JSON.parse(source);
  if (!Number.isInteger(parsed.maximumNewFileLines) || parsed.maximumNewFileLines <= 0) {
    throw new TypeError('source file size baseline has an invalid maximumNewFileLines');
  }
  if (parsed.grandfathered === null || typeof parsed.grandfathered !== 'object'
      || Array.isArray(parsed.grandfathered)) {
    throw new TypeError('source file size baseline has an invalid grandfathered map');
  }
  const exclude = Array.isArray(parsed.excludeFileNames)
    ? parsed.excludeFileNames.filter((name) => typeof name === 'string')
    : [];
  for (const [path, limit] of Object.entries(parsed.grandfathered)) {
    if (!path.startsWith('src/') || !path.endsWith('.ts')
        || !Number.isInteger(limit) || limit <= parsed.maximumNewFileLines) {
      throw new TypeError(`source file size baseline has an invalid entry: ${path}`);
    }
  }
  return { ...parsed, excludeFileNames: exclude };
}

export function evaluateSourceFileSizes(lineCounts, baseline) {
  const errors = [];
  const currentPaths = new Set(Object.keys(lineCounts));
  for (const [path, lines] of Object.entries(lineCounts)) {
    const grandfatheredLimit = baseline.grandfathered[path];
    if (grandfatheredLimit === undefined && lines > baseline.maximumNewFileLines) {
      errors.push(`${path}: ${lines} lines exceeds the new-file limit ${baseline.maximumNewFileLines}`);
    } else if (grandfatheredLimit !== undefined && lines > grandfatheredLimit) {
      errors.push(`${path}: grew from its ${grandfatheredLimit}-line cap to ${lines}`);
    } else if (grandfatheredLimit !== undefined && lines <= baseline.maximumNewFileLines) {
      errors.push(`${path}: now ${lines} lines; remove its stale grandfathered entry`);
    }
  }
  for (const path of Object.keys(baseline.grandfathered)) {
    if (!currentPaths.has(path)) errors.push(`${path}: missing; remove its stale grandfathered entry`);
  }
  return errors.sort();
}

export async function collectTypeScriptFiles(directory, excludeFileNames = []) {
  const excluded = new Set(excludeFileNames);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScriptFiles(path, excludeFileNames));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !excluded.has(entry.name)) files.push(path);
  }
  return files.sort();
}

export function normalizedSrcPath(packageRoot, path) {
  return relative(packageRoot, path).split(sep).join('/');
}
