import { readFileSync } from 'node:fs';

const repository = new URL('../../../../', import.meta.url);

/** Reads a file by its repository path, independent of the directory the tests run from. */
export function readRepositoryFile(path: string): string {
  return readFileSync(new URL(path, repository), 'utf8');
}
