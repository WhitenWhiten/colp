import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const directory = new URL('../migrations/', import.meta.url);
const base = process.argv[2] ?? 'e72b8912887c78e44018bfe4a8a8d29a826f993b';
const old = execFileSync('git', ['ls-tree', '--name-only', `${base}:packages/server/migrations`], { encoding: 'utf8', cwd: new URL('../../../', import.meta.url) })
  .trim().split('\n').filter((name) => /^\d+.*\.ts$/.test(name)).sort();
const head = old.at(-1);
if (!head) throw new Error('No baseline migration head');
const added = readdirSync(directory).filter((name) => /^\d+.*\.ts$/.test(name) && !old.includes(name));
for (const name of added) if (name <= head) throw new Error(`Migration ${name} must sort after ${head}`);
console.log(`Migration order verified: ${added.length} additions after ${head}`);
