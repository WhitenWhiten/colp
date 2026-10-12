import { execFileSync } from 'node:child_process';
import { readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const server = fileURLToPath(new URL('../', import.meta.url));
const node = fileURLToPath(new URL('../../node/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'colp-automation-package-'));
try {
  execFileSync('npm', ['run', 'build'], { cwd: node, stdio: 'inherit' });
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--pack-destination', scratch, '--json'], { cwd: node, encoding: 'utf8' }));
  copyFileSync(join(scratch, packed.filename), join(server, 'vendor/know-n-colp-0.1.3.tgz'));
  execFileSync('npm', ['install', './vendor/know-n-colp-0.1.3.tgz', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: server, stdio: 'inherit' });
  execFileSync('npm', ['run', 'runtime:manifest'], { cwd: server, stdio: 'inherit' });
  const manifest = JSON.parse(readFileSync(join(server, 'node_modules/@know-n/colp/package.json')));
  if (!manifest.exports['./automation']) throw new Error('Packed subpath missing');
} finally { rmSync(scratch, { recursive: true, force: true }); }
