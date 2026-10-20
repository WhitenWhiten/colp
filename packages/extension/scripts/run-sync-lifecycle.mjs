import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceNeedsWebProduct, acceptanceSpecs } from './sync-acceptance-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const group = process.env.KNOWN_SYNC_ACCEPTANCE_GROUP ?? process.argv[2];
const specs = acceptanceSpecs(group);
for (const spec of specs) if (!existsSync(resolve(root, spec))) throw new Error(`Missing acceptance spec: ${spec}`);

if (process.argv.includes('--build-requirements')) {
  process.stdout.write(`web-product=${acceptanceNeedsWebProduct(group)}\n`);
} else if (process.argv.includes('--list')) {
  process.stdout.write(JSON.stringify(specs) + '\n');
} else {
  // This is deliberately the strict xvfb wrapper; no headless/skip fallback.
  run(['scripts/with-xvfb.mjs', 'npx', 'playwright', 'test', ...specs]);
  run(['scripts/verify-release-artifact.mjs', 'dist/production']);
  run(['scripts/verify-bookmark-privacy-artifacts.mjs', 'test-results']);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
