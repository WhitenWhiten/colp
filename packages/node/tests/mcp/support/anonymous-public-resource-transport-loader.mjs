/**
 * Source loader for the cross-package anonymous public Resource transport test.
 *
 * The server projection imports the published `@know-n/colp/*` package from its
 * own `node_modules`, which the node package CI job does not install. This
 * loader keeps the test runnable from `packages/node` alone by:
 *   - resolving `@know-n/colp/*` to this checkout's TypeScript sources, and
 *   - resolving the repository's `.js` source specifiers to their `.ts`
 *     siblings, and
 *   - stripping the TypeScript types before evaluation.
 *
 * It is deliberately scoped to the repository's `packages/*\/src` trees so it
 * can never redirect a dependency from `node_modules`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolvePath(SUPPORT_DIR, '..', '..', '..', '..', '..');
const NODE_SOURCE = join(REPOSITORY_ROOT, 'packages', 'node', 'src');
const PUBLICATION_SHIM = pathToFileURL(
  join(SUPPORT_DIR, 'server-publication-shim.mjs'),
).href;
const COLLECTION_RESOURCES_SOURCE = pathToFileURL(
  join(REPOSITORY_ROOT, 'packages', 'server', 'src', 'modules', 'mcp', 'collection-resources.ts'),
).href;
const PACKAGE_SOURCE_ROOTS = Object.freeze([
  join(REPOSITORY_ROOT, 'packages', 'node', 'src'),
  join(REPOSITORY_ROOT, 'packages', 'server', 'src'),
]);

function isSourceParent(parentUrl) {
  if (typeof parentUrl !== 'string' || !parentUrl.startsWith('file:')) return false;
  const parentPath = fileURLToPath(parentUrl);
  return PACKAGE_SOURCE_ROOTS.some((root) => parentPath.startsWith(`${root}/`));
}

function resolveNodePackageSubpath(specifier) {
  const subpath = specifier === '@know-n/colp'
    ? ''
    : specifier.slice('@know-n/colp/'.length);
  const candidates = subpath === ''
    ? [join(NODE_SOURCE, 'index.ts')]
    : [join(NODE_SOURCE, subpath, 'index.ts'), join(NODE_SOURCE, `${subpath}.ts`)];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@know-n/colp' || specifier.startsWith('@know-n/colp/')) {
    const source = resolveNodePackageSubpath(specifier);
    if (source === undefined) {
      throw new Error(`The transport test loader cannot resolve '${specifier}' to a package source file.`);
    }
    return { url: pathToFileURL(source).href, shortCircuit: true };
  }
  if (
    specifier === '../publication/index.js'
    && context.parentURL?.split('?')[0] === COLLECTION_RESOURCES_SOURCE
  ) {
    return { url: PUBLICATION_SHIM, shortCircuit: true };
  }
  if (
    isSourceParent(context.parentURL)
    && (specifier.startsWith('./') || specifier.startsWith('../'))
    && specifier.endsWith('.js')
  ) {
    const requested = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    if (!existsSync(requested)) {
      const typescriptSource = `${requested.slice(0, -'.js'.length)}.ts`;
      if (existsSync(typescriptSource)) {
        return { url: pathToFileURL(typescriptSource).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    return {
      format: 'module',
      source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
