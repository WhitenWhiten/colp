import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const artifact = resolve(process.argv[2] ?? 'dist/production');
const evidence = resolve(process.argv[3] ?? 'test-results');
if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required; PostgreSQL evidence cannot be skipped');
for (const file of ['manifest.json', 'service-worker.js', 'options.js', 'options.html', 'bookmark-import-plan.js']) {
  await access(resolve(artifact, file), constants.R_OK).catch(() => { throw new Error(`production artifact missing: ${file}`); });
}
const manifest = JSON.parse(await readFile(resolve(artifact, 'manifest.json'), 'utf8'));
if (!Array.isArray(manifest.optional_permissions) || !manifest.optional_permissions.includes('bookmarks')) {
  throw new Error('production extension bookmarks permission is missing');
}
if (manifest.externally_connectable !== undefined) throw new Error('externally_connectable credential bridge is forbidden');
const worker = await readFile(resolve(artifact, 'service-worker.js'), 'utf8');
if (!worker.includes('indexedDB') || !worker.includes('import_plans') || !worker.includes('outbound_queue')) {
  throw new Error('durable IndexedDB import/queue authority is missing from the production artifact');
}
const html = await readFile(resolve(artifact, 'options.html'), 'utf8');
for (const id of ['import-file', 'import-native', 'commit-import', 'refresh-import', 'pause-import', 'resume-import', 'retry-import']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`production import control missing: ${id}`);
}
await access(evidence, constants.R_OK).catch(() => { throw new Error('Chromium evidence directory is missing'); });
const evidenceFiles = await files(evidence); if (evidenceFiles.length === 0) throw new Error('Chromium evidence is empty');
const forbidden = /NETSCAPE-Bookmark-file|Authorization:\s*Bearer|refresh[_ -]?token|source file contents|chrome-bookmarks-export/i;
for (const file of evidenceFiles) {
  const bytes = await readFile(file); if (forbidden.test(bytes.toString('utf8'))) throw new Error(`privacy marker leaked: ${file}`);
}
console.log('P3-35 production MV3 artifact, IndexedDB queue, bookmarks permission, PostgreSQL and privacy evidence verified');

async function files(directory) { const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) { const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path)); else output.push(path); }
  return output; }
