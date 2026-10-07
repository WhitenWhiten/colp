/**
 * A1 test fixture: real PostgreSQL for the Better Auth adapter/composition
 * tests (schema-backed requests through the REAL 1.7.1 handler).
 *
 * Resolution order (fail closed, repo evidence convention):
 * 1. KNOWN_TEST_DATABASE_URL / DATABASE_URL when set (no Docker required).
 * 2. Testcontainers `postgres:16.4-alpine` (KNOWN_POSTGRES_IMAGE override).
 *
 * Each run uses a dedicated schema (created/dropped), so the fixture never
 * touches application tables and reruns are idempotent. The Better Auth four
 * tables are created via the library's own `getMigrations` compiled from the
 * A1 runtime options (the same generator the G0 spike used; the reviewed SQL
 * is archived in /tmp/known-better-auth-spike/artifacts/compile-migration.sql).
 * Repo migrations are NOT involved (B1 owns those; A1 runs in parallel).
 */
import { randomUUID } from 'node:crypto';
import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { up as applyDcrRegistrationCapacitySchema } from '../../migrations/202609260600_oauth_dcr_registration_capacity.js';
import { up as applyDcrOwnedReservationOwnerSchema } from '../../migrations/202609270200_oauth_dcr_owned_reservation_owner.js';
import {
  buildBetterAuthOptions,
  type BetterAuthRuntimeConfig,
} from '../../src/infrastructure/auth/better-auth-runtime.js';

export interface BetterAuthPostgresFixture {
  readonly schemaName: string;
  readonly source: 'external' | 'testcontainers';
  /** Pool WITHOUT search_path (schema admin + evidence queries). */
  readonly adminPool: pg.Pool;
  /** Pool WITH search_path = schemaName (Better Auth adapter). */
  readonly pool: pg.Pool;
  readonly db: Kysely<Record<string, never>>;
  readonly close: () => Promise<void>;
}

/**
 * Isolated BA fixture helper: apply Better Auth 1.7.1
 * `getMigrations().runMigrations()` onto a schema that already has the
 * product Kysely `auth_*` tables. T-02 landed `auth_accounts.issuer` on the
 * production chain, so this is a no-op after `migrateToLatest`. HTTP fixtures
 * still call it so a schema that stopped at a pre-T-02 head can expand.
 */
export async function applyBetterAuth17LibrarySchemaExpand(
  options: BetterAuthOptions,
): Promise<void> {
  const migrations = await getMigrations(options);
  await migrations.runMigrations();
}

export async function openBetterAuthPostgres(
  config: BetterAuthRuntimeConfig,
): Promise<BetterAuthPostgresFixture> {
  const schemaName = `better_auth_a1_${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  const external = process.env.KNOWN_TEST_DATABASE_URL?.trim()
    || process.env.DATABASE_URL?.trim();
  let source: BetterAuthPostgresFixture['source'];
  let adminPool: pg.Pool;
  let container: { readonly stop: () => Promise<void> } | null = null;
  if (external) {
    source = 'external';
    adminPool = new pg.Pool({ connectionString: external });
  } else {
    container = await new PostgreSqlContainer(
      process.env.KNOWN_POSTGRES_IMAGE ?? 'postgres:16.4-alpine',
    ).start();
    source = 'testcontainers';
    adminPool = new pg.Pool({ connectionString: container.getConnectionUri() });
  }
  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    // Every pooled connection gets the dedicated schema via connection options.
    const pool = new pg.Pool({
      connectionString: adminPool.options.connectionString,
      host: adminPool.options.host,
      port: adminPool.options.port,
      user: adminPool.options.user,
      password: adminPool.options.password,
      database: adminPool.options.database,
      options: `-c search_path=${schemaName}`,
    });
    const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) });
    const options = buildBetterAuthOptions({
      enabled: true,
      config,
      database: { db, type: 'postgres', transaction: true },
    });
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
    // The Better Auth generator owns its library tables. The oauth-provider
    // tables exist only when the issuer plugins are in `options` (getMigrations
    // then creates `auth_oauth_client`). Know-N's bounded anonymous-DCR
    // registry is an additive product table on top of that schema; applying it
    // without the FK target is 42P01. Browser-only composition/adapter/routes
    // fixtures skip it; issuer-enabled fixtures apply it after expand.
    const oauthClient = await pool.query<{ rel: string | null }>(
      `SELECT to_regclass('auth_oauth_client') AS rel`,
    );
    if (oauthClient.rows[0]?.rel) {
      await applyDcrRegistrationCapacitySchema(db);
      await applyDcrOwnedReservationOwnerSchema(db);
    }
    return {
      schemaName,
      source,
      adminPool,
      pool,
      db,
      close: async () => {
        await pool.end().catch(() => undefined);
        try {
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } catch (error) {
          // Schema cleanup failure must not mask the test outcome.
          process.stderr.write(`[better-auth-postgres] schema cleanup failed: ${String(error)}\n`);
        }
        await adminPool.end().catch(() => undefined);
        await container?.stop().catch(() => undefined);
      },
    };
  } catch (error) {
    await adminPool.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
    throw error;
  }
}
