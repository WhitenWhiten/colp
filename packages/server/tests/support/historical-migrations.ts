import assert from 'node:assert/strict';
import { createMigrator } from '../../src/infrastructure/database/index.js';
import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';

/** A fixed historical window. Its latest is the explicit target, never the
 * evolving production head. Forward compatibility is exercised separately. */
export function createHistoricalMigrator(runtime: IsolatedPostgresRuntime, target: string) {
  const production = createMigrator(runtime.runtime.db, 'migrations', runtime.schema);
  return {
    migrateTo(name: string) {
      assert.ok(name <= target, `historical migration ${name} exceeds fixture target ${target}`);
      return production.migrateTo(name);
    },
    migrateToLatest: () => production.migrateTo(target),
    migrateDown: () => production.migrateDown(),
    async upgradeToCurrentLatest() {
      const result = await production.migrateToLatest();
      if (result.error) throw result.error;
      return result;
    },
  };
}
