import { exportAutomations } from '../infrastructure/automation/index.js';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Kysely } from 'kysely';
import { applySelfHostedPreset } from '../bootstrap/self-hosted-preset.js';
import { loadConfig } from '../bootstrap/config.js';
import {
  createDatabaseRuntime,
  maintenanceDatabaseRuntimeOptions,
  type DatabaseSchema,
} from '../infrastructure/database/index.js';
import { createPostgresCollectionExportReadPort } from '../infrastructure/collections/index.js';
import {
  buildCollectionExport,
  ExportCollectionError,
} from '../modules/collections/index.js';
import { serializeNetscapeBookmarkHtml } from '../modules/collections/index.js';
import { version } from '../version.js';

const CATALOG_SLUG = 'index';

export class ExportCliError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ExportCliError';
    this.code = code;
  }
}

export async function exportOwnedCollections(input: {
  readonly username: string;
  readonly outDir: string;
}): Promise<void> {
  const username = input.username.trim().toLowerCase();
  if (username.length === 0) throw new ExportCliError(2, 'export requires --username <name>');
  applySelfHostedPreset(process.env);
  const config = loadConfig();
  const database = createDatabaseRuntime(config.databaseUrl, {
    maxConnections: 1,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    applicationName: 'colp-server-export',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
    ...maintenanceDatabaseRuntimeOptions(),
  });
  try {
    const owner = await findOwner(database.db, username);
    const directory = await prepareDirectory(input.outDir);
    const reads = createPostgresCollectionExportReadPort(database.db);
    const ids = await reads.listOwnedIds(owner.subjectId);
    // The directory catalog is written last as `index.json`; reserve its stem so
    // no collection snapshot can be allocated the same file and overwritten.
    const used = new Set<string>([CATALOG_SLUG, 'automations']);
    const collections: Array<{ id: string; slug: string; title: string; version: string }> = [];
    for (const id of ids) {
      const source = await reads.loadForPrincipal({ collectionId: id, subjectId: owner.subjectId });
      if (source === null) continue;
      let built;
      try {
        built = buildCollectionExport(source, {
          principalId: owner.principalId,
          origin: config.publication.origin,
        });
      } catch (error: unknown) {
        if (error instanceof ExportCollectionError) {
          throw new ExportCliError(1, error.message);
        }
        throw error;
      }
      const slug = uniqueSlug(built.filenameSlug, source.id, used);
      await writeInside(directory, `${slug}.json`, `${JSON.stringify(built.snapshot, null, 2)}\n`);
      await writeInside(directory, `${slug}.html`, serializeNetscapeBookmarkHtml(built.snapshot));
      collections.push({ id: source.id, slug, title: source.title, version: built.entry.version });
    }
    await writeInside(directory, 'automations.json', `${JSON.stringify(await exportAutomations(database.db, owner.principalId), null, 2)}\n`);
    await writeInside(directory, `${CATALOG_SLUG}.json`, `${JSON.stringify({
      exportedAt: new Date().toISOString(),
      server: version.server,
      collections,
    }, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

/**
 * Resolve the export owner from the Better Auth user -> product account map.
 *
 * `principalId` is the product account id (accounts.id) and `subjectId` is its
 * separate ownership subject (accounts.subject_id). They are never
 * interchangeable: list/load reads are subject-scoped, while annotation
 * visibility and the Automation export are account-scoped.
 *
 * A user whose account mapping is missing or unusable (no map row, dangling
 * account, empty identifiers, deleted account) must fail the command. Falling
 * back to the auth user id with an empty subject would export nothing and
 * report success, which is indistinguishable from a genuinely empty backup.
 */
async function findOwner(
  db: Kysely<DatabaseSchema>,
  username: string,
): Promise<{ readonly principalId: string; readonly subjectId: string }> {
  const account = await db.selectFrom('auth_users as user')
    .innerJoin('auth_user_account_map as mapping', 'mapping.auth_user_id', 'user.id')
    .innerJoin('accounts as account', 'account.id', 'mapping.account_id')
    .select(['account.id as accountId', 'account.subject_id as subjectId', 'account.status as status', 'account.deleted_at as deletedAt'])
    .where('user.username', '=', username)
    .executeTakeFirst();
  if (account === undefined) {
    const user = await db.selectFrom('auth_users').select('id').where('username', '=', username).executeTakeFirst();
    if (user === undefined) throw new ExportCliError(3, 'unknown user');
    // The auth user exists but has no product account mapping, or its mapping
    // points at an account row that no longer exists (the inner joins above
    // cannot distinguish those two cases, and neither is exportable).
    throw new ExportCliError(1, 'user has no usable account mapping');
  }
  // Soft-deleted accounts keep their auth user mapping; match `unknown user`
  // so a deleted owner cannot be used to read account data.
  if (account.status === 'deleted' || account.deletedAt !== null) {
    throw new ExportCliError(3, 'unknown user');
  }
  if (typeof account.accountId !== 'string' || account.accountId.trim().length === 0) {
    throw new ExportCliError(1, 'account mapping has an empty account id');
  }
  if (typeof account.subjectId !== 'string' || account.subjectId.trim().length === 0) {
    throw new ExportCliError(1, 'account mapping has an empty subject id');
  }
  return { principalId: account.accountId, subjectId: account.subjectId };
}

async function prepareDirectory(outDir: string): Promise<string> {
  const directory = resolve(outDir);
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new ExportCliError(2, 'export --out must be a directory');
  } catch (error: unknown) {
    if (error instanceof ExportCliError) throw error;
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true });
  // Exports contain private collection content. Tighten an existing output
  // directory as well as newly-created paths; callers can relax permissions
  // explicitly after the command completes.
  await chmod(directory, 0o700);
  return directory;
}

async function writeInside(directory: string, name: string, body: string): Promise<void> {
  const file = join(directory, name);
  const root = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  if (!file.startsWith(root)) throw new ExportCliError(2, 'export filename escaped the output directory');
  await writeFile(file, body, 'utf8');
  await chmod(file, 0o600);
}

const MAX_SLUG_LENGTH = 200;

/**
 * Allocates one output filename stem per collection. `used` holds lower-cased
 * stems so names that differ only by case (including the reserved catalog
 * stem) cannot share a file on case-insensitive filesystems.
 *
 * The base is truncated to make room for the `-<id>[-<n>]` tail, never the
 * tail itself: truncating the tail of a maximum-length base reproduced the
 * base on every iteration, so the collision loop could not terminate.
 * Exported for tests only.
 */
export function uniqueSlug(base: string, id: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) {
    used.add(base.toLowerCase());
    return base;
  }
  const suffix = id.replace(/[^A-Za-z0-9._~-]/gu, '').slice(0, 32) || 'dup';
  const withTail = (tail: string) => `${base.slice(0, MAX_SLUG_LENGTH - tail.length)}${tail}`;
  let candidate = withTail(`-${suffix}`);
  // Every tail ends in a distinct `-<n>`, so each candidate is new and the
  // loop ends after at most used.size further probes.
  for (let sequence = 2; used.has(candidate.toLowerCase()); sequence += 1) {
    candidate = withTail(`-${suffix}-${sequence}`);
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
