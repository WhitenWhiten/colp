import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';
import { PostgresOutboxRepository, type OutboxClaim } from '../../src/infrastructure/outbox/index.js';
import { automationMixedWorker } from './automation-mixed-worker.js';

const connectionString = process.env.AUTOMATION_TEST_DATABASE_URL;
if (!connectionString || typeof process.send !== 'function') throw new Error('Isolated database and IPC required');
const pool = new pg.Pool({ connectionString, max: 6 });
const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
let reported = false;
class CommitWithoutAcknowledgment extends PostgresOutboxRepository {
  override async complete(claim: OutboxClaim): Promise<boolean> {
    const effects = await pool.query<{ count: string }>('SELECT count(*) FROM automation_effect_receipts');
    if (!reported && Number(effects.rows[0]!.count) > 0) {
      reported = true;
      process.send!({ type: 'effect-committed' });
      // The parent kills this actual process after the canonical transaction
      // committed and before the durable Outbox acknowledgment can happen.
      return new Promise<never>(() => { /* deliberate crash window */ });
    }
    return super.complete(claim);
  }
}
const { worker } = automationMixedWorker(db, pool, { repository: new CommitWithoutAcknowledgment(pool) });
try {
  for (let pass = 0; pass < 100 && !reported; pass++) {
    if (!await worker.runOnce()) throw new Error('No eligible source reached the crash window');
  }
  if (!reported) throw new Error('Canonical effect was not committed');
} catch (error) {
  process.send?.({ type: 'failure', message: error instanceof Error ? error.message : 'Worker failed' });
  process.exitCode = 1;
} finally {
  await worker.stop();
  await db.destroy();
  process.disconnect?.();
}
