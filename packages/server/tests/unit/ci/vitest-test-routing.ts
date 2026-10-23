import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

export const serverRoot = resolve(import.meta.dirname, '../../..');
let discovered: Record<string, string[]> | undefined;

/** Vitest's real glob resolution is independent of the project's ownership arrays. */
export function discoverProjectFiles(): Record<string, string[]> {
  if (discovered) return discovered;
  const output = execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/vitest/vitest.mjs'),
    'list', '--filesOnly', '--json'], { cwd: serverRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const files = JSON.parse(output) as Array<{ file: string; projectName: string }>;
  const projects: Record<string, string[]> = {};
  for (const { file, projectName } of files) (projects[projectName] ??= []).push(relative(serverRoot, file).replaceAll('\\', '/'));
  discovered = projects;
  return projects;
}

export function ownershipProblems(files: readonly string[], projects: Readonly<Record<string, readonly string[]>>): string[] {
  const owners = new Map<string, string[]>();
  for (const [name, paths] of Object.entries(projects)) for (const file of paths) {
    owners.set(file, [...owners.get(file) ?? [], name]);
  }
  const expected = new Set(files);
  return [...new Set([...files, ...owners.keys()])].flatMap(file => {
    const names = owners.get(file) ?? [];
    return !expected.has(file) ? [`stale discovery: ${file}`]
      : names.length !== 1 ? [`${file} has ${names.length} owners: ${names.join(', ')}`] : [];
  });
}
