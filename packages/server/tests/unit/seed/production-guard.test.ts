import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test, vi } from 'vitest';
import {
  assertSeedProductionAllowed,
  describeDatabaseTarget,
  SeedProductionGuardError,
} from '../../../src/infrastructure/seed/production-guard.js';
import { seedCli } from '../../../src/infrastructure/seed/run.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeMinimalManifest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seed-production-guard-'));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({ key: 'demo', tables: [], withdrawOrder: [] }),
    'utf8',
  );
  return directory;
}

describe('seed production guard (A6-2)', () => {
  test('refuses apply/withdraw/adopt in production without the explicit opt-in', () => {
    for (const command of ['apply', 'withdraw', 'adopt'] as const) {
      assert.throws(
        () => assertSeedProductionAllowed(
          command,
          { allowProduction: false },
          { nodeEnv: 'production', host: '10.1.2.3' },
          undefined,
        ),
        (error: unknown) => error instanceof SeedProductionGuardError
          && error.message.includes(`refusing seed --${command}`)
          && error.message.includes('HOST=10.1.2.3')
          && error.message.includes('--allow-production'),
        `${command} must fail closed in production`,
      );
    }
  });

  test('read-only status stays allowed, and non-production mutations need no opt-in', () => {
    assert.deepEqual(
      assertSeedProductionAllowed(
        'status',
        { allowProduction: false },
        { nodeEnv: 'production', host: '127.0.0.1' },
        undefined,
      ),
      { nodeEnv: 'production', host: '127.0.0.1', production: true },
    );
    for (const nodeEnv of ['development', 'TEST'] as const) {
      assert.equal(
        assertSeedProductionAllowed(
          'apply',
          { allowProduction: false },
          { nodeEnv, host: '127.0.0.1' },
          undefined,
        ).production,
        false,
      );
    }
  });

  test('--allow-production is the explicit opt-in and the resolved host is reported', () => {
    assert.deepEqual(
      assertSeedProductionAllowed(
        'adopt',
        { allowProduction: true },
        { nodeEnv: 'production', host: '10.0.0.7' },
        undefined,
      ),
      { nodeEnv: 'production', host: '10.0.0.7', production: true },
    );
  });

  test('refusal and logs report the database target without leaking credentials', () => {
    const databaseUrl = 'postgres://seed-user:super-secret-password@db.internal:5432/known';
    try {
      assertSeedProductionAllowed(
        'apply',
        { allowProduction: false },
        { nodeEnv: 'production', host: '127.0.0.1' },
        databaseUrl,
      );
      assert.fail('production apply must be refused');
    } catch (error) {
      assert.ok(error instanceof SeedProductionGuardError);
      assert.match(error.message, /DATABASE=postgres:\/\/db\.internal:5432\/known/u);
      assert.doesNotMatch(error.message, /seed-user|super-secret-password/u);
    }
    assert.equal(describeDatabaseTarget(undefined), '<unset>');
    assert.equal(describeDatabaseTarget('   '), '<unset>');
    assert.equal(describeDatabaseTarget('not-a-url'), '<non-url target>');
  });

  test('the CLI refuses before reading the manifest or any configuration', async () => {
    await assert.rejects(
      seedCli(
        ['--apply', '--seed-version', 'sha'],
        // The seed directory does not exist: a guard failure must win over
        // manifest loading, proving the refusal happens first.
        { NODE_ENV: 'production', SEED_DIR: '/nonexistent/colp-seed' },
      ),
      (error: unknown) => error instanceof SeedProductionGuardError
        && /--allow-production/u.test(error.message),
    );
  });

  test('an unsupported NODE_ENV fails closed before the production gate', async () => {
    await assert.rejects(
      seedCli(
        ['--apply', '--seed-version', 'sha', '--allow-production'],
        { NODE_ENV: 'staging', SEED_DIR: '/nonexistent/colp-seed' },
      ),
      /NODE_ENV must be one of development, test, production/u,
    );
  });

  test('--allow-production lets the CLI proceed and logs the resolved host', async () => {
    const seedDir = writeMinimalManifest();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await assert.rejects(
      seedCli(
        ['--apply', '--seed-version', 'sha', '--allow-production'],
        // 'Production' must be normalized before the guard compares it.
        { NODE_ENV: ' Production ', SEED_DIR: seedDir, HOST: ' 10.0.0.7 ' },
      ),
      /DATABASE_URL is required/u,
    );
    assert.ok(
      log.mock.calls.some((call) => typeof call[0] === 'string'
        && call[0].includes('NODE_ENV=production')
        && call[0].includes('HOST=10.0.0.7')
        && call[0].includes('DATABASE=<unset>')),
      'production seed mutations must log the resolved host and database target',
    );
  });
});
