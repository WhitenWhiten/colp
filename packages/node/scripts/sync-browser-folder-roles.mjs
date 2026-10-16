import { readFile, writeFile } from 'node:fs/promises';

// Apps build independently against published SDK versions. Generate their local
// policy from this source so library initialization and sync support cannot drift.
const source = new URL('../src/sync/browser-folder-roles.ts', import.meta.url);
const text = '// Generated from packages/node/src/sync/browser-folder-roles.ts; do not edit.\n'
  + await readFile(source, 'utf8');
const targets = ['server', 'web', 'extension'];
for (const name of targets) {
  const destination = new URL(`../../${name}/src/generated/browser-folder-roles.ts`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8').catch(() => '') !== text) {
      throw new Error(`Browser folder roles drifted in ${name}; run node packages/node/scripts/sync-browser-folder-roles.mjs`);
    }
  } else await writeFile(destination, text);
}
