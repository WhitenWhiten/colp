import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export function assertMigrationOrder(baseline, candidates) {
  const old = baseline.filter((name) => /^\d+.*\.ts$/.test(name)).sort();
  const head = old.at(-1);
  if (!head) throw new Error('No baseline migration head');
  const added = candidates.filter((name) => /^\d+.*\.ts$/.test(name) && !old.includes(name));
  for (const name of added) if (name <= head) throw new Error(`Migration ${name} must sort after ${head}`);
  assertUniquePrefixes(candidates, added);
  return { head, added };
}
/** G9: each added migration owns its UTC prefix, so no later merge can interleave two files. */
export function assertUniquePrefixes(names, added = names) {
  const files = names.filter((value) => /^\d+.*\.ts$/.test(value));
  for (const name of added) {
    const prefix = name.match(/^\d+/)[0];
    const other = files.find((value) => value !== name && value.match(/^\d+/)[0] === prefix);
    if (other) throw new Error(`Migrations ${[name, other].sort().join(' and ')} share prefix ${prefix}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? process.env.MIGRATION_BASE_REF ?? 'HEAD';
  const baseline = execFileSync('git', ['ls-tree', '--name-only', `${base}:packages/server/migrations`],
    { encoding: 'utf8', cwd: new URL('../../../', import.meta.url) }).trim().split('\n');
  const result = assertMigrationOrder(baseline, readdirSync(new URL('../migrations/', import.meta.url)));
  console.log(`Migration order verified: ${result.added.length} additions after ${result.head}`);
}
