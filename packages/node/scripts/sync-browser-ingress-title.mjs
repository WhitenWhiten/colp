import { readFile, writeFile } from 'node:fs/promises';

// Apps consume published SDK versions independently. Their checked-in policy
// copies are generated here and checked by the existing protocol drift gate.
const text = '// Generated from packages/node/src/sync/browser-ingress-title.ts; do not edit.\n'
  + await readFile(new URL('../src/sync/browser-ingress-title.ts', import.meta.url), 'utf8');
for (const name of ['server', 'extension']) {
  const destination = new URL(`../../${name}/src/generated/browser-ingress-title.ts`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8').catch(() => '') !== text) {
      throw new Error(`Browser ingress title policy drifted in ${name}; run npm --prefix packages/node run sync:protocol`);
    }
  } else await writeFile(destination, text);
}
