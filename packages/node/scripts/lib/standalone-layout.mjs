import { posix } from 'node:path';

export const standaloneRoots = Object.freeze([
  'packages/node', 'protocol', '.github/workflows/colp-ci.yml',
  '.npmrc', '.gitattributes', '.gitignore', 'AGENTS.md', 'LICENSE', 'README.md',
  'package.json', 'docs/history', 'COLP_EXPORT.json',
  'scripts/production-source-size.mjs', 'scripts/scan-tracked-secrets.mjs',
  'scripts/secret-scan-allowlist.json', 'scripts/github-action-pins.json',
]);

export function isStandalonePath(path) {
  return typeof path === 'string' && !path.includes('\\')
    && !posix.isAbsolute(path) && posix.normalize(path) === path
    && standaloneRoots.some(root => path === root || path.startsWith(root + '/'));
}

export function assertExportEntry(path, mode) {
  if (!isStandalonePath(path) || !['100644', '100755'].includes(mode)) {
    throw new Error('Unexpected standalone export entry: ' + path);
  }
  if (/(^|\/)(?:\.git|node_modules|dist|coverage|reports)(?:\/|$)/u.test(path)
    || /(?:^|\/)\.env(?:\.|$)/u.test(path)) {
    throw new Error('Generated output or environment file cannot be exported: ' + path);
  }
}

/** Retain only literal exceptions belonging to the exported package/protocol. */
export function filterStandaloneAllowlist(document) {
  if (!Array.isArray(document?.literals)) throw new TypeError('Expected the secret scanner literal registry.');
  const literals = [];
  for (const entry of document.literals) {
    const paths = (entry.path ? [entry.path] : entry.paths ?? []).filter(isStandalonePath);
    if (paths.length === 0) continue;
    const { path: _path, paths: _paths, ...metadata } = entry;
    literals.push({ ...metadata, paths });
  }
  return { literals };
}
