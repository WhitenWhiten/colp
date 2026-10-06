import { constants } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const protocolRoot = resolve(repositoryRoot, 'protocol');
const checkOnly = process.argv.includes('--check');

const assets = [
  {
    source: resolve(protocolRoot, 'schemas', 'collection-protocol.schema.json'),
    destination: resolve(
      packageRoot,
      'src',
      'schema',
      'generated',
      'collection-protocol.schema.json',
    ),
  },
  {
    source: resolve(protocolRoot, 'schemas', 'collection-protocol-0.2.schema.json'),
    destination: resolve(
      packageRoot,
      'src',
      'schema',
      'generated',
      'collection-protocol-0.2.schema.json',
    ),
  },
  {
    source: resolve(protocolRoot, 'examples'),
    destination: resolve(packageRoot, 'fixtures', 'protocol', 'examples'),
  },
  {
    source: resolve(protocolRoot, 'requirements.yaml'),
    destination: resolve(packageRoot, 'fixtures', 'protocol', 'requirements.yaml'),
  },
  {
    source: resolve(protocolRoot, 'requirements-0.2.yaml'),
    destination: resolve(packageRoot, 'fixtures', 'protocol', 'requirements-0.2.yaml'),
  },
  {
    source: resolve(protocolRoot, 'docs', '09-problem-registry.md'),
    destination: resolve(packageRoot, 'fixtures', 'protocol', 'docs', '09-problem-registry.md'),
  },
];

function assertInsidePackage(path) {
  const location = relative(packageRoot, path);
  if (location.startsWith('..') || location === '') {
    throw new Error(`Refusing to modify path outside packages/node/: ${path}`);
  }
}

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function assertFilesEqual(source, destination) {
  const sourceStat = await access(source, constants.R_OK).then(() => true).catch(() => false);
  const destinationStat = await access(destination, constants.R_OK)
    .then(() => true)
    .catch(() => false);
  if (!sourceStat || !destinationStat) {
    throw new Error(`Missing protocol asset: ${!sourceStat ? source : destination}`);
  }

  const sourceFiles = (await listFiles(source).catch(() => [source])).map((path) =>
    relative(source, path),
  );
  const destinationFiles = (await listFiles(destination).catch(() => [destination])).map(
    (path) => relative(destination, path),
  );
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) {
    throw new Error(`Protocol asset file list differs: ${destination}`);
  }

  for (const file of sourceFiles) {
    const sourcePath = sourceFiles.length === 1 && file === '' ? source : resolve(source, file);
    const destinationPath =
      destinationFiles.length === 1 && file === '' ? destination : resolve(destination, file);
    const [expected, actual] = await Promise.all([
      readFile(sourcePath),
      readFile(destinationPath),
    ]);
    if (!expected.equals(actual)) {
      throw new Error(`Protocol asset differs: ${destinationPath}`);
    }
  }
}

for (const asset of assets) {
  if (checkOnly) {
    await assertFilesEqual(asset.source, asset.destination);
    continue;
  }

  assertInsidePackage(asset.destination);
  await rm(asset.destination, { force: true, recursive: true });
  await mkdir(dirname(asset.destination), { recursive: true });
  await cp(asset.source, asset.destination, { recursive: true });
}

console.log(checkOnly ? 'Protocol assets are in sync.' : 'Protocol assets synchronized.');
