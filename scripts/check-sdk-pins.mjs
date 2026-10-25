/**
 * The server, extension and web consume one @know-n/colp build.
 *
 * Published releases use one exact registry version. Unreleased SDK changes
 * can share the server's vendored prerelease tarball. The pins and lockfile
 * entries must match the version packages/node carries now and share one
 * integrity. Conformance links ../node directly and is not a consumer here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SDK_CONSUMERS = Object.freeze(['packages/server', 'packages/extension', 'packages/web']);

/** `read(path)` returns parsed JSON, `exists(path)` checks a repository-relative file. */
export function checkSdkPins({ read, exists }) {
  const errors = [];
  const nodeVersion = read('packages/node/package.json').version;
  const consumers = SDK_CONSUMERS.map((root) => {
    const lock = read(`${root}/package-lock.json`);
    const spec = read(`${root}/package.json`).dependencies?.['@know-n/colp'];
    // A file: pin names the same tarball from each package's own directory.
    const target = typeof spec === 'string' && spec.startsWith('file:')
      ? join(root, spec.slice('file:'.length)).split('\\').join('/') : spec;
    return { root, spec, target, locked: lock.packages?.['node_modules/@know-n/colp'] };
  });
  if (new Set(consumers.map((consumer) => consumer.target)).size !== 1) {
    errors.push(`@know-n/colp pins differ: ${consumers.map((consumer) => `${consumer.root}=${consumer.target}`).join(', ')}`);
  }
  for (const { root, spec, target: tarball, locked } of consumers) {
    if (typeof spec !== 'string') { errors.push(`${root}: no @know-n/colp dependency`); continue; }
    if (!locked) { errors.push(`${root}: package-lock.json has no node_modules/@know-n/colp`); continue; }
    if (!spec.startsWith('file:')) {
      if (spec !== nodeVersion) errors.push(`${root}: pin ${spec} is not the current packages/node version ${nodeVersion}`);
      if (locked.version !== spec) errors.push(`${root}: locks ${locked.version} for pin ${spec}`);
      continue;
    }
    if (!exists(tarball)) errors.push(`${root}: ${tarball} does not exist`);
    if (!tarball.startsWith('packages/server/vendor/')) errors.push(`${root}: ${tarball} is not the server's vendored SDK`);
    if (tarball !== `packages/server/vendor/know-n-colp-${nodeVersion}.tgz`) {
      errors.push(`${root}: ${tarball} is not the current packages/node build ${nodeVersion}`);
    }
    if (locked.resolved !== spec || locked.version !== nodeVersion) {
      errors.push(`${root}: package-lock.json resolves ${locked.resolved} ${locked.version}, not ${spec}`);
    }
  }
  const integrities = new Set(consumers.map((consumer) => consumer.locked?.integrity));
  if (integrities.size !== 1) errors.push('@know-n/colp lockfile integrity differs; reinstall the tarball in every consumer');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkSdkPins({
    read: (path) => JSON.parse(readFileSync(join(repository, path), 'utf8')),
    exists: (path) => existsSync(join(repository, path)),
  });
  for (const error of errors) process.stderr.write(`sdk-pins: ${error}\n`);
  if (errors.length > 0) process.exitCode = 1;
  else process.stdout.write(`sdk-pins: ${SDK_CONSUMERS.length} consumers share one @know-n/colp build\n`);
}
