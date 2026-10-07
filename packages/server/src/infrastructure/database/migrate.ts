import 'dotenv/config';
import { loadDatabaseConnectionConfig } from '../config/database-connection.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDatabaseRuntime } from './runtime.js';
import { maintenanceDatabaseRuntimeOptions } from './maintenance-options.js';
import { runMigrations, type MigrationCommand } from './migrations.js';

function parseCommand(value: string | undefined): MigrationCommand {
  if (value === 'latest' || value === 'up' || value === 'down') return value;
  throw new Error('Usage: npm run db:migrate -- <latest|up|down> [migration-directory]');
}

export async function migrateCli(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCommand(arguments_[0]);
  const config = loadDatabaseConnectionConfig();
  const runtime = createDatabaseRuntime(config.databaseUrl, {
    applicationName: 'known-migrator',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
    ...maintenanceDatabaseRuntimeOptions(),
  });
  try {
    const outcome = await runMigrations(runtime.db, command, arguments_[1]);
    for (const result of outcome.results) {
      console.info(`${result.status}: ${result.migrationName}`);
    }
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrateCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
