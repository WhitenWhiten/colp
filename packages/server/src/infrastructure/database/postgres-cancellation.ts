import type { PoolConfig } from 'pg';
import type { DatabaseTransaction } from './unit-of-work.js';
import { settleBestEffort } from '../async/best-effort.js';
import { installTransactionCancellation } from './transaction-cancellation.js';
import { PostgresControlClient } from './postgres-control-client.js';

/** Kysely's PostgreSQL driver cancels through its independent control client. */
export async function installPostgresTransactionCancellation(
  transaction: DatabaseTransaction,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  return transaction.getExecutor().provideConnection(async (connection) => {
    if (!connection.cancelQuery || !connection.collectSessionInfo) {
      throw new Error('PostgreSQL driver must support query cancellation');
    }
    await connection.collectSessionInfo();
    return installTransactionCancellation(signal, () => connection.cancelQuery!(async () => {
      // Never fall back to the saturated transaction pool. Production pg
      // exposes Pool.Client; alternative drivers must provide a control client.
      throw new Error('PostgreSQL cancellation requires an independent control client');
    }));
  });
}

/** Raw pg consumers use the same independent connection strategy. */
export async function cancelPostgresBackend(config: PoolConfig, backendPid: number): Promise<boolean> {
  if (!Number.isSafeInteger(backendPid) || backendPid < 1) {
    throw new TypeError('PostgreSQL backend PID must be a positive safe integer');
  }
  const client = new PostgresControlClient({
    ...config,
    // pg makes the pool password non-enumerable.
    password: config.password,
    application_name: `${config.application_name ?? 'known-backend'}-cancel`,
  });
  try {
    await client.connect();
    const result = await client.query<{ cancelled: boolean }>('select pg_cancel_backend($1) cancelled', [backendPid]);
    return result.rows[0]?.cancelled === true;
  } finally {
    await settleBestEffort(client.end(), 'the single-use cancellation result is authoritative and the client is not pooled');
  }
}
