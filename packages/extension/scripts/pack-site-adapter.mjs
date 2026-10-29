#!/usr/bin/env node
/* Builds an installable site adapter package from a folder:

     node scripts/pack-site-adapter.mjs <folder> [out.json]

   The folder holds manifest.json, provenance.json and adapter.js (the body of a
   function that receives `sdk` and returns the adapter). Settings → Site adapters
   → Add-on packages installs the resulting file; nothing here runs adapter.js.
   See docs/site-adapters/community-packages.md. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packSiteAdapter(folder) {
  const read = name => readFile(resolve(folder, name), 'utf8');
  const [manifest, provenance, script] = await Promise.all([read('manifest.json'), read('provenance.json'), read('adapter.js')]);
  return `${JSON.stringify({ manifest: JSON.parse(manifest), provenance: JSON.parse(provenance), script }, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, out] = process.argv.slice(2);
  if (!folder) { console.error('usage: node scripts/pack-site-adapter.mjs <folder> [out.json]'); process.exit(2); }
  const text = await packSiteAdapter(folder);
  if (out) await writeFile(out, text); else process.stdout.write(text);
}
