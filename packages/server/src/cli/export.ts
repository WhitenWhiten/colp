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
    if (owner === null) throw new ExportCliError(3, 'unknown user');
    const directory = await prepareDirectory(input.outDir);
    const reads = createPostgresCollectionExportReadPort(database.db);
    const ids = await reads.listOwnedIds(owner.subjectId);
    const used = new Set<string>();
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
    await writeInside(directory, 'index.json', `${JSON.stringify({
      exportedAt: new Date().toISOString(),
      server: version.server,
      collections,
    }, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

async function findOwner(
  db: Kysely<DatabaseSchema>,
  username: string,
): Promise<{ readonly principalId: string; readonly subjectId: string } | null> {
  const account = await db.selectFrom('auth_users as user')
    .innerJoin('auth_user_account_map as mapping', 'mapping.auth_user_id', 'user.id')
    .innerJoin('accounts as account', 'account.id', 'mapping.account_id')
    .select(['account.id as accountId', 'account.subject_id as subjectId', 'account.status as status', 'account.deleted_at as deletedAt'])
    .where('user.username', '=', username)
    .executeTakeFirst();
  if (account !== undefined) {
    if (account.status === 'deleted' || account.deletedAt !== null) return null;
    return { principalId: account.accountId, subjectId: account.subjectId };
  }
  const user = await db.selectFrom('auth_users').select('id').where('username', '=', username).executeTakeFirst();
  if (user === undefined) return null;
  return { principalId: user.id, subjectId: '' };
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

function uniqueSlug(base: string, id: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const suffix = id.replace(/[^A-Za-z0-9._~-]/gu, '').slice(0, 32) || 'dup';
  let candidate = `${base}-${suffix}`.slice(0, 200);
  let sequence = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}-${sequence}`.slice(0, 200);
    sequence += 1;
  }
  used.add(candidate);
  return candidate;
}
