import { lockBookmarkSubscriptionAccount } from '../database/account-coordination.js';
import { sql, type Kysely } from 'kysely';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type {
  BookmarkPreferencesPorts,
  BookmarkPreferencesStore,
  BookmarkPreferencesView,
} from '../../modules/identity/index.js';

function mapRow(row: DatabaseSchema['bookmark_preferences']): BookmarkPreferencesView {
  return Object.freeze({
    bookmarkInsertPosition: row.bookmark_insert_position,
    foldersFirst: row.folders_first,
    captureMode: row.capture_mode,
    resultPanelAutoDismissMs: row.result_panel_auto_dismiss_ms,
    learnFromCorrections: row.learn_from_corrections,
    resumeClassificationWhenOnline: row.resume_classification_when_online,
    aiTagMode: row.ai_tag_mode,
    subscriptionOnUnfollow: row.subscription_on_unfollow,
    subscriptionOnUnsubscribe: row.subscription_on_unsubscribe,
    subscriptionDefaultCheckIntervalMinutes: row.subscription_default_check_interval_minutes,
    subscriptionDefaultDigestMode: row.subscription_default_digest_mode,
    subscriptionDefaultEditionLimit: row.subscription_default_edition_limit,

    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  });
}

export function createPostgresBookmarkPreferencesStore(transaction: Parameters<typeof createPostgresProductCommandReceiptPort>[0]): BookmarkPreferencesStore {
  return {
    async load(accountId) {
      const row = await transaction.selectFrom('bookmark_preferences').selectAll()
        .where('account_id', '=', accountId).executeTakeFirst();
      return row ? mapRow(row) : null;
    },
    async insertFirst(accountId, view) {
      const result = await sql`
        insert into bookmark_preferences (account_id, bookmark_insert_position, folders_first, capture_mode, result_panel_auto_dismiss_ms, learn_from_corrections, resume_classification_when_online, ai_tag_mode, subscription_on_unfollow, subscription_on_unsubscribe, subscription_default_check_interval_minutes, subscription_default_digest_mode, subscription_default_edition_limit, revision, updated_at)
        values (${accountId}, ${view.bookmarkInsertPosition}, ${view.foldersFirst}, ${view.captureMode}, ${view.resultPanelAutoDismissMs}, ${view.learnFromCorrections}, ${view.resumeClassificationWhenOnline}, ${view.aiTagMode}, ${view.subscriptionOnUnfollow}, ${view.subscriptionOnUnsubscribe}, ${view.subscriptionDefaultCheckIntervalMinutes}, ${view.subscriptionDefaultDigestMode}, ${view.subscriptionDefaultEditionLimit}, ${view.revision}, ${new Date(view.updatedAt)})
        on conflict (account_id) do nothing
      `.execute(transaction);
      return Number(result.numAffectedRows ?? 0) === 1 ? 'inserted' : 'conflict';
    },
    async updateIfRevision(accountId, expectedRevision, view) {
      const result = await sql`
        update bookmark_preferences
           set bookmark_insert_position = ${view.bookmarkInsertPosition},
               folders_first = ${view.foldersFirst},
               capture_mode = ${view.captureMode}, result_panel_auto_dismiss_ms = ${view.resultPanelAutoDismissMs}, learn_from_corrections = ${view.learnFromCorrections}, resume_classification_when_online = ${view.resumeClassificationWhenOnline}, ai_tag_mode = ${view.aiTagMode}, subscription_on_unfollow = ${view.subscriptionOnUnfollow}, subscription_on_unsubscribe = ${view.subscriptionOnUnsubscribe}, subscription_default_check_interval_minutes = ${view.subscriptionDefaultCheckIntervalMinutes}, subscription_default_digest_mode = ${view.subscriptionDefaultDigestMode}, subscription_default_edition_limit = ${view.subscriptionDefaultEditionLimit}, revision = ${view.revision}, updated_at = ${new Date(view.updatedAt)}
         where account_id = ${accountId} and revision = ${expectedRevision}
      `.execute(transaction);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
  };
}

export function createPostgresBookmarkPreferencesUnitOfWork(
  db: Kysely<DatabaseSchema>,
): { execute<Result>(work: (ports: BookmarkPreferencesPorts) => Promise<Result>): Promise<Result> } {
  const base = createUnitOfWork(db);
  return { execute: (work) => base.execute(async ({ transaction }) => work({
    receipts: createPostgresProductCommandReceiptPort(transaction),
    store: createPostgresBookmarkPreferencesStore(transaction),
    lockAccount: (accountId) => lockBookmarkSubscriptionAccount(transaction, accountId),
    clock: { now: () => databaseNow(transaction) },
  })) };
}

export function createPostgresBookmarkPreferencesQuery(db: Kysely<DatabaseSchema>): BookmarkPreferencesStore {
  return {
    async load(accountId) {
      const row = await db.selectFrom('bookmark_preferences').selectAll()
        .where('account_id', '=', accountId).executeTakeFirst();
      return row ? mapRow(row) : null;
    },
    async insertFirst() { throw new Error('bookmark preferences query store is read-only'); },
    async updateIfRevision() { throw new Error('bookmark preferences query store is read-only'); },
  };
}
