import { Kysely, PostgresDialect, type Dialect } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/index.js';

/**
 * Kysely stand-in for the shared unit of work (see
 * `tests/unit/database/unit-of-work-abort.test.ts`).
 *
 * The unit of work issues exactly one statement itself — the PID lookup
 * (`select pg_backend_pid() pid`) — so the fake driver answers that and hands
 * the same connection to the transaction callback. `statements` collects every
 * SQL string the adapter routes through the driver.
 */
export function fakeKyselyDatabase(pid: number, statements?: string[], onRelease?: () => void): Kysely<DatabaseSchema> {
  const dialect = {
    createDriver: () => ({
      init: async () => {},
      acquireConnection: async () => ({
        executeQuery: async (compiled: { sql: string }) => {
          statements?.push(compiled.sql);
          return { rows: [{ pid }] };
        },
        streamQuery: async () => { throw new Error('not used'); },
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
      beginTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      releaseConnection: async () => { onRelease?.(); },
      destroy: async () => {},
    }),
    createIntrospector: () => ({ getSchemas: async () => [], getTables: async () => [], getMetadata: async () => ({ tables: [] }) }),
    createQueryCompiler: () => new PostgresDialect({ pool: {} as never }).createQueryCompiler(),
    createAdapter: () => new PostgresDialect({ pool: {} as never }).createAdapter(),
  } as unknown as Dialect;
  return new Kysely<DatabaseSchema>({ dialect });
}
