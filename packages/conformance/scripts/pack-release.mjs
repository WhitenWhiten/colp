/** Pack a registry-ready runner while retaining the checkout's local dependency. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const [destination, ...extra] = process.argv.slice(2);
assert.ok(destination && extra.length === 0, 'Usage: npm run pack:release -- /path/to/artifacts');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const implementation = JSON.parse(await readFile(resolve(root, '../node/package.json'), 'utf8'));
assert.equal(manifest.version, implementation.version, 'Release the matching implementation first.');
assert.match(implementation.version, /^\d+\.\d+\.\d+$/u, 'An intentional stable release version is required.');
assert.equal(manifest.dependencies[implementation.name], 'file:../node');
manifest.dependencies[implementation.name] = implementation.version;
delete manifest.private;
delete manifest.scripts;
const output = resolve(destination);
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'colp-conformance-release-'));
try {
  for (const file of manifest.files) {
    await cp(resolve(root, file), resolve(staging, file), { recursive: true });
  }
  await cp(resolve(root, '../../LICENSE'), resolve(staging, 'LICENSE'));
  await writeFile(resolve(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', output],
    { cwd: staging, shell: process.platform === 'win32' });
  process.stdout.write(stdout);
} finally {
  await rm(staging, { recursive: true, force: true });
}
