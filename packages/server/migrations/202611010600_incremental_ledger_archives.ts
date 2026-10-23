import type { Kysely } from 'kysely';
import { setIncrementalLedgerArchiveBindings } from './lib/ledger-archive-bindings.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await setIncrementalLedgerArchiveBindings(db, true);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await setIncrementalLedgerArchiveBindings(db, false);
}
