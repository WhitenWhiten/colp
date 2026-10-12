import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function readSyncStateSource(root = PACKAGE_ROOT): Promise<string> {
  const dir = resolve(root, 'src/sync-state');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort();
  const parts = await Promise.all([
    readFile(resolve(root, 'src/sync-state-store.ts'), 'utf8'),
    ...files.map((name) => readFile(resolve(dir, name), 'utf8')),
  ]);
  return parts.join('\n');
}
