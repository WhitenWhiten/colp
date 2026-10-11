import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { requireTestDatabaseUrl, type IsolatedPostgresRuntime } from './postgres-test-runtime.js';

/** The database creation fixture used for whole isolated database migration testing. */
export async function createCreditTestDatabase(prefix: string, maxConnections = 12): Promise<IsolatedPostgresRuntime> {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Invalid test database prefix');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  if (name.length > 63) throw new Error('Test database name exceeds PostgreSQL identifier limit');
  const administrator = new Pool({ connectionString: requireTestDatabaseUrl(), max: 1 });
  await administrator.query(`CREATE DATABASE "${name}"`);
  const url = new URL(requireTestDatabaseUrl());
  url.pathname = `/${name}`;
  url.searchParams.set('options', '-c search_path=public');
  const runtime = createDatabaseRuntime(url.toString(), { maxConnections,
    applicationName: `known-test-${prefix}`, connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000 });
  return { databaseUrl: url.toString(), schema: 'public', runtime,
    async close() {
      await runtime.close();
      try { await administrator.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally { await administrator.end(); }
    },
  };
}
