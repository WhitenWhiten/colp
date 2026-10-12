import 'dotenv/config';
import { createDatabaseRuntime } from '../dist/src/infrastructure/database/runtime.js';
import { readCanonicalTreeCapacity } from '../dist/src/infrastructure/collections/canonical-tree-capacity-ledger.js';
import { measureCanonicalTree } from '../dist/src/infrastructure/collections/canonical-tree-capacity.js';

if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: backfill-canonical-tree-capacity.mjs [--check]');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const runtime = createDatabaseRuntime(process.env.DATABASE_URL, { maxConnections: 1,
  applicationName: 'canonical-capacity-backfill' });
let count = 0;
try {
  let after = '';
  for (;;) {
    const page = await runtime.db.selectFrom('collections').select('id').where('id', '>', after)
      .orderBy('id').limit(100).execute();
    if (!page.length) break;
    for (const { id } of page) {
      await runtime.db.transaction().execute(async tx => {
        const incremental = await readCanonicalTreeCapacity(tx, id);
        if (process.argv.includes('--check')) {
          const full = await measureCanonicalTree(tx, id);
          if (incremental.nodes !== full.nodes || incremental.bytes !== full.bytes) {
            throw new Error('Capacity ledger does not match the Snapshot serializer');
          }
        }
      });
      count++;
    }
    after = page.at(-1).id;
  }
  console.log(JSON.stringify({ collectionsChecked: count, verified: process.argv.includes('--check') }));
} finally { await runtime.close(); }
