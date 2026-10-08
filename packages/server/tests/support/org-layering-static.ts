/**
 * Shared walkers for the 2026-08-20 organization-audit static nets.
 * Split per lane so Wave 1 worktrees do not edit one allowlist file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const backendRoot = resolve(import.meta.dirname, '../..');
export const srcRoot = resolve(backendRoot, 'src');

export function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'generated'].includes(entry.name)) return [];
      return walk(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

export function rel(path: string): string {
  return relative(backendRoot, path).replaceAll('\\', '/');
}

export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function readSrc(path: string): string {
  return stripComments(readFileSync(path, 'utf8'));
}
