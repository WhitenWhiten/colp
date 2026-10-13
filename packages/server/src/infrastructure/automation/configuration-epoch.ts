import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
/** Owner serialization is supplied by the configuration/device unit of work. */
export async function touchAutomationConfiguration(db: Kysely<DatabaseSchema>, ownerId: string): Promise<void> {
  await sql`INSERT INTO automation_configuration_epochs(owner_id,revision) VALUES (${ownerId},1)
    ON CONFLICT (owner_id) DO UPDATE SET revision=automation_configuration_epochs.revision+1`.execute(db);
}
export async function automationConfigurationEpoch(db: Kysely<DatabaseSchema>, ownerId: string): Promise<string> {
  return (await sql<{ revision: string }>`SELECT revision::text FROM automation_configuration_epochs WHERE owner_id=${ownerId}`.execute(db)).rows[0]?.revision ?? '0';
}
