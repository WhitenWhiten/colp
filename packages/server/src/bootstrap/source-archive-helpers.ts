import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../infrastructure/database/index.js';
import { createPostgresSourceArchives } from '../infrastructure/source-archives/postgres.js';
import { createPostgresExtensionOwnerAccountPort, createPostgresExtensionOwnerSubjectPort } from '../infrastructure/identity/index.js';
/** Compose helper routes with the same account resolver as the Sync surface. */
export function sourceArchiveHelpers(db: Kysely<DatabaseSchema>) {
  return { sourceArchives: createPostgresSourceArchives(db), ownerAccount: createPostgresExtensionOwnerAccountPort(db), ownerSubject: createPostgresExtensionOwnerSubjectPort(db) };
}
