import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect } from 'kysely';
import { describe, test } from 'vitest';
import {
  down,
  up,
} from '../../../migrations/202611170200_auth_verification_value_index.js';

const migrationUrl = new URL(
  '../../../migrations/202611170200_auth_verification_value_index.ts',
  import.meta.url,
);

interface RecordedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Executes the migration against a recording pg pool, as the migrator would. */
function executingDb(): { db: Kysely<unknown>; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const pool = {
    connect: async () => ({
      async query(sql: string, parameters: readonly unknown[]) {
        statements.push({ sql, parameters });
        return { command: 'CREATE', rowCount: 0, rows: [] };
      },
      release() {},
    }),
    end: async () => {},
    options: {},
    Client: class {},
  };
  return {
    db: new Kysely<unknown>({ dialect: new PostgresDialect({ pool: pool as never }) }),
    statements,
  };
}

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('A5-2 auth_verifications(value) index migration', () => {
  test('executes an additive, idempotent index on value', async () => {
    const { db, statements } = executingDb();
    await up(db);

    assert.equal(statements.length, 1);
    // auth_verifications is deleted/filtered by `value` (trust-device revoke,
    // password security triggers); the index must lead with that column.
    assert.match(
      statements[0]!.sql,
      /CREATE INDEX IF NOT EXISTS auth_verifications_value_idx\s+ON auth_verifications \("value"\)/u,
    );
    assert.deepEqual(statements[0]!.parameters, []);

    // Re-running up is a catalog no-op: `IF NOT EXISTS` owns idempotency.
    await up(db);
    assert.equal(statements.length, 2);
    assert.equal(statements[1]!.sql, statements[0]!.sql);
  });

  test('down removes exactly this migration index', async () => {
    const { db, statements } = executingDb();
    await down(db);
    assert.equal(statements.length, 1);
    assert.match(statements[0]!.sql, /DROP INDEX IF EXISTS auth_verifications_value_idx/u);
  });

  test('stays inside the migration transaction and never touches the identifier index', async () => {
    const source = await readFile(migrationUrl, 'utf8');
    const withoutComments = stripBlockComments(source);

    // Kysely runs migrations inside one transaction: no CONCURRENTLY.
    assert.doesNotMatch(withoutComments, /CREATE INDEX CONCURRENTLY/iu);
    // Unique would forbid the many verification rows that may share one user id.
    assert.doesNotMatch(withoutComments, /CREATE UNIQUE INDEX/iu);

    // The identifier index stays the library contract: additive only.
    assert.doesNotMatch(source, /auth_verifications_identifier_idx/u);
    assert.doesNotMatch(withoutComments, /\b(?:ALTER TABLE|DROP TABLE)\b/iu);
  });
});
