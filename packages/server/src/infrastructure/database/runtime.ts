import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import { cancelPostgresBackend } from './postgres-cancellation.js';
import { PostgresControlClient } from './postgres-control-client.js';
import { TransactionPhaseDialect, type TransactionPhaseFaultInjector } from './transaction-phase-driver.js';
import type { DatabaseSchema } from './database-schema.js';
export type * from './database-schema.js';

export interface DatabaseRuntimeOptions {
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleTransactionTimeoutMs?: number;
  readonly applicationName?: string;
  readonly production?: boolean;
  /**
   * Explicit SSL override for the production gate: pass `false` to connect
   * without TLS (e.g. Postgres inside the same compose network with no
   * server-side TLS). Omit (or pass `true`) to keep the production default
   * of `ssl: { rejectUnauthorized: true }`.
   */
  readonly ssl?: boolean;
  /**
   * Optional driver-level fault injection (FIX-L-010): `afterCommitApplied`
   * runs after the COMMIT statement is applied by the server. Throwing there
   * simulates a REAL lost COMMIT acknowledgement and the unit of work reports
   * `commit_outcome_unknown`. Evidence probes and integration tests only;
   * never set in production.
   */
  readonly transactionPhaseFaultInjector?: TransactionPhaseFaultInjector;
}

export interface DatabaseRuntime {
  readonly db: Kysely<DatabaseSchema>;
  readonly pool: Pool;
  cancelBackend(backendPid: number): Promise<boolean>;
  verifyReady(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabasePoolConfig(
  databaseUrl: string,
  options: DatabaseRuntimeOptions = {},
): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: options.maxConnections ?? 10,
    // PGC-06 (T-13): permanent LISTEN and long-checkout connections survive
    // NAT/firewall idle sweeps instead of dying silently until reconnect.
    keepAlive: true,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 2_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
    idle_in_transaction_session_timeout: options.idleTransactionTimeoutMs ?? 15_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    application_name: options.applicationName ?? 'known-backend',
    ...(options.production && options.ssl !== false ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

export function createDatabaseRuntime(
  databaseUrl: string,
  options: DatabaseRuntimeOptions = {},
): DatabaseRuntime {
  const poolConfig = createDatabasePoolConfig(databaseUrl, options);
  const pool = new Pool(poolConfig);
  // Idle clients terminated by the server (pg_terminate_backend, failover,
  // admin restarts) emit 'error' on the pool itself; without a listener that
  // is an uncaught exception and kills the process. pg-pool drops the dead
  // client and replaces it on the next acquire; in-flight queries reject
  // individually and are handled by their callers.
  pool.on('error', () => undefined);
  // Checked-out clients (`pool.connect()` — kysely transactions, the outbox
  // inTransaction helper) have NO pg-pool error listener: `_acquireClient`
  // removes the idle listener on checkout. A backend terminated while such a
  // client is checked out (idle between statements) would emit an unhandled
  // 'error' and crash the whole process; the P4A-P05 reconnect evidence
  // proved exactly that. Attach a no-op listener to every new client so the
  // failure surfaces only through the query rejections callers already handle.
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  const db = new Kysely<DatabaseSchema>({
    dialect: new TransactionPhaseDialect(new PostgresDialect({ pool, controlClient: PostgresControlClient }), options.transactionPhaseFaultInjector),
  });
  let closePromise: Promise<void> | undefined;

  return {
    db,
    pool,
    cancelBackend: (backendPid) => cancelPostgresBackend(poolConfig, backendPid),
    async verifyReady(): Promise<void> {
      const schema = await pool.query<{
        authority_migration: boolean;
        authoritative_effect_migration: boolean;
        pull_recovery_proof_migration: boolean;
        receipts: string | null;
        operations: string | null;
        audit_events: string | null;
        effect_cutovers: string | null;
        operation_effects: string | null;
        operation_effect_pages: string | null;
        pull_recovery_proofs: string | null;
      }>(`select
        exists (select 1 from kysely_migration where name = '202607221600_authority_repair') as authority_migration,
        exists (select 1 from kysely_migration where name = '202607252700_sync_operation_effects') as authoritative_effect_migration,
        exists (select 1 from kysely_migration where name = '202607300100_sync_pull_recovery_proofs') as pull_recovery_proof_migration,
        to_regclass('product_command_receipts')::text as receipts,
        to_regclass('operations')::text as operations,
        to_regclass('audit_events')::text as audit_events,
        to_regclass('sync_collection_effect_cutovers')::text as effect_cutovers,
        to_regclass('sync_operation_effects')::text as operation_effects,
        to_regclass('sync_operation_effect_pages')::text as operation_effect_pages,
        to_regclass('sync_pull_cursor_recovery_proofs')::text as pull_recovery_proofs`);
      const state = schema.rows[0];
      if (!state
          || !state.authority_migration
          || !state.authoritative_effect_migration
          || !state.pull_recovery_proof_migration
          || !state.receipts
          || !state.operations
          || !state.audit_events
          || !state.effect_cutovers
          || !state.operation_effects
          || !state.operation_effect_pages
          || !state.pull_recovery_proofs) {
        throw new Error('database schema is not at the required Phase 3 Pull recovery proof migration');
      }

      const constraints = await pool.query<{ constraint_name: string }>(`select conname as constraint_name
        from pg_constraint
        where conname = any($1::text[])
          and connamespace = current_schema()::regnamespace`, [[
        'product_command_id_canonical_uuid_v4',
        'product_command_full_result_retention',
        'publisher_receipt_replay_window',
        'operations_collection_ordinal_unique',
        'resource_revisions_resource_ordinal_unique',
        'audit_events_operation_collection_fk',
        'nodes_position_token_colp_check',
        'operations_collection_operation_unique',
        'sync_sessions_protocol_version_check',
        'sync_pull_cursor_evidence_protocol_version_check',
        'sync_operation_effect_operation_fk',
        'sync_pull_cursor_recovery_proofs_retention_check',
      ]]);
      if (constraints.rowCount !== 12) {
        throw new Error('database is missing required Phase 3 authoritative effect constraints');
      }
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await db.destroy();
        // Kysely initializes its driver lazily. If callers only used the exposed
        // pg Pool, destroy() has no initialized driver to close.
        if (!pool.ending) await pool.end();
      })();
      return closePromise;
    },
  };
}

/** Backward-compatible name retained from the bootstrap foundation. */
export const createDatabase = createDatabaseRuntime;
