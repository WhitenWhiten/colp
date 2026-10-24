#!/usr/bin/env node
// Local Linux runner: persistent dependencies, disposable containers, mandatory xvfb.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const extension = resolve(root, 'packages/extension');
const version = '1.61.1';
const image = `colp-extension-tests:pw${version}`;
const prefix = `colp-adapters-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
const [mode, ...args] = process.argv.slice(2);
let container;
let stopping = false;

function run(command, argv, quiet = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { stdio: quiet ? 'ignore' : 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}
async function cleanup() {
  if (container) await run('docker', ['rm', '--force', container], true).catch(() => {});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

const verify = `
for package in extension server; do
  cd /workspace/packages/"$package"
  test -f node_modules/.colp-linux-lock || { echo 'Run with-orbstack.mjs prepare first.' >&2; exit 2; }
  sha256sum --check --status node_modules/.colp-linux-lock || { echo 'Lockfile changed; rerun prepare.' >&2; exit 2; }
done
cd /workspace/packages/extension
node -e 'if (require("@playwright/test/package.json").version !== "${version}") throw Error("Playwright image/package mismatch")'
exec env -u KNOWN_E2E_HEADED xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' "$@"
`;

async function inContainer(command) {
  container = `${prefix}-${randomUUID().slice(0, 8)}`;
  console.log(`Linux runner: ${image}; dependency volumes: ${prefix}-{extension,server,npm}`);
  try {
    await run('docker', ['run', '--rm', '--init', '--name', container, '--shm-size=1g',
      '--mount', `type=bind,source=${root},target=/workspace`,
      '--mount', `type=volume,source=${prefix}-extension,target=/workspace/packages/extension/node_modules`,
      '--mount', `type=volume,source=${prefix}-server,target=/workspace/packages/server/node_modules`,
      '--mount', `type=volume,source=${prefix}-npm,target=/root/.npm`,
      '--workdir', '/workspace/packages/extension', image, ...command]);
  } finally { await cleanup(); container = undefined; }
}

try {
  const lock = JSON.parse(readFileSync(resolve(extension, 'package-lock.json'), 'utf8'));
  if (lock.packages['node_modules/@playwright/test'].version !== version) {
    throw new Error('Update the runner image/version to match the extension lockfile before preparing.');
  }
  if (mode === 'prepare' && args.length === 0) {
    await run('docker', ['build', '--tag', image, resolve(extension, 'tools/linux-runner')]);
    await inContainer(['bash', '-euc', `
for package in extension server; do
  cd /workspace/packages/"$package"
  npm ci --ignore-scripts --no-audit --no-fund
  if test -d node_modules/esbuild; then npm rebuild esbuild --ignore-scripts=false; fi
  sha256sum package-lock.json > node_modules/.colp-linux-lock
done
node --version
xvfb-run --help >/dev/null
xdotool --version
`]);
  } else if (mode === 'run' && args.length > 0) {
    await inContainer(['bash', '-euc', verify, '--', ...args]);
  } else if (mode === 'e2e' && args.length > 0) {
    // Require a real explicit file before accepting additional CLI filters.
    const spec = resolve(extension, args[0]);
    if (!spec.startsWith(`${extension}/e2e/`) || !spec.endsWith('.spec.ts') || !existsSync(spec)) {
      throw new Error('e2e requires an existing e2e/*.spec.ts as its first argument.');
    }
    await inContainer(['bash', '-euc', verify, '--', 'node', 'node_modules/@playwright/test/cli.js',
      'test', '--project=core', ...args]);
  } else {
    throw new Error('Usage: node scripts/with-orbstack.mjs prepare | run <command> [args] | e2e <e2e/file.spec.ts> [filters]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
