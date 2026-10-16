// Vendors the unpublished @know-n/colp build the automation server needs. The tarball is named after
// the packed version, so it must carry a prerelease version that can never collide with an npm release.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const server = fileURLToPath(new URL('../', import.meta.url));
const node = fileURLToPath(new URL('../../node/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'colp-automation-package-'));
try {
  execFileSync('npm', ['run', 'build'], { cwd: node, stdio: 'inherit' });
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--pack-destination', scratch, '--json'], { cwd: node, encoding: 'utf8' }));
  if (!/^\d+\.\d+\.\d+-/.test(packed.version)) throw new Error(`Vendored @know-n/colp ${packed.version} must be a prerelease version`);
  mkdirSync(join(server, 'vendor'), { recursive: true });
  for (const stale of readdirSync(join(server, 'vendor'))) {
    if (/^know-n-colp-.*\.tgz$/.test(stale) && stale !== packed.filename) rmSync(join(server, 'vendor', stale));
  }
  copyFileSync(join(scratch, packed.filename), join(server, 'vendor', packed.filename));
  execFileSync('npm', ['install', `./vendor/${packed.filename}`, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: server, stdio: 'inherit' });
  execFileSync('node', ['scripts/write-version.mjs'], { cwd: server, stdio: 'inherit' });
  execFileSync('npm', ['run', 'runtime:manifest'], { cwd: server, stdio: 'inherit' });
  const manifest = JSON.parse(readFileSync(join(server, 'node_modules/@know-n/colp/package.json')));
  if (!manifest.exports['./automation']) throw new Error('Packed subpath missing');
} finally { rmSync(scratch, { recursive: true, force: true }); }
