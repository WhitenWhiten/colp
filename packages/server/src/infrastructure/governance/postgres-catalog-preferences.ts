import { sql, type Kysely } from 'kysely';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type {
  CatalogPreferencesPorts,
  CatalogPreferencesStore,
  CatalogPreferencesView,
} from '../../modules/governance/index.js';

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter((item): item is string => typeof item === 'string'))
    : Object.freeze([]);
}

function mapRow(row: DatabaseSchema['catalog_preferences']): CatalogPreferencesView {
  return Object.freeze({
    hiddenOwnerAccountIds: asStringArray(row.hidden_owner_account_ids),
    hiddenTags: asStringArray(row.hidden_tags),
    hiddenTitleKeywords: asStringArray(row.hidden_title_keywords),
    preferredLanguages: asStringArray(row.preferred_languages),
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  });
}

function createStore(transaction: Parameters<typeof createPostgresProductCommandReceiptPort>[0]): CatalogPreferencesStore {
  return {
    async load(accountId) {
      const row = await transaction.selectFrom('catalog_preferences')
        .selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return row ? mapRow(row) : null;
    },
    async insertFirst(accountId, view) {
      try {
        await sql`
          insert into catalog_preferences (
            account_id, hidden_owner_account_ids, hidden_tags, hidden_title_keywords,
            preferred_languages, revision, updated_at
          ) values (
            ${accountId},
            ${JSON.stringify(view.hiddenOwnerAccountIds)}::jsonb,
            ${JSON.stringify(view.hiddenTags)}::jsonb,
            ${JSON.stringify(view.hiddenTitleKeywords)}::jsonb,
            ${JSON.stringify(view.preferredLanguages)}::jsonb,
            ${view.revision},
            ${new Date(view.updatedAt)}
          )
        `.execute(transaction);
        return 'inserted';
      } catch (error: unknown) {
        const code = (error as { code?: string }).code
          ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code === '23505') return 'conflict';
        throw error;
      }
    },
    async updateIfRevision(accountId, expectedRevision, view) {
      const result = await sql`
        update catalog_preferences
           set hidden_owner_account_ids = ${JSON.stringify(view.hiddenOwnerAccountIds)}::jsonb,
               hidden_tags = ${JSON.stringify(view.hiddenTags)}::jsonb,
               hidden_title_keywords = ${JSON.stringify(view.hiddenTitleKeywords)}::jsonb,
               preferred_languages = ${JSON.stringify(view.preferredLanguages)}::jsonb,
               revision = ${view.revision},
               updated_at = ${new Date(view.updatedAt)}
         where account_id = ${accountId} and revision = ${expectedRevision}
      `.execute(transaction);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
  };
}

export function createPostgresCatalogPreferencesUnitOfWork(
  db: Kysely<DatabaseSchema>,
): { execute<Result>(work: (ports: CatalogPreferencesPorts) => Promise<Result>): Promise<Result> } {
  const base = createUnitOfWork(db);
  return {
    execute: (work) => base.execute(async ({ transaction }) => work({
      receipts: createPostgresProductCommandReceiptPort(transaction),
      store: createStore(transaction),
      clock: { now: () => databaseNow(transaction) },
    })),
  };
}

export function createPostgresCatalogPreferencesQuery(
  db: Kysely<DatabaseSchema>,
): CatalogPreferencesStore {
  return {
    async load(accountId) {
      const row = await db.selectFrom('catalog_preferences').selectAll().where('account_id', '=', accountId).executeTakeFirst();
      return row ? mapRow(row) : null;
    },
    async insertFirst() {
      throw new Error('catalog preferences query store is read-only');
    },
    async updateIfRevision() {
      throw new Error('catalog preferences query store is read-only');
    },
  };
}
