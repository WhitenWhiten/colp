import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const extensionRoot = resolve(import.meta.dirname, '..');

/** Concatenate the MV3 entry and extracted `src/sw` modules for static contract greps. */
export async function readServiceWorkerGraph(root = extensionRoot): Promise<string> {
  const swDir = resolve(root, 'src/sw');
  const names = (await readdir(swDir)).filter((name) => name.endsWith('.ts')).sort();
  const files = [resolve(root, 'src/service-worker.ts'), ...names.map((name) => resolve(swDir, name))];
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}
